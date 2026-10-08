import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { powerStatusArgs } from '../widgets/shared/battery-model.mjs';
import { outputDeviceArgsRegex } from '../widgets/shared/audio-model.mjs';
import { bluetoothArgsRegex, bluetoothSettingsPermission } from '../widgets/shared/bluetooth-model.mjs';
import { globalProtectArgsRegex } from '../widgets/shared/globalprotect-model.mjs';
import { calendarDays, dateKey, popupPlacement, popupSizes, shiftMonth } from '../widgets/shared/popup-model.mjs';
import { attachPopupSizing } from '../widgets/shared/popup-sizing.mjs';
import { outsideClickArgs, outsideClickArgsRegex, createOutsideClickWatcher, spawnOutsideClickProcess } from '../widgets/shared/popup-dismissal.mjs';

const monitor = (x, y, width, height, scaleFactor = 1, name = 'display') => ({
  name, position: { x, y }, size: { width, height }, scaleFactor,
});

test('popup owns narrowly scoped power privileges without changing bar docking', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const bar = pack.widgets.find(widget => widget.name === 'bar');
  const popup = pack.widgets.find(widget => widget.name === 'popup');
  assert.equal(bar.zOrder, 'top_most', 'Ordinary window shadows must stay below the bar.');
  assert(popup, 'Popup must be a top-level widget.');
  assert.equal(popup.focused, false, 'Background prewarming must not steal focus.');
  assert.equal(popup.shownInTaskbar, false);
  assert.equal(popup.zOrder, 'top_most');
  assert.equal(popup.transparent, true, 'Rounded popup corners need a transparent native surface.');
  assert.deepEqual(popup.presets, []);
  assert.deepEqual(bar.privileges.shellCommands[1], {
    program: 'powershell.exe', argsRegex: outsideClickArgsRegex(),
  });
  assert(!popup.privileges.shellCommands.some(permission => permission.argsRegex.includes('PopupMouse')));
  const mousePermission = new RegExp(bar.privileges.shellCommands[1].argsRegex);
  assert(mousePermission.test(outsideClickArgs.join(' ')));
  assert(!mousePermission.test(`${outsideClickArgs.join(' ')}; shutdown /s /t 0`));
  assert.deepEqual(popup.privileges.shellCommands.slice(0, 2), [
    { program: 'shutdown', argsRegex: '^(/l|/s /t 0)$' },
    { program: 'rundll32.exe', argsRegex: '^user32\\.dll,LockWorkStation$' },
  ]);
  assert.deepEqual(popup.privileges.shellCommands[2], {
    program: 'powershell.exe', argsRegex: outputDeviceArgsRegex(),
  });
  assert.deepEqual(popup.privileges.shellCommands[3], {
    program: 'powershell.exe', argsRegex: bluetoothArgsRegex(),
  });
  assert.deepEqual(popup.privileges.shellCommands[4], bluetoothSettingsPermission);
  assert.deepEqual(popup.privileges.shellCommands[5], {
    program: 'powershell.exe', argsRegex: globalProtectArgsRegex(),
  });
  assert.equal(popup.privileges.shellCommands.length, 8);
  assert.equal(bar.presets[0].height, '28px');
  assert.equal(bar.presets[0].dockToEdge.enabled, true);
  assert.deepEqual(bar.presets[0].monitorSelection, { type: 'all' });
  assert.equal(bar.privileges.shellCommands.length, 4);
  const powerStatus = bar.privileges.shellCommands[0];
  assert.equal(powerStatus.program, 'powershell.exe');
  const allowed = new RegExp(powerStatus.argsRegex);
  assert(allowed.test(powerStatusArgs.join(' ')));
  assert(!allowed.test(`${powerStatusArgs.join(' ')}; shutdown /s /t 0`));
  assert(!allowed.test('-Command Get-Process'));
  assert(bar.includeFiles.includes('widgets/shared/**'));
  assert(popup.includeFiles.includes('widgets/popup/**'));
  assert(popup.includeFiles.includes('widgets/shared/**'));
});

test('prewarm popup configuration is transparent, nonfocused and absent from the taskbar', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const popup = pack.widgets.find(widget => widget.name === 'popup');
  assert.equal(popup.focused, false);
  assert.equal(popup.transparent, true);
  assert.equal(popup.shownInTaskbar, false);
});

