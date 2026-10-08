// Measure the natural dialog height, not the native viewport height. Keep the
// content's maximum height fixed so shrinking the window cannot cause a loop.
export async function attachPopupSizing({ main, maxHeight, resize, reportError, Observer }) {
  let appliedHeight = null;
  let stopped = false;
  let pending = false;
  let running = false;
  const measure = () => Math.min(maxHeight, Math.ceil(main.getBoundingClientRect().height + 4));

  async function update() {
    pending = true;
    if (running || stopped) return;
    running = true;
    try {
      while (pending && !stopped) {
        pending = false;
        const height = measure();
        if (height === appliedHeight) continue;
        await resize(height);
        appliedHeight = height;
      }
    } finally {
      running = false;
    }
  }

  await update();
  const observer = new Observer(() => { void update().catch(reportError); });
  observer.observe(main);
  return () => {
    stopped = true;
    observer.disconnect();
  };
}
