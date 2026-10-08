// Keep ordinary window shadows below the bar, but let fullscreen cover it.
export function createBarZOrder(setZOrder, onError) {
  let requested = 'top_most';
  let pending = Promise.resolve();
  return wm => {
    if (!wm) return pending;
    const order = wm.focusedContainer?.state?.type === 'fullscreen' ? 'normal' : 'top_most';
    if (order === requested) return pending;
    requested = order;
    pending = pending.then(() => setZOrder(order)).catch(error => {
      requested = null;
      onError(error);
    });
    return pending;
  };
}
