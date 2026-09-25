// WebView storage is private to this application origin. Persist synchronously
// on each edit so pagehide is a final flush, not the only chance to retain data.
export function createDraftStorage(storage, workspaceId) {
  const key = `viento-mobile-draft-v1:${workspaceId}`;
  let previous;
  return {
    load() {
      previous = storage.getItem(key);
      if (previous === null) return null;
      return JSON.parse(previous);
    },
    save(draft) {
      const value = draft === null ? null : JSON.stringify(draft);
      if (value === previous) return;
      // Update the baseline only after a successful storage operation. A full
      // disk/quota failure retains the old recovery copy and can be retried.
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
      previous = value;
    },
  };
}