test('GlazeWM fullscreen uses the full monitor instead of the reserved work area', async () => {
  const config = await readFile(new URL('../../../glazewm/config.yaml', import.meta.url), 'utf8');
  const fullscreen = config.match(/^    fullscreen:\r?\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert(fullscreen, 'Fullscreen defaults must be configured.');
  assert.match(fullscreen, /^      maximized: false\r?$/m);
  assert.match(fullscreen, /^      shown_on_top: false\r?$/m);
});

test('placement preserves physical anchor at mixed DPI and negative coordinates', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const display = monitor(-2560, -200, 2560, 1440, scale);
    const placement = popupPlacement(display, [display], display.position,
      { left: 400, width: 40, bottom: 28 }, { width: 328, height: 376 });
    const x = display.position.x + parseFloat(placement.offsetX) * scale;
    const y = display.position.y + parseFloat(placement.offsetY) * scale;
    assert.equal(x + 164 * scale, display.position.x + 420 * scale);
    assert.equal(y, display.position.y + 28 * scale);
    assert.equal(placement.dockToEdge.enabled, false);
    assert.deepEqual(placement.monitorSelection, { type: 'name', match: 'display' });
  }
});

test('placement clamps all edges and shrinks on small monitors', () => {
  const display = monitor(0, 0, 300, 250);
  for (const left of [-100, 10, 500]) {
    const placement = popupPlacement(display, [display], { x: 0, y: 220 },
      { left, width: 20, bottom: 28 }, { width: 328, height: 376 });
    assert.equal(parseFloat(placement.width), 300);
    assert.equal(parseFloat(placement.height), 250);
    assert.equal(parseFloat(placement.offsetX), 0);
    assert.equal(parseFloat(placement.offsetY), 0);
  }
});

test('rightmost popups meet the screen edge and bar without gaps at mixed DPI', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const display = monitor(-1920, -200, 1920, 1440, scale);
    const placement = popupPlacement(display, [display], display.position,
      { left: 1920 / scale - 40, width: 40, bottom: 28 }, popupSizes.network);
    const right = display.position.x + (parseFloat(placement.offsetX) + parseFloat(placement.width)) * scale;
    const top = display.position.y + parseFloat(placement.offsetY) * scale;
    assert.equal(right, display.position.x + display.size.width);
    assert.equal(top, display.position.y + 28 * scale);
  }
});

test('unnamed or duplicate monitors use backend-sorted zero-based indices', () => {
  const primary = monitor(0, 0, 1920, 1080, 1, null);
  const left = monitor(-1920, 0, 1920, 1080, 1, null);
  const placement = popupPlacement(primary, [primary, left], primary.position,
    { left: 200, width: 20, bottom: 28 }, { width: 328, height: 376 });
  assert.deepEqual(placement.monitorSelection, { type: 'index', match: 1 });
  assert.throws(() => popupPlacement(primary, [left], primary.position,
    { left: 0, width: 20, bottom: 28 }, { width: 328, height: 376 }), /no longer connected/);
});

test('short clock and status buttons anchor popups below the full bar height', async () => {
  const env = await harness({ triggerBottom: 24, barHeight: 28 });
  const bar = await env.bar('bar-1');
  for (const type of ['calendar', 'network']) {
    bar.click(type);
    await env.settle();
    assert.equal(parseFloat(env.placements.at(-1).offsetY), 28);
    assert.equal(env.state().layout.rect.bottom, 28, 'Resizing must preserve the full bar anchor.');
  }
  assert.deepEqual(env.errors, []);
});

test('calendar has six Monday-first weeks including leap day and year transitions', () => {
  const days = calendarDays(2024, 1);
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 1);
  assert.equal(dateKey(days[0]), '2024-01-29');
  assert(days.some(date => dateKey(date) === '2024-02-29'));
  assert.equal(dateKey(calendarDays(2026, 0)[0]), '2025-12-29');
  assert.equal(dateKey(shiftMonth(new Date(2024, 0, 31, 12), 1)), '2024-02-29');
  assert.equal(dateKey(shiftMonth(new Date(2025, 0, 31, 12), 1)), '2025-02-28');
  assert.equal(dateKey(shiftMonth(new Date(2024, 1, 29, 12), 12)), '2025-02-28');
});

