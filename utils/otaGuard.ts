// Guard for the invisible OTA apply moments (launch catch-up, background
// apply). reloadAsync() tears down the whole JS world — anything mid-flight
// (a gallery upload, a desktop import round-trip, an auto-tag run) dies with
// it, so those flows register themselves here and UpdateGate stays its hand
// while any key is held. Key-based (not a counter) so a flow that sets its
// state twice can never leak a phantom hold.
const holds = new Set<string>();

export function setOtaHold(key: string, held: boolean): void {
  if (held) holds.add(key);
  else holds.delete(key);
}

export function otaHeld(): boolean {
  return holds.size > 0;
}
