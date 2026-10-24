// Local paint-owner trial: business surfaces keep their original theme paint.
// Cold-load contract only; no detached decoration, observers, listeners or marker scan.
export function createPersistentDecoration() {
  return { sync() {}, dispose() {} };
}
