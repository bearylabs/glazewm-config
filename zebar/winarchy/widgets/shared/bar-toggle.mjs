export function attachBarToggle(button, {
  query, toggle, label, setTitle, reportError, clearError,
}) {
  let busy = false;
  let closed = false;
  let state = null;
  function render(value) {
    state = value;
    button.disabled = busy || state?.available !== true;
    button.classList.toggle('is-muted', state?.enabled !== true);
    button.setAttribute('aria-pressed', String(state?.enabled === true));
    const text = label(state);
    button.setAttribute('aria-label', text);
    setTitle(button, text);
  }
  async function refresh() {
    if (busy || closed) return;
    busy = true;
    button.disabled = true;
    try {
      const value = await query();
      if (!closed) render(value);
    } catch (error) {
      if (!closed) {
        render(null);
        reportError(error);
      }
    } finally {
      busy = false;
      if (!closed) button.disabled = state?.available !== true;
    }
  }
  async function onClick() {
    if (busy || closed) return;
    busy = true;
    button.disabled = true;
    clearError();
    try {
      const value = await toggle();
      if (!closed) render(value);
    } catch (error) {
      if (!closed) reportError(error);
    } finally {
      busy = false;
      if (!closed) void refresh();
    }
  }
  button.addEventListener('click', onClick);
  document.body.addEventListener('mouseenter', refresh);
  void refresh();
  const timer = setInterval(refresh, 10000);
  function close() {
    closed = true;
    clearInterval(timer);
    button.removeEventListener('click', onClick);
    document.body.removeEventListener('mouseenter', refresh);
  }
  window.addEventListener('pagehide', close, { once: true });
  return { refresh, close };
}
