import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { networkConnection } from '../shared/network-model.mjs';
import { batteryIndicator, queryPowerStatus } from '../shared/battery-model.mjs';
import { createIcon, createBatteryIcon } from '../shared/icons.mjs';
import { startNetworkBackground } from '../shared/network-background.mjs';
import { startBluetoothBackground } from '../shared/bluetooth-background.mjs';
import { createBarZOrder } from '../shared/bar-z-order.mjs';
import { createAudioOwner } from '../shared/audio-bridge.mjs';
import { readSnapshot, vpnSnapshotValid } from '../shared/snapshot-cache.mjs';
import { shellQuery } from '../shared/native-query.mjs';
import { queryAwake, toggleAwake } from '../shared/awake-model.mjs';
import { queryDnd, toggleDnd } from '../shared/dnd-model.mjs';
import { queryNightLight, toggleNightLight } from '../shared/night-light-model.mjs';
import { attachBarToggle } from '../shared/bar-toggle.mjs';

for (const [id, icons] of Object.entries({
  split: [['split-horizontal', 'split__horizontal'], ['split-vertical', 'split__vertical']],
  'network-trigger': [['wifi', 'net__wifi'], ['ethernet', 'net__ethernet'], ['wifi-off', 'net__none']],
  'bluetooth-trigger': [['bluetooth', '']],
  'globalprotect-trigger': [['globalprotect', '']],
  'audio-trigger': [['volume-high', 'vol__on'], ['volume-off', 'vol__muted']],
  'display-trigger': [['monitor', '']],
  'awake-trigger': [['coffee', '']],
  'dnd-trigger': [['bell-off', '']],
  'night-light-trigger': [['weather-night', '']],
})) {
  document.getElementById(id).replaceChildren(...icons.map(([name, className]) => createIcon(name, className)));
}
const vpnIcon = document.querySelector('#globalprotect-trigger svg');
const vpnSlash = document.createElementNS('http://www.w3.org/2000/svg', 'path');
vpnSlash.setAttribute('class', 'vpn__slash');
vpnSlash.setAttribute('d', 'M3 3 21 21');
vpnSlash.setAttribute('fill', 'none');
vpnSlash.setAttribute('stroke', 'currentColor');
vpnSlash.setAttribute('stroke-width', '2');
vpnSlash.setAttribute('stroke-linecap', 'round');
// A background-colored outline keeps the slash distinct from the shield.
const vpnSlashOutline = vpnSlash.cloneNode(true);
vpnSlashOutline.setAttribute('stroke', 'var(--ctp-base)');
vpnSlashOutline.setAttribute('stroke-width', '4');
vpnIcon.append(vpnSlashOutline, vpnSlash);
document.getElementById('power-trigger').replaceChildren(createBatteryIcon());

