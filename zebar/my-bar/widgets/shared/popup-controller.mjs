import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { availableMonitors, currentMonitor, getAllWindows } from 'https://esm.sh/@tauri-apps/api@2.0.2/window';
import { listen, emit } from 'https://esm.sh/@tauri-apps/api@2.0.2/event';
import { LogicalSize, PhysicalPosition } from 'https://esm.sh/@tauri-apps/api@2.0.2/dpi';
import { invoke } from 'https://esm.sh/@tauri-apps/api@2.0.2/core';
import { popupPlacement, popupSizes } from './popup-model.mjs';
import { attachPopupSizing } from './popup-sizing.mjs';
import { createOutsideClickWatcher, spawnOutsideClickProcess } from './popup-dismissal.mjs';

const widget = zebar.currentWidget();
const stateKey = `my-bar:popup:${widget.packId}`;
const lockName = `${stateKey}:lifecycle`;
const readyEvent = 'my-bar:popup-ready';
const popupTitle = `Zebar - ${widget.packId} / popup`;
const barTitle = `Zebar - ${widget.packId} / bar`;
const startupTimeout = 10000;
let mouseWatcher = null;

function readState() {
  const value = localStorage.getItem(stateKey);
  return value ? JSON.parse(value) : null;
}

function writeState(state) {
  if (state) {
    localStorage.setItem(stateKey, JSON.stringify(state));
  } else {
    localStorage.removeItem(stateKey);
  }
  window.dispatchEvent(new Event('popup-state-changed'));
}

function exclusive(action) {
  if (!navigator.locks) {
    throw new Error('WebView2 Web Locks are required for multi-monitor popups.');
  }
  return navigator.locks.request(lockName, action);
}

async function popupWindows() {
  const windows = await getAllWindows();
  const entries = await Promise.all(windows.map(async nativeWindow => ({
    nativeWindow,
    title: await nativeWindow.title(),
  })));
  return entries.filter(entry => entry.title === popupTitle).map(entry => entry.nativeWindow);
}

