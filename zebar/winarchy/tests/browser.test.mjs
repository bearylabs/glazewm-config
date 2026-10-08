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
  import { createAudioOwner } from '/widgets/shared/audio-bridge.mjs';
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
  const notify = () => {
    listeners.forEach(fn => fn());
    if (document.documentElement.dataset.popupType === 'audio') {
      return new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  window.__test = { data, calls, errors, notify, failAudio: false, providerStops: 0 };
  // Model the persistent bar transport even when testing only the popup page.
  if (location.pathname.includes('/popup/')) {
    const owner = createAudioOwner(() => ({ audio: data.audio, error: errors.audio }));
    listeners.push(() => owner.publish());
    window.addEventListener('pagehide', () => owner.close(), { once: true });
  }
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
  export function currentWidget() {
    return { setZOrder: async order => calls.push(['z-order', order]) };
  }
  export function createProviderGroup(config) {
    if (location.pathname.includes('/popup/') && config.audio) throw new Error('Popup must not own native audio');
    const owned = [];
    window.__test.providerStops ??= 0;
    const register = fn => { owned.push(fn); listeners.push(fn); };
    const select = source => Object.fromEntries(Object.keys(config).map(key => [key, window.__holdNetwork && source === data && key === 'network' ? null : source[key] ?? null]));
    return {
      get outputMap() { return select(data); },
      get errorMap() { return select(errors); },
      onOutput(fn) { register(() => fn(select(data))); queueMicrotask(() => fn(select(data))); },
      onError(fn) { register(() => fn(select(errors))); },
      stopAll: async () => {
        window.__test.providerStops++;
        for (const fn of owned) listeners.splice(listeners.indexOf(fn), 1);
      },
    };
  }
  let nextPid = 1000;
  const queryProcesses = new Map();
  const shellListeners = new Set();
  export async function listen(name, callback) {
    if (name !== 'shell-emit') throw new Error('Unexpected native event: ' + name);
    shellListeners.add(callback);
    return () => shellListeners.delete(callback);
  }
  export async function invoke(command, parameters) {
    if (command === 'shell_spawn') {
      const child = await shellSpawn(parameters.program, parameters.args);
      const emit = event => {
        for (const callback of [...shellListeners]) callback({ payload: { pid: child.processId, event } });
      };
      child.onStdout(data => emit({ type: 'stdout', data }));
      child.onStderr(data => emit({ type: 'stderr', data }));
      child.onExit(data => emit({ type: 'terminated', data }));
      return child.processId;
    }
    const { pid } = parameters;
    if (command !== 'shell_kill') throw new Error('Unexpected native command: ' + command);
    const process = queryProcesses.get(pid);
    if (!process) throw new Error('Unknown process ID');
    if (!process.done) window.__test.queryKills = (window.__test.queryKills ?? 0) + 1;
    process.done = true;
    queryProcesses.delete(pid);
  }
  export async function shellSpawn(program, args) {
    if (program === 'powershell.exe') {
      const handlers = {};
      const pid = nextPid++;
      const process = {
        done: false,
        finish(result) {
          if (process.done) return;
          process.done = true;
          handlers.exit(result);
        },
      };
      queryProcesses.set(pid, process);
      setTimeout(async () => {
        if (window.__test.holdNetworkStats && args[3]?.includes('GetIPv4Statistics')) return;
        try {
          const result = await shellExec(program, args);
          if (process.done) return;
          if (result.stdout) handlers.stdout(result.stdout);
          if (result.stderr) handlers.stderr(result.stderr);
          process.finish({ code: result.code, success: result.code === 0, signal: null });
        } catch (error) {
          if (process.done) return;
          handlers.stderr(error.message);
          process.finish({ code: 1, success: false, signal: null });
        }
      }, 0);
      return {
        processId: pid,
        onStdout: callback => { handlers.stdout = callback; },
        onStderr: callback => { handlers.stderr = callback; },
        onExit: callback => { handlers.exit = callback; },
      };
    }
    calls.push(['shell-spawn', program, args]);
    if (window.__test.failShellSpawn) throw new Error('Process launch failed');
    return { processId: 123 };
  }
  export async function shellExec(program, args) {
    if (window.__holdNetwork && program === 'powershell.exe' && /GlobalProtectButton|GetRadiosAsync|GetIPv4Statistics/.test(args[3] ?? '')) {
      while (window.__holdNetwork) await new Promise(resolve => setTimeout(resolve, 20));
    }
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
    if (program === 'powershell.exe' && args[3]?.includes('$nic.GetIPv4Statistics()')) {
      if (window.__test.failNetworkStats) return { code: 1, stderr: 'Network statistics unavailable' };
      return { code: 0, stdout: JSON.stringify(window.__test.networkStats ?? { id: 'wifi', received: 1410000000, sent: 353000000, gateway: '192.168.1.1', ping: 31 }) };
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
    if (program === 'powershell.exe' && args[3]?.includes('BatteryFullChargedCapacity')) return {
      code: 0, stdout: '38000', stderr: '',
    };
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
  import { waitForPopupSessionEnd } from './popup-session.mjs';
  export function retainPopupDuringInteraction() {
    window.__test.retained = true;
    return () => { window.__test.retained = false; };
  }
  export async function handoffPopupToNative(action) {
    window.__test.nativeHandoffs = (window.__test.nativeHandoffs ?? 0) + 1;
    await action();
  }
  export async function initialisePopup(render, reportError) {
    try {
      const maxHeight = innerHeight;
      document.documentElement.style.setProperty('--popup-max-height', maxHeight + 'px');
      window.__reopenPopup = async type => {
        window.dispatchEvent(new Event('popup-session-end'));
        await waitForPopupSessionEnd();
        await render(type);
      };
      await window.__reopenPopup(new URL(location.href).searchParams.get('type') ?? 'calendar');
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
      if (url.pathname === '/widgets/bar/bar.mjs') {
        source = source.replace('const powerTimer = setInterval(refreshPower, 10000);',
          'window.__refreshPower = refreshPower; const powerTimer = setInterval(refreshPower, 10000);');
      }
      if (url.pathname === '/widgets/popup/globalprotect.mjs') {
        source = source.replace('const interval = setInterval', 'window.__refreshGlobalProtect = refresh; const interval = setInterval');
      }
      if (url.pathname === '/widgets/popup/network.mjs') {
        source = source.replace('const statsTimer = setInterval', 'window.__refreshNetworkStats = updateStats; const statsTimer = setInterval')
          .replace('timeout: 15000', 'timeout: window.__test.networkQueryTimeout ?? 15000');
      }
      if (url.pathname === '/widgets/popup/bluetooth.mjs') {
        source = source.replace('const statusTimer = setInterval', 'window.__refreshBluetoothStatus = () => run("status"); window.__scanBluetooth = () => run("scan"); const statusTimer = setInterval');
      }
      source = source.replaceAll('https://esm.sh/zebar@3.3.1', '/__mocks.mjs')
        .replaceAll('https://esm.sh/@tauri-apps/api@2.0.2/core', '/__mocks.mjs')
        .replaceAll('https://esm.sh/@tauri-apps/api@2.0.2/event', '/__mocks.mjs')
        .replaceAll('https://esm.sh/@tauri-apps/api@2.0.2/window', '/__mocks.mjs');
      response.setHeader('Content-Type', url.pathname.endsWith('.html') ? 'text/html'
        : url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
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
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      if (type === 'audio') {
        for (let attempt = 0; attempt < 100; attempt++) {
          if (await evaluate("!document.getElementById('volume-slider').disabled")) break;
          await pause(10);
        }
        assert(await evaluate("!document.getElementById('volume-slider').disabled"), 'Audio receives the bar snapshot');
        await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      }
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
      assert.deepEqual(result.triggers, ['calendar', 'globalprotect', 'bluetooth', 'network', 'audio', 'display', 'power']);
      assert.deepEqual(result.workspaces, ['One', '2']);
      assert.equal(result.modes, 'pauseresize');
      assert.equal(result.bg, 'rgb(30, 30, 46)');
      assert.deepEqual(result.calls.filter(call => call[0] === 'wm'), [['wm', 'focus --workspace 2']]);
      assert.equal(result.oldStats, false);
    });
    await t.test('GlobalProtect is the first right icon, installed-only and muted when disconnected', async () => {
      await load('bar');
      assert.equal(await evaluate("document.querySelector('.zone--right button').id"), 'globalprotect-trigger');
      for (const vpn of [
        { available: false, connected: false },
        { available: true, connected: false },
        { available: true, connected: true },
      ]) {
        await evaluate(`localStorage.setItem('winarchy.network.vpn.v1', JSON.stringify({ time: Date.now(), value: ${JSON.stringify(vpn)} }));
          window.dispatchEvent(new StorageEvent('storage', { key: 'winarchy.network.vpn.v1' }));
          document.getElementById('globalprotect-trigger').getAnimations().forEach(animation => animation.finish());`);
        assert.equal(await evaluate("document.getElementById('globalprotect-trigger').hidden"), !vpn.available);
        assert.equal(await evaluate("document.getElementById('globalprotect-trigger').classList.contains('is-muted')"), !vpn.connected);
        assert.equal(await evaluate("getComputedStyle(document.querySelector('#globalprotect-trigger .vpn__slash')).display !== 'none'"), !vpn.connected);
        if (vpn.available) assert.notEqual(await evaluate("getComputedStyle(document.getElementById('globalprotect-trigger')).display"), 'none');
      }
      assert.equal(await evaluate("getComputedStyle(document.getElementById('globalprotect-trigger')).color === getComputedStyle(document.getElementById('display-trigger')).color"), true);
    });
    await t.test('native VPN status restores the icon and never recolors the Network icon', async () => {
      await evaluate(`localStorage.setItem('winarchy.network.vpn.v1', JSON.stringify({
        time: Date.now(), value: { available: false, connected: false },
      }));`);
      await load('bar');
      assert.equal(await evaluate("document.getElementById('globalprotect-trigger').hidden"), false,
        'Successful native code:0 status must show the installed VPN client.');
      const color = await evaluate(`(() => {
        const icon = document.getElementById('network-trigger');
        icon.getAnimations().forEach(animation => animation.finish());
        return getComputedStyle(icon).color;
      })()`);
      await evaluate(`window.__test.data.network.defaultInterface = window.__test.data.network.interfaces[0];
        window.__test.notify(); document.getElementById('network-trigger').getAnimations().forEach(animation => animation.finish());`);
      assert.equal(await evaluate("getComputedStyle(document.getElementById('network-trigger')).color"), color);
      await evaluate(`window.__test.data.network.defaultInterface = {
        name: 'GlobalProtect', type: 'tunnel', ipv4Addresses: ['172.16.0.2'],
      }; window.__test.notify(); document.getElementById('network-trigger').getAnimations().forEach(animation => animation.finish());`);
      assert.equal(await evaluate("getComputedStyle(document.getElementById('network-trigger')).color"), color);
      assert.equal(await evaluate("document.getElementById('network-trigger').classList.contains('is-vpn')"), false);
    });
    await t.test('focused workspace uses the same underline as open popups', async () => {
      await load('bar');
      const results = await evaluate(`(() => {
        const trigger = document.getElementById('display-trigger');
        trigger.setAttribute('aria-expanded', 'true');
        const properties = ['content', 'bottom', 'width', 'height', 'backgroundColor', 'transform', 'pointerEvents'];
        const style = node => properties.map(key => getComputedStyle(node, '::after')[key]);
        return ['ws-v1', 'ws-v2', 'ws-v3'].map(variant => {
          document.body.className = variant;
          return { workspace: style(document.querySelector('.workspace.is-focused')),
            popup: style(trigger), inactive: getComputedStyle(document.querySelector('.workspace:not(.is-focused)'), '::after').content };
        });
      })()`);
      for (const result of results) {
        assert.deepEqual(result.workspace, result.popup);
        assert.equal(result.inactive, 'none');
      }
    });
    await t.test('center and right triggers only underline while their popup is open', async () => {
      await load('bar');
      const results = await evaluate(`(() => {
        return [...document.querySelectorAll('.zone--center button, .zone--right button')].map(node => {
          const originalColor = getComputedStyle(node).color;
          node.classList.add('is-hovered');
          const hover = getComputedStyle(node);
          const result = { hoverBackground: hover.backgroundColor, hoverColor: hover.color,
            originalColor, cursor: hover.cursor,
            closedLine: getComputedStyle(node, '::after').content };
          node.setAttribute('aria-expanded', 'true');
          const line = getComputedStyle(node, '::after');
          return { ...result, openBackground: getComputedStyle(node).backgroundColor,
            openColor: getComputedStyle(node).color, openLine: line.content, lineHeight: line.height };
        });
      })()`);
      assert.equal(results.length, 7);
      for (const result of results) {
        assert.equal(result.hoverBackground, 'rgba(0, 0, 0, 0)');
        assert.equal(result.openBackground, 'rgba(0, 0, 0, 0)');
        assert.equal(result.hoverColor, result.originalColor);
        assert.equal(result.openColor, result.originalColor);
        assert.equal(result.cursor, 'pointer');
        assert.equal(result.closedLine, 'none');
        assert.equal(result.openLine, '\"\"');
        assert.equal(result.lineHeight, '2px');
      }
    });
    await t.test('bar uses consistent filled icons and keeps status variants', async () => {
      await load('bar');
      assert(await evaluate(`(() => {
        const icons = [...document.querySelectorAll('.status svg, .split svg')];
        return icons.length === 11 && icons.every(icon =>
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
    await t.test('unchanged provider updates leave tooltip titles and clock nodes untouched', async () => {
      await load('bar');
      const result = await evaluate(`(async () => {
        const changes = [];
        const observer = new MutationObserver(records => {
          changes.push(...records.filter(record =>
            record.attributeName === 'title' || record.target.id === 'time')
            .map(record => record.target.id));
        });
        observer.observe(document.body, { subtree: true, attributes: true, childList: true });
        window.__test.notify();
        window.__test.notify();
        await window.__refreshPower();
        await new Promise(resolve => setTimeout(resolve, 0));
        observer.disconnect();
        return changes;
      })()`);
      assert.deepEqual(result, [], 'Repeated status snapshots must not reset active WebView tooltips.');
      await evaluate(`window.__test.data.audio.defaultPlaybackDevice.volume = 43; window.__test.notify()`);
      assert.match(await evaluate("document.getElementById('audio-trigger').getAttribute('aria-label')"), /43%/);
      assert.deepEqual(await evaluate(`[
        ...document.querySelectorAll('.zone--center [title], .zone--right [title]')
      ].map(node => node.id)`), ['globalprotect-trigger']);
    });
    await t.test('battery icon shows AC, low, mid, full and unavailable status', async () => {
      await load('bar');
      assert.equal(await evaluate("document.getElementById('power-trigger').dataset.state"), 'ac');
      // The test server exposes the real polling callback without a ten-second wait.
      for (const [ac, charge, battery, expected] of [
        ['Offline', 0, 'Critical', 'critical'], ['Offline', 0.2, 'Low', 'low'],
        ['Offline', 0.21, 'High', 'mid'], ['Offline', 0.79, 'High', 'mid'],
        ['Offline', 0.8, 'High', 'full'], ['Offline', 1, 'High', 'full'],
        ['Online', 0.15, 'Charging', 'ac'], ['Online', 1, 'High', 'ac'],
        ['Online', -1, 'NoSystemBattery', 'ac'], ['Unknown', -1, 'Unknown', 'unknown'],
      ]) {
        await evaluate(`window.__test.powerStatus = ${JSON.stringify({ ac, charge, battery })}; window.__refreshPower()`);
        const result = await evaluate(`(() => {
          const icon = document.getElementById('power-trigger');
          return { state: icon.dataset.state, label: icon.getAttribute('aria-label'),
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
        if (ac === 'Online') assert.match(result.label, /Am Netz/);
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
      for (const type of ['calendar', 'audio', 'network', 'globalprotect', 'bluetooth', 'display', 'power']) {
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
      await evaluate("window.__reopenPopup('display')");
      await pause(100);
      assert(await evaluate('window.__popupHeights.at(-1) < innerHeight'), 'A single display should not fill the maximum height.');
    });
    await t.test('Bluetooth groups devices, pairs via native calls and reports failures', async () => {
      await load('bluetooth');
      await pause(100);
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.bluetooth-section h2')].map(el => el.textContent)"), ['Connected', 'Paired', 'Available']);
      assert.equal(await evaluate("document.querySelector('.audio-switch').getAttribute('aria-checked')"), 'true');
      assert.equal(await evaluate("document.querySelector('.bluetooth-scan')"), null);
      assert.equal(await evaluate("document.querySelector('.bluetooth-hero #bluetooth-settings').getAttribute('aria-label')"), 'Open Windows Bluetooth settings');
      assert.equal(await evaluate("document.querySelector('#bluetooth-settings').className"), 'network-vpn__open');
      assert.equal(await evaluate("document.querySelector('#bluetooth-settings path').getAttribute('d')"), 'M6 18 18 6M6 6h12v12');
      assert.equal(await evaluate("/Scanning for nearby|Put new devices|Bluetooth LE connections/.test(document.querySelector('#system-content').textContent)"), false);
      assert(await evaluate("window.__test.calls.some(call => call[0] === 'bluetooth' && call[2][3].includes('::Read($true)'))"), 'Discovery starts automatically.');
      await evaluate("document.querySelector('[data-action=pair]').click()");
      await pause(100);
      assert(await evaluate("window.__test.calls.some(call => call[0] === 'bluetooth' && call[2][3].includes(\"::Act('pair'\"))"));
      await evaluate("window.__test.failBluetooth = true; void window.__refreshBluetoothStatus()");
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
        void window.__scanBluetooth();
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
    await t.test('Bluetooth discovery silently shows new devices only when found', async () => {
      await load('bluetooth');
      await pause(100);
      await evaluate(`window.__test.bluetooth = { available: true, enabled: true, devices: [] }; window.__scanBluetooth()`);
      assert.equal(await evaluate("document.querySelectorAll('.bluetooth-section:not([hidden])').length"), 2);
      assert.equal(await evaluate("document.querySelector('[data-device-id=available]')"), null);
      await evaluate('window.__test.holdBluetoothScan = true; void window.__scanBluetooth()');
      await pause(50);
      assert.equal(await evaluate("document.querySelectorAll('.bluetooth-section:not([hidden])').length"), 2);
      assert.equal(await evaluate("document.querySelector('#bluetooth-status').textContent"), '');
      await evaluate(`window.__test.resolveBluetoothScan({ available: true, enabled: true, devices: [
        { id: 'new', name: 'New mouse', paired: false, connected: false },
      ] })`);
      await pause(100);
      assert.equal(await evaluate("document.querySelector('[data-device-id=new]').closest('.bluetooth-section').querySelector('h2').textContent"), 'Available');
      assert.equal(await evaluate("document.querySelector('[data-device-id=new] .bluetooth-name').textContent"), 'New mouse');
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
    await t.test('one WebView can reopen and change types without duplicate controls or provider listeners', async () => {
      await load('audio');
      const stopsBefore = await evaluate('window.__test.providerStops');
      await evaluate("window.__reopenPopup('calendar')");
      assert.equal(await evaluate('window.__test.providerStops'), stopsBefore,
        'Closing audio must not stop the persistent native provider.');
      const month = await evaluate("document.getElementById('month-label').textContent");
      await evaluate("document.getElementById('next-month').click()");
      const nextMonth = await evaluate("document.getElementById('month-label').textContent");
      assert.notEqual(nextMonth, month);
      await evaluate("window.__reopenPopup('calendar')");
      assert.equal(await evaluate("document.getElementById('month-label').textContent"), month);
      await evaluate("document.getElementById('next-month').click()");
      assert.equal(await evaluate("document.getElementById('month-label').textContent"), nextMonth,
        'Exactly one navigation handler should fire after reopening.');
      await evaluate("window.__reopenPopup('network')");
      assert.equal(await evaluate("document.querySelectorAll('#globalprotect-toggle').length"), 0);
      await evaluate("window.__reopenPopup('globalprotect')");
      assert.equal(await evaluate("document.querySelectorAll('#globalprotect-toggle').length"), 1);
      await evaluate("window.__reopenPopup('audio')");
      await pause(25);
      assert.equal(await evaluate("document.querySelectorAll('#volume-slider').length"), 1);
      assert.equal(await evaluate("document.querySelectorAll('#globalprotect-toggle').length"), 0);
      assert.equal(await evaluate('window.__test.providerStops'), stopsBefore + 1);
      await evaluate("window.__test.data.audio.defaultPlaybackDevice.volume = 71; window.__test.notify()");
      assert.equal(await evaluate("document.getElementById('volume-slider').value"), '71');
      await evaluate("window.__reopenPopup('audio')");
      assert.equal(await evaluate('window.__test.providerStops'), stopsBefore + 1,
        'Reopening audio must only replace transport listeners.');
      assert.equal(await evaluate("document.querySelectorAll('#volume-slider').length"), 1);
      const vpnCalls = await evaluate("window.__test.calls.filter(call => call[0] === 'globalprotect').length");
      await pause(1100);
      assert.equal(await evaluate("window.__test.calls.filter(call => call[0] === 'globalprotect').length"), vpnCalls,
        'Hidden/replaced GlobalProtect sessions must not keep polling.');
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
          controls: [...panel.querySelectorAll('button, input')].filter(node => node.getClientRects().length).length,
          vpn: panel.querySelector('.network-vpn'),
          fits: panel.scrollWidth <= panel.clientWidth && document.body.scrollHeight <= innerHeight,
        };
      })()`);
      assert.equal(result.headerHidden, true);
      assert.equal(result.title, '<script>bad</script>');
      assert.equal(result.meta, 'WI-FI CONNECTION');
      assert.equal(result.labelledBy, 'network-title');
      assert.match(result.font, /JetBrainsMono/);
      assert.equal(result.padding, '14px');
      assert.equal(result.radius, '0px');
      assert.deepEqual(result.sections, []);
      assert.equal(result.flat, true);
      assert.equal(result.controls, 3);
      assert.equal(result.vpn, null);
      assert.equal(result.fits, true);
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('#system-content [title]')].map(node => node.getAttribute('title')).sort()`),
        ['Copy Gateway: 192.168.1.1', 'Copy IP Address: 192.168.1.2', 'Open Windows Wi-Fi networks'].sort());
      assert.equal(await evaluate("document.querySelector('.network-diagnostics')"), null);
      assert.equal(await evaluate("document.querySelector('.network-vpn')"), null);
      assert.equal(await evaluate("[...document.querySelectorAll('.network-traffic dt')].find(node => node.textContent === 'IP Address').nextElementSibling.textContent"), '192.168.1.2');
      assert(await evaluate("document.getElementById('system-content').scrollHeight < 320"));
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.network-traffic dt')].map(node => node.textContent)"),
        ['Ping', 'Link rate', 'Receiving', 'Sending', 'Downloaded', 'Uploaded', 'IP Address', 'Gateway']);
      await evaluate(`window.__copiedAddresses = [];
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async value => window.__copiedAddresses.push(value),
        } });
        for (const label of ['IP Address', 'Gateway']) {
          const row = [...document.querySelectorAll('.network-traffic dt')].find(node => node.textContent === label);
          row.nextElementSibling.querySelector('button').click();
        }`);
      await pause(20);
      assert.deepEqual(await evaluate('window.__copiedAddresses'), ['192.168.1.2', '192.168.1.1']);
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
      assert.equal(await evaluate("document.getElementById('network-title').hasAttribute('title')"), false);
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'ETHERNET CONNECTION');
      assert.equal(await evaluate("document.querySelectorAll('.network-section').length"), 0);
      assert.equal(await evaluate("document.querySelectorAll('.network-connection .network-overview dt').length"), 1, 'Ethernet speed is already in the hero.');
      assert.equal(await evaluate("document.querySelector('.network-connection .network-overview dd').textContent"), '10.0.0.2');
      assert.equal(await evaluate("document.querySelector('.network-diagnostics')"), null);
      await evaluate(`window.__test.data.network = { defaultInterface: null, interfaces: [] }; window.__test.notify()`);
      assert.equal(await evaluate("document.getElementById('network-title').textContent"), 'No physical connection');
      assert.equal(await evaluate("document.querySelector('.hero__meta').textContent"), 'NOT CONNECTED');
      assert.equal(await evaluate("document.querySelector('.network-diagnostics')"), null);
      assert.equal(await evaluate("document.querySelector('.network-traffic').hidden"), true);
      await evaluate(`window.__test.data.network = { defaultInterface: {
        name: 'Adapter '.repeat(40), type: 'wifi', ipv4Addresses: ['10.0.0.2'],
        ipv6Addresses: Array.from({ length: 40 }, (_, i) => '2001:db8::' + i),
      } }; window.__test.notify()`);
      assert.equal(await evaluate("document.querySelector('.hero__title').textContent.includes('%')"), false);
      await pause(30);
      await evaluate('window.__test.notify()');
      assert.equal(await evaluate("document.querySelector('details')"), null);
      const overflow = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        panel.scrollTop = panel.scrollHeight;
        return { body: document.body.scrollHeight, height: innerHeight, scroll: panel.scrollTop,
          width: panel.scrollWidth, clientWidth: panel.clientWidth };
      })()`);
      assert(overflow.body <= overflow.height && overflow.width <= overflow.clientWidth,
        JSON.stringify(overflow));
    });
    await t.test('network updates retain focused address and native flyout buttons', async () => {
      await load('network');
      await evaluate('window.__refreshNetworkStats()');
      for (const label of ['IP Address', 'Gateway']) {
        await evaluate(`window.__focusedAddress = [...document.querySelectorAll('.network-traffic dt')]
          .find(node => node.textContent === ${JSON.stringify(label)}).nextElementSibling.querySelector('button');
          window.__focusedAddress.focus();`);
        await evaluate(`window.__test.networkStats = { id: 'wifi', received: 1410001000, sent: 353000500,
          gateway: '192.168.1.254', ping: 12 }; window.__refreshNetworkStats()`);
        assert(await evaluate('document.activeElement === window.__focusedAddress && window.__focusedAddress.isConnected'));
        await evaluate('window.__test.notify()');
        assert(await evaluate('document.activeElement === window.__focusedAddress'));
      }
      await evaluate(`window.__flyoutButton = document.getElementById('wifi-settings-open');
        window.__flyoutButton.focus(); window.__test.notify();`);
      assert(await evaluate('document.activeElement === window.__flyoutButton && window.__flyoutButton.isConnected'));
    });
    await t.test('network statistics timeout kills the native query and permits recovery', async () => {
      await load('network');
      await evaluate('window.__refreshNetworkStats()');
      await evaluate(`window.__test.networkQueryTimeout = 20; window.__test.holdNetworkStats = true;
        window.__refreshNetworkStats()`);
      assert.equal(await evaluate('window.__test.queryKills'), 1);
      assert.match(await evaluate("document.querySelector('.network-traffic [role=status]').textContent"), /timed out/);
      await evaluate('window.__test.holdNetworkStats = false; window.__test.networkQueryTimeout = 15000; window.__refreshNetworkStats()');
      assert.equal(await evaluate("document.querySelector('.network-traffic [role=status]').hidden"), true);
    });
    await t.test('network statistics failures clear stale metrics and recover visibly', async () => {
      await load('network');
      await evaluate('window.__refreshNetworkStats()');
      assert.match(await evaluate("document.querySelector('.network-traffic').textContent"), /31 ms/);
      await evaluate('window.__test.failNetworkStats = true; window.__refreshNetworkStats()');
      assert.match(await evaluate("document.querySelector('.network-traffic [role=status]').textContent"), /statistics unavailable/);
      assert.equal(await evaluate("document.querySelector('.network-traffic [role=status]').hidden"), false);
      assert.equal(await evaluate("document.querySelector('.network-traffic').textContent.includes('31 ms')"), false);
      assert.equal(await evaluate("localStorage.getItem('winarchy.network.traffic.v1')"), null);
      await evaluate('window.__test.failNetworkStats = false; window.__refreshNetworkStats()');
      assert.equal(await evaluate("document.querySelector('.network-traffic [role=status]').hidden"), true);
      assert.match(await evaluate("document.querySelector('.network-traffic').textContent"), /31 ms/);
      const receiving = await evaluate("[...document.querySelectorAll('.network-traffic dt')].find(node => node.textContent === 'Receiving').nextElementSibling.textContent");
      assert.equal(receiving, '--', 'Recovery starts a fresh rate baseline.');
    });
    await t.test('VPN action hover stays aligned with the icon and centered switch track', async () => {
      await load('globalprotect');
      await evaluate('window.__refreshGlobalProtect()');
      assert(await evaluate("document.querySelector('.network-section__heading #globalprotect-open') !== null"));
      assert(await evaluate("document.querySelector('.network-vpn__actions #globalprotect-open') !== null"));
      assert.equal(await evaluate("document.querySelectorAll('.network-vpn__row, #globalprotect-name').length"), 0);
      assert.equal(await evaluate("document.querySelector('.network-vpn__actions').firstElementChild.id"), 'globalprotect-open');
      const geometry = await evaluate(`(() => {
        const open = document.getElementById('globalprotect-open');
        const toggle = document.getElementById('globalprotect-toggle');
        const button = toggle.getBoundingClientRect();
        const track = toggle.querySelector('.network-vpn__track').getBoundingClientRect();
        const openRect = open.getBoundingClientRect();
        const icon = open.querySelector('svg').getBoundingClientRect();
        return { iconDx: (openRect.left + openRect.width / 2) - (icon.left + icon.width / 2),
          iconDy: (openRect.top + openRect.height / 2) - (icon.top + icon.height / 2), openPadding: getComputedStyle(open).padding, switchPadding: getComputedStyle(toggle).padding,
          dx: (button.left + button.width / 2) - (track.left + track.width / 2),
          dy: (button.top + button.height / 2) - (track.top + track.height / 2),
          actionsDy: (button.top + button.height / 2) - (openRect.top + openRect.height / 2),
          arrowBeforeSwitch: openRect.right <= button.left }; 
      })()`);
      assert.equal(geometry.openPadding, '0px');
      assert(geometry.arrowBeforeSwitch && Math.abs(geometry.actionsDy) < 0.1, JSON.stringify(geometry));
      assert(Math.abs(geometry.iconDx) < 0.1 && Math.abs(geometry.iconDy) < 0.1, JSON.stringify(geometry));
      assert.equal(geometry.switchPadding, '6px');
      assert(Math.abs(geometry.dx) < 0.1 && Math.abs(geometry.dy) < 0.1, JSON.stringify(geometry));
      for (const id of ['globalprotect-open', 'globalprotect-toggle']) {
        const point = await evaluate(`(() => { const rect = document.getElementById('${id}').getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
        await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
        const style = await evaluate(`(() => { const node = document.getElementById('${id}'); const css = getComputedStyle(node);
          return { hovered: node.matches(':hover'), background: css.backgroundColor, shadow: css.boxShadow,
            border: css.borderTopColor, otherHovered: document.getElementById('${id === 'globalprotect-open' ? 'globalprotect-toggle' : 'globalprotect-open'}').matches(':hover') }; })()`);
        assert.equal(style.hovered, true);
        assert.equal(style.otherHovered, false);
        if (id === 'globalprotect-toggle') {
          assert.equal(style.background, 'rgba(0, 0, 0, 0)');
          assert.match(style.shadow, /inset/);
        } else {
          assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
          assert.notEqual(style.border, 'rgba(0, 0, 0, 0)');
        }
        if (process.env.NETWORK_SCREENSHOT_PATH) {
          const height = await evaluate('window.__popupHeights.at(-1)');
          const screenshot = await client.call('Page.captureScreenshot', {
            format: 'png', clip: { x: 0, y: 0, width: popupSizes.network.width, height, scale: 1 },
          });
          await writeFile(process.env.NETWORK_SCREENSHOT_PATH.replace(/\.png$/, '-' + id + '-hover.png'), Buffer.from(screenshot.data, 'base64'));
        }
      }
      await client.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 });
    });
    await t.test('GlobalProtect keeps controls mounted, waits for MFA, and confirms state independently of the route', async () => {
      await load('globalprotect');
      assert.equal(await evaluate("document.querySelector('main').getAttribute('aria-labelledby')"), 'globalprotect-title');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('role')"), 'switch');
      assert.equal(await evaluate("document.getElementById('globalprotect-open').getAttribute('aria-label')"), 'Open GlobalProtect client');
      await evaluate('window.__refreshGlobalProtect()');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('aria-label')"), 'Connect GlobalProtect');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('aria-checked')"), 'false');
      await evaluate("document.getElementById('globalprotect-toggle').click()");
      await pause(30);
      assert.equal(await evaluate("document.querySelector('.network-vpn [role=status]').textContent"), 'Connecting…');
      assert(await evaluate("document.getElementById('globalprotect-toggle').disabled"));
      assert(await evaluate('window.__test.retained'));
      assert.match(await evaluate("document.querySelector('.network-vpn .note').textContent"), /MFA/);
      assert.equal(await evaluate("window.__test.calls.filter(c => c[0] === 'globalprotect' && c[1] === 'hide').length"), 0);
      await evaluate(`window.__test.globalprotect = { available: true, connected: true };
        window.__test.data.network.defaultInterface = window.__test.data.network.interfaces[0];
        window.__test.notify(); window.__refreshGlobalProtect()`);
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('aria-label')"), 'Disconnect GlobalProtect');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('aria-checked')"), 'true');
      assert.equal(await evaluate("getComputedStyle(document.querySelector('.network-vpn .network-section__heading')).backgroundColor"), 'rgba(0, 0, 0, 0)');
      assert(await evaluate("document.querySelector('.network-vpn .note').hidden"));
      assert.equal(await evaluate('window.__test.retained'), false);
      await evaluate("document.getElementById('globalprotect-toggle').click()");
      await pause(30);
      assert.equal(await evaluate("document.querySelector('.network-vpn [role=status]').textContent"), 'Disconnecting…');
      assert(await evaluate('window.__test.retained'));
      await evaluate('window.__test.globalprotect.connected = false; window.__refreshGlobalProtect()');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('aria-label')"), 'Connect GlobalProtect');
      await evaluate('window.__test.failGlobalProtect = true; document.getElementById("globalprotect-toggle").click()');
      await pause(30);
      assert.match(await evaluate("document.getElementById('popup-error').textContent"), /button unavailable/);
      assert(await evaluate("document.getElementById('globalprotect-toggle').disabled"));
      await evaluate('window.__test.failGlobalProtect = false; window.__refreshGlobalProtect()');
      await evaluate("document.getElementById('globalprotect-open').click()");
      await pause(30);
      assert.deepEqual(await evaluate("window.__test.calls.filter(c => c[0] === 'globalprotect' && c[1] !== 'status')"),
        [['globalprotect', 'connect'], ['globalprotect', 'hide'], ['globalprotect', 'disconnect'], ['globalprotect', 'hide'], ['globalprotect', 'connect'], ['globalprotect', 'open']]);
      await evaluate('window.__test.globalprotect.available = false; window.__refreshGlobalProtect()');
      assert(await evaluate("document.getElementById('globalprotect-toggle').disabled"));
    });
    await t.test('explicit Open client during a pending VPN action prevents automatic hiding', async () => {
      await load('globalprotect');
      await evaluate('window.__refreshGlobalProtect()');
      await evaluate("document.getElementById('globalprotect-toggle').click()");
      await pause(30);
      await evaluate("document.getElementById('globalprotect-open').click()");
      await pause(30);
      await evaluate('window.__test.globalprotect = { available: true, connected: true }; window.__refreshGlobalProtect()');
      assert.equal(await evaluate("document.getElementById('globalprotect-toggle').getAttribute('aria-checked')"), 'true');
      assert.equal(await evaluate("window.__test.calls.filter(c => c[0] === 'globalprotect' && c[1] === 'hide').length"), 0);
    });
    await t.test('network cache paints immediately while live status queries are pending', async () => {
      await load('network');
      await pause(50);
      const before = await evaluate("document.querySelector('.network-traffic').textContent");
      await client.call('Page.enable');
      const injected = await client.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__holdNetwork = true;' });
      try {
        await load('network');
        assert.equal(await evaluate("document.querySelector('.network-traffic').textContent"), before);
        assert.equal(await evaluate("document.getElementById('network-title').textContent"), '<script>bad</script>');
        assert.equal(await evaluate("document.querySelector('.network-vpn')"), null);
        assert(await evaluate("!document.getElementById('wifi-settings-open').disabled"));
        await evaluate('window.__holdNetwork = false; window.__test.notify()');
        await pause(100);
        assert(await evaluate("!document.getElementById('wifi-settings-open').disabled"));
      } finally {
        await evaluate('window.__holdNetwork = false');
        await client.call('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
      }
    });
    await t.test('Wi-Fi header opens native network selection and matches the VPN arrow style', async () => {
      await load('network');
      assert(await evaluate("document.querySelector('.network-hero #wifi-settings-open svg') !== null"));
      assert.equal(await evaluate("document.getElementById('wifi-settings-open').getAttribute('aria-label')"), 'Open Windows Wi-Fi networks');
      assert.equal(await evaluate("document.getElementById('wifi-toggle')"), null);
      const arrowStyle = id => evaluate(`(() => {
        const css = getComputedStyle(document.getElementById('${id}'));
        return [css.backgroundColor, css.borderRadius, css.borderTopWidth, css.borderTopColor, css.width, css.height, css.padding];
      })()`);
      const wifiStyle = await arrowStyle('wifi-settings-open');
      await evaluate("window.__reopenPopup('globalprotect')");
      assert.deepEqual(await arrowStyle('globalprotect-open'), wifiStyle);
      await evaluate("window.__reopenPopup('network')");
      await evaluate("document.getElementById('wifi-settings-open').click()");
      await pause(30);
      assert.deepEqual(await evaluate('window.__test.calls.at(-1)'), ['shell-spawn', 'explorer.exe', ['ms-availablenetworks:']]);
      assert.equal(await evaluate('window.__test.nativeHandoffs'), 1);
      await evaluate('window.__test.data.network = null; window.__test.notify()');
      assert(await evaluate("!document.getElementById('wifi-settings-open').disabled"));
      await evaluate("document.getElementById('wifi-settings-open').click()");
      await pause(30);
      assert.deepEqual(await evaluate('window.__test.calls.at(-1)'), ['shell-spawn', 'explorer.exe', ['ms-availablenetworks:']]);
      assert.deepEqual(await evaluate("window.__test.calls.filter(c => c[0] === 'wifi-radio')"), []);
    });
    await t.test('network omits diagnostics and treats device text as text', async () => {
      await load('network');
      const text = await evaluate("document.getElementById('system-content').textContent");
      assert(await evaluate('document.body.scrollHeight <= innerHeight'));
      for (const value of ['WI-FI CONNECTION', '192.168.1.2', '<script>bad</script>']) {
        assert(text.includes(value), value);
      }
      assert.equal(await evaluate("document.querySelector('#system-content script') !== null"), false);
      await evaluate(`window.__test.data.network = null; window.__test.errors.network = 'Access denied'; window.__test.notify()`);
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /Access denied/);
    });
    await t.test('display matches the flat Omarchy popups without links or controls', async () => {
      await load('display');
      const result = await evaluate(`(() => {
        const panel = document.getElementById('system-content');
        return {
          title: document.getElementById('display-title').textContent,
          meta: panel.querySelector('.hero__meta').textContent,
          font: getComputedStyle(document.body).fontFamily,
          radius: getComputedStyle(document.body).borderRadius,
          sections: [...panel.querySelectorAll('h2')].map(node => node.textContent),
          scale: panel.querySelector('.display-scale__value').textContent,
          current: panel.querySelector('.display-row--current h3').textContent,
          fill: getComputedStyle(panel.querySelector('.display-row--current .display-row__heading')).backgroundColor,
          controls: panel.querySelectorAll('button, input, a, .card, .badge, dl').length,
          connected: panel.querySelectorAll('[aria-label="Connected"]').length,
        };
      })()`);
      assert.equal(result.title, 'Display');
      assert.equal(result.meta, 'Left');
      assert.match(result.font, /JetBrainsMono/);
      assert.equal(result.radius, '0px');
      assert.deepEqual(result.sections, ['Scale', 'Displays']);
      assert.equal(result.scale, '150%');
      assert.equal(result.current, 'Left · focused');
      assert.notEqual(result.fill, 'rgba(0, 0, 0, 0)');
      assert.equal(result.controls, 0);
      assert.equal(result.connected, 2);
      if (process.env.DISPLAY_SCREENSHOT_PATH) {
        const height = await evaluate('window.__popupHeights.at(-1)');
        const { data } = await client.call('Page.captureScreenshot', {
          format: 'png', clip: { x: 0, y: 0, width: popupSizes.display.width, height, scale: 1 },
        });
        await writeFile(process.env.DISPLAY_SCREENSHOT_PATH, Buffer.from(data, 'base64'));
      }
      await evaluate('window.__test.monitors = []; window.__reopenPopup("display")');
      assert.match(await evaluate("document.getElementById('popup-error').textContent"), /No connected displays/);
      await evaluate(`window.__test.monitors = [{ name: null, position: { x: -100, y: -200 },
        size: { width: 1080, height: 1920 }, scaleFactor: 1.25 }]; window.__reopenPopup('display');`);
      assert.equal(await evaluate("document.querySelector('.display-scale__value').textContent"), '125%');
      assert.equal(await evaluate("document.querySelector('.display-row h3').textContent"), 'Display 1 · focused');
    });
    await t.test('minimal display list escapes names and stays within the popup bounds', async () => {
      await load('display');
      await evaluate(`window.__test.monitors = Array.from({ length: 20 }, (_, index) => ({
        name: index === 0 ? '<script>display</script>' : null,
        position: { x: -1080 * index, y: -200 },
        size: { width: 1080, height: 1920 }, scaleFactor: 1.5,
      })); window.__reopenPopup('display');`);
      await pause(25);
      assert.equal(await evaluate("document.querySelectorAll('.display-row').length"), 20);
      assert.equal(await evaluate("document.querySelector('#system-content script') !== null"), false);
      assert.match(await evaluate("document.getElementById('system-content').textContent"), /Display 20/);
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
        isCharging: true, state: 'charging', cycleCount: 93, timeTillFull: 960000,
        powerConsumption: 16.4 }; window.__test.notify()`);
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
          labels: [...panel.querySelectorAll('dt')].map(node => node.textContent),
          values: [...panel.querySelectorAll('dd')].map(node => node.textContent),
          buttons: panel.querySelectorAll('button').length,
          calls: window.__test.calls,
        };
      })()`);
      assert.equal(result.headerHidden, true);
      assert.equal(result.labelledBy, 'power-title');
      assert.equal(result.title, 'Battery');
      assert.equal(result.meta, 'SOAKING AMPS');
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
      assert.deepEqual(result.sections, []);
      assert.deepEqual(result.labels, ['Battery size', 'Time to full', 'Charge cycles', 'Charging']);
      assert.deepEqual(result.values, ['38Wh', '16m', '93', '16.4W']);
      assert.equal(result.buttons, 0);
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
      assert(overflow.body <= overflow.height && overflow.scroll === 0 && overflow.width <= overflow.clientWidth,
        JSON.stringify(overflow));
    });
    await t.test('battery popup excludes system details and session actions', async () => {
      await load('power');
      await evaluate('window.__test.notify()');
      const text = await evaluate("document.getElementById('system-content').textContent");
      for (const value of ['CPU', 'Memory', 'Drives', 'Session', 'Health', 'Shut down', 'Log out', 'Lock', 'Power profile']) {
        assert(!text.includes(value), value);
      }
      assert.equal(await evaluate("document.getElementById('power-confirmation') === null"), true);
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