// Reassigning title, even to the same value, dismisses WebView2 tooltips.
// Provider output arrives every second; only publish actual changes.
function setTitle(element, title) {
  if (element.title !== title) element.title = title;
}
const popupErrorEl = document.getElementById('popup-error');
function reportPopupError(error) {
  console.error('Bar:', error);
  popupErrorEl.textContent = error.message ?? String(error);
  setTitle(popupErrorEl, `${popupErrorEl.textContent} (click to dismiss)`);
  popupErrorEl.hidden = false;
}
popupErrorEl.addEventListener('click', () => { popupErrorEl.hidden = true; });
const toggleOptions = {
  setTitle, reportError: reportPopupError,
  clearError: () => { popupErrorEl.hidden = true; },
};
const awakeControl = attachBarToggle(document.getElementById('awake-trigger'), {
  ...toggleOptions,
  query: () => queryAwake(shellQuery),
  toggle: () => toggleAwake(zebar.shellExec),
  label: state => !state ? 'PowerToys Awake -- status unavailable'
    : !state.available ? 'Enable Awake in PowerToys Settings first'
    : state.enabled ? 'PowerToys Awake -- on. Allow sleep'
    : 'PowerToys Awake -- off. Stay Awake',
});
const dndControl = attachBarToggle(document.getElementById('dnd-trigger'), {
  ...toggleOptions,
  query: () => queryDnd(shellQuery),
  toggle: () => toggleDnd(zebar.shellExec),
  label: state => !state ? 'Windows Do not disturb -- status unavailable'
    : state.enabled ? 'Windows Do not disturb -- on. Allow notifications'
    : 'Windows Do not disturb -- off. Silence notifications',
});
const nightLightControl = attachBarToggle(document.getElementById('night-light-trigger'), {
  ...toggleOptions,
  query: () => queryNightLight(shellQuery),
  toggle: () => toggleNightLight(zebar.shellExec),
  label: state => !state ? 'Windows Night light -- status unavailable'
    : !state.available ? 'Windows Night light -- unavailable. Check Windows display settings'
    : state.enabled ? 'Windows Night light -- on. Turn off'
    : 'Windows Night light -- off. Turn on',
});
const updateBarZOrder = createBarZOrder(
  order => zebar.currentWidget().setZOrder(order), reportPopupError,
);
import('../shared/popup-controller.mjs').then(({ attachPopupTriggers }) => {
  attachPopupTriggers(
    [...document.querySelectorAll('[data-popup-trigger]')].map(trigger => ({
      trigger, type: trigger.dataset.popupTrigger,
    })),
    reportPopupError,
    () => { popupErrorEl.hidden = true; },
  );
}).catch(reportPopupError);

const providers = zebar.createProviderGroup({
  date: { type: 'date', refreshInterval: 1000, formatting: 'HH:mm' },
  glazewm: { type: 'glazewm' },
  network: { type: 'network', refreshInterval: 30000 },
  audio: { type: 'audio' },
});
const audioOwner = createAudioOwner(() => ({
  audio: providers.outputMap.audio, error: providers.errorMap.audio,
}));
window.addEventListener('pagehide', () => audioOwner.close(), { once: true });
const vpnEl = document.getElementById('globalprotect-trigger');
const vpnCacheKey = 'winarchy.network.vpn.v1';
function renderVpn(vpn) {
  vpnEl.hidden = vpn?.available !== true;
  vpnEl.classList.toggle('is-muted', vpn?.connected !== true);
  const label = `GlobalProtect -- ${vpn?.connected ? 'Connected' : 'Disconnected'}. Open VPN controls`;
  vpnEl.setAttribute('aria-label', label);
  setTitle(vpnEl, label);
}
renderVpn(readSnapshot(vpnCacheKey, vpnSnapshotValid));
window.addEventListener('storage', event => {
  if (event.key === vpnCacheKey) {
    const vpn = readSnapshot(vpnCacheKey, vpnSnapshotValid);
    // An action clears the display cache while awaiting adapter confirmation.
    if (vpn) renderVpn(vpn);
  }
});
const stopNetworkBackground = startNetworkBackground(shellQuery, () => providers.outputMap.network, { onVpn: renderVpn });
window.addEventListener('pagehide', stopNetworkBackground, { once: true });
const stopBluetoothBackground = startBluetoothBackground(shellQuery);
window.addEventListener('pagehide', stopBluetoothBackground, { once: true });
const timeEl = document.getElementById('time');
const workspacesEl = document.getElementById('workspaces');
const modesEl = document.getElementById('modes');
const splitEl = document.getElementById('split');
const audioEl = document.getElementById('audio-trigger');
const networkEl = document.getElementById('network-trigger');
const powerEl = document.getElementById('power-trigger');
let powerBusy = false;
async function refreshPower() {
  if (powerBusy) return;
  powerBusy = true;
  let status;
  let failure;
  try {
    status = await queryPowerStatus(shellQuery);
  } catch (error) {
    failure = error.message ?? String(error);
    console.error('Power status:', error);
  } finally {
    const indicator = batteryIndicator(status);
    powerEl.dataset.state = indicator.state;
    const fillHeight = 14 * (indicator.charge ?? 0) / 100;
    const fill = powerEl.querySelector('.battery__fill');
    fill.setAttribute('height', String(fillHeight));
    fill.setAttribute('y', String(20 - fillHeight));
    powerEl.setAttribute('aria-label', `${indicator.label}${failure ? ` — ${failure}` : ''}. Open power and system information`);
    powerBusy = false;
  }
}
void refreshPower();
const powerTimer = setInterval(refreshPower, 10000);
window.addEventListener('pagehide', () => clearInterval(powerTimer), { once: true });
const weekday = new Intl.DateTimeFormat(navigator.language, { weekday: 'long' });
let glazewm = null;
providers.onError(errors => {
  audioOwner.publish();
  for (const [name, error] of Object.entries(errors)) {
    if (error) reportPopupError(new Error(`${name}: ${error.message ?? error}`));
  }
  renderVolume(providers.outputMap.audio);
  renderNetwork(providers.outputMap.network);
});
providers.onOutput(output => {
  audioOwner.publish();
  if (output.date) {
    const time = `${weekday.format(new Date(output.date.now))} ${output.date.formatted}`;
    if (timeEl.textContent !== time) timeEl.textContent = time;
  }
  renderVolume(output.audio);
  renderNetwork(output.network);
  glazewm = output.glazewm;
  updateBarZOrder(glazewm);
  renderWorkspaces(glazewm);
  renderModes(glazewm);
  renderSplit(glazewm);
});

