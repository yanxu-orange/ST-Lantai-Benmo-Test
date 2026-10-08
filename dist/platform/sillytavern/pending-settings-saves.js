// ST saves the entire extensionSettings snapshot, including credentials, even
// for an appearance-only edit. Strong writes must follow earlier background
// saves from either adapter. Completed promises are discarded immediately.
const pendingBySettings = new WeakMap();
export function trackSettingsSave(settings, result) {
  let pending = pendingBySettings.get(settings);
  if (!pending) { pending = new Set(); pendingBySettings.set(settings, pending); }
  const work = Promise.resolve(result).catch(() => {});
  pending.add(work);
  void work.then(() => {
    pending.delete(work);
    if (!pending.size) pendingBySettings.delete(settings);
  });
}
export function hasSettingsSaves(settings) { return !!pendingBySettings.get(settings)?.size; }
export async function waitForSettingsSaves(settings) {
  while (hasSettingsSaves(settings)) await Promise.all([...pendingBySettings.get(settings)]);
}