async function loadController(context, mocks) {
  const source = await readFile(new URL('../widgets/shared/popup-controller.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async specifier => {
    const dependencies = {
      './popup-model.mjs': { popupPlacement, popupSizes },
      './popup-sizing.mjs': { attachPopupSizing },
      './popup-session.mjs': { waitForPopupSessionEnd: async () => {} },
      './popup-dismissal.mjs': { createOutsideClickWatcher, spawnOutsideClickProcess },
      'https://esm.sh/@tauri-apps/api@2.0.2/core': { invoke: async () => { throw new Error('Unexpected native command'); } },
      'https://esm.sh/@tauri-apps/api@2.0.2/dpi': {
        LogicalSize: class { constructor(width, height) { Object.assign(this, { width, height }); } },
        PhysicalPosition: class { constructor(x, y) { Object.assign(this, { x, y }); } },
      },
    };
    const exports = mocks[specifier] ?? dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

async function harness({ startError = null, warmError = null, holdWarm = false, reopenError = null,
  locksAvailable = true, triggerBottom = 28, barHeight = 28,
  monitors = [monitor(0, 0, 1920, 1080)],
} = {}) {
  const values = new Map();
  const listeners = new Map();
  let nativeWindows = [];
  let queue = Promise.resolve();
  let startCount = 0;
  let requestCount = 0;
  let finishWarmup;
  let helperStartCount = 0;
  const placements = [];
  const errors = [];
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const locks = {
    request: (_, action) => {
      const result = queue.then(action);
      queue = result.catch(() => {});
      return result;
    },
  };
  async function bar(id) {
    const window = new EventTarget();
    const document = new EventTarget();
    document.documentElement = { clientHeight: barHeight };
    let mouseOutput;
    let helperStopped = false;
    let helperPid;
    const commands = [];
    const context = vm.createContext({
      console, Event, window, document, localStorage: storage,
      navigator: { locks: locksAvailable ? locks : undefined },
      crypto: { randomUUID: () => `request-${id}-${++requestCount}` },
      setTimeout, clearTimeout,
    });
    const mocks = {
      'https://esm.sh/zebar@3.3.1': {
        currentWidget: () => ({
          id, packId: 'my-bar',
          tauriWindow: { innerPosition: async () => ({ x: 0, y: 0 }) },
        }),
        shellSpawn: async (program, args) => {
          assert.equal(program, 'powershell.exe');
          assert.deepEqual(Array.from(args), Array.from(outsideClickArgs));
          helperStartCount++;
          helperPid = 1000 + helperStartCount;
          return {
            processId: helperPid,
            onStdout: callback => {
              mouseOutput = callback;
              setImmediate(() => callback('ready'));
            },
            onStderr() {},
            onExit() {},
            write: async () => { throw new Error('Broken Zebar processId wrapper used for write.'); },
            kill: async () => { throw new Error('Broken Zebar processId wrapper used for kill.'); },
          };
        },
        startWidget: async (_, placement) => {
          const pendingRequest = JSON.parse(storage.getItem('my-bar:popup:my-bar'));
          if (pendingRequest.phase === 'warming') {
            assert(!commands.some(command => command.startsWith('arm:')), 'Background startup must not arm outside-click detection.');
            assert.equal(placement.width, '1px');
            assert.equal(placement.height, '1px');
            const target = monitors[0];
            const x = target.position.x + parseFloat(placement.offsetX) * target.scaleFactor;
            const y = target.position.y + parseFloat(placement.offsetY) * target.scaleFactor;
            assert(x > Math.max(...monitors.map(item => item.position.x + item.size.width)), 'Warm outside the entire virtual desktop.');
            assert(y > Math.max(...monitors.map(item => item.position.y + item.size.height)));
            if (warmError) throw warmError;
          } else {
            assert.equal(commands.at(-1), `arm:${pendingRequest.requestId}\n`, 'Native detection must be armed before creating the popup.');
          }
          if (startError) throw startError;
          placements.push(placement);
          startCount++;
          const label = `popup-${startCount}`;
          const nativeWindow = {
            label, visible: pendingRequest.phase !== 'warming',
            title: async () => 'Zebar - my-bar / popup',
            hide: async () => { nativeWindow.visible = false; },
            show: async () => { nativeWindow.visible = true; },
            close: async () => {
              nativeWindows = nativeWindows.filter(item => item.label !== label);
            },
          };
          nativeWindows.push(nativeWindow);
          storage.setItem('my-bar:popup:my-bar:window', label);
          const request = JSON.parse(storage.getItem('my-bar:popup:my-bar'));
          const ready = () => {
            for (const callback of listeners.values()) callback({ payload: { ...request, popupId: label } });
          };
          if (holdWarm && request.phase === 'warming') finishWarmup = ready;
          else ready();
        },
      },
      'https://esm.sh/@tauri-apps/api@2.0.2/window': {
        getAllWindows: async () => nativeWindows,
        currentMonitor: async () => monitors[0],
        availableMonitors: async () => monitors,
      },
      'https://esm.sh/@tauri-apps/api@2.0.2/event': {
        listen: async (_, callback) => {
          listeners.set(id, callback);
          return () => listeners.delete(id);
        },
        emit: async (event, payload) => {
          assert.equal(event, 'my-bar:popup-open');
          if (reopenError) throw reopenError;
          const nativeWindow = nativeWindows.find(item => item.label === payload.popupId);
          assert(nativeWindow);
          const layout = payload.layout;
          placements.push(popupPlacement(layout.monitor, layout.monitors, layout.barPosition,
            layout.rect, { width: layout.width, height: layout.maxHeight }));
          await nativeWindow.show();
          for (const callback of listeners.values()) callback({ payload });
        },
      },
    };
    mocks['https://esm.sh/@tauri-apps/api@2.0.2/core'] = {
      invoke: async (command, args) => {
        assert.equal(args.pid, helperPid, 'Backend requires pid, not processId.');
        assert(!Object.hasOwn(args, 'processId'));
        if (command === 'shell_write') {
          commands.push(args.buffer);
          if (args.buffer.startsWith('arm:')) mouseOutput(`armed:${args.buffer.slice(4).trim()}`);
        } else if (command === 'shell_kill') {
          helperStopped = true;
        } else {
          throw new Error(`Unexpected native command: ${command}`);
        }
      },
    };
    const controller = await loadController(context, mocks);
    const triggers = Object.keys(popupSizes).map(type => {
      const trigger = new EventTarget();
      trigger.getBoundingClientRect = () => ({ left: 940, width: 40, bottom: triggerBottom });
      trigger.attributes = {};
      const classes = new Set();
      trigger.classList = {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name),
      };
      trigger.setAttribute = (name, value) => { trigger.attributes[name] = value; };
      trigger.contains = target => target === trigger;
      return { trigger, type };
    });
    controller.attachPopupTriggers(triggers, error => errors.push(error), () => {});
    const findTrigger = (type = 'calendar') => triggers.find(item => item.type === type).trigger;
    return {
      click(type) {
        const event = new Event('click');
        event.detail = 0;
        findTrigger(type).dispatchEvent(event);
      },
      pointerDown(type) {
        const event = new Event('pointerdown');
        event.button = 0;
        Object.defineProperty(event, 'target', { value: findTrigger(type) });
        document.dispatchEvent(event);
      },
      mouseClick(type) {
        const event = new Event('click');
        event.detail = 1;
        findTrigger(type).dispatchEvent(event);
      },
      hover(type) { findTrigger(type).dispatchEvent(new Event('pointermove')); },
      leave(type) { findTrigger(type).dispatchEvent(new Event('pointerleave')); },
      blur() { window.dispatchEvent(new Event('blur')); },
      outsideClick(requestId = JSON.parse(storage.getItem('my-bar:popup:my-bar')).requestId) {
        mouseOutput(`outside:${requestId}`);
      },
      pagehide() { window.dispatchEvent(new Event('pagehide')); },
      get helperStopped() { return helperStopped; },
      hovered: type => findTrigger(type).classList.contains('is-hovered'),
      expanded: type => findTrigger(type).attributes['aria-expanded'],
      dismiss: controller.dismissPopup,
      retain: controller.retainPopupDuringInteraction,
    };
  }
  return {
    bar, errors, placements,
    finishWarmup: () => finishWarmup(),
    seedState: state => storage.setItem('my-bar:popup:my-bar', JSON.stringify(state)),
    get nativeWindows() { return nativeWindows.filter(item => item.visible); },
    get allWindows() { return nativeWindows; },
    async destroyCachedWindow() { await nativeWindows[0].close(); },
    get startCount() { return startCount; },
    get helperStartCount() { return helperStartCount; },
    state: () => JSON.parse(storage.getItem('my-bar:popup:my-bar')),
    async settle() {
      await new Promise(resolve => setImmediate(resolve));
      await queue;
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('bar startup preloads exactly one hidden popup across monitors before the first click', async () => {
  const env = await harness({ monitors: [
    monitor(-2560, -300, 2560, 1440, 1.5, 'left'),
    monitor(0, 400, 3840, 2160, 2, 'right'),
  ] });
  const first = await env.bar('bar-1');
  await env.bar('bar-2');
  await env.settle();
  assert.equal(env.startCount, 1);
  assert.equal(env.allWindows.length, 1);
  assert.equal(env.nativeWindows.length, 0);
  assert.equal(env.state(), null);
  for (const type of Object.keys(popupSizes)) assert.equal(first.expanded(type), 'false');
  first.click('calendar');
  await env.settle();
  assert.equal(env.startCount, 1, 'The first real click must reuse the startup WebView.');
  assert.equal(env.nativeWindows.length, 1);
  assert.deepEqual(env.errors, []);
  await env.bar('bar-3');
  await env.settle();
  assert.equal(env.state().type, 'calendar', 'A late-loading bar must not hide an active popup.');
  assert.equal(env.startCount, 1);
});

test('startup recovers persisted active state from a previous Zebar process', async () => {
  const env = await harness();
  env.seedState({ phase: 'open', type: 'calendar', packId: 'my-bar', ownerId: 'old-bar', requestId: 'old-request' });
  const bar = await env.bar('bar-1');
  await env.settle();
  assert.equal(env.state(), null);
  assert.equal(env.startCount, 1);
  assert.equal(env.nativeWindows.length, 0);
  bar.click('calendar');
  await env.settle();
  assert.equal(env.startCount, 1);
  assert.equal(env.state().ownerId, 'bar-1');
  assert.deepEqual(env.errors, []);
});

test('a click during startup waits for prewarming without creating a duplicate or toggling it closed', async () => {
  const env = await harness({ holdWarm: true });
  const bar = await env.bar('bar-1');
  for (let attempt = 0; attempt < 30 && !env.startCount; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.startCount, 1);
  assert.equal(env.state().phase, 'warming');
  bar.pointerDown('calendar');
  bar.mouseClick('calendar');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.nativeWindows.length, 0);
  env.finishWarmup();
  await env.settle();
  assert.equal(env.startCount, 1);
  assert.equal(env.state().phase, 'open');
  assert.equal(env.state().type, 'calendar');
  assert.deepEqual(env.errors, []);
});

test('failed background prewarming leaves no active state and the first click can retry', async () => {
  const env = await harness({ warmError: new Error('Background startup failed') });
  const bar = await env.bar('bar-1');
  await env.settle();
  assert.equal(env.state(), null);
  assert.equal(env.allWindows.length, 0);
  assert.deepEqual(env.errors, [], 'Background failure is not a user-action error.');
  bar.click('audio');
  await env.settle();
  assert.equal(env.state().phase, 'open');
  assert.equal(env.state().type, 'audio');
  assert.equal(env.nativeWindows.length, 1);
  assert.deepEqual(env.errors, []);
});

test('same icon toggles, other monitor replaces, stale close cannot close replacement', async () => {
  const env = await harness();
  const first = await env.bar('bar-1');
  const second = await env.bar('bar-2');
  first.click();
  await env.settle();
  const original = env.state();
  assert.equal(env.nativeWindows.length, 1);
  second.click();
  await env.settle();
  assert.equal(env.nativeWindows.length, 1);
  assert.equal(env.state().ownerId, 'bar-2');
  await first.dismiss(original.requestId);
  assert.equal(env.nativeWindows.length, 1);
  second.click();
  await env.settle();
  assert.equal(env.nativeWindows.length, 0);
  assert.equal(env.state(), null);
  assert.deepEqual(env.errors, []);
});

test('switching popup types preserves one window, dimensions, and trigger-specific expanded state', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  for (const type of Object.keys(popupSizes)) {
    bar.pointerDown(type);
    bar.mouseClick(type);
    await env.settle();
    assert.equal(env.nativeWindows.length, 1);
    assert.equal(env.state().type, type);
    assert.equal(env.placements.at(-1).width, `${popupSizes[type].width}px`);
    assert.equal(env.placements.at(-1).height, `${popupSizes[type].height}px`);
    for (const other of Object.keys(popupSizes)) {
      assert.equal(bar.expanded(other), String(other === type));
    }
  }
  assert.equal(env.startCount, 1, 'Changing types reuses the native WebView.');
  assert.deepEqual(env.errors, []);
});

test('concurrent monitor clicks are serialized without duplicate windows', async () => {
  const env = await harness();
  const first = await env.bar('bar-1');
  const second = await env.bar('bar-2');
  first.click();
  second.click();
  await env.settle();
  assert.equal(env.nativeWindows.length, 1);
  assert.equal(env.state().ownerId, 'bar-2');
  assert.equal(env.startCount, 1);
  assert.deepEqual(env.errors, []);
});

test('start errors and missing Web Locks are surfaced, never reported as open', async () => {
  for (const options of [
    { startError: new Error('Native start failed') },
    { locksAvailable: false },
  ]) {
    const env = await harness(options);
    const first = await env.bar('bar-1');
    first.click();
    await env.settle();
    assert.equal(env.errors.length, 1);
    assert.equal(env.nativeWindows.length, 0);
    assert.equal(env.state(), null);
  }
});

test('mouse activation waits for click, and toggle intent survives blur before click', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  bar.pointerDown();
  await env.settle();
  assert.equal(env.startCount, 1, 'Startup creates a hidden window, but pointerdown must not show it.');
  assert.equal(env.nativeWindows.length, 0);
  bar.mouseClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 1);
  bar.pointerDown();
  await bar.dismiss(env.state().requestId);
  bar.mouseClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 0);
  assert.equal(env.startCount, 1, 'Release of the closing click must not reopen the popup.');
  assert.deepEqual(env.errors, []);
});

