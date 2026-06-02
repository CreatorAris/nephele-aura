// Lightbox root + view + per-image gesture wiring. Adapted from Bluesky's
// social-app/src/components/Lightbox/pager/ImagePager.tsx (MIT, ~774 lines).
//
// Phase 2 scope: single image only. Bluesky uses react-native-pager-view to
// swipe between images; we skip that dep for now and render only
// images[initialIndex]. Phase 3.5 will swap in a gesture-handler-based pager
// (no new native dep).
//
// Also stripped relative to Bluesky:
//   - react-native-edge-to-edge SystemBars  -> expo-status-bar
//   - expo-screen-orientation lock           -> not needed (Aura is portrait-only)
//   - chrome/Header + chrome/Footer          -> Aura wires its own rating bar in Phase 3
//   - PlatformInfo.getIsReducedMotionEnabled -> always animate (acceptable for v0)
//   - #/alf useTheme / setSystemUITheme      -> backdrop is hardcoded black

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { BlurView } from 'expo-blur';
import { Download, FolderPlus, Share2 } from 'lucide-react-native';
import { Gesture } from 'react-native-gesture-handler';
import PagerView from 'react-native-pager-view';
import Animated, {
  type AnimatableValue,
  type AnimatedRef,
  cancelAnimation,
  interpolate,
  measure,
  type MeasuredDimensions,
  ReduceMotion,
  runOnJS,
  runOnUI,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withSpring,
  type WithSpringConfig,
} from 'react-native-reanimated';

import { type Lightbox, useLightboxControls } from '../state';
import { type Dimensions, type ImageSource, type LightboxTransforms, type Transform } from '../types';
// Metro picks ImageItem.android.tsx on Android, ImageItem.ios.tsx on iOS.
// The iOS file is still a stub returning null (Phase 4) — that's intentional;
// hardcoding `.android` here would silently use the Android gesture stack on
// iOS instead of surfacing the missing implementation.
import ImageItem from './ImageItem';

// `_WORKLET` is set by Reanimated at runtime in worklet context.
// Declare so TS doesn't complain when we read it from a worklet for diagnostics.
declare global {
  // eslint-disable-next-line no-var
  var _WORKLET: boolean | undefined;
}

type Rect = { x: number; y: number; width: number; height: number };

const IS_IOS = Platform.OS === 'ios';
const PIXEL_RATIO = PixelRatio.get();

const SLOW_SPRING: WithSpringConfig = {
  mass: IS_IOS ? 1.25 : 0.75,
  damping: 300,
  stiffness: 800,
  energyThreshold: 6e-9,
};
const FAST_SPRING: WithSpringConfig = {
  mass: IS_IOS ? 1.25 : 0.75,
  damping: 150,
  stiffness: 900,
  energyThreshold: 6e-9,
};

function canAnimate(lightbox: Lightbox): boolean {
  const img = lightbox.images[lightbox.index];
  return !!img.thumbRect && !!(img.dimensions || img.thumbDimensions);
}

