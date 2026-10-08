import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { bluetoothGroups, executeBluetooth, mergeBluetoothSnapshot, cachedBluetoothSnapshot, cacheBluetoothSnapshot, openBluetoothSettings } from '../shared/bluetooth-model.mjs';
import { createIcon } from '../shared/icons.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';

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
  heading.append(icon, body);
  const lists = node('div', undefined, 'bluetooth-lists');
  const sections = new Map();
  const rows = new Map();
  const deviceMessages = new Map();
  for (const [key, label] of [['connected', 'Connected'], ['paired', 'Paired'], ['available', 'Available']]) {
    const section = node('section', undefined, 'bluetooth-section');
    section.append(node('h2', label));
    const content = node('div');
    section.append(content);
    sections.set(key, { section, content });
    lists.append(section);
  }
  const status = node('p', '', 'note');
  status.id = 'bluetooth-status';
  status.setAttribute('role', 'status');
  const settings = button('', () => {
    void openBluetoothSettings(zebar.shellExec).catch(showError);
  }, 'network-vpn__open');
  settings.id = 'bluetooth-settings';
  settings.setAttribute('aria-label', 'Open Windows Bluetooth settings');
  settings.title = 'Open Windows Bluetooth settings';
  const openIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  openIcon.setAttribute('viewBox', '0 0 24 24');
  openIcon.setAttribute('aria-hidden', 'true');
  openIcon.setAttribute('focusable', 'false');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M6 18 18 6M6 6h12v12');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('stroke-linecap', 'round');
  arrow.setAttribute('stroke-linejoin', 'round');
  openIcon.append(arrow);
  settings.append(openIcon);
  heading.append(settings, toggle);
  root.replaceChildren(heading, lists, status);

  function showError(error, id) {
    if (id) {
      deviceMessages.set(id, { text: error.message ?? String(error), error: true });
      return;
    }
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
    const message = node('span', '', 'bluetooth-state');
    message.hidden = true;
    message.setAttribute('role', 'status');
    info.append(name, message);
    control.append(image, info);
    const forget = button('', () => {
      const current = row.device;
      void run('forget', current.id);
    }, 'bluetooth-forget');
    forget.title = 'Forget device';
    const forgetIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    forgetIcon.setAttribute('viewBox', '0 0 24 24');
    forgetIcon.setAttribute('aria-hidden', 'true');
    forgetIcon.setAttribute('focusable', 'false');
    const cancel = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // Material Design Cancel: filled circle with a cut-out cross.
    cancel.setAttribute('d', 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z');
    cancel.setAttribute('fill', 'currentColor');
    forgetIcon.append(cancel);
    forget.append(forgetIcon);
    row.append(control, forget);
    Object.assign(row, { device, control, forget, name, message });
    return row;
  }
  function render() {
    // Discovery and status reads never disable the existing device controls.
    toggle.disabled = busy || !state?.available;
    toggle.setAttribute('aria-checked', String(Boolean(state?.enabled)));
    toggle.title = state?.enabled ? 'Turn Bluetooth off' : 'Turn Bluetooth on';
    meta.textContent = !state ? failed ? 'Unavailable' : 'Loading…' : !state.available ? 'No adapter' : state.enabled ? 'On' : 'Turned off';
    root.setAttribute('aria-busy', String(busy));
    const groups = bluetoothGroups(state?.devices);
    const visibleIds = new Set();
    for (const [key, { section, content }] of sections) {
      section.hidden = !state?.enabled || !groups[key].length;
      if (key === 'available') content.setAttribute('aria-busy', String(scanning));
      const desiredRows = [];
      for (const device of groups[key]) {
        visibleIds.add(device.id);
        let row = rows.get(device.id);
        if (!row) { row = makeRow(device); rows.set(device.id, row); }
        row.device = device;
        row.name.textContent = device.name;
        const deviceMessage = deviceMessages.get(device.id);
        row.message.textContent = deviceMessage?.text ?? '';
        row.message.hidden = !deviceMessage;
        row.message.classList.toggle('error', Boolean(deviceMessage?.error));
        row.message.setAttribute('role', deviceMessage?.error ? 'alert' : 'status');
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
      const text = ({ pair: 'Pairing… Check the Windows pairing dialog.', connect: 'Connecting…', disconnect: 'Disconnecting…', forget: 'Removing pairing…', on: 'Turning Bluetooth on…', off: 'Turning Bluetooth off…' })[action];
      if (id) deviceMessages.set(id, { text, error: false });
      else status.textContent = text;
    }
    const startedAt = revision;
    render();
    try {
      const result = await executeBluetooth(zebar.shellExec, action, id);
      if (disposed || (query && startedAt !== revision)) return;
      const snapshot = result ?? await executeBluetooth(zebar.shellExec, 'status');
      if (disposed) return;
      state = mergeBluetoothSnapshot(state, snapshot, action === 'scan');
      if (id) deviceMessages.delete(id);
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
        showError(error, id);
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
  // Native discovery takes eight seconds, plus PowerShell/WinRT startup time.
  // Ten seconds keeps discovery frequent without launching overlapping scans.
  const scanTimer = setInterval(() => { if (state?.enabled) void run('scan'); }, 10000);
  onPopupSessionEnd(() => {
    disposed = true;
    clearInterval(statusTimer);
    clearInterval(scanTimer);
    for (const timer of followUpTimers) clearTimeout(timer);
    followUpTimers.clear();
  });
}
