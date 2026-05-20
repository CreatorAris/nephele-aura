// ImageItem (iOS variant) — Phase 1 stub.
// Phase 4 (post-Android-cutover): port from Bluesky's social-app/src/
// components/Lightbox/pager/ImageItem/ImageItem.ios.tsx (~359 lines).
//
// iOS leans on Animated.ScrollView's built-in pinchGestureEnabled +
// maximumZoomScale for zoom/pan, then composes that with a Tap gesture for
// double-tap zoom-in and the shared dismissSwipePan for swipe-down close.

import { type SharedValue } from 'react-native-reanimated';
import { type PanGesture } from 'react-native-gesture-handler';
import { type ImageSource, type LightboxTransforms, type Dimensions } from '../../types';

type Props = {
  imageSrc: ImageSource;
  onRequestClose: () => void;
  onTap: () => void;
  onZoom: (scaled: boolean) => void;
  onLoad: (dims: Dimensions) => void;
  showControls: boolean;
  imageAspect: number | undefined;
  imageDimensions: Dimensions | undefined;
  dismissSwipePan: PanGesture;
  transforms: Readonly<SharedValue<LightboxTransforms>>;
};

export default function ImageItem(_props: Props): null {
  // TODO(phase-4): port Bluesky's ImageItem.ios.tsx.
  return null;
}
