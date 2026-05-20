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
| `pager/ImagePager.tsx` | 🚧 stub |
| `pager/ImageItem/index.tsx` | ✅ platform router stub |
| `pager/ImageItem/ImageItem.android.tsx` | 🚧 stub (priority for Aura) |
| `pager/ImageItem/ImageItem.ios.tsx` | 🚧 stub (Phase 4) |
| `state.tsx` | ⬜ not yet created (uses Aura context, not Bluesky's) |
| `chrome/*` | ⬜ not porting (Aura already has rating bar) |

## Phase progress

- **Phase 1 — Skeleton (this commit):** directory + small files + stubs. TS clean. Nothing imports from here yet.
- **Phase 2 — Port ImagePager + ImageItem.android:** real worklet transforms, gesture composition, hero open/close springs.
- **Phase 3 — Cutover:** swap `FullscreenLightbox` in `app/(tabs)/index.tsx` from `react-native-awesome-gallery` to this. Remove the awesome-gallery dep.
- **Phase 4 — iOS variant + polish:** port `ImageItem.ios.tsx`. Handle close-when-thumb-offscreen (Bluesky also falls back to fade in that case).

## Source files (read-only references)

`E:\Nephele Workshop\Reference\bluesky-social-app\src\components\Lightbox\`
