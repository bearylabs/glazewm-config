import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { availableMonitors, currentMonitor, getAllWindows } from 'https://esm.sh/@tauri-apps/api@2.0.2/window';
import { listen, emit } from 'https://esm.sh/@tauri-apps/api@2.0.2/event';
import { LogicalSize, PhysicalPosition } from 'https://esm.sh/@tauri-apps/api@2.0.2/dpi';
import { invoke } from 'https://esm.sh/@tauri-apps/api@2.0.2/core';
import { popupPlacement, popupSizes } from './popup-model.mjs';
import { attachPopupSizing } from './popup-sizing.mjs';
import { waitForPopupSessionEnd } from './popup-session.mjs';
import { createOutsideClickWatcher, spawnOutsideClickProcess } from './popup-dismissal.mjs';

const widget = zebar.currentWidget();
const stateKey = `my-bar:popup:${widget.packId}`;
const lockName = `${stateKey}:lifecycle`;
const readyEvent = 'my-bar:popup-ready';
const openEvent = 'my-bar:popup-open';
const windowKey = `${stateKey}:window`;
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

async function waitForPopupReady(request, start) {
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const unlisten = await listen(readyEvent, ({ payload }) => {
    if (payload.packId === widget.packId && payload.requestId === request.requestId) resolveReady(payload);
  });
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(start).then(() => ready),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${request.type ?? 'Popup prewarm'} startup timed out.`)), startupTimeout);
      }),
    ]);
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    clearTimeout(timer);
    await unlisten();
  }
}

export async function prewarmPopup() {
  return exclusive(async () => {
    // All monitor bars share this lock and cache. Never replace a live popup.
    const previous = readState();
    const windows = await popupWindows();
    const cachedId = localStorage.getItem(windowKey);
    if (windows.some(nativeWindow => nativeWindow.label === cachedId) || (previous && windows.length)) return;
    // Storage survives process restarts; a request without a native window is stale.
    if (previous) writeState(null);
    await closeWindows(windows);
    const [monitor, monitors] = await Promise.all([currentMonitor(), availableMonitors()]);
    if (!monitor || !monitors.length) throw new Error('Cannot determine the popup prewarm monitor.');
    const placement = popupPlacement(monitor, monitors, monitor.position,
      { left: 0, width: 1, bottom: 0 }, { width: 1, height: 1 });
    // Start a transparent, nonfocused 1px surface outside the entire virtual
    // desktop, not merely outside one screen (mixed DPI/negative coordinates).
    placement.offsetX = `${(Math.max(...monitors.map(item => item.position.x + item.size.width)) - monitor.position.x + 64) / monitor.scaleFactor}px`;
    placement.offsetY = `${(Math.max(...monitors.map(item => item.position.y + item.size.height)) - monitor.position.y + 64) / monitor.scaleFactor}px`;
    const request = { requestId: crypto.randomUUID(), packId: widget.packId, phase: 'warming' };
    try {
      await waitForPopupReady(request, async () => {
        writeState(request);
        await zebar.startWidget('popup', placement);
      });
      writeState(null);
    } catch (error) {
      writeState(null);
      localStorage.removeItem(windowKey);
      await closeWindows(await popupWindows());
      throw error;
    }
  });
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
    // Unlike destroying our own WebView, hiding it allows code to continue.
    // Publish only after success so a failed hide preserves the live session.
    await Promise.all(windows.map(nativeWindow => nativeWindow.hide()));
    writeState(null);
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
    await Promise.all(windows.map(nativeWindow => nativeWindow.hide()));
    writeState(null);
    if (isToggle) return;
    const cachedId = localStorage.getItem(windowKey);
    const reusable = windows.find(nativeWindow => nativeWindow.label === cachedId);
    // Old/orphaned windows have no live request listener and cannot be reused.
    await closeWindows(windows.filter(nativeWindow => nativeWindow !== reusable));

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
    try {
      const result = await waitForPopupReady(request, async () => {
        // Arm only real openings, never the hidden startup window.
        await mouseWatcher.arm(request.requestId);
        writeState(request);
        if (reusable) {
          await emit(openEvent, { ...request, popupId: reusable.label });
        } else {
          await zebar.startWidget('popup', placement);
        }
      });
      writeState({ ...request, phase: 'open', popupId: result.popupId });
    } catch (error) {
      // A failed HTML/module start must not leave an unowned native window.
      writeState(null);
      localStorage.removeItem(windowKey);
      await closeWindows(await popupWindows());
      throw error;
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
    if (navigator.locks) {
      // Startup is best-effort: a real click retries if background loading fails.
      void prewarmPopup().catch(error => console.warn('Popup prewarm failed; retrying on click:', error));
    }
    window.addEventListener('pagehide', () => mouseWatcher.stop(), { once: true });
  }
  let pointerCloseRequestId = null;
  function run(action) {
    clearError();
    Promise.resolve().then(action).catch(reportError);
  }
  function toggle(trigger, type, closeRequestId) {
    const triggerRect = trigger.getBoundingClientRect();
    // Buttons can be shorter than the bar (especially the centered clock).
    // Anchor vertically to the bar viewport, not the button's lower edge.
    const rect = { left: triggerRect.left, width: triggerRect.width,
      bottom: document.documentElement.clientHeight };
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
  let request = null;
  let closing = true;
  let opening = false;
  let hasFocused = false;
  let stopSizing = () => {};

  function disposeSession() {
    if (!request) return;
    closing = true;
    hasFocused = false;
    stopSizing();
    stopSizing = () => {};
    document.documentElement.removeAttribute('data-popup-ready');
    // Unlike pagehide, this ends only the rendered session, not the WebView.
    window.dispatchEvent(new Event('popup-session-end'));
    request = null;
  }
  async function close(automatic = false) {
    if (closing || opening || !request) return;
    const id = request.requestId;
    closing = true;
    try {
      if (await dismissPopup(id, automatic) === false && request?.requestId === id) closing = false;
    } catch (error) {
      if (request?.requestId === id) closing = false;
      reportError(error);
    }
  }
  async function handleFocusChange(focused) {
    const id = request?.requestId;
    if (!id || opening || closing) return;
    if (focused) {
      hasFocused = true;
      return;
    }
    if (!hasFocused) return;
    try {
      if (await widget.tauriWindow.isFocused()) return;
      // Never let a late blur from the previous session close its replacement.
      if (!await focusedBar() && request?.requestId === id) await close(true);
    } catch (error) {
      reportError(error);
    }
  }
  async function open(next) {
    if (!next || next.phase !== 'opening' || next.packId !== widget.packId ||
        !Object.hasOwn(popupSizes, next.type)) {
      throw new Error('No valid popup request. Open the popup from the bar.');
    }
    disposeSession();
    request = next;
    closing = false;
    opening = true;
    try {
      // Finish old provider unsubscriptions before subscribing the same config
      // again; Zebar's shared provider hashes otherwise race with stopAll().
      await waitForPopupSessionEnd();
      const layout = next.layout;
      document.documentElement.style.setProperty('--popup-max-height', `${layout.maxHeight}px`);
      // Move while hidden before applying logical dimensions: on a different
      // monitor Tauri must first pick up the target monitor's DPI.
      const initial = popupPlacement(layout.monitor, layout.monitors,
        layout.barPosition, layout.rect, { width: layout.width, height: layout.maxHeight });
      await widget.tauriWindow.setPosition(new PhysicalPosition(
        Math.round(layout.monitor.position.x + parseFloat(initial.offsetX) * layout.monitor.scaleFactor),
        Math.round(layout.monitor.position.y + parseFloat(initial.offsetY) * layout.monitor.scaleFactor),
      ));
      await widget.tauriWindow.setSize(new LogicalSize(layout.width, parseFloat(initial.height)));
      await render(next.type);
      document.getElementById('close-popup').addEventListener('click', () => void close());
      stopSizing = await attachPopupSizing({
        main: document.querySelector('main'), maxHeight: layout.maxHeight,
        Observer: ResizeObserver, reportError,
        resize: async height => {
          if (closing || request?.requestId !== next.requestId) return;
          const placement = popupPlacement(layout.monitor, layout.monitors,
            layout.barPosition, layout.rect, { width: layout.width, height });
          await widget.tauriWindow.setSize(new LogicalSize(layout.width, parseFloat(placement.height)));
          if (closing || request?.requestId !== next.requestId) return;
          await widget.tauriWindow.setPosition(new PhysicalPosition(
            Math.round(layout.monitor.position.x + parseFloat(placement.offsetX) * layout.monitor.scaleFactor),
            Math.round(layout.monitor.position.y + parseFloat(placement.offsetY) * layout.monitor.scaleFactor),
          ));
        },
      });
      // Hidden WebViews can suspend requestAnimationFrame. Show the native
      // window while CSS keeps it transparent, then reveal the resized frame.
      await widget.tauriWindow.show();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (request?.requestId !== next.requestId) throw new Error('Popup request was superseded.');
      document.documentElement.setAttribute('data-popup-ready', 'true');
      hasFocused = await widget.tauriWindow.isFocused();
      localStorage.setItem(windowKey, widget.id);
      opening = false;
      await emit(readyEvent, { packId: widget.packId, requestId: next.requestId, popupId: widget.id });
    } catch (error) {
      disposeSession();
      await emit(readyEvent, { packId: widget.packId, requestId: next.requestId,
        error: error.message ?? String(error) });
      throw error;
    } finally {
      if (!request || request.requestId === next.requestId) opening = false;
    }
  }
  const unlistenFocus = await widget.tauriWindow.onFocusChanged(({ payload }) => handleFocusChange(payload));
  const unlistenOpen = await listen(openEvent, ({ payload }) => {
    const current = readState();
    if (payload.packId !== widget.packId || payload.popupId !== widget.id ||
        current?.phase !== 'opening' || current.requestId !== payload.requestId || opening) return;
    void open(current).catch(reportError);
  });
  const onFocus = () => { void handleFocusChange(true); };
  const onBlur = () => { void handleFocusChange(false); };
  const onState = () => {
    if (request && readState()?.requestId !== request.requestId) disposeSession();
  };
  const onStorage = event => { if (event.key === stateKey) onState(); };
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  window.addEventListener('storage', onStorage);
  window.addEventListener('popup-state-changed', onState);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && request) {
      event.preventDefault();
      void close();
    }
  });
  window.addEventListener('pagehide', () => {
    disposeSession();
    unlistenFocus();
    unlistenOpen();
    if (localStorage.getItem(windowKey) === widget.id) localStorage.removeItem(windowKey);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('storage', onStorage);
    window.removeEventListener('popup-state-changed', onState);
  }, { once: true });
  const initial = readState();
  await widget.tauriWindow.hide();
  if (initial?.phase === 'warming' && initial.packId === widget.packId) {
    // All imports have finished and the request listener is installed. Do not
    // render providers, arm dismissal, show, focus, or wait for hidden frames.
    localStorage.setItem(windowKey, widget.id);
    await emit(readyEvent, { packId: widget.packId, requestId: initial.requestId, popupId: widget.id });
  } else {
    await open(initial);
  }
}
