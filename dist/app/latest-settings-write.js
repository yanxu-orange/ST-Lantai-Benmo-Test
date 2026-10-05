// UI-owned intent for small settings changes. Persistence and conflict detection
// stay with the domain repository; a view can unmount without disposing this.
export function createLatestSettingsWrite({ initial, persist, isCurrent = () => true,
  equals = (a, b) => JSON.stringify(a) === JSON.stringify(b), onChange = () => {} }) {
  const copy = value => structuredClone(value);
  let confirmed = copy(initial), desired = copy(initial), pending = null;
  let disposed = false, error = null;
  const current = () => { try { return !disposed && isCurrent() === true; } catch { return false; } };
  const inspect = () => ({ value: copy(desired), confirmed: copy(confirmed), saving: !!pending, error });
  const notify = () => { if (!disposed) { try { onChange(inspect()); } catch { /* View isolation. */ } } };
  async function drain() {
    try {
      while (current() && !equals(desired, confirmed)) {
        const sent = copy(desired);
        const receipt = await persist(copy(sent));
        if (!current()) return false;
        confirmed = copy(receipt);
        // A newer click retains its exact intent. Never replay a toggle against
        // the newly confirmed value: two toggles must still cancel each other.
        if (equals(desired, sent)) desired = copy(confirmed);
      }
      return current();
    } catch (failure) {
      if (!disposed) error = failure;
      // Retain the user's intent, but do not retry an uncertain write.
      return false;
    } finally {
      pending = null;
      notify();
    }
  }
  return Object.freeze({
    inspect,
    change(edit) {
      if (!current() || error) return Promise.resolve(false);
      const next = copy(desired);
      // Validation errors leave the current intent and in-flight save intact.
      edit(next);
      if (equals(next, desired)) return pending ?? Promise.resolve(true);
      desired = next;
      if (!pending) pending = Promise.resolve().then(drain);
      notify();
      return pending;
    },
    reset(value) {
      if (disposed || pending) return false;
      confirmed = copy(value); desired = copy(value); error = null;
      notify();
      return true;
    },
    dispose() { disposed = true; },
  });
}
