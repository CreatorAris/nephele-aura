// Lightbox state + control context. Adapted from Bluesky's social-app/src/
// components/Lightbox/state.tsx (MIT). Differences:
//   - Drop useNonReactiveCallback (plain function refs are fine for our scope)
//   - Drop hotkeys scope (Aura has no global hotkey system)
//   - Drop nanoid (simple counter sufficient for unique ids)
//
// The crux of the hero animation is in `openLightbox`: when invoked, we run a
// worklet that measures the tapped thumbnail's screen rect, then bakes that
// rect into the open call so the lightbox can interpolate transforms from
// it on the very first render.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import {
  measure,
  type MeasuredDimensions,
  runOnJS,
  runOnUI,
} from 'react-native-reanimated';

import { type ImageSource } from './types';

// Per-image action surfaced in the pager as an auto-hiding corner button +
// long-press menu item. `key` lets the pager pick an icon ('album' / 'eagle');
// the save logic lives in the caller (kept out of the shared component).
export type LightboxAction = {
  key: string;
  label: string;
  onPress: (image: ImageSource) => void;
};

export type Lightbox = {
  id: string;
  images: ImageSource[];
  index: number;
  // Invoked once when the lightbox closes (any path: tap, dismiss swipe, back
  // gesture). Receives the last-active index — callers use this to mirror the
  // lightbox's pager position into their own state (e.g. Aura's DetailModal
  // jumps to whatever image the user landed on after swiping).
  onClose?: (finalIndex: number) => void;
  // Optional per-image actions. When present the pager shows auto-hiding
  // bottom-right buttons + a long-press menu; callers that omit it (gallery/
  // feed) get no chrome change.
  actions?: LightboxAction[];
};

const LightboxContext = createContext<{
  activeLightbox: Lightbox | null;
}>({
  activeLightbox: null,
});
LightboxContext.displayName = 'LightboxContext';

const LightboxControlContext = createContext<{
  openLightbox: (lightbox: Omit<Lightbox, 'id'>) => void;
  closeLightbox: () => boolean;
  // Called by the pager whenever the active page changes so closeLightbox can
  // pass the final index to onClose. Plain function, not async — keep it cheap
  // since it fires on every swipe.
  setLightboxIndex: (i: number) => void;
  // Patch the active lightbox's image list in place (e.g. swap a thumbnail uri
  // for a full-resolution one that arrived asynchronously over the relay).
  updateImages: (fn: (imgs: ImageSource[]) => ImageSource[]) => void;
}>({
  openLightbox: () => {},
  closeLightbox: () => false,
  setLightboxIndex: () => {},
  updateImages: () => {},
});
LightboxControlContext.displayName = 'LightboxControlContext';

let lightboxIdCounter = 0;
function nextLightboxId(): string {
  lightboxIdCounter += 1;
  return `lb-${lightboxIdCounter}`;
}

export function LightboxProvider({ children }: React.PropsWithChildren<{}>) {
  const [activeLightbox, setActiveLightbox] = useState<Lightbox | null>(null);
  // Keep latest activeLightbox in a ref so closeLightbox returns the correct
  // "wasActive" without re-creating the callback on every state change.
  const activeRef = useRef(activeLightbox);
  activeRef.current = activeLightbox;
  // Tracks the pager's currently-active page. Updated from ImagePager on every
  // onPageSelected. Read by closeLightbox to feed onClose(finalIndex).
  const currentIndexRef = useRef<number>(0);
  // Guard so onClose only fires once per lightbox session even if closeLightbox
  // is called twice (e.g. swipe-dismiss races with the Modal back-gesture).
  const calledOnCloseRef = useRef<boolean>(false);

  const doOpen = useCallback((lightbox: Omit<Lightbox, 'id'>) => {
    setActiveLightbox(prev => {
      // Ignore duplicate open requests; user must close the active one first.
      if (prev) return prev;
      const next = { ...lightbox, id: nextLightboxId() };
      currentIndexRef.current = next.index;
      calledOnCloseRef.current = false;
      return next;
    });
  }, []);

  const openLightbox = useCallback((lightbox: Omit<Lightbox, 'id'>) => {
    const thumbRef = lightbox.images[lightbox.index]?.thumbRef;
    if (thumbRef) {
      // Measure on UI thread, then open with rect baked in so the very first
      // render of the lightbox already has the hero start position.
      // AnimatedRef can't cross runOnJS — only the plain rect goes through.
      const openWithRect = (rect: MeasuredDimensions | null) => {
        doOpen({
          ...lightbox,
          images: lightbox.images.map((img, i) =>
            i === lightbox.index ? { ...img, thumbRect: rect } : img,
          ),
        });
      };
      runOnUI(() => {
        'worklet';
        const rect = measure(thumbRef);
        runOnJS(openWithRect)(rect);
      })();
    } else {
      doOpen(lightbox);
    }
  }, [doOpen]);

  const setLightboxIndex = useCallback((i: number) => {
    currentIndexRef.current = i;
  }, []);

  const updateImages = useCallback(
    (fn: (imgs: ImageSource[]) => ImageSource[]) => {
      setActiveLightbox(prev => (prev ? { ...prev, images: fn(prev.images) } : prev));
    },
    [],
  );

  const closeLightbox = useCallback(() => {
    const active = activeRef.current;
    const wasActive = !!active;
    if (active?.onClose && !calledOnCloseRef.current) {
      calledOnCloseRef.current = true;
      active.onClose(currentIndexRef.current);
    }
    setActiveLightbox(null);
    return wasActive;
  }, []);

  const state = useMemo(() => ({ activeLightbox }), [activeLightbox]);
  const methods = useMemo(
    () => ({ openLightbox, closeLightbox, setLightboxIndex, updateImages }),
    [openLightbox, closeLightbox, setLightboxIndex, updateImages],
  );

  return (
    <LightboxContext.Provider value={state}>
      <LightboxControlContext.Provider value={methods}>
        {children}
      </LightboxControlContext.Provider>
    </LightboxContext.Provider>
  );
}

export function useLightbox() {
  return useContext(LightboxContext);
}

export function useLightboxControls() {
  return useContext(LightboxControlContext);
}
