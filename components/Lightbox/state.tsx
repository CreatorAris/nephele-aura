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

export type Lightbox = {
  id: string;
  images: ImageSource[];
  index: number;
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
}>({
  openLightbox: () => {},
  closeLightbox: () => false,
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

  const doOpen = useCallback((lightbox: Omit<Lightbox, 'id'>) => {
    setActiveLightbox(prev => {
      // Ignore duplicate open requests; user must close the active one first.
      if (prev) return prev;
      return { ...lightbox, id: nextLightboxId() };
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

  const closeLightbox = useCallback(() => {
    const wasActive = !!activeRef.current;
    setActiveLightbox(null);
    return wasActive;
  }, []);

  const state = useMemo(() => ({ activeLightbox }), [activeLightbox]);
  const methods = useMemo(() => ({ openLightbox, closeLightbox }), [openLightbox, closeLightbox]);

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