test('trigger hover clears on activation and focus loss without a pointerleave', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  bar.hover('audio');
  assert.equal(bar.hovered('audio'), true);
  bar.pointerDown('audio');
  bar.mouseClick('audio');
  await env.settle();
  assert.equal(bar.hovered('audio'), false);
  assert.equal(bar.expanded('audio'), 'true');
  await bar.dismiss(env.state().requestId);
  assert.equal(bar.expanded('audio'), 'false');
  assert.equal(bar.hovered('audio'), false);
  bar.hover('audio');
  assert.equal(bar.hovered('audio'), true, 'Fresh pointer movement restores hover.');
  bar.blur();
  assert.equal(bar.hovered('audio'), false);
  bar.hover('audio');
  bar.leave('audio');
  assert.equal(bar.hovered('audio'), false);
  assert.deepEqual(env.errors, []);
});

async function popupHarness(initiallyFocused = false, type = 'calendar', layoutOverrides = {}, initialPhase = 'opening') {
  const request = {
    requestId: 'request-1', ownerId: 'bar-1', packId: 'my-bar',
    type, phase: initialPhase,
    layout: {
      monitor: monitor(-2560, -200, 2560, 1440, 1.5),
      monitors: [monitor(-2560, -200, 2560, 1440, 1.5)],
      barPosition: { x: -2560, y: -200 },
      rect: { left: 400, width: 40, bottom: 28 },
      width: 328, maxHeight: 376,
      ...layoutOverrides,
    },
  };
  let state = JSON.stringify(request);
  let focused = initiallyFocused;
  let focusHandler;
  let closed = false;
  let visible = true;
  let cachedId = null;
  let openHandler;
  const renders = [];
  const errors = [];
  const messages = [];
  const window = new EventTarget();
  const document = new EventTarget();
  document.getElementById = () => new EventTarget();
  const lifecycle = [];
  document.documentElement = {
    style: { setProperty() {} },
    setAttribute(name, value) {
      assert.equal(name, 'data-popup-ready');
      assert.equal(value, 'true');
      lifecycle.push('visible');
    },
    removeAttribute(name) { assert.equal(name, 'data-popup-ready'); },
  };
  document.querySelector = () => ({ getBoundingClientRect: () => ({ height: 300 }) });
  const sizes = [];
  const positions = [];
  const nativeWindow = {
    label: 'popup-1',
    title: async () => 'Zebar - my-bar / popup',
    isFocused: async () => focused,
    show: async () => { visible = true; lifecycle.push('show'); },
    hide: async () => {
      visible = false;
    },
    setFocus: async () => { throw new Error('window.set_focus not allowed by ACL'); },
    setSize: async size => { sizes.push(size); lifecycle.push('size'); },
    setPosition: async position => {
      assert(Number.isInteger(position.x), 'Tauri physical x must be an i32.');
      assert(Number.isInteger(position.y), 'Tauri physical y must be an i32.');
      positions.push(position);
      lifecycle.push('position');
    },
    close: async () => {
      assert.equal(state, null, 'Expanded state must be cleared before destroying the popup WebView.');
      closed = true;
    },
    onFocusChanged: async handler => {
      focusHandler = handler;
      return () => {};
    },
  };
  const context = vm.createContext({
    console, Event, window, document, setTimeout, clearTimeout,
    ResizeObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => {
      assert(visible, 'Do not wait for animation frames while the native WebView is hidden.');
      return setImmediate(() => { lifecycle.push('frame'); callback(); });
    },
    navigator: { locks: { request: (_, action) => Promise.resolve().then(action) } },
    localStorage: {
      getItem: key => key.endsWith(':window') ? cachedId : state,
      setItem: (key, value) => { if (key.endsWith(':window')) cachedId = value; else state = value; },
      removeItem: key => { if (key.endsWith(':window')) cachedId = null; else state = null; },
    },
  });
  const controller = await loadController(context, {
    'https://esm.sh/zebar@3.3.1': {
      currentWidget: () => ({ id: 'popup-1', packId: 'my-bar', tauriWindow: nativeWindow }),
      shellSpawn: async () => { throw new Error('Popups must reuse the bar helper, never spawn PowerShell.'); },
    },
    'https://esm.sh/@tauri-apps/api@2.0.2/window': {
      getAllWindows: async () => closed ? [] : [nativeWindow],
      currentMonitor: async () => null,
      availableMonitors: async () => [],
    },
    'https://esm.sh/@tauri-apps/api@2.0.2/event': {
      listen: async (event, callback) => {
        assert.equal(event, 'my-bar:popup-open');
        openHandler = callback;
        return () => { openHandler = null; };
      },
      emit: async (_, payload) => { messages.push(payload); lifecycle.push('ready'); },
    },
  });
  await controller.initialisePopup(type => { renders.push(type); }, error => errors.push(error));
  return {
    errors, messages, sizes, positions, lifecycle, renders,
    window, document,
    state: () => state ? JSON.parse(state) : null,
    async reopen(type = 'calendar', layout = {}) {
      const next = { ...request, type, phase: 'opening', requestId: `request-${messages.length + 1}`,
        layout: { ...request.layout, ...layout } };
      state = JSON.stringify(next);
      openHandler({ payload: { ...next, popupId: 'popup-1' } });
      for (let attempt = 0; attempt < 50 && messages.at(-1)?.requestId !== next.requestId; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.equal(messages.at(-1)?.requestId, next.requestId, 'Reopening must acknowledge the new request.');
    },
    retain: controller.retainPopupDuringInteraction,
    dismiss: () => controller.dismissPopup(state ? JSON.parse(state).requestId : null),
    get closed() { return !visible; },
    get destroyed() { return closed; },
    async focus(value) {
      focused = value;
      await focusHandler({ payload: value });
    },
    async staleBlur() { await focusHandler({ payload: false }); },
    pagehide() { window.dispatchEvent(new Event('pagehide')); },
    async webviewBlur(value = false) {
      focused = value;
      window.dispatchEvent(new Event('blur'));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('prewarm initialisation hides the native window without rendering, showing, focusing or waiting for frames', async () => {
  const popup = await popupHarness(false, 'calendar', {}, 'warming');
  assert.equal(popup.closed, true);
  assert.deepEqual(popup.renders, []);
  assert.deepEqual(popup.lifecycle, ['ready']);
  assert.equal(popup.messages[0].popupId, 'popup-1');
  assert.equal(popup.sizes.length, 0);
  assert.equal(popup.positions.length, 0);
  await popup.reopen('audio');
  assert.equal(popup.closed, false);
  assert.deepEqual(popup.renders, ['audio']);
  assert.deepEqual(popup.errors, []);
});

test('network client/MFA focus loss retains the popup until the operation ends', async () => {
  const popup = await popupHarness(true, 'network');
  const release = popup.retain();
  await popup.focus(false);
  await popup.webviewBlur();
  assert.equal(popup.closed, false);
  release();
  await popup.focus(true);
  await popup.focus(false);
  assert.equal(popup.closed, true);
  assert.deepEqual(popup.errors, []);
});

test('explicit dismissal bypasses retention and expired retention cannot trap the popup', async () => {
  const explicit = await popupHarness(true, 'network');
  explicit.retain();
  await explicit.dismiss();
  assert.equal(explicit.closed, true);
  const expired = await popupHarness(true, 'network');
  expired.retain(-1);
  await expired.focus(false);
  assert.equal(expired.closed, true);
});

test('retained MFA outside clicks rearm native detection; normal outside dismissal resumes afterward', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  bar.click('network');
  await env.settle();
  const release = bar.retain();
  bar.outsideClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 1);
  bar.outsideClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 1);
  assert.equal(env.helperStartCount, 1);
  release();
  bar.outsideClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 0);
  assert.deepEqual(env.errors, []);
});

