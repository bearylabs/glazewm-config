import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { bluetoothGroups, executeBluetooth, mergeBluetoothSnapshot, cachedBluetoothSnapshot, cacheBluetoothSnapshot, openBluetoothSettings } from '../shared/bluetooth-model.mjs';
import { createIcon } from '../shared/icons.mjs';

function node(tag, text, className = '') {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  el.className = className;
  return el;
}
function button(text, action, className = '') {
  const el = node('button', text, className);
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}
export function renderBluetooth(root) {
  let storage;
  try { storage = window.localStorage; } catch { /* Optional cache. */ }
  let state = cachedBluetoothSnapshot(storage);
  let busy = false;
  let scanning = false;
  let refreshing = false;
  let disposed = false;
  let revision = 0;
  let failed = false;
  const followUpTimers = new Set();
  const heading = node('div', undefined, 'hero bluetooth-hero');
  const icon = node('div', undefined, 'hero__icon');
  icon.append(createIcon('bluetooth'));
  const body = node('div', undefined, 'hero__body');
  const title = node('p', 'Bluetooth', 'hero__title');
  title.id = 'bluetooth-title';
  const meta = node('div', 'Loading…', 'hero__meta');
  body.append(title, meta);
  const toggle = button('', () => void run(state?.enabled ? 'off' : 'on'), 'audio-switch');
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', 'Bluetooth');
  const track = node('span', undefined, 'audio-switch__track');
  track.setAttribute('aria-hidden', 'true');
  track.append(node('span', undefined, 'audio-switch__knob'));
  toggle.append(track);
  heading.append(icon, body, toggle);
  const scan = button('Scan for devices', () => void run(state ? 'scan' : 'status'), 'bluetooth-scan');
  const lists = node('div', undefined, 'bluetooth-lists');
  const sections = new Map();
  const rows = new Map();
  for (const [key, label] of [['connected', 'Connected'], ['paired', 'Paired'], ['available', 'Available']]) {
    const section = node('section', undefined, 'bluetooth-section');
    section.append(node('h2', label));
    const content = node('div');
    section.append(content);
    const searching = node('p', 'Scanning for nearby devices…', 'note');
    if (key === 'available') section.append(searching);
    sections.set(key, { section, content, searching });
    lists.append(section);
  }
  const status = node('p', '', 'note');
  status.id = 'bluetooth-status';
  status.setAttribute('role', 'status');
  const note = node('p', 'Put new devices into pairing mode. PIN and confirmation dialogs open in a separate Windows window. Bluetooth LE connections are managed by Windows.', 'note');
  const settings = button('Windows Bluetooth settings', () => {
    void openBluetoothSettings(zebar.shellExec).catch(showError);
  }, 'bluetooth-settings');
  settings.id = 'bluetooth-settings';
  root.replaceChildren(heading, scan, lists, status, note, settings);

  function showError(error) {
    failed = true;
    status.textContent = error.message ?? String(error);
    status.classList.add('error');
    status.setAttribute('role', 'alert');
    // Expected device errors belong inline, not duplicated in the popup toast.
  }

  function makeRow(device) {
    const row = node('div', undefined, 'bluetooth-row');
    const control = button('', () => {
      const current = row.device;
      void run(current.connected ? 'disconnect' : current.paired ? 'connect' : 'pair', current.id);
    }, 'audio-device');
    const image = node('span', undefined, 'audio-device__icon');
    image.append(createIcon('bluetooth'));
    const info = node('span', undefined, 'audio-device__name');
    const name = node('span', '', 'bluetooth-name');
    const description = node('span', '', 'bluetooth-state');
    info.append(name, description);
    control.append(image, info);
    const forget = button('×', () => {
      const current = row.device;
      if (window.confirm(`Remove pairing with ${current.name}?`)) void run('forget', current.id);
    }, 'bluetooth-forget');
    forget.title = 'Forget device';
    row.append(control, forget);
    Object.assign(row, { device, control, forget, name, description });
    return row;
  }
  function render() {
    // Discovery and status reads never disable the existing device controls.
    toggle.disabled = busy || !state?.available;
    toggle.setAttribute('aria-checked', String(Boolean(state?.enabled)));
    toggle.title = state?.enabled ? 'Turn Bluetooth off' : 'Turn Bluetooth on';
    scan.disabled = busy || scanning || refreshing || Boolean(state && !state.enabled);
    scan.textContent = scanning ? 'Scanning…' : !state && failed ? 'Retry' : 'Scan for devices';
    meta.textContent = !state ? failed ? 'Unavailable' : 'Loading…' : !state.available ? 'No adapter' : state.enabled ? 'On' : 'Turned off';
    root.setAttribute('aria-busy', String(busy));
    const groups = bluetoothGroups(state?.devices);
    const visibleIds = new Set();
    for (const [key, { section, content, searching }] of sections) {
      section.hidden = !state?.enabled || (!groups[key].length && !(key === 'available' && scanning));
      searching.hidden = !scanning;
      if (key === 'available') content.setAttribute('aria-busy', String(scanning));
      const desiredRows = [];
      for (const device of groups[key]) {
        visibleIds.add(device.id);
        let row = rows.get(device.id);
        if (!row) { row = makeRow(device); rows.set(device.id, row); }
        row.device = device;
        row.name.textContent = device.name;
        row.description.textContent = device.connected ? 'Connected · click to disconnect' : device.paired ? 'Paired · click to connect' : 'Click to pair';
        row.control.dataset.deviceId = device.id;
        row.control.dataset.action = device.connected ? 'disconnect' : device.paired ? 'connect' : 'pair';
        row.control.setAttribute('aria-pressed', String(device.connected));
        row.control.disabled = busy;
        row.control.title = `${device.name} — ${device.address || ''}`;
        row.forget.dataset.deviceId = device.id;
        row.forget.dataset.action = 'forget';
        row.forget.setAttribute('aria-label', `Forget ${device.name}`);
        row.forget.hidden = !device.paired;
        row.forget.disabled = busy;
        desiredRows.push(row);
      }
      // Keep unchanged paired rows mounted: focus/hover/scroll survive background scans.
      desiredRows.forEach((row, index) => {
        if (content.children[index] !== row) content.insertBefore(row, content.children[index] ?? null);
      });
    }
    for (const [id, row] of rows) {
      if (!visibleIds.has(id)) { row.remove(); rows.delete(id); }
    }
  }
  function showState() {
    status.textContent = !state.available ? 'No Bluetooth adapter found.' : !state.enabled ? 'Turn Bluetooth on to scan.' : '';
    status.classList.remove('error');
    status.setAttribute('role', 'status');
    failed = false;
    cacheBluetoothSnapshot(storage, state);
  }
  async function run(action, id) {
    const query = action === 'status' || action === 'scan';
    if (disposed || busy || (action === 'scan' && scanning) || (action === 'status' && refreshing)) return;
    if (action === 'scan') scanning = true;
    else if (action === 'status') refreshing = true;
    else {
      busy = true;
      revision++;
      status.textContent = ({ pair: 'Pairing… Check the Windows pairing dialog.', connect: 'Connecting…', disconnect: 'Disconnecting…', forget: 'Removing pairing…', on: 'Turning Bluetooth on…', off: 'Turning Bluetooth off…' })[action];
    }
    const startedAt = revision;
    render();
    try {
      const result = await executeBluetooth(zebar.shellExec, action, id);
      if (disposed || (query && startedAt !== revision)) return;
      const snapshot = result ?? await executeBluetooth(zebar.shellExec, 'status');
      if (disposed) return;
      state = mergeBluetoothSnapshot(state, snapshot, action === 'scan');
      showState();
      if (['pair', 'connect', 'disconnect', 'on'].includes(action)) {
        // Windows may finish auto-connecting/installing audio endpoints after pairing.
        for (const delay of [1500, 5000]) {
          const timer = setTimeout(() => { followUpTimers.delete(timer); void run('status'); }, delay);
          followUpTimers.add(timer);
        }
      }
    } catch (error) {
      if (!disposed && (!query || startedAt === revision)) {
        showError(error);
      }
    } finally {
      if (action === 'scan') scanning = false;
      else if (action === 'status') refreshing = false;
      else { busy = false; revision++; }
      if (!disposed) render();
    }
  }
  render(); // Previously paired devices are visible immediately from the local cache.
  void run('status').then(() => { if (state?.enabled) void run('scan'); });
  // Paired-only status reads are separate from discovery and never disable controls.
  const statusTimer = setInterval(() => void run('status'), 10000);
  const scanTimer = setInterval(() => { if (state?.enabled) void run('scan'); }, 15000);
  window.addEventListener('pagehide', () => {
    disposed = true;
    clearInterval(statusTimer);
    clearInterval(scanTimer);
    for (const timer of followUpTimers) clearTimeout(timer);
    followUpTimers.clear();
  }, { once: true });
}
