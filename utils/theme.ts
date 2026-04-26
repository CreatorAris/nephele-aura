/**
 * Design tokens extracted from TMUI 4.0 source code.
 * Adapted for React Native / Expo.
 *
 * Key adaptations:
 * - TMUI dark bg #000000 → #0f0f1a (Nephele fairy aesthetic, no pure black)
 * - TMUI primary #0091FF → #b388ff (Nephele purple brand)
 * - TMUI success #34C759 → #4ade80 (teal-green, no pure green per user preference)
 * - Signature easing curve preserved: cubic-bezier(0.42, 0.38, 0.15, 0.93)
 */

// ─── Color Palette ────────────────────────────────────────

export const colors = {
  // Brand
  primary: '#b388ff',
  primaryDark: '#9c6aff',
  primaryLight: '#d4b8ff',

  // Semantic (TMUI-derived, adjusted for Nephele)
  success: '#4ade80',
  danger: '#FF8D28',
  warn: '#F7B500',
  error: '#FF383C',
  info: '#8888aa',

  // Dark theme surfaces (TMUI sheet/input/border mapped)
  dark: {
    bg: '#0f0f1a',           // page background (TMUI: #000000)
    surface: '#1a1a2e',      // cards, sheets (TMUI: #1c1c1E)
    surfaceVariant: '#252540', // inputs, elevated (TMUI: #2c2c2e)
    border: '#2a2a3e',       // dividers (TMUI: #2c2c2e)
    tabbar: '#1a1a2e',       // bottom tab (TMUI: #0a0a0a)
  },

  // Text (TMUI-derived)
  text: {
    primary: '#e0e0e0',    // main text (TMUI: #f5f5f7)
    secondary: '#888888',   // secondary
    tertiary: '#666666',    // hint/placeholder
    inverse: '#1d1d1f',     // text on light bg
  },

  // Grayscale (TMUI colorsDefault)
  grey: {
    50: '#fafafa',
    100: '#f5f5f5',
    200: '#eeeeee',
    300: '#e0e0e0',
    400: '#bdbdbd',
    500: '#9e9e9e',
    600: '#757575',
    700: '#616161',
    800: '#424242',
    900: '#212121',
  },
} as const;

// ─── Spacing ──────────────────────────────────────────────
// TMUI uses 4px base unit (n1=4, n2=8, ...)

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

// ─── Border Radius ────────────────────────────────────────
// TMUI defaults: input=12, button=12, tag=5, sheet=12, drawer=26, modal=18

export const borderRadius = {
  xs: 4,
  sm: 8,
  md: 12,    // default (card, button, input, cell)
  lg: 18,    // modal, dialog
  xl: 26,    // drawer, action sheet
  full: 9999, // pill shape
} as const;

// ─── Typography ───────────────────────────────────────────
// TMUI: xxs=12, xs=13, s=14, m=16(base), n=18, g=20, lg=21, xl=24

export const typography = {
  sizes: {
    xxs: 10,
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    xxl: 24,
    xxxl: 28,
    display: 34,
  },
  weights: {
    normal: '400' as const,
    medium: '500' as const,
    semibold: '600' as const,
    bold: '700' as const,
  },
  lineHeights: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.8,
  },
} as const;

// ─── Shadows ──────────────────────────────────────────────
// TMUI card default: 0 3px 10px rgba(0,0,0,0.05)

export const shadows = {
  none: {
    shadowColor: 'transparent',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
  },
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
} as const;

// ─── Animation ────────────────────────────────────────────
// TMUI signature: cubic-bezier(0.42, 0.38, 0.15, 0.93) @ 500ms

export const animation = {
  duration: {
    fast: 200,
    normal: 350,
    slow: 500,    // TMUI default
  },
  // TMUI signature easing — use with react-native-reanimated Easing.bezier()
  easing: {
    tmui: [0.42, 0.38, 0.15, 0.93] as [number, number, number, number],
    easeOut: [0.0, 0.0, 0.58, 1.0] as [number, number, number, number],
    easeInOut: [0.42, 0.0, 0.58, 1.0] as [number, number, number, number],
    easeOutBack: [0.68, -0.55, 0.265, 1.55] as [number, number, number, number],
  },
} as const;

// ─── Component Sizes ──────────────────────────────────────
// TMUI button sizes: mini=28h, small=34h, normal=42h, large=52h

export const componentSizes = {
  button: {
    mini:   { height: 28, fontSize: 12, paddingH: 12 },
    small:  { height: 34, fontSize: 14, paddingH: 16 },
    normal: { height: 42, fontSize: 16, paddingH: 20 },
    large:  { height: 52, fontSize: 17, paddingH: 24 },
  },
  avatar: {
    sm: 32,
    md: 40,
    lg: 60,
    xl: 80,
  },
  icon: {
    sm: 16,
    md: 20,
    lg: 24,
    xl: 32,
  },
} as const;

// ─── HSL Color Utilities ──────────────────────────────────
// Ported from TMUI xCoreColorUtil.uts

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  let r = 0, g = 0, b = 0;
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16) / 255;
    g = parseInt(clean[1] + clean[1], 16) / 255;
    b = parseInt(clean[2] + clean[2], 16) / 255;
  } else {
    r = parseInt(clean.substring(0, 2), 16) / 255;
    g = parseInt(clean.substring(2, 4), 16) / 255;
    b = parseInt(clean.substring(4, 6), 16) / 255;
  }
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** TMUI pattern: darken by reducing lightness by 5 */
export function darken(hex: string, amount = 5): string {
  const { h, s, l } = hexToHsl(hex);
  return `hsl(${h}, ${s}%, ${Math.max(0, l - amount)}%)`;
}

/** TMUI pattern: lighten by increasing lightness by 10 */
export function lighten(hex: string, amount = 10): string {
  const { h, s, l } = hexToHsl(hex);
  return `hsl(${h}, ${s}%, ${Math.min(100, l + amount)}%)`;
}

/** TMUI pattern: generate tint color (l=93 default, l=85 hover) */
export function tint(hex: string, lightness = 93): string {
  const { h, s } = hexToHsl(hex);
  return `hsl(${h}, ${s}%, ${lightness}%)`;
}