async function closeWindows(windows) {
  if (!windows.length) return;
  await Promise.all(windows.map(nativeWindow => nativeWindow.close()));
  const labels = new Set(windows.map(nativeWindow => nativeWindow.label));
  const deadline = Date.now() + startupTimeout;
  while ((await getAllWindows()).some(nativeWindow => labels.has(nativeWindow.label))) {
    if (Date.now() >= deadline) {
      throw new Error('The previous popup did not close.');
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// Native client/MFA interactions temporarily retain this exact popup request.
// The deadline bounds retention even if the WebView or operation fails.
export function retainPopupDuringInteraction(duration = 150000) {
  const state = readState();
  if (!state || state.type !== 'network') return () => {};
  const requestId = state.requestId;
  const deadline = Date.now() + duration;
  writeState({ ...state, retainDismissalUntil: deadline });
  return () => {
    const current = readState();
    if (current?.requestId !== requestId || current.retainDismissalUntil !== deadline) return;
    const { retainDismissalUntil, ...rest } = current;
    writeState(rest);
  };
}

export async function dismissPopup(requestId, automatic = false) {
  return exclusive(async () => {
    const state = readState();
    if (requestId && state?.requestId !== requestId) return;
    if (automatic && state?.type === 'network' && state.retainDismissalUntil > Date.now()) return false;
    const windows = await popupWindows();
    // Publish the closed state before closing our own WebView: code after the
    // native close may never run, leaving the bar's expanded state stuck.
    writeState(null);
    try {
      await closeWindows(windows);
    } catch (error) {
      writeState(state);
      throw error;
    }
  });
}

async function togglePopup(type, rect, closeRequestId = null) {
  if (!Object.hasOwn(popupSizes, type)) throw new Error(`Unknown popup: ${type}`);
  return exclusive(async () => {
    const previous = readState();
    if (closeRequestId && previous?.requestId !== closeRequestId) return;
    const windows = await popupWindows();
    const isToggle = closeRequestId || (windows.length && previous?.ownerId === widget.id &&
      previous?.type === type);
    await closeWindows(windows);
    writeState(null);
    if (isToggle) return;

    const [monitor, monitors, position] = await Promise.all([
      currentMonitor(),
      availableMonitors(),
      widget.tauriWindow.innerPosition(),
    ]);
    if (!monitor) throw new Error('Cannot determine the bar monitor.');
    const placement = popupPlacement(monitor, monitors, position, rect, popupSizes[type]);
    const request = {
      requestId: crypto.randomUUID(),
      ownerId: widget.id,
      packId: widget.packId,
      type,
      phase: 'opening',
      layout: {
        monitor, monitors, barPosition: position,
        rect: { left: rect.left, width: rect.width, bottom: rect.bottom },
        width: parseFloat(placement.width),
        maxHeight: parseFloat(placement.height),
      },
    };
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    const unlisten = await listen(readyEvent, ({ payload }) => {
      if (payload.packId === widget.packId && payload.requestId === request.requestId) {
        resolveReady(payload);
      }
    });
    let timer;
    try {
      // Usually already warm from bar startup; arm before creating the window
      // so its very first outside click is covered without delaying its render.
      await mouseWatcher.arm(request.requestId);
      writeState(request);
      await zebar.startWidget('popup', placement);
      const result = await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${type} startup timed out.`)), startupTimeout);
        }),
      ]);
      if (result.error) throw new Error(result.error);
      writeState({ ...request, phase: 'open', popupId: result.popupId });
    } catch (error) {
      // A failed HTML/module start must not leave an unowned native window.
      await closeWindows(await popupWindows());
      writeState(null);
      throw error;
    } finally {
      clearTimeout(timer);
      await unlisten();
    }
  });
}

export function attachPopupTriggers(triggers, reportError, clearError) {
  if (!mouseWatcher) {
    mouseWatcher = createOutsideClickWatcher(
      (program, args) => spawnOutsideClickProcess(zebar.shellSpawn, invoke, program, args),
      async requestId => {
        const dismissed = await dismissPopup(requestId, true);
        // The native watcher is one-shot. A client/MFA click consumes its arm
        // even when we retain the popup, so rearm the still-current request.
        if (dismissed === false && readState()?.requestId === requestId) {
          await mouseWatcher.arm(requestId);
        }
      }, reportError,
    );
    void mouseWatcher.prewarm().catch(reportError);
    window.addEventListener('pagehide', () => mouseWatcher.stop(), { once: true });
  }
  let pointerCloseRequestId = null;
  function run(action) {
    clearError();
    Promise.resolve().then(action).catch(reportError);
  }
  function toggle(trigger, type, closeRequestId) {
    const rect = trigger.getBoundingClientRect();
    run(() => togglePopup(type, rect, closeRequestId));
  }
  function update() {
    try {
      const state = readState();
      if (state?.ownerId !== widget.id) mouseWatcher.disarm();
      for (const { trigger, type } of triggers) {
        trigger.setAttribute('aria-expanded', String(
          state?.ownerId === widget.id && state?.phase === 'open' && state?.type === type,
        ));
      }
    } catch (error) {
      reportError(error);
    }
  }
  // Preserve close intent if native blur closes the popup before click arrives.
  document.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    pointerCloseRequestId = null;
    const match = triggers.find(({ trigger }) => trigger.contains(event.target));
    if (match) {
      try {
        const state = readState();
        if (state?.ownerId === widget.id && state?.type === match.type) {
          pointerCloseRequestId = state.requestId;
        }
      } catch (error) {
        reportError(error);
      }
    } else {
      run(() => dismissPopup());
    }
  }, true);
  document.addEventListener('pointercancel', () => { pointerCloseRequestId = null; });
  function clearHover() {
    for (const { trigger } of triggers) trigger.classList.remove('is-hovered');
  }
  // Native popups can steal pointer capture without delivering mouseleave,
  // leaving CSS :hover stuck in the bar's WebView. Track actual movement instead.
  window.addEventListener('blur', clearHover);
  document.addEventListener('pointerleave', clearHover);
  for (const { trigger, type } of triggers) {
    const hover = () => trigger.classList.add('is-hovered');
    trigger.addEventListener('pointerenter', hover);
    trigger.addEventListener('pointermove', hover);
    trigger.addEventListener('pointerleave', () => trigger.classList.remove('is-hovered'));
    trigger.addEventListener('click', event => {
      clearHover();
      const closeRequestId = event.detail === 0 ? null : pointerCloseRequestId;
      pointerCloseRequestId = null;
      toggle(trigger, type, closeRequestId);
    });
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') run(() => dismissPopup());
  });
  window.addEventListener('storage', event => {
    if (event.key === stateKey) update();
  });
  window.addEventListener('popup-state-changed', update);
  update();
}

export function attachCalendarTrigger(trigger, reportError, clearError) {
  attachPopupTriggers([{ trigger, type: 'calendar' }], reportError, clearError);
}

async function focusedBar() {
  const windows = await getAllWindows();
  for (const nativeWindow of windows) {
    if (await nativeWindow.isFocused() && await nativeWindow.title() === barTitle) {
      return true;
    }
  }
  return false;
}

export async function initialisePopup(render, reportError) {
  const request = readState();
  if (!request || request.phase !== 'opening' || request.packId !== widget.packId ||
      !Object.hasOwn(popupSizes, request.type)) {
    throw new Error('No valid popup request. Open the popup from the bar.');
  }
  let closing = false;
  let hasFocused = false;
  let stopSizing = () => {};
  async function close(automatic = false) {
    if (closing) return;
    closing = true;
    try {
      if (await dismissPopup(request.requestId, automatic) === false) closing = false;
    } catch (error) {
      closing = false;
      reportError(error);
    }
  }
  async function handleFocusChange(focused) {
    if (focused) {
      hasFocused = true;
      return;
    }
    if (!hasFocused) return;
    try {
      if (await widget.tauriWindow.isFocused()) return;
      // A bar click performs its own atomic toggle/close; do not race it.
      if (!await focusedBar()) await close(true);
    } catch (error) {
      reportError(error);
    }
  }
  const unlistenFocus = await widget.tauriWindow.onFocusChanged(({ payload }) => handleFocusChange(payload));
  // WebView focus events also cover activation changes not delivered by Tauri.
  const onFocus = () => { void handleFocusChange(true); };
  const onBlur = () => { void handleFocusChange(false); };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void close();
    }
  });
  document.getElementById('close-popup').addEventListener('click', () => void close());
  window.addEventListener('pagehide', () => {
    stopSizing();
    unlistenFocus();
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  }, { once: true });
  try {
    const layout = request.layout;
    document.documentElement.style.setProperty('--popup-max-height', `${layout.maxHeight}px`);
    await render(request.type);
    stopSizing = await attachPopupSizing({
      main: document.querySelector('main'),
      maxHeight: layout.maxHeight,
      Observer: ResizeObserver,
      reportError,
      resize: async height => {
        if (closing) return;
        const placement = popupPlacement(layout.monitor, layout.monitors,
          layout.barPosition, layout.rect, { width: layout.width, height });
        await widget.tauriWindow.setSize(new LogicalSize(layout.width, parseFloat(placement.height)));
        if (closing) return;
        // PhysicalPosition is serialized as i32 by Tauri; mixed DPI and
        // fractional DOM bounds can produce subpixel physical coordinates.
        await widget.tauriWindow.setPosition(new PhysicalPosition(
          Math.round(layout.monitor.position.x + parseFloat(placement.offsetX) * layout.monitor.scaleFactor),
          Math.round(layout.monitor.position.y + parseFloat(placement.offsetY) * layout.monitor.scaleFactor),
        ));
      },
    });
    // Native resize completion can precede the WebView's next layout/paint.
    // Keep the entire surface transparent until the resized frame is ready.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!closing) {
      // The bar's persistent native watcher was armed before this window was
      // created. No PowerShell startup/C# compilation on the popup's hot path.
      document.documentElement.setAttribute('data-popup-ready', 'true');
      if (await widget.tauriWindow.isFocused()) hasFocused = true;
    }
    // Even an immediate dismissal must release the bar's startup lifecycle lock.
    await emit(readyEvent, {
      packId: widget.packId,
      requestId: request.requestId,
      popupId: widget.id,
    });
  } catch (error) {
    await emit(readyEvent, {
      packId: widget.packId,
      requestId: request.requestId,
      error: error.message ?? String(error),
    });
    throw error;
  }
}
