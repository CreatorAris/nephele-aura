# Lightbox (Bluesky-derived)

Reanimated-based image viewer adapted from
[bluesky-social/social-app](https://github.com/bluesky-social/social-app) (MIT)
under `src/components/Lightbox/`.

Why fork: `react-native-awesome-gallery` works but the open/close transition
is a plain fade. Bluesky's hero animation (thumb spring → fullscreen, then
back) is the polish we want. Their pager + gesture math is solid; we strip
the Bluesky-specific deps (`#/alf` theme, Lingui, `useNonReactiveCallback`,
ATProto types) and rebuild on Tamagui + plain React 19.

## File layout

| File | Status |
|---|---|
| `types.ts` | ✅ adapted (dropped avatar variants + alt label) |
| `pager/transforms.ts` | ✅ verbatim (pure worklet math) |
| `pager/ImagePager.tsx` | ✅ ported (pager + LightboxView + LightboxImage) |
| `pager/ImageItem/index.tsx` | ✅ platform router |
| `pager/ImageItem/ImageItem.android.tsx` | ✅ ported (pinch / pan / double-tap / dismiss) |
| `pager/ImageItem/ImageItem.ios.tsx` | 🚧 stub (deferred) |
| `state.tsx` | ✅ created with Aura context |
| `chrome/*` | ⬜ not porting (Aura uses route-level rating bar) |

## Phase progress

- **Phase 1 — Skeleton:** ✅ directory + small files + stubs landed.
- **Phase 2 — Port ImagePager + ImageItem.android:** ✅ real worklet transforms, gesture composition, hero open/close springs.
- **Phase 3 — Cutover:** ✅ `app/(tabs)/index.tsx` now opens this Lightbox via `useLightboxControls().openLightbox(...)`. `react-native-awesome-gallery` removed from `package.json` (lockfile cleanup deferred — see TODO).
- **Phase 4 — iOS variant + polish:** ⬜ deferred. Aura is Android-only today; revisit when iOS becomes a target. Includes: port `ImageItem.ios.tsx` (~359 lines of Bluesky's ScrollView-based zoom), close-when-thumb-offscreen fade fallback.

## Source files (read-only references)

`E:\Nephele Workshop\Reference\bluesky-social-app\src\components\Lightbox\`