export default function LightboxRoot({
  lightbox: nextLightbox,
  onRequestClose,
}: {
  lightbox: Lightbox | null;
  onRequestClose: () => void;
}) {
  'use no memo';
  const ref = useAnimatedRef<View>();
  const [activeLightbox, setActiveLightbox] = useState(nextLightbox);
  const [orientation, setOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const openProgress = useSharedValue(0);
  const thumbRects = useSharedValue<Record<number, MeasuredDimensions | null>>({});

  if (!activeLightbox && nextLightbox) {
    setActiveLightbox(nextLightbox);
  }

  useEffect(() => {
    if (!nextLightbox) return;

    const initial: Record<number, MeasuredDimensions | null> = {};
    nextLightbox.images.forEach((img, i) => {
      initial[i] = img.thumbRect ?? null;
    });
    thumbRects.set(initial);

    const isAnimated = canAnimate(nextLightbox);

    // Workaround for https://github.com/software-mansion/react-native-reanimated/issues/6677
    rAF_FIXED(() => {
      openProgress.set(() => (isAnimated ? withClampedSpring(1, SLOW_SPRING) : 1));
    });
    return () => {
      rAF_FIXED(() => {
        openProgress.set(() => (isAnimated ? withClampedSpring(0, SLOW_SPRING) : 0));
      });
    };
  }, [nextLightbox, openProgress, thumbRects]);

  const onFullyClosed = useCallback(() => {
    setActiveLightbox(null);
    runOnUI(() => {
      'worklet';
      thumbRects.set({});
    })();
  }, [thumbRects]);

  useAnimatedReaction(
    () => openProgress.get() === 0,
    (isGone, wasGone) => {
      if (isGone && !wasGone) runOnJS(onFullyClosed)();
    },
  );

  // Plain JS callback. The caller (useAnimatedReaction in LightboxImage) is on
  // the UI thread, so it must bridge via runOnJS — not by relying on a
  // 'worklet' directive inside useCallback, which Reanimated's babel plugin
  // doesn't reliably transform.
  const onFlyAway = useCallback(() => {
    openProgress.set(0);
    onRequestClose();
  }, [onRequestClose, openProgress]);

  return (
    <View
      style={[styles.screen, !activeLightbox && styles.screenHidden]}
      aria-modal
      accessibilityViewIsModal
      aria-hidden={!activeLightbox}
    >
      <Animated.View
        ref={ref}
        style={{ flex: 1 }}
        collapsable={false}
        onLayout={e => {
          const layout = e.nativeEvent.layout;
          setOrientation(layout.height > layout.width ? 'portrait' : 'landscape');
        }}
      >
        {activeLightbox && (
          <LightboxView
            key={activeLightbox.id + '-' + orientation}
            lightbox={activeLightbox}
            orientation={orientation}
            onRequestClose={onRequestClose}
            onFlyAway={onFlyAway}
            safeAreaRef={ref}
            openProgress={openProgress}
            thumbRects={thumbRects}
          />
        )}
      </Animated.View>
    </View>
  );
}

function LightboxView({
  lightbox,
  orientation,
  onRequestClose,
  onFlyAway,
  safeAreaRef,
  openProgress,
  thumbRects,
}: {
  lightbox: Lightbox;
  orientation: 'portrait' | 'landscape';
  onRequestClose: () => void;
  onFlyAway: () => void;
  safeAreaRef: AnimatedRef<View>;
  openProgress: SharedValue<number>;
  thumbRects: SharedValue<Record<number, MeasuredDimensions | null>>;
}) {
  const { images, index: initialImageIndex } = lightbox;
  const isAnimated = useMemo(() => canAnimate(lightbox), [lightbox]);
  const [isScaled, setIsScaled] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [imageIndex, setImageIndex] = useState(initialImageIndex);
  const dismissSwipeTranslateY = useSharedValue(0);
  const isFlyingAway = useSharedValue(false);
  // Push the active page index into the provider so closeLightbox can hand it
  // back to onClose. Without this the DetailModal stays on the original tap
  // even after the user swiped to another image.
  const { setLightboxIndex } = useLightboxControls();

  // Optional save actions (save-to-album / save-to-Eagle). Surfaced two ways:
  // auto-hiding bottom-right buttons (discoverable, then out of the way) + a
  // long-press menu (re-access after they fade). Opt-in — gallery/feed pass
  // none, so this whole block is inert for them.
  const actions = lightbox.actions;
  const [actionsVisible, setActionsVisible] = useState(!!actions?.length);
  const [menuVisible, setMenuVisible] = useState(false);
  useEffect(() => {
    if (!actions?.length) return;
    setActionsVisible(true);
    const t = setTimeout(() => setActionsVisible(false), 2000);
    return () => clearTimeout(t);
  }, [actions]);
  const onLongPressImage = useCallback(() => {
    if (actions?.length) setMenuVisible(true);
  }, [actions]);
  const runAction = useCallback((a: { onPress: (img: ImageSource) => void }) => {
    setMenuVisible(false);
    const img = images[imageIndex];
    if (img) a.onPress(img);
  }, [images, imageIndex]);

  const containerStyle = useAnimatedStyle(() => {
    if (openProgress.get() < 1) {
      return { pointerEvents: 'none', opacity: isAnimated ? 1 : 0 };
    }
    if (isFlyingAway.get()) {
      return { pointerEvents: 'none', opacity: 1 };
    }
    return { pointerEvents: 'auto', opacity: 1 };
  });

  const backdropStyle = useAnimatedStyle(() => {
    const screenSize = measure(safeAreaRef);
    let opacity = 1;
    const openProgressValue = openProgress.get();
    if (openProgressValue < 1) {
      opacity = Math.sqrt(openProgressValue);
    } else if (screenSize && orientation === 'portrait') {
      const dragProgress = Math.min(
        Math.abs(dismissSwipeTranslateY.get()) / (screenSize.height / 2),
        1,
      );
      opacity -= dragProgress;
    }
    const factor = IS_IOS ? 100 : 50;
    return { opacity: Math.round(opacity * factor) / factor };
  });

  const handleRequestClose = useCallback(() => {
    const activeRef = images[imageIndex]?.thumbRef;
    if (isAnimated && activeRef) {
      // Re-measure the thumb rect at close time — the thumb may have scrolled
      // to a different position while the user was in the lightbox.
      runOnUI(() => {
        'worklet';
        const rect = measure(activeRef);
        thumbRects.modify(rects => {
          'worklet';
          rects[imageIndex] = rect;
          return rects;
        });
        runOnJS(onRequestClose)();
      })();
    } else {
      onRequestClose();
    }
  }, [isAnimated, images, imageIndex, thumbRects, onRequestClose]);

  const onTap = useCallback(() => {
    setShowControls(show => !show);
  }, []);

  const onZoom = useCallback((nextIsScaled: boolean) => {
    setIsScaled(nextIsScaled);
    if (nextIsScaled) setShowControls(false);
  }, []);

  useAnimatedReaction(
    () => {
      const screenSize = measure(safeAreaRef);
      return !screenSize || Math.abs(dismissSwipeTranslateY.get()) > screenSize.height;
    },
    (isOut, wasOut) => {
      if (isOut && !wasOut) {
        // Stop the decay animation from blocking the screen forever.
        cancelAnimation(dismissSwipeTranslateY);
        runOnJS(onFlyAway)();
      }
    },
  );

  return (
    <Animated.View style={[styles.container, containerStyle]}>
      {/* Always hide the system status bar inside the lightbox — Aura users
          want the preview to fill the whole screen edge-to-edge, no time/
          battery/signal chrome competing for attention. Bluesky's original
          tied hidden to (isScaled || !showControls); we go further. */}
      <StatusBar style="light" hidden />
      <Animated.View style={[styles.backdrop, backdropStyle]} renderToHardwareTextureAndroid />
      <PagerView
        // Disable horizontal paging while zoomed — inner Pan gesture takes over.
        scrollEnabled={!isScaled}
        initialPage={initialImageIndex}
        onPageSelected={e => {
          const pos = e.nativeEvent.position;
          setImageIndex(pos);
          setLightboxIndex(pos);
          // Reset zoom across page changes so the new page starts at 1:1.
          setIsScaled(false);
        }}
        onPageScrollStateChanged={e => {
          setIsDragging(e.nativeEvent.pageScrollState !== 'idle');
        }}
        overdrag
        style={styles.pager}
      >
        {images.map((imageSrc, i) => {
          // Virtualization belt-and-suspenders: PagerView's offscreenPageLimit
          // already limits native mount, but this skips the React subtree for
          // pages further than ±2 from active — at 18k items the extra
          // SharedValue / useDerivedValue / useAnimatedReaction setup adds up.
          const inWindow = Math.abs(i - imageIndex) <= 2;
          return (
            <View key={`${i}-${imageSrc.uri}`}>
              {inWindow ? (
                <LightboxImage
                  onTap={onTap}
                  onZoom={onZoom}
                  onLongPress={actions?.length ? onLongPressImage : undefined}
                  imageSrc={imageSrc}
                  onRequestClose={handleRequestClose}
                  isScrollViewBeingDragged={isDragging}
                  showControls={showControls}
                  safeAreaRef={safeAreaRef}
                  isScaled={isScaled}
                  isFlyingAway={isFlyingAway}
                  isActive={i === imageIndex}
                  dismissSwipeTranslateY={dismissSwipeTranslateY}
                  openProgress={openProgress}
                  thumbRects={thumbRects}
                  imageIndex={i}
                />
              ) : null}
            </View>
          );
        })}
      </PagerView>

      {/* Save actions — auto-hiding bottom-right buttons + long-press menu.
          Real blur (dimezisBlurView) is safe here: a static Modal overlay, no
          recycling FlashList behind it (that combo is what crashed on Android). */}
      {actions?.length ? (
        <>
          {actionsVisible && (
            <View style={styles.cornerActions} pointerEvents="box-none">
              {actions.map(a => (
                <Pressable key={a.key} onPress={() => runAction(a)}>
                  <BlurView intensity={40} tint="dark" experimentalBlurMethod="dimezisBlurView" style={styles.cornerBtn}>
                    {a.key === 'album' ? <Download size={15} color="#fff" /> : a.key === 'eagle' ? <FolderPlus size={15} color="#fff" /> : a.key === 'share' ? <Share2 size={15} color="#fff" /> : null}
                    <Text style={styles.cornerLabel}>{a.label}</Text>
                  </BlurView>
                </Pressable>
              ))}
            </View>
          )}
          {menuVisible && (
            <Pressable style={styles.menuScrim} onPress={() => setMenuVisible(false)}>
              <BlurView intensity={60} tint="dark" experimentalBlurMethod="dimezisBlurView" style={styles.menuSheet}>
                {actions.map(a => (
                  <Pressable key={a.key} onPress={() => runAction(a)} style={styles.menuRow}>
                    {a.key === 'album' ? <Download size={18} color="#fff" /> : a.key === 'eagle' ? <FolderPlus size={18} color="#fff" /> : a.key === 'share' ? <Share2 size={18} color="#fff" /> : null}
                    <Text style={styles.menuLabel}>{a.label}</Text>
                  </Pressable>
                ))}
              </BlurView>
            </Pressable>
          )}
        </>
      ) : null}
    </Animated.View>
  );
}

function LightboxImage({
  imageSrc,
  onTap,
  onZoom,
  onLongPress,
  onRequestClose,
  isScrollViewBeingDragged,
  isScaled,
  isFlyingAway,
  isActive,
  showControls,
  safeAreaRef,
  openProgress,
  dismissSwipeTranslateY,
  thumbRects,
  imageIndex,
}: {
  imageSrc: ImageSource;
  onRequestClose: () => void;
  onTap: () => void;
  onZoom: (scaled: boolean) => void;
  onLongPress?: () => void;
  isScrollViewBeingDragged: boolean;
  isScaled: boolean;
  isActive: boolean;
  isFlyingAway: SharedValue<boolean>;
  showControls: boolean;
  safeAreaRef: AnimatedRef<View>;
  openProgress: SharedValue<number>;
  dismissSwipeTranslateY: SharedValue<number>;
  thumbRects: SharedValue<Record<number, MeasuredDimensions | null>>;
  imageIndex: number;
}) {
  const [fetchedDims, setFetchedDims] = useState<Dimensions | null>(null);
  const dims = fetchedDims ?? imageSrc.dimensions ?? imageSrc.thumbDimensions;
  let imageAspect: number | undefined;
  if (dims) {
    imageAspect = dims.width / dims.height;
    if (Number.isNaN(imageAspect)) imageAspect = undefined;
  }

  const {
    width: widthDelayedForJSThreadOnly,
    height: heightDelayedForJSThreadOnly,
  } = useWindowDimensions();
  const measureSafeArea = useCallback(() => {
    'worklet';
    let safeArea: Rect | null = measure(safeAreaRef);
    if (!safeArea) {
      if (typeof _WORKLET !== 'undefined' && _WORKLET) {
        console.error('Expected to always be able to measure safe area.');
      }
      safeArea = {
        x: 0,
        y: 0,
        width: widthDelayedForJSThreadOnly,
        height: heightDelayedForJSThreadOnly,
      };
    }
    return safeArea;
  }, [safeAreaRef, heightDelayedForJSThreadOnly, widthDelayedForJSThreadOnly]);

  const { thumbRect: thumbRectJS, thumbBorderRadius } = imageSrc;
  const transforms = useDerivedValue<LightboxTransforms>(() => {
    'worklet';
    const safeArea = measureSafeArea();
    const openProgressValue = openProgress.get();
    const dismissTranslateY =
      isActive && openProgressValue === 1 ? dismissSwipeTranslateY.get() : 0;

    if (openProgressValue === 0 && isFlyingAway.get()) {
      return {
        isHidden: true,
        isResting: false,
        borderRadius: 0,
        scaleAndMoveTransform: [],
        cropFrameTransform: [],
        cropContentTransform: [],
      };
    }

    if (isActive && imageAspect && openProgressValue < 1) {
      let thumbRect;
      if (typeof _WORKLET !== 'undefined' && _WORKLET) {
        thumbRect = thumbRects.get()[imageIndex];
      } else {
        thumbRect = thumbRectJS;
      }
      if (thumbRect) {
        return interpolateTransform(
          openProgressValue,
          thumbRect,
          safeArea,
          imageAspect,
          thumbBorderRadius,
        );
      }
    }
    return {
      isHidden: false,
      isResting: dismissTranslateY === 0,
      borderRadius: 0,
      scaleAndMoveTransform: [{ translateY: dismissTranslateY }],
      cropFrameTransform: [],
      cropContentTransform: [],
    };
  });

  const dismissSwipePan = Gesture.Pan()
    .enabled(isActive && !isScaled)
    .activeOffsetY([-10, 10])
    .failOffsetX([-10, 10])
    .maxPointers(1)
    .onUpdate(e => {
      'worklet';
      if (openProgress.get() !== 1 || isFlyingAway.get()) return;
      dismissSwipeTranslateY.set(e.translationY);
    })
    .onEnd(e => {
      'worklet';
      if (openProgress.get() !== 1 || isFlyingAway.get()) return;
      if (Math.abs(e.velocityY) > 200) {
        isFlyingAway.set(true);
        if (dismissSwipeTranslateY.get() === 0) {
          // withDecay won't start from exactly 0 (Reanimated quirk).
          dismissSwipeTranslateY.set(1);
        }
        dismissSwipeTranslateY.set(() => {
          'worklet';
          return withDecay({
            velocity: e.velocityY,
            velocityFactor: Math.max(3500 / Math.abs(e.velocityY), 1),
            deceleration: 1,
            reduceMotion: ReduceMotion.Never,
          });
        });
      } else {
        dismissSwipeTranslateY.set(() => {
          'worklet';
          return withSpring(0, {
            stiffness: 700,
            damping: 50,
            reduceMotion: ReduceMotion.Never,
          });
        });
      }
    });

  return (
    <ImageItem
      imageSrc={imageSrc}
      onTap={onTap}
      onZoom={onZoom}
      onLongPress={onLongPress}
      onRequestClose={onRequestClose}
      onLoad={setFetchedDims}
      isScrollViewBeingDragged={isScrollViewBeingDragged}
      showControls={showControls}
      measureSafeArea={measureSafeArea}
      imageAspect={imageAspect}
      imageDimensions={dims ?? undefined}
      dismissSwipePan={dismissSwipePan}
      transforms={transforms}
    />
  );
}

const styles = StyleSheet.create({
  screen: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
  },
  screenHidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
  container: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: '#000',
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  pager: {
    flex: 1,
  },
  cornerActions: {
    position: 'absolute',
    right: 14,
    bottom: 44,
    gap: 10,
    alignItems: 'flex-end',
  },
  cornerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 20,
    overflow: 'hidden',  // clip the blur to the rounded pill
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  cornerLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  menuScrim: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    justifyContent: 'flex-end',
    alignItems: 'center',
    paddingBottom: 60,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  menuSheet: {
    borderRadius: 16,
    overflow: 'hidden',
    minWidth: 220,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 15,
  },
  menuLabel: { color: '#fff', fontSize: 15, fontWeight: '500' },
});

