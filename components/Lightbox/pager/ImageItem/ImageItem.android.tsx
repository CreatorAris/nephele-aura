// ImageItem (Android variant). Adapted from Bluesky's social-app/src/
// components/Lightbox/pager/ImageItem/ImageItem.android.tsx (MIT).
//
// Differences:
//   - Drop `imageSrc.type` (Bluesky had circle-avi / rect-avi variants for
//     avatars). Aura's library is rectangular photos only — borderRadius is
//     always 0 at full open.
//   - Drop accessibility labels (Aura uses filename, not user-authored alt).
//   - The transforms / gesture composition (pan + pinch + double-tap + dismiss
//     swipe) are ported verbatim — this is the production-quality core that
//     makes the hero animation feel right.

import { memo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import {
  Gesture,
  GestureDetector,
  type PanGesture,
} from 'react-native-gesture-handler';
import Animated, {
  type AnimatableValue,
  runOnJS,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { Image } from 'expo-image';

import analytics from '../../../../utils/analytics';
import {
  type Dimensions as ImageDimensions,
  type ImageSource,
  type LightboxTransforms,
} from '../../types';
import {
  applyRounding,
  createTransform,
  prependPan,
  prependPinch,
  prependTransform,
  readTransform,
  type TransformMatrix,
} from '../transforms';

const MIN_SCREEN_ZOOM = 2;
const MAX_ORIGINAL_IMAGE_ZOOM = 2;

const initialTransform = createTransform();

type Props = {
  imageSrc: ImageSource;
  onRequestClose: () => void;
  onTap: () => void;
  onZoom: (isZoomed: boolean) => void;
  onLongPress?: () => void;
  onLoad: (dims: ImageDimensions) => void;
  isScrollViewBeingDragged: boolean;
  showControls: boolean;
  measureSafeArea: () => {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  imageAspect: number | undefined;
  imageDimensions: ImageDimensions | undefined;
  dismissSwipePan: PanGesture;
  transforms: Readonly<SharedValue<LightboxTransforms>>;
};

function ImageItemInner({
  imageSrc,
  onTap,
  onZoom,
  onLongPress,
  onLoad,
  isScrollViewBeingDragged,
  measureSafeArea,
  imageAspect,
  imageDimensions,
  dismissSwipePan,
  transforms,
}: Props) {
  const [isScaled, setIsScaled] = useState(false);
  const committedTransform = useSharedValue(initialTransform);
  const panTranslation = useSharedValue({ x: 0, y: 0 });
  const pinchOrigin = useSharedValue({ x: 0, y: 0 });
  const pinchScale = useSharedValue(1);
  const pinchTranslation = useSharedValue({ x: 0, y: 0 });
  const containerRef = useAnimatedRef();

  // Track scaled state — used to gate the pan gesture's minPointers behavior.
  useAnimatedReaction(
    () => {
      if (pinchScale.get() !== 1) return true;
      const [, , committedScale] = readTransform(committedTransform.get());
      if (committedScale !== 1) return true;
      return false;
    },
    (nextIsScaled, prevIsScaled) => {
      if (nextIsScaled !== prevIsScaled) {
        runOnJS(handleZoom)(nextIsScaled);
      }
    },
  );

  function handleZoom(nextIsScaled: boolean) {
    setIsScaled(nextIsScaled);
    onZoom(nextIsScaled);
  }

  // Android-stock behavior: "bump" into edges when panning/pinching past bounds.
  function getExtraTranslationToStayInBounds(
    candidateTransform: TransformMatrix,
    screenSize: { width: number; height: number },
  ) {
    'worklet';
    if (!imageAspect) return [0, 0];
    const [nextTranslateX, nextTranslateY, nextScale] = readTransform(candidateTransform);
    const scaledDimensions = getScaledDimensions(imageAspect, nextScale, screenSize);
    const clampedTranslateX = clampTranslation(
      nextTranslateX, scaledDimensions.width, screenSize.width,
    );
    const clampedTranslateY = clampTranslation(
      nextTranslateY, scaledDimensions.height, screenSize.height,
    );
    return [clampedTranslateX - nextTranslateX, clampedTranslateY - nextTranslateY];
  }

  const pinch = Gesture.Pinch()
    .onStart(e => {
      'worklet';
      const screenSize = measureSafeArea();
      pinchOrigin.set({
        x: e.focalX - screenSize.width / 2,
        y: e.focalY - screenSize.height / 2,
      });
    })
    .onChange(e => {
      'worklet';
      const screenSize = measureSafeArea();
      if (!imageDimensions) return;
      const [, , committedScale] = readTransform(committedTransform.get());
      const maxCommittedScale = Math.max(
        MIN_SCREEN_ZOOM,
        (imageDimensions.width / screenSize.width) * MAX_ORIGINAL_IMAGE_ZOOM,
      );
      const minPinchScale = 1 / committedScale;
      const maxPinchScale = maxCommittedScale / committedScale;
      const nextPinchScale = Math.min(Math.max(minPinchScale, e.scale), maxPinchScale);
      pinchScale.set(nextPinchScale);

      const t = createTransform();
      prependPan(t, panTranslation.get());
      prependPinch(t, nextPinchScale, pinchOrigin.get(), pinchTranslation.get());
      prependTransform(t, committedTransform.get());
      const [dx, dy] = getExtraTranslationToStayInBounds(t, screenSize);
      if (dx !== 0 || dy !== 0) {
        const pt = pinchTranslation.get();
        pinchTranslation.set({ x: pt.x + dx, y: pt.y + dy });
      }
    })
    .onEnd(() => {
      'worklet';
      const t = createTransform();
      prependPinch(t, pinchScale.get(), pinchOrigin.get(), pinchTranslation.get());
      prependTransform(t, committedTransform.get());
      applyRounding(t);
      committedTransform.set(t);

      pinchScale.set(1);
      pinchOrigin.set({ x: 0, y: 0 });
      pinchTranslation.set({ x: 0, y: 0 });
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    // Initial pinch can transition into pan mid-flight — minPointers=2 prevents
    // single-finger panning until the user has zoomed in.
    .minPointers(isScaled ? 1 : 2)
    .onChange(e => {
      'worklet';
      const screenSize = measureSafeArea();
      if (!imageDimensions) return;

      const nextPanTranslation = { x: e.translationX, y: e.translationY };
      const t = createTransform();
      prependPan(t, nextPanTranslation);
      prependPinch(t, pinchScale.get(), pinchOrigin.get(), pinchTranslation.get());
      prependTransform(t, committedTransform.get());

      const [dx, dy] = getExtraTranslationToStayInBounds(t, screenSize);
      nextPanTranslation.x += dx;
      nextPanTranslation.y += dy;
      panTranslation.set(nextPanTranslation);
    })
    .onEnd(() => {
      'worklet';
      const t = createTransform();
      prependPan(t, panTranslation.get());
      prependTransform(t, committedTransform.get());
      applyRounding(t);
      committedTransform.set(t);
      panTranslation.set({ x: 0, y: 0 });
    });

  const singleTap = Gesture.Tap().onEnd(() => {
    'worklet';
    runOnJS(onTap)();
  });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(e => {
      'worklet';
      const screenSize = measureSafeArea();
      if (!imageDimensions || !imageAspect) return;
      const [, , committedScale] = readTransform(committedTransform.get());
      if (committedScale !== 1) {
        // Already zoomed — collapse back to 1:1.
        committedTransform.set(withClampedSpring(createTransform()));
        return;
      }

      // Zoom in enough to eliminate black bars, but cap at native resolution.
      const screenAspect = screenSize.width / screenSize.height;
      const candidateScale = Math.max(
        imageAspect / screenAspect,
        screenAspect / imageAspect,
        MIN_SCREEN_ZOOM,
      );
      const maxScale = Math.max(
        MIN_SCREEN_ZOOM,
        (imageDimensions.width / screenSize.width) * MAX_ORIGINAL_IMAGE_ZOOM,
      );
      const scale = Math.min(candidateScale, maxScale);

      const candidateTransform = createTransform();
      const origin = {
        x: e.absoluteX - screenSize.width / 2,
        y: e.absoluteY - screenSize.height / 2,
      };
      prependPinch(candidateTransform, scale, origin, { x: 0, y: 0 });

      // Correct any out-of-bounds offset so the zoomed image stays on screen.
      const [dx, dy] = getExtraTranslationToStayInBounds(candidateTransform, screenSize);
      const finalTransform = createTransform();
      prependPinch(finalTransform, scale, origin, { x: dx, y: dy });
      committedTransform.set(withClampedSpring(finalTransform));
    });

  // Opt-in long-press (save menu). .enabled(false) when no handler so it's
  // fully inert for callers that don't use it (gallery/feed) — zero gesture
  // change for them. Distinct from tap (quick) / pan (movement) by timing.
  const longPress = Gesture.LongPress()
    .enabled(!!onLongPress)
    .minDuration(420)
    .onStart(() => {
      'worklet';
      if (onLongPress) runOnJS(onLongPress)();
    });

  const composedGesture = isScrollViewBeingDragged
    ? Gesture.Manual()  // no-op while parent pager is dragging
    : Gesture.Exclusive(
        dismissSwipePan,
        Gesture.Simultaneous(pinch, pan),
        doubleTap,
        longPress,
        singleTap,
      );

  const containerStyle = useAnimatedStyle(() => {
    const { scaleAndMoveTransform, isHidden } = transforms.get();
    // Compose live gesture transforms on top of committed transform.
    // (Matrix mul — operations applied in reverse order.)
    const t = createTransform();
    prependPan(t, panTranslation.get());
    prependPinch(t, pinchScale.get(), pinchOrigin.get(), pinchTranslation.get());
    prependTransform(t, committedTransform.get());
    const [translateX, translateY, scale] = readTransform(t);
    const manipulationTransform = [{ translateX }, { translateY }, { scale }];
    const screenSize = measureSafeArea();
    return {
      opacity: isHidden ? 0 : 1,
      transform: scaleAndMoveTransform.concat(manipulationTransform),
      width: screenSize.width,
      maxHeight: screenSize.height,
      alignSelf: 'center',
      aspectRatio: imageAspect ?? 1 /* force onLoad */,
    };
  });

  const imageCropStyle = useAnimatedStyle(() => {
    const { cropFrameTransform, borderRadius: br } = transforms.get();
    return {
      flex: 1,
      overflow: 'hidden',
      transform: cropFrameTransform,
      borderRadius: br,
    };
  });

  const imageStyle = useAnimatedStyle(() => {
    const { cropContentTransform } = transforms.get();
    return {
      flex: 1,
      transform: cropContentTransform,
      opacity: imageAspect === undefined ? 0 : 1,
    };
  });

  const [showLoader, setShowLoader] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  // Load-start timestamp — onLoad delta gives per-host download+decode time
  // for the CF vs CN relay A/B (event lightbox_image_loaded).
  const mountedAt = useRef(Date.now());
  // The full-res swap arrives as a uri PROP UPDATE (the pager keys pages by
  // position so PagerView never sees a remount). Reset the per-uri load
  // state in render so the loader shows for the new source and onLoad/the
  // timing probe fire for it.
  const lastUriRef = useRef(imageSrc.uri);
  if (lastUriRef.current !== imageSrc.uri) {
    lastUriRef.current = imageSrc.uri;
    mountedAt.current = Date.now();
    if (hasLoaded) setHasLoaded(false);
  }
  useAnimatedReaction(
    () => transforms.get().isResting && !hasLoaded,
    (show, prevShow) => {
      if (!prevShow && show) runOnJS(setShowLoader)(true);
      else if (prevShow && !show) runOnJS(setShowLoader)(false);
    },
  );

  return (
    <GestureDetector gesture={composedGesture}>
      <Animated.View
        ref={containerRef}
        style={styles.container}
        renderToHardwareTextureAndroid
      >
        <Animated.View style={containerStyle}>
          {showLoader && (
            <ActivityIndicator size="small" color="#fff" style={styles.loading} />
          )}
          <Animated.View style={imageCropStyle}>
            <Animated.View style={imageStyle}>
              <Image
                contentFit="contain"
                // Decode at full resolution — default downscales the bitmap to
                // the view size, so pinch-zoom magnified a screen-res copy and
                // large images looked blurry even though /full is the original.
                allowDownscaling={false}
                source={{ uri: imageSrc.uri }}
                placeholderContentFit="contain"
                placeholder={{ uri: imageSrc.thumbUri, cacheKey: imageSrc.thumbCacheKey }}
                onLoad={
                  hasLoaded
                    ? undefined
                    : e => {
                        setHasLoaded(true);
                        if (imageSrc.uri?.startsWith('http')) {
                          analytics.capture('lightbox_image_loaded', {
                            ms: Date.now() - mountedAt.current,
                            host: imageSrc.uri.split('/')[2] ?? '',
                          });
                        }
                        onLoad({ width: e.source.width, height: e.source.height });
                      }
                }
                onError={e => {
                  console.warn(
                    '[Lightbox] image load failed:',
                    imageSrc.uri?.slice(0, 90),
                    e?.error,
                  );
                  analytics.capture('lightbox_image_error', {
                    error: String(e?.error ?? '').slice(0, 120),
                    uri_kind: imageSrc.uri?.startsWith('data:') ? 'data' : imageSrc.uri?.split('/')[2] ?? '',
                  });
                }}
                style={{ flex: 1 }}
                cachePolicy="memory"
              />
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    height: '100%',
    overflow: 'hidden',
    justifyContent: 'center',
  },
  loading: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
});

function getScaledDimensions(
  imageAspect: number,
  scale: number,
  screenSize: { width: number; height: number },
): ImageDimensions {
  'worklet';
  const screenAspect = screenSize.width / screenSize.height;
  const isLandscape = imageAspect > screenAspect;
  if (isLandscape) {
    return {
      width: scale * screenSize.width,
      height: (scale * screenSize.width) / imageAspect,
    };
  }
  return {
    width: scale * screenSize.height * imageAspect,
    height: scale * screenSize.height,
  };
}

function clampTranslation(value: number, scaledSize: number, screenSize: number): number {
  'worklet';
  const panDistance = Math.max(0, (scaledSize - screenSize) / 2);
  return Math.min(Math.max(-panDistance, value), panDistance);
}

function withClampedSpring<T extends AnimatableValue>(value: T): T {
  'worklet';
  return withSpring(value, { overshootClamping: true });
}

export default memo(ImageItemInner);