test('retention releases only its original request and never suppresses other popup types', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  bar.click('network');
  await env.settle();
  const releaseOld = bar.retain();
  bar.click('audio');
  await env.settle();
  releaseOld();
  assert.equal(env.state().type, 'audio');
  bar.retain();
  bar.outsideClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 0);
  assert.deepEqual(env.errors, []);
});

test('initially unfocused popup ignores startup blur and closes only after real focus loss', async () => {
  const popup = await popupHarness();
  assert.equal(popup.closed, false, 'Initial negative focus snapshot must not dismiss the popup.');
  assert.equal(popup.messages[0].popupId, 'popup-1');
  assert.equal(popup.sizes[0].width, 328);
  assert.equal(popup.sizes[1].height, 304, 'Native height follows the measured content plus border/padding.');
  assert.equal(popup.positions[0].x, -2176);
  assert.equal(popup.positions[0].y, -158, 'Resizing preserves the bar anchor at mixed DPI.');
  await popup.focus(false);
  assert.equal(popup.closed, false, 'Startup blur before activation must not dismiss the popup.');
  await popup.focus(true);
  await popup.staleBlur();
  assert.equal(popup.closed, false, 'Stale blur must not close a currently focused popup.');
  await popup.focus(false);
  assert.equal(popup.closed, true, 'Actual focus loss after activation must still dismiss.');
  assert.deepEqual(popup.errors, []);
});

