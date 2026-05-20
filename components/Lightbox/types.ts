import { type Component } from 'react';
import { type TransformsStyle } from 'react-native';
import {
  type AnimatedRef,
  type MeasuredDimensions,
} from 'react-native-reanimated';

export type Dimensions = {
  width: number;
  height: number;
};

export type Position = {
  x: number;
  y: number;
};

// Single image source for the lightbox. Adapted from Bluesky's ImageSource:
// we drop `type` (avatar variants) and `alt` (a11y label) since Aura's library
// items are all rectangular photos with the filename as the only label.
export type ImageSource = {
  uri: string;                       // full-resolution URL
  dimensions: Dimensions | null;     // intrinsic full image size
  thumbUri: string;                  // thumbnail URL used as placeholder
  thumbDimensions: Dimensions | null;
  thumbRect: MeasuredDimensions | null;        // screen-space rect at open time
  thumbRef?: AnimatedRef<Component> | null;    // ref measured in UI thread
  thumbBorderRadius?: number;
};

// Transform values passed from the pager into each ImageItem. The three
// transforms compose the hero-open animation:
//   scaleAndMoveTransform — outer container, translate + scale to fullscreen
//   cropFrameTransform    — crop frame, animates aspect/crop from thumb to full
//   cropContentTransform  — image content within the crop frame
export type Transform = Exclude<TransformsStyle['transform'], string | undefined>;

export type LightboxTransforms = {
  scaleAndMoveTransform: Transform;
  cropFrameTransform: Transform;
  cropContentTransform: Transform;
  borderRadius: number;
  isResting: boolean;
  isHidden: boolean;
};
