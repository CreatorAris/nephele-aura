// Single source of truth for color values used across screens.
// Mirrors the system Aura's UI implicitly uses today — extracted from
// scattered hex literals so future tweaks (e.g. a darker text-primary, a
// softer focus ring) land in one place instead of 30+ touch sites.
//
// Brand colors track the desktop app's #b388ff Nephele purple. Status colors
// (danger / warning / success) match the existing values to keep the
// migration purely structural — token names ≠ new design decisions.

export const colors = {
  text: {
    primary: '#1d1d1f',   // titles, large numbers, dominant text
    secondary: '#666',     // body text, button labels
    tertiary: '#999',      // helpers, captions, inactive states
    muted: '#bbb',         // placeholders, disabled
    faint: '#ccc',         // pre-disabled hints, dividers in dense rows
  },

  bg: {
    canvas: '#fafafa',     // screen background
    surface: '#fff',       // cards, sheets, raised regions
    subtle: '#f5f5f7',     // input fields, low-contrast fills
    skeleton: '#eaeaea',   // loading placeholders
    thumb: '#f0f0f0',      // image placeholder while thumb loads
  },

  border: {
    default: '#ececec',    // regular borders (search bar, chips at rest)
    subtle: '#f0f0f0',     // very light dividers between rows
    hairline: '#f2f2f2',   // sheet section dividers
    focus: '#b388ff',      // focused / active borders
  },

  brand: {
    primary: '#b388ff',    // Nephele purple — interactive accent
    soft: '#f0e6ff',       // active chip background
    softer: '#f8f0ff',     // active row background (folder picker selection)
    accent: '#d4c4f0',     // empty-state icon tint
  },

  status: {
    danger: '#FF383C',     // logout / destructive
    error: '#cc4444',      // inline error text
    warning: '#f7b500',    // star rating fill, partial success
    success: '#5cb85c',    // fully successful state
  },

  overlay: {
    scrim: 'rgba(0,0,0,0.4)',           // sheet backdrop
    scrimStrong: 'rgba(0,0,0,0.45)',    // modal backdrop
    onImage: 'rgba(255,255,255,0.85)',  // selection checkbox over image
  },
} as const;
