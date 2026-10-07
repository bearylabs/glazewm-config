import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { popupSizes } from '../widgets/shared/popup-model.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const edge = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

const mocks = `
  const listeners = [];
  const data = {
    date: { now: '2026-10-07T10:58:00', formatted: '10:58' },
    glazewm: {
      currentWorkspaces: [
        { name: '1', displayName: 'One', hasFocus: true, children: [] },
        { name: '2', hasFocus: false, children: [{}] },
      ],
      bindingModes: [{ name: 'resize' }], isPaused: true, tilingDirection: 'horizontal',
      runCommand: command => calls.push(['wm', command]),
    },
    audio: { defaultPlaybackDevice: { deviceId: 'speakers', name: 'Speakers', volume: 42, isMuted: false } },
    network: {
      defaultInterface: { name: 'GlobalProtect', type: 'tunnel', ipv4Addresses: ['172.16.0.2'] },
      defaultGateway: { ssid: '<script>bad</script>', signalStrength: 75 },
      interfaces: [{
        name: 'Wi-Fi', type: 'wifi', friendlyName: 'Wireless',
        ipv4Addresses: ['192.168.1.2/24'], ipv6Addresses: ['fe80::1234'], receiveSpeed: 1e9,
      }],
    },
    battery: null,
    cpu: { vendor: 'Test CPU', usage: 38, frequency: 3200, physicalCoreCount: 4, logicalCoreCount: 8 },
    memory: { usedMemory: 4 * 1024 ** 3, totalMemory: 16 * 1024 ** 3, usage: 25 },
    disk: { disks: [
      { mountPoint: 'C:', name: 'System', totalSpace: { bytes: 100 * 1024 ** 3 }, availableSpace: { bytes: 20 * 1024 ** 3 } },
      { mountPoint: 'D:', name: 'Data', totalSpace: { bytes: 200 * 1024 ** 3 }, availableSpace: { bytes: 100 * 1024 ** 3 } },
    ] },
  };
  data.audio.playbackDevices = [data.audio.defaultPlaybackDevice,
    { deviceId: '{0.0.0.00000000}.{12345678-1234-1234-1234-123456789abc}', name: 'Headphones (Jabra)', volume: 27, isMuted: false },
  ];
  const calls = [];
  const errors = {};
  const notify = () => listeners.forEach(fn => fn());
  window.__test = { data, calls, errors, notify, failAudio: false };
  data.audio.setVolume = async (volume, options) => {
    if (window.__test.failAudio) throw new Error('Volume command failed');
    calls.push(['volume', volume, options]);
    data.audio.defaultPlaybackDevice.volume = volume;
    notify();
  };
  data.audio.setMute = async (muted, options) => {
    calls.push(['mute', muted, options]);
    data.audio.defaultPlaybackDevice.isMuted = muted;
    notify();
  };
  export function createProviderGroup(config) {
    const select = source => Object.fromEntries(Object.keys(config).map(key => [key, source[key] ?? null]));
    return {
      get outputMap() { return select(data); },
      get errorMap() { return select(errors); },
      onOutput(fn) { listeners.push(() => fn(select(data))); queueMicrotask(() => fn(select(data))); },
      onError(fn) { listeners.push(() => fn(select(errors))); },
      stopAll: async () => {},
    };
  }
  export async function shellExec(program, args) {
    if (program === 'powershell.exe' && args[3]?.includes('[AudioOutput]::Select')) {
      calls.push(['output-device', program, args]);
      if (window.__test.failDeviceSwitch) return { code: 1, stderr: 'Device switch failed' };
      data.audio.defaultPlaybackDevice = data.audio.playbackDevices[1];
      notify();
      return { code: 0 };
    }
    if (program === 'powershell.exe' && args[3]?.includes('GlobalProtectButton')) {
      const action = args[3].match(/\\$action = '([^']+)'/)[1];
      calls.push(['globalprotect', action]);
      if (window.__test.failGlobalProtect) return { code: 1, stderr: 'GlobalProtect button unavailable' };
      if (action !== 'status') return { code: 0, stdout: JSON.stringify({ requested: action }) };
      return { code: 0, stdout: JSON.stringify(window.__test.globalprotect ?? { available: true, connected: false }) };
    }
    if (program === 'powershell.exe' && args[3]?.includes('class BluetoothMenu')) {
      calls.push(['bluetooth', program, args]);
      if (window.__test.holdBluetoothScan && args[3].includes('::Read($true)')) {
        return await new Promise(resolve => { window.__test.resolveBluetoothScan = snapshot => resolve({ code: 0, stdout: JSON.stringify(snapshot) }); });
      }
      if (window.__test.holdBluetoothStatus && args[3].includes('::Read($false)')) {
        return await new Promise(resolve => { window.__test.resolveBluetoothStatus = snapshot => resolve({ code: 0, stdout: JSON.stringify(snapshot) }); });
      }
      if (window.__test.failBluetooth) return { code: 1, stderr: 'Bluetooth access denied' };
      return { code: 0, stdout: JSON.stringify(window.__test.bluetooth ?? {
        available: true, enabled: true, devices: [
          { id: 'connected', name: 'Headset', paired: true, connected: true },
          { id: 'paired', name: 'Keyboard', paired: true, connected: false },
          { id: 'available', name: 'Mouse', paired: false, connected: false },
        ],
      }) };
    }
    if (program === 'powershell.exe') return {
      code: 0, stdout: JSON.stringify(window.__test.powerStatus ?? { ac: 'Online', charge: 0.8, battery: 'High' }),
    };
    calls.push(['shell', program, args]); return { code: 0 };
  }
  export async function availableMonitors() {
    if (window.__test.monitors) return window.__test.monitors;
    return [
      { name: 'Left', position: { x: -2560, y: -200 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.5 },
      { name: 'Main', position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    ];
  }
  export async function currentMonitor() { return (await availableMonitors())[0]; }
`;

