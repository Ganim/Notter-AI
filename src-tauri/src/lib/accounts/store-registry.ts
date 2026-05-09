type Resetter = () => void;
const resetters: Resetter[] = [];

export function registerResettableStore(reset: Resetter): void {
  resetters.push(reset);
}

export function resetAllStores(): void {
  for (const r of resetters) {
    try { r(); } catch (e) { console.error('[store-registry] reset failed', e); }
  }
}

export function _clearForTests(): void {
  resetters.length = 0;
}
