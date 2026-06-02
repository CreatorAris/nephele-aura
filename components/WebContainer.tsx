// Web-only "phone column" frame. The app is built portrait phone-first; on wide
// landscape surfaces (desktop browser, tablet) flex:1 would stretch everything
// across the full viewport. This centers the whole app in a fixed-width column
// and letterboxes the sides. No-op on native (returns children unchanged).
import { Platform, Dimensions, View } from 'react-native';
import type { ReactNode } from 'react';

export const MAX_CONTENT_WIDTH = 480;

// Width-aware screens (masonry gallery/feed, the onboarding pager) size off
// useWindowDimensions(), which on web reports the full browser width. Clamp the
// reported window width to the column so those screens size to what's actually
// visible instead of overflowing. This runs at module import — pulling
// WebContainer in from the root layout guarantees it lands before first render.
if (Platform.OS === 'web') {
  const originalGet = Dimensions.get.bind(Dimensions);
  // @ts-expect-error narrowing RN-web's Dimensions.get signature
  Dimensions.get = (dim: string) => {
    const value = originalGet(dim as 'window' | 'screen');
    if (dim === 'window' && value.width > MAX_CONTENT_WIDTH) {
      return { ...value, width: MAX_CONTENT_WIDTH };
    }
    return value;
  };
}

const CANVAS = '#1A1438'; // app background
const MARGIN = '#120E26'; // one step darker — frames the column on wide screens

export function WebContainer({ children }: { children: ReactNode }) {
  if (Platform.OS !== 'web') return children as ReactNode;
  return (
    <View style={{ flex: 1, backgroundColor: MARGIN, alignItems: 'center' }}>
      <View
        style={{
          flex: 1,
          width: '100%',
          maxWidth: MAX_CONTENT_WIDTH,
          backgroundColor: CANVAS,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}
