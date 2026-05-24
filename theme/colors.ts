// Single source of truth for color values used across screens.
//
// DARK THEME ("midnight" / "Astral Night") — values copied from the desktop
// app's QML palette (gui/qml/core/Theme.qml, "midnight"). Deep violet-blue
// base (#1A1438) with the locked brand purple (#CEACE0) injected at higher
// elevation and as the interactive accent. Token names are unchanged from the
// previous light palette so the 80+ existing `colors.*` call sites keep
// working — only the values flipped.

export const colors = {
  text: {
    primary: '#F5F2FF',    // titles, large numbers, dominant text (off-white violet)
    secondary: '#C0B5DC',  // body text, button labels
    tertiary: '#8278A0',   // helpers, captions, inactive states
    muted: '#7A70A0',      // placeholders, disabled (≥4.5:1 on canvas)
    faint: '#4A4068',      // pre-disabled hints, dividers in dense rows
  },

  bg: {
    canvas: '#1A1438',     // screen background — deep violet-blue base
    surface: '#2E2A48',    // cards, sheets, raised regions (opaque violet)
    subtle: '#241E3C',     // input fields, low-contrast fills
    skeleton: '#2A2548',   // loading placeholders
    thumb: '#252240',      // image placeholder while thumb loads
  },

  border: {
    default: '#3A3458',    // regular borders (search bar, chips at rest)
    subtle: '#2E2A4E',     // very light dividers between rows
    hairline: '#2A2548',   // sheet section dividers
    focus: '#CEACE0',      // focused / active borders (brand purple)
  },

  brand: {
    primary: '#CEACE0',    // Nephele purple — interactive accent (locked across themes)
    soft: '#4A3580',       // active chip background — visible step above surface #2E2A48
    softer: '#3D2A6A',     // active row background (folder picker selection)
    accent: '#B5C8F7',     // empty-state icon tint (periwinkle)
  },

  status: {
    danger: '#EC8E94',     // logout / destructive
    dangerSoft: '#4A2E3A', // destructive button fill — danger tinted toward canvas (parallels brand.soft)
    error: '#E8959A',      // inline error text
    warning: '#F5C878',    // star rating fill, partial success
    success: '#7EC8D9',    // fully successful state (teal)
  },

  overlay: {
    scrim: 'rgba(0,0,0,0.5)',            // sheet backdrop
    scrimStrong: 'rgba(0,0,0,0.6)',      // modal backdrop
    onImage: 'rgba(255,255,255,0.9)',    // selection checkbox over image
  },
} as const;