const controllerMock = `
  import { attachPopupSizing } from './popup-sizing.mjs';
  export function retainPopupDuringInteraction() {
    window.__test.retained = true;
    return () => { window.__test.retained = false; };
  }
  export async function initialisePopup(render, reportError) {
    try {
      const maxHeight = innerHeight;
      document.documentElement.style.setProperty('--popup-max-height', maxHeight + 'px');
      await render(new URL(location.href).searchParams.get('type') ?? 'calendar');
      window.__popupHeights = [];
      await attachPopupSizing({
        main: document.querySelector('main'), maxHeight, Observer: ResizeObserver, reportError,
        resize: async height => { window.__popupHeights.push(height); },
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.documentElement.setAttribute('data-popup-ready', 'true');
      window.__ready = true;
    } catch (error) { reportError(error); }
  }
  export function attachPopupTriggers(triggers) {
    window.__triggers = triggers.map(item => item.type);
  }
`;

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('Browser connection closed.'));
    pending.clear();
  });
  return {
    close: () => socket.close(),
    call(method, params = {}) {
      return new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

test('real Edge renders bar and all popup controls using mocked native APIs', { timeout: 60000 }, async t => {
  try {
    await access(edge);
  } catch {
    t.skip('Set EDGE_PATH to a local Edge executable to run browser coverage.');
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), 'zebar-popup-test-'));
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const relative = decodeURIComponent(url.pathname).replaceAll('/', path.sep);
      const filename = path.resolve(root, `.${relative}`);
      if (!filename.startsWith(root)) throw new Error('Invalid test path');
      let source;
      if (url.pathname === '/__mocks.mjs') source = mocks;
      else if (url.pathname.endsWith('/popup-controller.mjs')) source = controllerMock;
      else source = await readFile(filename, 'utf8');
      if (url.pathname === '/widgets/bar/index.html') {
        source = source.replace('const powerTimer = setInterval(refreshPower, 10000);',
          'window.__refreshPower = refreshPower; const powerTimer = setInterval(refreshPower, 10000);');
      }
      if (url.pathname === '/widgets/popup/globalprotect.mjs') {
        source = source.replace('const interval = setInterval', 'window.__refreshGlobalProtect = refresh; const interval = setInterval');
      }
      if (url.pathname === '/widgets/popup/bluetooth.mjs') {
        source = source.replace('const statusTimer = setInterval', 'window.__refreshBluetoothStatus = () => run("status"); const statusTimer = setInterval');
      }
      source = source.replaceAll('https://esm.sh/zebar@3.3.1', '/__mocks.mjs')
        .replaceAll('https://esm.sh/@tauri-apps/api@2.0.2/window', '/__mocks.mjs');
      response.setHeader('Content-Type', url.pathname.endsWith('.html') ? 'text/html' : 'text/javascript');
      response.end(source);
    } catch (error) {
      response.writeHead(404).end(error.message);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = spawn(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let client;
  let browserClient;
  try {
    let port;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await pause(100);
      }
    }
    assert(port, 'Edge must expose a debugging endpoint');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    browserClient = await cdp(version.webSocketDebuggerUrl);
    client = await cdp(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    const evaluate = async expression => {
      const result = await client.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    let loadSequence = 0;
    async function load(type, width = popupSizes[type]?.width ?? 1920, height = popupSizes[type]?.height ?? 28) {
      await client.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      const url = `http://127.0.0.1:${server.address().port}/widgets/${type === 'bar' ? 'bar' : 'popup'}/index.html?type=${type}&load=${++loadSequence}`;
      await client.call('Page.navigate', { url });
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        ready = await evaluate(`location.href === ${JSON.stringify(url)} && Boolean(window.${type === 'bar' ? '__triggers' : '__ready'})`);
        if (ready) break;
        await pause(25);
      }
      assert(ready, `${type} must initialize without module errors`);
    }
    const click = text => evaluate(`[...document.querySelectorAll('#system-content button')].find(node => node.textContent === ${JSON.stringify(text)}).click()`);
    await t.test('bar keeps exact clock center and existing workspace behavior', async () => {
      await load('bar');
      const result = await evaluate(`(() => {
        const clock = document.querySelector('.zone--center').getBoundingClientRect();
        document.querySelector('[data-name="2"]').click();
        return {
          center: clock.left + clock.width / 2, viewport: innerWidth,
          clock: document.getElementById('time').textContent,
          triggers: window.__triggers, workspaces: [...document.querySelectorAll('.workspace')].map(node => node.textContent),
          modes: document.getElementById('modes').textContent,
          bg: getComputedStyle(document.body).backgroundColor,
          calls: window.__test.calls, oldStats: Boolean(document.getElementById('cpu')),
        };
      })()`);
      assert(Math.abs(result.center - result.viewport / 2) < 0.5);
      assert.match(result.clock, /10:58/);
      assert(result.clock.length > 5, 'Omarchy weekday belongs in clock');
      assert.deepEqual(result.triggers, ['calendar', 'bluetooth', 'network', 'audio', 'display', 'power']);
      assert.deepEqual(result.workspaces, ['One', '2']);
      assert.equal(result.modes, 'pauseresize');
      assert.equal(result.bg, 'rgb(36, 39, 58)');
      assert.deepEqual(result.calls, [['wm', 'focus --workspace 2']]);
      assert.equal(result.oldStats, false);
    });
    await t.test('bar uses consistent filled icons and keeps status variants', async () => {
      await load('bar');
      assert(await evaluate(`(() => {
        const icons = [...document.querySelectorAll('.status svg, .split svg')];
        return icons.length === 9 && icons.every(icon =>
          icon.getAttribute('fill') === 'currentColor' && !icon.hasAttribute('stroke') &&
          icon.getAttribute('aria-hidden') === 'true' && getComputedStyle(icon).width === '16px');
      })()`));
      await evaluate('window.__test.data.audio.defaultPlaybackDevice.isMuted = true; window.__test.notify()');
      assert(await evaluate(`getComputedStyle(document.querySelector('.vol__muted')).display !== 'none' &&
        getComputedStyle(document.querySelector('.vol__on')).display === 'none'`));
      await evaluate('window.__test.data.network = null; window.__test.notify()');
      assert(await evaluate(`getComputedStyle(document.querySelector('.net__none')).display !== 'none' &&
        getComputedStyle(document.querySelector('.net__wifi')).display === 'none'`));
    });
    await t.test('battery icon shows AC, low, mid, full and unavailable status', async () => {
      await load('bar');
      assert.equal(await evaluate("document.getElementById('power-trigger').dataset.state"), 'ac');
      // The test server exposes the real polling callback without a ten-second wait.
      for (const [ac, charge, battery, expected] of [
        ['Offline', 0, 'Critical', 'low'], ['Offline', 0.2, 'Low', 'low'],
        ['Offline', 0.21, 'High', 'mid'], ['Offline', 0.79, 'High', 'mid'],
        ['Offline', 0.8, 'High', 'full'], ['Offline', 1, 'High', 'full'],
        ['Online', 0.15, 'Charging', 'ac'], ['Online', 1, 'High', 'ac'],
        ['Online', -1, 'NoSystemBattery', 'ac'], ['Unknown', -1, 'Unknown', 'unknown'],
      ]) {
        await evaluate(`window.__test.powerStatus = ${JSON.stringify({ ac, charge, battery })}; window.__refreshPower()`);
        const result = await evaluate(`(() => {
          const icon = document.getElementById('power-trigger');
          return { state: icon.dataset.state, title: icon.title,
            fill: Number(icon.querySelector('.battery__fill').getAttribute('height')),
            fillY: Number(icon.querySelector('.battery__fill').getAttribute('y')),
            bolt: getComputedStyle(icon.querySelector('.battery__bolt')).display !== 'none' };
        })()`);
        assert.equal(result.state, expected);
        assert.equal(result.bolt, ac === 'Online');
        if (charge >= 0) {
          assert(Math.abs(result.fill - 14 * charge) < 0.01);
          assert(Math.abs(result.fillY + result.fill - 20) < 0.01);
        }
        if (ac === 'Online') assert.match(result.title, /Am Netz/);
      }
    });
    await t.test('left icon keeps showing and toggling tiling direction during fullscreen', async () => {
      await load('bar');
      for (const direction of ['horizontal', 'vertical']) {
        const result = await evaluate(`(() => {
          window.__test.data.glazewm.focusedContainer = { state: { type: 'fullscreen' } };
          window.__test.data.glazewm.tilingDirection = ${JSON.stringify(direction)};
          window.__test.notify();
          const split = document.getElementById('split');
          split.click();
          return {
            direction: split.dataset.direction,
            title: split.title,
            visible: [...split.querySelectorAll('svg')]
              .filter(icon => getComputedStyle(icon).display !== 'none')
              .map(icon => icon.getAttribute('class')),
            fullscreenIcon: Boolean(split.querySelector('.split__fullscreen')),
            command: window.__test.calls.at(-1),
          };
        })()`);
        assert.equal(result.direction, direction);
        assert.equal(result.title, `Next split: ${direction}`);
        assert.deepEqual(result.visible, [`split__${direction}`]);
        assert.equal(result.fullscreenIcon, false);
        assert.deepEqual(result.command, ['wm', 'toggle-tiling-direction']);
      }
    });
    await t.test('popup height follows rendered content rather than filling the viewport', async () => {
      for (const type of ['calendar', 'audio', 'network', 'bluetooth', 'display', 'power']) {
        await load(type);
        const result = await evaluate(`({
          height: window.__popupHeights.at(-1),
          content: Math.ceil(document.querySelector('main').getBoundingClientRect().height + 4),
          maximum: innerHeight,
        })`);
        assert.equal(await evaluate('getComputedStyle(document.body).opacity'), '1');
        assert.equal(result.height, Math.min(result.content, result.maximum));
        assert(result.height <= popupSizes[type].height);
        if (type === 'audio') assert(result.height < popupSizes.audio.height);
      }
      await load('network');
      const fullHeight = await evaluate('window.__popupHeights.at(-1)');
      await evaluate('window.__test.data.network = null; window.__test.notify()');
      await pause(100);
      const compactHeight = await evaluate('window.__popupHeights.at(-1)');
      assert(compactHeight < fullHeight, 'Missing network details must not leave a large empty panel.');
      await load('display');
      await evaluate('window.__test.monitors = [{ name: "Main", position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }]');
      await click('Refresh displays');
      await pause(100);
      assert(await evaluate('window.__popupHeights.at(-1) < innerHeight'), 'A single display should not fill the maximum height.');
    });
    await t.test('Bluetooth groups devices, pairs via native calls and reports failures', async () => {
      await load('bluetooth');
      await pause(100);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.bluetooth-section h2')].map(el => el.textContent)"), ['Connected', 'Paired', 'Available']);
      assert.equal(await evaluate("document.querySelector('.audio-switch').getAttribute('aria-checked')"), 'true');
      await evaluate("document.querySelector('[data-action=pair]').click()");
      await pause(100);
      assert(await evaluate("window.__test.calls.some(call => call[0] === 'bluetooth' && call[2][3].includes(\"::Act('pair'\"))"));
      await evaluate("window.__test.failBluetooth = true; document.querySelector('.bluetooth-scan').click()");
      await pause(100);
      assert(await evaluate("document.querySelector('#bluetooth-status').textContent.includes('Bluetooth access denied')"));
      assert.equal(await evaluate("document.querySelector('#bluetooth-status').getAttribute('role')"), 'alert');
      assert.equal(await evaluate("document.querySelector('#popup-error').hidden"), true, 'Device errors should not appear twice.');
      await evaluate("document.querySelector('#bluetooth-settings').click()");
      await pause(50);
      assert.deepEqual(await evaluate('window.__test.calls.at(-1)'), ['shell', 'explorer.exe', ['ms-settings:bluetooth']]);
    });
    await t.test('Bluetooth scans leave paired controls mounted and usable; late scans cannot undo an action', async () => {
      await load('bluetooth');
      await pause(100);
      await evaluate(`(() => {
        window.__pairedBefore = document.querySelector('[data-device-id="paired"][data-action="connect"]');
        window.__test.holdBluetoothScan = true;
        document.querySelector('.bluetooth-scan').click();
      })()`);
      await pause(50);
      assert.equal(await evaluate('window.__pairedBefore.disabled'), false);
      assert.equal(await evaluate('window.__pairedBefore.isConnected'), true);
      assert.equal(await evaluate("document.querySelector('.audio-switch').disabled"), false);
      assert.equal(await evaluate("document.querySelector('#system-content').getAttribute('aria-busy')"), 'false');
      await evaluate(`(() => {
        window.__test.bluetooth = { available: true, enabled: true, devices: [
          { id: 'paired', name: 'Keyboard', paired: true, connected: true },
        ] };
        window.__pairedBefore.click();
      })()`);
      await pause(100);
      assert(await evaluate("window.__test.calls.some(call => call[0] === 'bluetooth' && call[2][3].includes(\"::Act('connect'\"))"));
      await evaluate(`window.__test.resolveBluetoothScan({ available: true, enabled: true, devices: [
        { id: 'paired', name: 'Keyboard', paired: true, connected: false },
        { id: 'stale', name: 'Stale scan result', paired: false, connected: false },
      ] })`);
      await pause(100);
      assert.equal(await evaluate('window.__pairedBefore.isConnected'), true);
      assert.equal(await evaluate('window.__pairedBefore.dataset.action'), 'disconnect');
      assert.equal(await evaluate("document.querySelector('[data-device-id=stale]') === null"), true);
      assert.equal(await evaluate('window.__pairedBefore.disabled'), false);
    });
    await t.test('Bluetooth status refresh updates paired rows without disabling them or replacing nearby devices', async () => {
      await load('bluetooth');
      await pause(100);
      await evaluate(`(() => {
        window.__pairedBefore = document.querySelector('[data-device-id="paired"][data-action="connect"]');
        window.__test.holdBluetoothStatus = true;
        void window.__refreshBluetoothStatus();
      })()`);
      await pause(50);
      assert.equal(await evaluate('window.__pairedBefore.disabled'), false);
      assert.equal(await evaluate("document.querySelector('#system-content').getAttribute('aria-busy')"), 'false');
      await evaluate(`window.__test.resolveBluetoothStatus({ available: true, enabled: true, devices: [
        { id: 'connected', name: 'Headset', paired: true, connected: true },
        { id: 'paired', name: 'Keyboard', paired: true, connected: true },
      ] })`);
      await pause(100);
      assert.equal(await evaluate('window.__pairedBefore.isConnected'), true);
      assert.equal(await evaluate('window.__pairedBefore.dataset.action'), 'disconnect');
      assert.equal(await evaluate("document.querySelector('[data-device-id=available]').disabled"), false);
      assert.equal(await evaluate("document.querySelector('[data-device-id=available] .bluetooth-name').textContent"), 'Mouse');
      await evaluate('window.__test.holdBluetoothStatus = false');
    });
    await t.test('calendar still fits and supports keyboard month navigation', async () => {
      await load('calendar');
      assert.deepEqual(await evaluate(`({
        days: document.querySelectorAll('#calendar-days button').length,
        tabs: document.querySelectorAll('#calendar-days button[tabindex="0"]').length,
        fits: document.body.scrollHeight <= innerHeight,
      })`), { days: 42, tabs: 1, fits: true });
      assert.deepEqual(await evaluate(`({
        square: getComputedStyle(document.body).borderRadius,
        border: getComputedStyle(document.body).borderTopWidth,
        weeks: document.querySelectorAll('#calendar-days .calendar-week').length,
        hero: Boolean(document.querySelector('#calendar-icon svg')) && document.getElementById('hero-date').textContent.length > 0,
        bottomNav: document.querySelector('header').getBoundingClientRect().top >= document.querySelector('table').getBoundingClientRect().bottom,
      })`), { square: '0px', border: '2px', weeks: 6, hero: true, bottomNav: true });
      const hero = await evaluate("document.getElementById('hero-date').textContent");
      const progress = await evaluate("document.getElementById('year-percent').textContent");
      const previous = await evaluate('document.activeElement.dataset.date');
      await client.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'PageDown', code: 'PageDown' });
      const next = await evaluate('document.activeElement.dataset.date');
      assert.notEqual(next, previous);
      assert.equal(await evaluate("document.getElementById('hero-date').textContent"), hero);
      assert.equal(await evaluate("document.getElementById('year-percent').textContent"), progress);
      await evaluate("document.getElementById('today').click()");
      assert.equal(await evaluate('document.activeElement.dataset.date'), previous);
      for (const [width, height] of [[560, 440], [328, 300], [280, 240]]) {
        await load('calendar', width, height);
        assert.deepEqual(await evaluate(`(() => {
          const content = document.getElementById('calendar-content');
          const bounds = document.querySelector('main').getBoundingClientRect();
          const days = [...document.querySelectorAll('#calendar-days button')];
          const controls = ['today', 'previous-month', 'next-month'].map(id => document.getElementById(id));
          return {
            noScroll: content.scrollHeight <= content.clientHeight && content.scrollWidth <= content.clientWidth,
            fullyVisible: [...days, ...controls].every(node => {
              const rect = node.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth;
            }),
            fits: bounds.bottom <= innerHeight && bounds.right <= innerWidth,
            days: days.length,
          };
        })()`), { noScroll: true, fullyVisible: true, fits: true, days: 42 });
      }
    });
    await t.test('audio slider and mute send provider commands and reflect external updates', async () => {
      await load('audio');
      assert(await evaluate('document.body.scrollHeight <= innerHeight'));
      assert(await evaluate("document.querySelector('.hero__icon svg').getAttribute('fill') === 'currentColor'"));
      await evaluate(`(() => {
        const slider = document.getElementById('volume-slider');
        for (const value of [0, 65, 100]) {
          slider.value = value;
          slider.dispatchEvent(new Event('input'));
        }
      })()`);
      await pause(50);
      assert.deepEqual(await evaluate('window.__test.calls'), [
        ['volume', 0, { deviceId: 'speakers' }],
        ['volume', 65, { deviceId: 'speakers' }],
        ['volume', 100, { deviceId: 'speakers' }],
      ]);
      await evaluate("document.getElementById('audio-mute').click()");
      await pause(25);
      assert(await evaluate(`document.getElementById('audio-mute').getAttribute('aria-label') === 'Unmute' && document.getElementById('audio-mute').getAttribute('aria-checked') === 'false'`));
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'MUTED');
      await evaluate(`window.__test.data.audio.defaultPlaybackDevice.volume = 12; window.__test.notify()`);
      assert.equal(await evaluate("document.getElementById('volume-slider').value"), '12');
      await evaluate(`window.__test.failAudio = true; const slider = document.getElementById('volume-slider'); slider.value = 60; slider.dispatchEvent(new Event('input'))`);
      await pause(25);
      assert.match(await evaluate("document.getElementById('popup-error').textContent"), /Volume command failed/);
      await evaluate(`window.__test.data.audio.defaultPlaybackDevice = null; window.__test.notify()`);
      assert(await evaluate("document.getElementById('volume-slider').disabled"));
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /No default output device/);
    });
    await t.test('audio uses Omarchy hero, flat device rows and foreground slider without duplicate header', async () => {
      await load('audio');
      const result = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        const slider = document.getElementById('volume-slider');
        const hero = document.querySelector('.audio-hero');
        return {
          headerHidden: document.querySelector('header').hidden,
          title: hero.querySelector('.hero__title').textContent,
          meta: hero.querySelector('.hero__meta').textContent,
          labelledBy: document.querySelector('main').getAttribute('aria-labelledby'),
          font: getComputedStyle(document.body).fontFamily,
          padding: getComputedStyle(panel).padding,
          radius: getComputedStyle(document.body).borderRadius,
          switchRole: document.getElementById('audio-mute').getAttribute('role'),
          switchOn: document.getElementById('audio-mute').getAttribute('aria-checked'),
          progress: slider.style.getPropertyValue('--audio-progress'),
          cards: panel.querySelectorAll('.card').length,
          dropdown: Boolean(document.getElementById('audio-device-toggle')),
          order: [...panel.children].map(node => node.className),
        };
      })()`);
      assert.equal(result.headerHidden, true);
      assert.equal(result.title, 'Audio');
      assert.equal(result.meta, 'EASY LISTENING');
      assert.equal(result.labelledBy, 'audio-title');
      assert.match(result.font, /JetBrainsMono/);
      assert.equal(result.padding, '14px');
      assert.equal(result.radius, '0px');
      assert.equal(result.switchRole, 'switch');
      assert.equal(result.switchOn, 'true');
      assert.equal(result.progress, '42%');
      assert.equal(result.cards, 0);
      assert.equal(result.dropdown, false);
      assert.deepEqual(result.order.slice(0, 4), ['hero audio-hero', 'audio-separator', 'audio-control', 'audio-devices']);
      if (process.env.AUDIO_SCREENSHOT_PATH) {
        const height = await evaluate('window.__popupHeights.at(-1)');
        const { data } = await client.call('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: popupSizes.audio.width, height, scale: 1 },
        });
        await writeFile(process.env.AUDIO_SCREENSHOT_PATH, Buffer.from(data, 'base64'));
      }
      await evaluate(`window.__test.data.audio.playbackDevices = Array.from({ length: 30 }, (_, i) => ({
        deviceId: 'test-' + i, name: 'Very long output device name '.repeat(10), volume: 42, isMuted: false,
      })); window.__test.notify()`);
      const overflow = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        panel.scrollTop = panel.scrollHeight;
        return { body: document.body.scrollHeight, height: innerHeight, scroll: panel.scrollTop,
          width: panel.scrollWidth, clientWidth: panel.clientWidth };
      })()`);
      assert(overflow.body <= overflow.height && overflow.scroll > 0 && overflow.width <= overflow.clientWidth,
        JSON.stringify(overflow));
    });
    await t.test('output devices switch Windows defaults and follow external changes and hotplug', async () => {
      await load('audio');
      assert.equal(await evaluate("document.querySelectorAll('.audio-device').length"), 2);
      assert.equal(await evaluate("document.querySelector('.audio-device[aria-pressed=true]').textContent"), 'Speakers');
      assert.equal(await evaluate("document.getElementById('audio-devices').hidden"), false);
      await click('Headphones (Jabra)');
      await pause(50);
      assert.equal(await evaluate("document.querySelector('.audio-device[aria-pressed=true] .audio-device__name').textContent"), 'Headphones (Jabra)');
      assert.equal(await evaluate("document.getElementById('volume-slider').value"), '27');
      assert.equal(await evaluate('window.__test.calls[0][0]'), 'output-device');
      assert.equal(await evaluate("document.getElementById('audio-devices').hidden"), false);
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'MURMUR');
      await evaluate("document.getElementById('audio-mute').click()");
      await pause(25);
      await evaluate('window.__test.data.audio.defaultPlaybackDevice = window.__test.data.audio.playbackDevices[0]; window.__test.notify()');
      assert.equal(await evaluate("document.querySelector('.audio-device[aria-pressed=true] .audio-device__name').textContent"), 'Speakers');
      await evaluate('window.__test.failDeviceSwitch = true');
      await click('Headphones (Jabra)');
      await pause(50);
      assert.match(await evaluate("document.getElementById('popup-error').textContent"), /Device switch failed/);
      assert.equal(await evaluate("document.querySelector('.audio-device[aria-pressed=true] .audio-device__name').textContent"), 'Speakers');
      await evaluate('window.__test.data.audio.playbackDevices.pop(); window.__test.notify()');
      assert.equal(await evaluate("document.querySelectorAll('.audio-device').length"), 1);
      await evaluate('window.__test.data.audio.playbackDevices = []; window.__test.data.audio.defaultPlaybackDevice = null; window.__test.notify()');
      assert.equal(await evaluate("document.querySelectorAll('.audio-device').length"), 0);
      assert(await evaluate("document.getElementById('audio-mute').disabled"));
      assert.match(await evaluate("document.querySelector('.audio-status').textContent"), /No default output device/);
    });
    await t.test('network uses Omarchy hero and flat details without fabricated controls or metrics', async () => {
      await load('network');
      const result = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        const hero = panel.querySelector('.network-hero');
        return {
          headerHidden: document.querySelector('header').hidden,
          title: hero.querySelector('.hero__title').textContent,
          meta: hero.querySelector('.hero__meta').textContent,
          labelledBy: document.querySelector('main').getAttribute('aria-labelledby'),
          font: getComputedStyle(document.body).fontFamily,
          padding: getComputedStyle(panel).padding,
          radius: getComputedStyle(document.body).borderRadius,
          sections: [...panel.querySelectorAll('h2')].map(node => node.textContent),
          flat: panel.querySelectorAll('.card, .stat, .badge, .details-grid').length === 0,
          controls: panel.querySelectorAll('button, input').length,
          vpn: panel.querySelector('.network-section__state').textContent,
          fits: panel.scrollWidth <= panel.clientWidth && document.body.scrollHeight <= innerHeight,
        };
      })()`);
      assert.equal(result.headerHidden, true);
      assert.equal(result.title, '<script>bad</script> (75%)');
      assert.equal(result.meta, 'WI-FI CONNECTION');
      assert.equal(result.labelledBy, 'network-title');
      assert.match(result.font, /JetBrainsMono/);
      assert.equal(result.padding, '14px');
      assert.equal(result.radius, '0px');
      assert.deepEqual(result.sections, ['Connection', 'Addresses', 'Company VPN', 'GlobalProtect']);
      assert.equal(result.flat, true);
      assert.equal(result.controls, 2);
      assert.equal(result.vpn, 'VPN active');
      assert.equal(result.fits, true);
      if (process.env.NETWORK_SCREENSHOT_PATH) {
        await evaluate(`window.__test.data.network.defaultGateway.ssid = 'Office Wi-Fi'; window.__test.notify()`);
        await pause(50);
        const height = await evaluate('window.__popupHeights.at(-1)');
        const { data } = await client.call('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: popupSizes.network.width, height, scale: 1 },
        });
        await writeFile(process.env.NETWORK_SCREENSHOT_PATH, Buffer.from(data, 'base64'));
      }
      await evaluate(`window.__test.data.network = {
        defaultInterface: { name: 'Ethernet adapter', type: 'ethernet', receiveSpeed: 2.5e9,
          ipv4Addresses: ['10.0.0.2'], ipv6Addresses: [] },
      }; window.__test.notify()`);
      assert.equal(await evaluate("document.getElementById('network-title').textContent"), 'Ethernet (2.5 Gb/s)');
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'ETHERNET CONNECTION');
      assert.equal(await evaluate("document.querySelectorAll('.network-section').length"), 3);
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /Physical default route/);
      await evaluate(`window.__test.data.network = { defaultInterface: null, interfaces: [] }; window.__test.notify()`);
      assert.equal(await evaluate("document.getElementById('network-title').textContent"), 'No physical connection');
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'NOT CONNECTED');
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /Unavailable/);
      await evaluate(`window.__test.data.network = { defaultInterface: {
        name: 'Adapter '.repeat(40), type: 'wifi', ipv4Addresses: ['10.0.0.2'],
        ipv6Addresses: Array.from({ length: 40 }, (_, i) => '2001:db8::' + i),
      } }; window.__test.notify()`);
      assert.equal(await evaluate("document.querySelector('.hero__title').textContent.includes('%')"), false);
      const overflow = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        panel.scrollTop = panel.scrollHeight;
        return { body: document.body.scrollHeight, height: innerHeight, scroll: panel.scrollTop,
          width: panel.scrollWidth, clientWidth: panel.clientWidth };
      })()`);
      assert(overflow.body <= overflow.height && overflow.scroll > 0 && overflow.width <= overflow.clientWidth,
        JSON.stringify(overflow));
    });
    await t.test('GlobalProtect keeps controls mounted, waits for MFA, and confirms state independently of the route', async () => {
      await load('network');
      await evaluate('window.__refreshGlobalProtect()');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').textContent"), 'Connect');
      await evaluate("document.getElementById('globalprotect-toggle').click()");
      await pause(30);
      assert.equal(await evaluate("document.querySelector('.network-vpn [role=status]').textContent"), 'Connecting…');
      assert(await evaluate("document.getElementById('globalprotect-toggle').disabled"));
      assert(await evaluate('window.__test.retained'));
      assert.match(await evaluate("document.querySelector('.network-vpn .note').textContent"), /MFA/);
      await evaluate(`window.__test.globalprotect = { available: true, connected: true };
        window.__test.data.network.defaultInterface = window.__test.data.network.interfaces[0];
        window.__test.notify(); window.__refreshGlobalProtect()`);
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').textContent"), 'Disconnect');
      assert.equal(await evaluate('window.__test.retained'), false);
      await evaluate("document.getElementById('globalprotect-toggle').click()");
      await pause(30);
      assert.equal(await evaluate("document.querySelector('.network-vpn [role=status]').textContent"), 'Disconnecting…');
      assert(await evaluate('window.__test.retained'));
      await evaluate('window.__test.globalprotect.connected = false; window.__refreshGlobalProtect()');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').textContent"), 'Connect');
      await evaluate('window.__test.failGlobalProtect = true; document.getElementById("globalprotect-toggle").click()');
      await pause(30);
      assert.match(await evaluate("document.getElementById('popup-error').textContent"), /button unavailable/);
      assert(await evaluate("document.getElementById('globalprotect-toggle').disabled"));
      await evaluate('window.__test.failGlobalProtect = false; window.__refreshGlobalProtect()');
      await evaluate("document.getElementById('globalprotect-open').click()");
      await pause(30);
      assert.deepEqual(await evaluate("window.__test.calls.filter(c => c[0] === 'globalprotect' && c[1] !== 'status')"),
        [['globalprotect', 'connect'], ['globalprotect', 'disconnect'], ['globalprotect', 'connect'], ['globalprotect', 'open']]);
      await evaluate('window.__test.globalprotect.available = false; window.__refreshGlobalProtect()');
      assert(await evaluate("document.getElementById('globalprotect-toggle').disabled"));
    });
    await t.test('network shows existing VPN heuristic and treats device text as text', async () => {
      await load('network');
      const text = await evaluate("document.getElementById('system-content').textContent");
      assert(await evaluate('document.body.scrollHeight <= innerHeight'));
      for (const value of ['Wi-Fi', 'Wireless', '192.168.1.2/24', 'fe80::1234', '172.16.0.2', 'GlobalProtect', 'split tunnels', '<script>bad</script>']) {
        assert(text.includes(value), value);
      }
      assert.equal(await evaluate("document.querySelector('#system-content script') !== null"), false);
      await evaluate(`window.__test.data.network = null; window.__test.errors.network = 'Access denied'; window.__test.notify()`);
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /Access denied/);
    });
    await t.test('display uses Omarchy hero, scale section and flat current-monitor rows', async () => {
      await load('display');
      const result = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        return {
          headerHidden: document.querySelector('header').hidden,
          title: document.getElementById('display-title').textContent,
          meta: panel.querySelector('.hero__meta').textContent,
          labelledBy: document.querySelector('main').getAttribute('aria-labelledby'),
          font: getComputedStyle(document.body).fontFamily,
          padding: getComputedStyle(panel).padding,
          radius: getComputedStyle(document.body).borderRadius,
          sections: [...panel.querySelectorAll('h2')].map(node => node.textContent),
          scale: panel.querySelector('.display-scale__value').textContent,
          current: panel.querySelector('.display-row--current h3').textContent,
          selectedFill: getComputedStyle(panel.querySelector('.display-row--current .display-row__heading')).backgroundColor,
          flat: panel.querySelectorAll('.card, .badge, .display-preview, .details-grid').length === 0,
          buttons: [...panel.querySelectorAll('button')].map(node => node.id),
          inputs: panel.querySelectorAll('input').length,
          busy: document.getElementById('display-refresh').disabled,
        };
      })()`);
      assert.equal(result.headerHidden, true);
      assert.equal(result.title, 'Display');
      assert.equal(result.meta, 'READ-ONLY OVERVIEW');
      assert.equal(result.labelledBy, 'display-title');
      assert.match(result.font, /JetBrainsMono/);
      assert.equal(result.padding, '14px');
      assert.equal(result.radius, '0px');
      assert.deepEqual(result.sections, ['Scale', 'Displays']);
      assert.equal(result.scale, '150%');
      assert.equal(result.current, 'Left');
      assert.notEqual(result.selectedFill, 'rgba(0, 0, 0, 0)');
      assert.equal(result.flat, true);
      assert.deepEqual(result.buttons, ['display-refresh']);
      assert.equal(result.inputs, 0);
      assert.equal(result.busy, false);
      if (process.env.DISPLAY_SCREENSHOT_PATH) {
        const height = await evaluate('window.__popupHeights.at(-1)');
        const { data } = await client.call('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: popupSizes.display.width, height, scale: 1 },
        });
        await writeFile(process.env.DISPLAY_SCREENSHOT_PATH, Buffer.from(data, 'base64'));
      }
      await evaluate(`window.__test.monitors = [];`);
      await click('Refresh displays');
      assert.equal(await evaluate("document.getElementById('display-title').textContent"), 'Display');
      assert.match(await evaluate("document.getElementById('popup-error').textContent"), /No connected displays/);
      assert.equal(await evaluate("document.getElementById('display-refresh').disabled"), false);
      await evaluate(`window.__test.monitors = [{ name: null, position: { x: -100, y: -200 },
        size: { width: 1080, height: 1920 }, scaleFactor: 1.25 }];`);
      await click('Refresh displays');
      assert.equal(await evaluate("document.querySelector('.display-scale__value').textContent"), '125%');
      assert.equal(await evaluate("document.querySelector('.display-row h3').textContent"), 'Display 1');
      assert.equal(await evaluate("document.querySelector('.display-section__meta').textContent"), '1 connected display');
    });
    await t.test('display shows negative coordinates and mixed scaling without settings controls', async () => {
      await load('display');
      const text = await evaluate("document.getElementById('system-content').textContent");
      for (const value of ['Display', '2 connected displays', 'This bar', 'Left', '2560 x 1440', '150%', '-2560, -200', 'Main', '100%']) {
        assert(text.includes(value), value);
      }
      assert.equal(await evaluate("document.querySelectorAll('#system-content input').length"), 0);
      assert.equal(await evaluate("document.querySelectorAll('.display-row').length"), 2);
      assert.equal(await evaluate("document.querySelectorAll('.display-row--current').length"), 1);
      assert(await evaluate('document.body.scrollHeight <= innerHeight'));
      await evaluate(`window.__test.monitors = Array.from({ length: 6 }, (_, index) => ({
        name: index === 0 ? '<script>display</script>' : null,
        position: { x: -1080 * index, y: -200 },
        size: { width: 1080, height: 1920 }, scaleFactor: 1.5,
      }))`);
      await click('Refresh displays');
      await pause(25);
      assert.equal(await evaluate("document.querySelectorAll('.display-row').length"), 6);
      assert.equal(await evaluate("[...document.querySelectorAll('.display-details dd')].filter(node => node.textContent === 'Portrait').length"), 6);
      assert.equal(await evaluate("document.querySelector('#system-content script') !== null"), false);
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /Display 6/);
      assert(await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        panel.scrollTop = panel.scrollHeight;
        return document.body.scrollHeight <= innerHeight && panel.scrollTop > 0 &&
          panel.scrollWidth <= panel.clientWidth;
      })()`));
    });
    await t.test('battery uses Omarchy hero, charge bar and flat stats while preserving unavailable states', async () => {
      await load('power');
      assert.equal(await evaluate("document.getElementById('power-title').textContent"), 'Battery');
      assert.equal(await evaluate("document.querySelector('.hero__value').textContent"), '—');
      assert.equal(await evaluate("document.querySelector('.battery-progress') === null"), true);
      await evaluate(`window.__test.data.battery = { chargePercent: 72, healthPercent: 91,
        isCharging: true, state: 'charging' }; window.__test.notify()`);
      const result = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        const progress = panel.querySelector('.battery-progress');
        return {
          headerHidden: document.querySelector('header').hidden,
          labelledBy: document.querySelector('main').getAttribute('aria-labelledby'),
          title: document.getElementById('power-title').textContent,
          meta: panel.querySelector('.hero__meta').textContent,
          value: panel.querySelector('.hero__value').textContent,
          font: getComputedStyle(document.body).fontFamily,
          padding: getComputedStyle(panel).padding,
          radius: getComputedStyle(document.body).borderRadius,
          height: getComputedStyle(progress).height,
          progress: progress.getAttribute('aria-valuenow'),
          fill: progress.firstChild.style.width,
          charging: progress.dataset.charging,
          iconFill: Number(panel.querySelector('.battery__fill').getAttribute('height')),
          flat: panel.querySelectorAll('.card, .stat, .badge, .details-grid').length === 0,
          sections: [...panel.querySelectorAll('h2')].map(node => node.textContent),
          buttonRadius: getComputedStyle(panel.querySelector('.controls button')).borderRadius,
          calls: window.__test.calls,
        };
      })()`);
      assert.equal(result.headerHidden, true);
      assert.equal(result.labelledBy, 'power-title');
      assert.equal(result.title, 'Battery');
      assert.equal(result.meta, 'CHARGING');
      assert.equal(result.value, '72%');
      assert.match(result.font, /JetBrainsMono/);
      assert.equal(result.padding, '14px');
      assert.equal(result.radius, '0px');
      assert.equal(result.height, '8px');
      assert.equal(result.progress, '72');
      assert.equal(result.fill, '72%');
      assert.equal(result.charging, 'true');
      assert(Math.abs(result.iconFill - 14 * 0.72) < 0.01);
      assert.equal(result.flat, true);
      assert.deepEqual(result.sections, ['System', 'Drives', 'Session']);
      assert.equal(result.buttonRadius, '0px');
      assert.deepEqual(result.calls, []);
      await client.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.battery-progress > span')).animationName"), 'none');
      await client.call('Emulation.setEmulatedMedia', { features: [] });
      if (process.env.BATTERY_SCREENSHOT_PATH) {
        await pause(50);
        const height = await evaluate('window.__popupHeights.at(-1)');
        const { data } = await client.call('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: popupSizes.power.width, height, scale: 1 },
        });
        await writeFile(process.env.BATTERY_SCREENSHOT_PATH, Buffer.from(data, 'base64'));
      }
      for (const charge of [0, 100]) {
        await evaluate(`window.__test.data.battery = { chargePercent: ${charge}, isCharging: false,
          state: ${JSON.stringify(charge === 100 ? 'FullyCharged' : 'Discharging')} }; window.__test.notify()`);
        assert.equal(await evaluate("document.querySelector('.hero__value').textContent"), charge + '%');
        assert.equal(await evaluate("document.querySelector('.battery-progress > span').style.width"), charge + '%');
        assert.equal(await evaluate("document.querySelector('.battery-progress').dataset.charging"), 'false');
      }
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'FULLY CHARGED');
      for (const value of [null, -1, 101]) {
        await evaluate(`window.__test.data.battery = ${value === null ? 'null' : `{ chargePercent: ${value} }`}; window.__test.notify()`);
        assert.equal(await evaluate("document.querySelector('.hero__value').textContent"), '—');
        assert.equal(await evaluate("document.querySelector('.battery-progress') === null"), true);
      }
      await evaluate(`window.__test.errors.battery = 'Battery unavailable';
        window.__test.data.disk.disks = Array.from({ length: 30 }, () => ({
          mountPoint: 'C:', name: 'Long disk name '.repeat(40), totalSpace: { bytes: 1024 ** 3 },
          availableSpace: { bytes: 512 * 1024 ** 2 },
        })); window.__test.notify()`);
      assert.match(await evaluate("document.querySelector('.power-stats .error').textContent"), /Battery unavailable/);
      const overflow = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        panel.scrollTop = panel.scrollHeight;
        return { body: document.body.scrollHeight, height: innerHeight, scroll: panel.scrollTop,
          width: panel.scrollWidth, clientWidth: panel.clientWidth };
      })()`);
      assert(overflow.body <= overflow.height && overflow.scroll > 0 && overflow.width <= overflow.clientWidth,
        JSON.stringify(overflow));
    });
    await t.test('power preserves confirmation through provider updates and exposes all drives', async () => {
      await load('power');
      let text = await evaluate("document.getElementById('system-content').textContent");
      assert(await evaluate(`document.body.scrollHeight <= innerHeight &&
        getComputedStyle(document.getElementById('system-content')).overflowY === 'auto'`));
      for (const value of ['No battery data', '38%', '4.0 GiB / 16.0 GiB', 'C:', 'D:', '80%', '50%']) {
        assert(text.includes(value), value);
      }
      await click('Shut down');
      assert.equal(await evaluate('window.__test.calls.length'), 0);
      assert.equal(await evaluate("document.getElementById('power-confirmation').hidden"), false);
      assert.equal(await evaluate('document.activeElement.textContent'), 'Cancel');
      await evaluate('window.__test.notify()');
      assert.equal(await evaluate("document.getElementById('power-confirmation').hidden"), false);
      await click('Cancel');
      assert.equal(await evaluate('window.__test.calls.length'), 0);
      await click('Log out');
      await click('Confirm');
      await pause(25);
      assert.deepEqual(await evaluate('window.__test.calls'), [['shell', 'shutdown', ['/l']]]);
      await click('Lock');
      await pause(25);
      assert.deepEqual(await evaluate('window.__test.calls.at(-1)'), ['shell', 'rundll32.exe', ['user32.dll,LockWorkStation']]);
    });
  } finally {
    client?.close();
    if (browserClient) {
      await browserClient.call('Browser.close').catch(() => {});
      browserClient.close();
    }
    if (browser.exitCode === null) {
      await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]);
      if (browser.exitCode === null) browser.kill();
    }
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