function interpolatePx(
  px: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
) {
  'worklet';
  const value = interpolate(px, inputRange, outputRange);
  return Math.round(value * PIXEL_RATIO) / PIXEL_RATIO;
}

function interpolateTransform(
  progress: number,
  thumbnailDims: { pageX: number; width: number; pageY: number; height: number },
  safeArea: { width: number; height: number; x: number; y: number },
  imageAspect: number,
  thumbBorderRadius?: number,
): LightboxTransforms {
  'worklet';
  const thumbAspect = thumbnailDims.width / thumbnailDims.height;
  let uncroppedInitialWidth;
  let uncroppedInitialHeight;
  if (imageAspect > thumbAspect) {
    uncroppedInitialWidth = thumbnailDims.height * imageAspect;
    uncroppedInitialHeight = thumbnailDims.height;
  } else {
    uncroppedInitialWidth = thumbnailDims.width;
    uncroppedInitialHeight = thumbnailDims.width / imageAspect;
  }
  const safeAreaAspect = safeArea.width / safeArea.height;
  let finalWidth;
  let finalHeight;
  if (safeAreaAspect > imageAspect) {
    finalWidth = safeArea.height * imageAspect;
    finalHeight = safeArea.height;
  } else {
    finalWidth = safeArea.width;
    finalHeight = safeArea.width / imageAspect;
  }
  const initialScale = Math.min(
    uncroppedInitialWidth / finalWidth,
    uncroppedInitialHeight / finalHeight,
  );
  const croppedFinalWidth = thumbnailDims.width / initialScale;
  const croppedFinalHeight = thumbnailDims.height / initialScale;
  const screenCenterX = safeArea.width / 2;
  const screenCenterY = safeArea.height / 2;
  const thumbnailSafeAreaX = thumbnailDims.pageX - safeArea.x;
  const thumbnailSafeAreaY = thumbnailDims.pageY - safeArea.y;
  const thumbnailCenterX = thumbnailSafeAreaX + thumbnailDims.width / 2;
  const thumbnailCenterY = thumbnailSafeAreaY + thumbnailDims.height / 2;
  const initialTranslateX = thumbnailCenterX - screenCenterX;
  const initialTranslateY = thumbnailCenterY - screenCenterY;
  const scale = interpolate(progress, [0, 1], [initialScale, 1]);
  const translateX = interpolatePx(progress, [0, 1], [initialTranslateX, 0]);
  const translateY = interpolatePx(progress, [0, 1], [initialTranslateY, 0]);
  const cropScaleX = interpolate(progress, [0, 1], [croppedFinalWidth / finalWidth, 1]);
  const cropScaleY = interpolate(progress, [0, 1], [croppedFinalHeight / finalHeight, 1]);
  const sourceBorderRadius = thumbBorderRadius ?? 0;
  const initialCropScaleX = croppedFinalWidth / finalWidth;
  const borderRadius = interpolate(
    progress,
    [0, 1],
    [sourceBorderRadius / (initialScale * initialCropScaleX), 0],
  );

  return {
    isHidden: false,
    isResting: progress === 1,
    scaleAndMoveTransform: [{ translateX }, { translateY }, { scale }],
    cropFrameTransform: [{ scaleX: cropScaleX }, { scaleY: cropScaleY }],
    cropContentTransform: [{ scaleX: 1 / cropScaleX }, { scaleY: 1 / cropScaleY }],
    borderRadius,
  };
}

function withClampedSpring<T extends AnimatableValue>(
  value: T,
  config: WithSpringConfig,
): T {
  'worklet';
  return withSpring(value, { ...config, overshootClamping: true });
}

// React Native's rAF doesn't fire callbacks in registration order; coalesce
// so the open/close animations don't race.
// https://github.com/facebook/react-native/issues/48005
let isFrameScheduled = false;
let pendingFrameCallbacks: Array<() => void> = [];
function rAF_FIXED(callback: () => void) {
  pendingFrameCallbacks.push(callback);
  if (!isFrameScheduled) {
    isFrameScheduled = true;
    requestAnimationFrame(() => {
      const callbacks = pendingFrameCallbacks.slice();
      isFrameScheduled = false;
      pendingFrameCallbacks = [];
      let hasError = false;
      let error;
      for (let i = 0; i < callbacks.length; i++) {
        try {
          callbacks[i]();
        } catch (e) {
          hasError = true;
          error = e;
        }
      }
      if (hasError) throw error;
    });
  }
}
