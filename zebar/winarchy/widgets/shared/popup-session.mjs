// A reusable popup has many render sessions but only one WebView lifetime.
// Run each cleanup once, either when hidden/replaced or when the page unloads.
const pending = new Set();

export function onPopupSessionEnd(cleanup) {
  function end() {
    window.removeEventListener('popup-session-end', end);
    window.removeEventListener('pagehide', end);
    const result = cleanup();
    if (result?.then) {
      const task = Promise.resolve(result).catch(error => console.error('Popup cleanup:', error));
      pending.add(task);
      void task.finally(() => pending.delete(task));
    }
  }
  window.addEventListener('popup-session-end', end);
  window.addEventListener('pagehide', end);
}

export async function waitForPopupSessionEnd() {
  while (pending.size) await Promise.all([...pending]);
}