test('native positioning rounds fractional physical coordinates at mixed DPI', async () => {
  for (const scale of [1.25, 1.5, 1.75]) {
    const display = monitor(-2560, -200, 2560, 1440, scale);
    const rect = { left: 400.5, width: 40, bottom: 28.5 };
    const popup = await popupHarness(false, 'calendar', {
      monitor: display, monitors: [display], rect,
    });
    assert.equal(popup.positions[0].x, Math.round(-2560 + (420.5 - 164) * scale));
    assert.equal(popup.positions[0].y, Math.round(-200 + 28.5 * scale));
    assert.deepEqual(popup.errors, []);
  }
});

test('popup stays transparent until native sizing and the resized frame are ready', async () => {
  const popup = await popupHarness();
  assert.deepEqual(popup.lifecycle, ['position', 'size', 'size', 'position', 'show', 'frame', 'frame', 'visible', 'ready']);
  const html = await readFile(new URL('../widgets/popup/index.html', import.meta.url), 'utf8');
  const initialBody = html.match(/\n      body \{([\s\S]*?)\n      \}/)?.[1];
  assert.match(initialBody, /background: transparent/);
  assert.match(initialBody, /border: 1px solid transparent/);
  assert.match(initialBody, /opacity: 0/);
  assert.match(initialBody, /pointer-events: none/);
  assert.match(html, /html\[data-popup-ready='true'\] body/);
  assert.deepEqual(popup.errors, []);
});

