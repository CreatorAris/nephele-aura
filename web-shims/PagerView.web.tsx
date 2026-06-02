// Web-only shim for react-native-pager-view (which imports RN internals that
// don't exist on web). Implements the subset of the API Aura uses:
// initialPage / onPageSelected / setPage / setPageWithoutAnimation.
// A horizontal paging ScrollView is the standard web equivalent.
import React, {
  forwardRef,
  useImperativeHandle,
  useRef,
  Children,
} from 'react';
import {
  ScrollView,
  View,
  useWindowDimensions,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';

type PagerProps = {
  initialPage?: number;
  scrollEnabled?: boolean;
  onPageSelected?: (e: { nativeEvent: { position: number } }) => void;
  style?: any;
  children?: React.ReactNode;
};

export type PagerViewRef = {
  setPage: (n: number) => void;
  setPageWithoutAnimation: (n: number) => void;
};

const PagerView = forwardRef<PagerViewRef, PagerProps>((props, ref) => {
  const { initialPage = 0, onPageSelected, style, children, scrollEnabled = true } = props;
  const { width } = useWindowDimensions();
  const scrollRef = useRef<ScrollView>(null);
  const pageRef = useRef(initialPage);

  // Single commit path: update the tracked page and notify the parent. Dedupe so
  // a programmatic setPage + the scroll-settle event don't fire onPageSelected
  // twice. Crucially this runs for programmatic page changes too — web's
  // scrollTo does not reliably emit onMomentumScrollEnd, so without this the
  // parent's page state never advances (the "stuck on screen 2" bug).
  const commitPage = (n: number) => {
    if (n !== pageRef.current) {
      pageRef.current = n;
      onPageSelected?.({ nativeEvent: { position: n } });
    }
  };

  useImperativeHandle(ref, () => ({
    setPage: (n: number) => {
      scrollRef.current?.scrollTo({ x: n * width, animated: true });
      commitPage(n);
    },
    setPageWithoutAnimation: (n: number) => {
      scrollRef.current?.scrollTo({ x: n * width, animated: false });
      commitPage(n);
    },
  }));

  const onMomentumScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    commitPage(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  const pages = Children.toArray(children);
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      pagingEnabled
      scrollEnabled={scrollEnabled}
      showsHorizontalScrollIndicator={false}
      onMomentumScrollEnd={onMomentumScrollEnd}
      contentOffset={{ x: initialPage * width, y: 0 }}
      style={style}
    >
      {pages.map((child, i) => (
        <View key={i} style={{ width }}>
          {child}
        </View>
      ))}
    </ScrollView>
  );
});

PagerView.displayName = 'PagerViewWebShim';
export default PagerView;