function renderVolume(audio) {
  const device = audio?.defaultPlaybackDevice;
  audioEl.classList.toggle('is-muted', device?.isMuted === true);
  audioEl.setAttribute('aria-label', device
    ? `Audio -- ${device.name}, ${Number.isFinite(device.volume) ? Math.round(device.volume) + '%' : 'volume unavailable'}${device.isMuted ? ', muted' : ''}`
    : 'Audio -- no output device data');
}
function renderNetwork(net) {
  const { tunnel, iface, link } = networkConnection(net);
  networkEl.dataset.link = link;
  networkEl.setAttribute('aria-label', !net ? 'Network -- data unavailable' : [
    link === 'none' ? 'No physical link' : link === 'wifi' ? 'Wi-Fi' : 'Ethernet',
    iface?.friendlyName ?? iface?.name,
    tunnel ? 'VPN (default-route heuristic)' : null,
  ].filter(Boolean).join(' -- '));
}
function renderWorkspaces(wm) {
  if (!wm) return;
  workspacesEl.replaceChildren(...wm.currentWorkspaces.map(workspace => {
    const el = document.createElement('div');
    el.className = 'workspace';
    el.classList.toggle('is-focused', workspace.hasFocus);
    el.classList.toggle('is-active', !workspace.hasFocus && workspace.children.length > 0);
    el.dataset.name = workspace.name;
    el.textContent = workspace.displayName ?? workspace.name;
    return el;
  }));
}
function renderSplit(wm) {
  if (!wm) return;
  splitEl.dataset.direction = wm.tilingDirection ?? '';
  setTitle(splitEl, `Next split: ${wm.tilingDirection ?? 'unknown'}`);
}
splitEl.addEventListener('click', () => {
  glazewm?.runCommand('toggle-tiling-direction');
});
function renderModes(wm) {
  if (!wm) return;
  const labels = wm.bindingModes.map(mode => mode.displayName ?? mode.name);
  if (wm.isPaused) labels.unshift('pause');
  modesEl.replaceChildren(...labels.map(label => {
    const el = document.createElement('div');
    el.className = 'mode';
    el.textContent = label;
    return el;
  }));
}
workspacesEl.addEventListener('click', event => {
  const name = event.target.closest('.workspace')?.dataset.name;
  if (name && glazewm) glazewm.runCommand(`focus --workspace ${name}`);
});