test('prewarmed bar helper closes on the first outside click and is reused until bar teardown', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  await env.settle();
  assert.equal(env.helperStartCount, 1, 'Prewarm when the bar loads, not when opening a popup.');
  bar.click();
  await env.settle();
  const firstRequest = env.state().requestId;
  bar.outsideClick();
  await env.settle();
  assert.equal(env.nativeWindows.length, 0, 'No preparatory click inside the popup should be necessary.');
  assert.equal(bar.helperStopped, false, 'Closing a popup must not kill its reusable helper.');
  bar.click('audio');
  await env.settle();
  bar.outsideClick(firstRequest);
  await env.settle();
  assert.equal(env.nativeWindows.length, 1, 'A late outside click cannot close the replacement popup.');
  assert.equal(env.helperStartCount, 1, 'Opening another popup must not launch PowerShell again.');
  bar.pagehide();
  await env.settle();
  assert.equal(bar.helperStopped, true, 'Closing the bar must stop its helper.');
  assert.deepEqual(env.errors, []);
});

test('WebView blur dismisses when the native focus-loss notification is missing', async () => {
  const popup = await popupHarness(true);
  await popup.webviewBlur(true);
  assert.equal(popup.closed, false, 'A WebView blur must not dismiss a still-focused native window.');
  await popup.webviewBlur();
  assert.equal(popup.closed, true);
  assert.deepEqual(popup.errors, []);
});

