// Tiny single-handler bus so the global floating tab bar's center upload
// button can trigger the gallery screen's import picker — the import flow
// lives in app/(tabs)/index.tsx because it owns the WS / file-server state.
// The gallery registers its handler on mount; the tab bar triggers it.
type Handler = () => void;

let handler: Handler | null = null;

export const uploadBus = {
  setHandler(h: Handler | null) { handler = h; },
  trigger() { handler?.(); },
};
