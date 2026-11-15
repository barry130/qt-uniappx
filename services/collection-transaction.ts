// Complete an interrupted follow commit before a newer edit or cloud pull.
// Registering a callback avoids a player -> follow -> player module cycle.
let recover: (() => void) | null = null;
let recovering = false;
export function registerCollectionRecovery(callback: () => void): void { recover = callback; }
export function prepareCollectionWrite(): void {
  if (recovering || recover == null) return;
  recovering = true;
  try { recover!(); } finally { recovering = false; }
}