test('positive startup focus snapshot arms outside-click dismissal', async () => {
  const popup = await popupHarness(true);
  assert.equal(popup.closed, false);
  await popup.focus(false);
  assert.equal(popup.closed, true);
  assert.deepEqual(popup.errors, []);
});

test('closing and reopening uses the same native window, including after changing type or owner', async () => {
  const env = await harness();
  const first = await env.bar('bar-1');
  const second = await env.bar('bar-2');
  first.click('calendar');
  await env.settle();
  const original = env.state();
  await first.dismiss(original.requestId);
  assert.equal(env.nativeWindows.length, 0);
  assert.equal(env.allWindows.length, 1, 'Dismiss hides, it does not destroy the WebView.');
  second.click('network');
  await env.settle();
  assert.equal(env.startCount, 1);
  assert.equal(env.state().popupId, original.popupId);
  assert.notEqual(env.state().requestId, original.requestId);
  assert.equal(env.state().ownerId, 'bar-2');
  second.click('network');
  await env.settle();
  first.click('calendar');
  await env.settle();
  assert.equal(env.startCount, 1);
  assert.equal(env.nativeWindows.length, 1);
  assert.deepEqual(env.errors, []);
});

test('a destroyed cached WebView is recreated instead of waiting on a stale label', async () => {
  const env = await harness();
  const bar = await env.bar('bar-1');
  bar.click();
  await env.settle();
  await bar.dismiss(env.state().requestId);
  await env.destroyCachedWindow();
  bar.click('audio');
  await env.settle();
  assert.equal(env.startCount, 2);
  assert.equal(env.nativeWindows.length, 1);
  assert.equal(env.state().type, 'audio');
  assert.deepEqual(env.errors, []);
});

test('failed reuse destroys the broken cache and a later click creates a fresh WebView', async () => {
  const env = await harness({ reopenError: new Error('Popup listener unavailable') });
  const bar = await env.bar('bar-1');
  await env.settle(); // The startup cache exists without a preceding click.
  bar.click('audio');
  await env.settle();
  assert.equal(env.errors.length, 1);
  assert.equal(env.state(), null);
  assert.equal(env.allWindows.length, 0);
  bar.click('audio');
  await env.settle();
  assert.equal(env.startCount, 2);
  assert.equal(env.state().type, 'audio');
});

test('a reused popup disposes each session and renders a fresh request at its new monitor DPI', async () => {
  const popup = await popupHarness(true);
  let ended = 0;
  popup.window.addEventListener('popup-session-end', () => { ended++; });
  await popup.dismiss();
  assert.equal(ended, 1);
  assert.equal(popup.destroyed, false);
  const display = monitor(1920, 0, 2560, 1440, 2);
  await popup.reopen('network', {
    monitor: display, monitors: [display], barPosition: display.position,
    rect: { left: 400, width: 40, bottom: 28 }, width: 380, maxHeight: 500,
  });
  assert.equal(popup.closed, false);
  assert.equal(popup.sizes.at(-1).width, 380);
  assert.equal(popup.positions.at(-1).x, 2380);
  assert.equal(popup.positions.at(-1).y, 56);
  assert.deepEqual(popup.renders, ['calendar', 'network']);
  assert.equal(popup.messages.at(-1).requestId, 'request-2');
  await popup.dismiss();
  assert.equal(ended, 2);
  await popup.reopen('audio');
  assert.deepEqual(popup.renders, ['calendar', 'network', 'audio']);
  assert.equal(popup.destroyed, false);
  assert.deepEqual(popup.errors, []);
});
