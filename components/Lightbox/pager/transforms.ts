// Affine 3x3 transform matrix helpers used by the lightbox hero animation.
// Adapted verbatim from Bluesky's social-app/src/components/Lightbox/pager/
// transforms.ts (MIT). The pager composes scale + translate matrices in the
// UI worklet to derive the per-frame transforms ImageItem applies.
//
// Matrix layout (row-major affine):
//   [0] [1] [2]      [scaleX   shearX  translateX]
//   [3] [4] [5]  =   [shearY   scaleY  translateY]
//   [6] [7] [8]      [0        0       1         ]
//
// We only use uniform scaling + translation (no rotation/skew), so [1], [3],
// [6], [7] stay zero in practice.

import { type Position } from '../types';

export type TransformMatrix = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export function createTransform(): TransformMatrix {
  'worklet';
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function applyRounding(t: TransformMatrix) {
  'worklet';
  t[2] = Math.round(t[2]);
  t[5] = Math.round(t[5]);
  // Snap near-1 scale values so the animation comes to rest cleanly.
  t[0] = Math.round(t[0] * 200) / 200;
  t[4] = Math.round(t[0] * 200) / 200;
}

export function readTransform(t: TransformMatrix): [number, number, number] {
  'worklet';
  const scale = t[0];
  const translateX = t[2];
  const translateY = t[5];
  return [translateX, translateY, scale];
}

export function prependTranslate(t: TransformMatrix, x: number, y: number) {
  'worklet';
  t[2] += t[0] * x + t[1] * y;
  t[5] += t[3] * x + t[4] * y;
}

export function prependScale(t: TransformMatrix, value: number) {
  'worklet';
  t[0] *= value;
  t[1] *= value;
  t[3] *= value;
  t[4] *= value;
}

export function prependTransform(ta: TransformMatrix, tb: TransformMatrix) {
  'worklet';
  const a00 = ta[0], a01 = ta[1], a02 = ta[2];
  const a10 = ta[3], a11 = ta[4], a12 = ta[5];
  const a20 = ta[6], a21 = ta[7], a22 = ta[8];
  ta[0] = a00 * tb[0] + a01 * tb[3] + a02 * tb[6];
  ta[1] = a00 * tb[1] + a01 * tb[4] + a02 * tb[7];
  ta[2] = a00 * tb[2] + a01 * tb[5] + a02 * tb[8];
  ta[3] = a10 * tb[0] + a11 * tb[3] + a12 * tb[6];
  ta[4] = a10 * tb[1] + a11 * tb[4] + a12 * tb[7];
  ta[5] = a10 * tb[2] + a11 * tb[5] + a12 * tb[8];
  ta[6] = a20 * tb[0] + a21 * tb[3] + a22 * tb[6];
  ta[7] = a20 * tb[1] + a21 * tb[4] + a22 * tb[7];
  ta[8] = a20 * tb[2] + a21 * tb[5] + a22 * tb[8];
}

export function prependPan(t: TransformMatrix, translation: Position) {
  'worklet';
  prependTranslate(t, translation.x, translation.y);
}

export function prependPinch(
  t: TransformMatrix,
  scale: number,
  origin: Position,
  translation: Position,
) {
  'worklet';
  prependTranslate(t, translation.x, translation.y);
  prependTranslate(t, origin.x, origin.y);
  prependScale(t, scale);
  prependTranslate(t, -origin.x, -origin.y);
}
