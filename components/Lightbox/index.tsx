// Lightbox entry. Reads activeLightbox from context and mounts LightboxRoot
// inside a transparent native Modal so the lightbox stacks above any sibling
// RN Modals (e.g. Aura's DetailModal). Mount this <Lightbox /> once at the
// app shell, wrapped in <LightboxProvider />.

import { Modal } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useLightbox, useLightboxControls } from './state';
import LightboxRoot from './pager/ImagePager';

export { LightboxProvider, useLightbox, useLightboxControls } from './state';
export type { ImageSource, Dimensions } from './types';

export function Lightbox() {
  const { activeLightbox } = useLightbox();
  const { closeLightbox } = useLightboxControls();
  return (
    <Modal
      visible={!!activeLightbox}
      transparent
      statusBarTranslucent
      animationType="none"        // hero spring drives the open/close animation
      onRequestClose={closeLightbox}
    >
      {/* react-native-gesture-handler requires a GestureHandlerRootView at the
          root of every Modal — without this, pinch/pan/tap gestures inside the
          lightbox silently no-op (the outer GHRV in app/_layout.tsx doesn't
          reach into the native Modal window). */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <LightboxRoot lightbox={activeLightbox} onRequestClose={closeLightbox} />
      </GestureHandlerRootView>
    </Modal>
  );
}
