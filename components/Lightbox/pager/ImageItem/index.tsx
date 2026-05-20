// Platform router for ImageItem. Metro picks ImageItem.android.tsx on Android,
// ImageItem.ios.tsx on iOS — both are Phase 2 work. Until then this default
// export keeps the import path resolvable.
export { default } from './ImageItem.android';
