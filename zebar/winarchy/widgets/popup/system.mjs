import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { renderDisplay } from './display.mjs';
import { networkConnection, linkRate, ipv4 } from '../shared/network-model.mjs';
import { outputVolumeName, selectOutputDevice } from '../shared/audio-model.mjs';
import { createAudioClient } from '../shared/audio-bridge.mjs';
import { createBatteryIcon, createIcon } from '../shared/icons.mjs';
import { percent } from '../shared/system-model.mjs';
import { batteryDetails, batteryCapacityArgs } from '../shared/battery-model.mjs';

import { renderBluetooth } from './bluetooth.mjs';
import { renderGlobalProtect } from './globalprotect.mjs';
import { networkStatsCommand, networkMetrics, networkOverviewEntries } from '../shared/network-stats.mjs';
import { openWifiSettings } from '../shared/wifi-settings.mjs';
import { handoffPopupToNative } from '../shared/popup-controller.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot, networkSnapshotValid, trafficSnapshotValid } from '../shared/snapshot-cache.mjs';
import { readBackgroundSnapshot } from '../shared/network-background.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function details(entries, className = '', reportError = console.error) {
  const list = element('dl', undefined, className);
  const network = className.split(' ').includes('network-overview');
  for (const [label, value] of network ? networkOverviewEntries(entries) : entries) {
    const item = element('div');
    const displayValue = value ?? 'Unavailable';
    const description = element('dd');
    if (network && ['IP Address', 'Gateway'].includes(label) && value && !['--', 'Unavailable'].includes(value)) {
      const copy = button(displayValue, () => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(String(value))).then(() => {
          copy.title = 'Copied to clipboard';
          copy.setAttribute('aria-label', `${label} ${value} copied to clipboard`);
        }).catch(reportError);
      });
      copy.className = 'network-copy';
      copy.title = `Copy ${label}: ${value}`;
      copy.setAttribute('aria-label', copy.title);
      description.append(copy);
    } else description.textContent = displayValue;
    item.append(element('dt', label), description);
    list.append(item);
  }
  return list;
}

function hero(icon, title, meta, value) {
  const node = element('div', undefined, 'hero');
  const body = element('div', undefined, 'hero__body');
  body.append(element('p', title, 'hero__title'), element('div', meta, 'hero__meta'));
  const iconHolder = element('div', undefined, 'hero__icon');
  iconHolder.append(createIcon(icon));
  node.append(iconHolder, body);
  if (value) node.append(element('div', value, 'hero__value'));
  return node;
}

function meter(value) {
  const track = element('div', undefined, 'meter');
  const fill = element('span');
  fill.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  track.append(fill);
  return track;
}

function button(label, action) {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

function subscribe(config, render) {
  const group = zebar.createProviderGroup(config);
  let disposed = false;
  const update = () => { if (!disposed) render(group.outputMap, group.errorMap); };
  group.onOutput(update);
  group.onError(update);
  onPopupSessionEnd(() => {
    disposed = true;
    return group.stopAll().catch(error => console.error('Stopping popup providers:', error));
  });
  update();
  return group;
}

function unavailable(name, error) {
  return element('p', error ? `${name}: ${error.message ?? error}` : `${name}: waiting for data...`,
    error ? 'error' : 'note');
}

function renderAudio(root, reportError) {
  const status = element('p', 'Waiting for output device...', 'note audio-status');
  const label = element('label', 'OUTPUT');
  label.htmlFor = 'volume-slider';
  const slider = element('input');
  slider.id = 'volume-slider';
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '1';
  slider.disabled = true;
  const value = element('output', 'Unavailable');
  value.htmlFor = slider.id;
  const mute = button('Mute', () => run(async () => {
    const audio = group.outputMap.audio;
    const device = audio?.defaultPlaybackDevice;
    if (!device) throw new Error('No default output device.');
    await audio.setMute(!device.isMuted, { deviceId: device.deviceId });
  }));
  mute.id = 'audio-mute';
  mute.disabled = true;
  mute.className = 'audio-switch';
  mute.setAttribute('role', 'switch');
  const switchTrack = element('span', undefined, 'audio-switch__track');
  switchTrack.setAttribute('aria-hidden', 'true');
  switchTrack.append(element('span', undefined, 'audio-switch__knob'));
  mute.replaceChildren(switchTrack);
  const heading = hero('volume-high', 'Audio', 'Unavailable');
  heading.classList.add('audio-hero');
  heading.querySelector('.hero__title').id = 'audio-title';
  heading.append(mute);
  const control = element('div', undefined, 'audio-control');
  const row = element('div', undefined, 'audio-control__row');
  row.append(label, value);
  const sliderRow = element('div', undefined, 'audio-slider-row');
  sliderRow.append(slider);
  control.append(row, sliderRow);
  const devices = element('div', undefined, 'audio-devices');
  devices.id = 'audio-devices';
  devices.setAttribute('role', 'group');
  devices.setAttribute('aria-label', 'Output device');
  const deviceButtons = new Map();
  const separator = element('div', undefined, 'audio-separator');
  separator.setAttribute('role', 'separator');
  root.append(heading, separator, control, devices, status);
  let volumeQueue = Promise.resolve();
  let pendingVolume = 0;
  let muteBusy = false;
  let switchBusy = false;
  let disposed = false;

  async function switchDevice(deviceId) {
    if (switchBusy || muteBusy) return;
    if (group.outputMap.audio?.defaultPlaybackDevice?.deviceId === deviceId) return;
    switchBusy = true;
    update(group.outputMap, group.errorMap);
    try {
      await volumeQueue;
      if (disposed) return;
      await selectOutputDevice(zebar.shellExec, group.outputMap.audio, deviceId);
    } catch (error) {
      if (!disposed) reportError(error);
    } finally {
      switchBusy = false;
      update(group.outputMap, group.errorMap);
    }
  }

  function run(action) {
    muteBusy = true;
    mute.disabled = true;
    Promise.resolve().then(() => { if (!disposed) return action(); })
      .catch(error => { if (!disposed) reportError(error); }).finally(() => {
        muteBusy = false;
        update(group.outputMap, group.errorMap);
      });
  }

  function update(output, errors) {
    if (disposed) return;
    const device = output.audio?.defaultPlaybackDevice;
    status.textContent = errors.audio
      ? `Audio: ${errors.audio.message ?? errors.audio}`
      : device ? '' : 'No default output device available.';
    status.hidden = Boolean(device && !errors.audio);
    status.classList.toggle('error', Boolean(errors.audio));
    root.dataset.muted = String(device?.isMuted === true);
    const heroIcon = heading.querySelector('.hero__icon');
    heroIcon.replaceChildren(createIcon(device?.isMuted ? 'volume-off' : 'volume-high'));
    slider.disabled = !device || !Number.isFinite(device.volume) || switchBusy;
    mute.disabled = !device || muteBusy || switchBusy;
    const playback = output.audio?.playbackDevices ?? [];
    const connectedIds = new Set(playback.map(item => item.deviceId));
    for (const [id, node] of deviceButtons) {
      if (!connectedIds.has(id)) {
        node.remove();
        deviceButtons.delete(id);
      }
    }
    for (const item of playback) {
      let node = deviceButtons.get(item.deviceId);
      if (!node) {
        node = button('', () => void switchDevice(item.deviceId));
        node.className = 'audio-device';
        const icon = element('span', undefined, 'audio-device__icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.append(createIcon('volume-high'));
        node.append(icon, element('span', undefined, 'audio-device__name'));
        deviceButtons.set(item.deviceId, node);
        devices.append(node);
      }
      const selected = item.deviceId === device?.deviceId;
      node.querySelector('.audio-device__name').textContent = item.name;
      node.title = item.name;
      node.setAttribute('aria-pressed', String(selected));
      node.disabled = switchBusy || muteBusy || Boolean(errors.audio);
    }
    devices.setAttribute('aria-busy', String(switchBusy));
    const muteLabel = device?.isMuted ? 'Unmute' : 'Mute';
    mute.setAttribute('aria-label', muteLabel);
    mute.title = muteLabel;
    mute.setAttribute('aria-checked', String(Boolean(device && !device.isMuted)));
    if (!pendingVolume) {
      slider.value = String(device?.volume ?? 0);
      value.textContent = device ? percent(device.volume) : 'Unavailable';
      slider.setAttribute('aria-valuetext', value.textContent);
      updateVolumeStyle(device?.volume, device?.isMuted);
    }
  }
  function updateVolumeStyle(volume, muted) {
    slider.style.setProperty('--audio-progress', `${Math.max(0, Math.min(100, volume ?? 0))}%`);
    heading.querySelector('.hero__meta').textContent = outputVolumeName(volume, muted).toUpperCase();
  }
  // No native provider subscription here: closing this session must not stop
  // the persistent bar's shared audio backend (Zebar 3.3.1 callback lifetime bug).
  const group = createAudioClient((output, errors) => {
    if (!disposed) update(output, errors);
  });
  onPopupSessionEnd(() => { disposed = true; group.close(); });
  slider.addEventListener('input', () => {
    const audio = group.outputMap.audio;
    const device = audio?.defaultPlaybackDevice;
    if (!device) {
      reportError(new Error('No default output device.'));
      return;
    }
    const volume = Number(slider.value);
    updateVolumeStyle(volume, device.isMuted);
    value.textContent = percent(volume);
    slider.setAttribute('aria-valuetext', value.textContent);
    pendingVolume++;
    volumeQueue = volumeQueue.then(async () => {
      if (disposed) return;
      if (group.outputMap.audio?.defaultPlaybackDevice?.deviceId !== device.deviceId) {
        throw new Error('Output device changed. Adjust volume again.');
      }
      await audio.setVolume(volume, { deviceId: device.deviceId });
    }).catch(error => { if (!disposed) reportError(error); }).finally(() => {
      pendingVolume--;
      if (!pendingVolume) update(group.outputMap, group.errorMap);
    });
  });
}

function renderNetwork(root, reportError) {
  const networkCacheKey = 'winarchy.network.connection.v1';
  const trafficCacheKey = 'winarchy.network.traffic.v1';
  const cachedNetwork = readSnapshot(networkCacheKey, networkSnapshotValid);
  const cachedTraffic = readSnapshot(trafficCacheKey, trafficSnapshotValid);
  let liveNetworkSeen = false;
  const connection = element('div', undefined, 'network-connection');
  const traffic = element('div', undefined, 'network-traffic');
  traffic.append(details(cachedTraffic?.entries ?? networkMetrics(null), 'network-details network-overview', reportError));
  let wifiOpening = false;
  const wifiOpen = button('', () => {
    if (wifiOpening) return;
    wifiOpening = true;
    wifiOpen.disabled = true;
    void handoffPopupToNative(() => openWifiSettings(zebar.shellSpawn)).catch(reportError).finally(() => {
      wifiOpening = false;
      wifiOpen.disabled = false;
    });
  });
  wifiOpen.id = 'wifi-settings-open';
  wifiOpen.className = 'network-vpn__open';
  wifiOpen.setAttribute('aria-label', 'Open Windows Wi-Fi networks');
  wifiOpen.title = 'Open Windows Wi-Fi networks';
  const arrowIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrowIcon.setAttribute('viewBox', '0 0 24 24');
  arrowIcon.setAttribute('aria-hidden', 'true');
  arrowIcon.setAttribute('focusable', 'false');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M6 18 18 6M6 6h12v12');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('stroke-linecap', 'round');
  arrow.setAttribute('stroke-linejoin', 'round');
  arrowIcon.append(arrow);
  wifiOpen.append(arrowIcon);
  root.append(connection, traffic);
  let previousStats = cachedTraffic?.snapshot ?? null;
  let previousTime = cachedTraffic?.time ?? 0;
  let statsBusy = false;
  let statsInitialized = false;
  let statsClosed = false;
  let latestStats = cachedTraffic?.snapshot ?? null;
  let latestInterface = null;
  function updateWifiLabels() {
    const title = connection.querySelector('#network-title');
    if (latestStats?.ssid && title && latestInterface && /wifi|wireless|802\.11/i.test(latestInterface.type ?? '')) { title.textContent = latestStats.ssid; }
  }
  async function updateStats() {
    if (statsBusy || statsClosed) return;
    statsBusy = true;
    try {
      const backgroundTraffic = !statsInitialized ? readBackgroundSnapshot(trafficCacheKey, trafficSnapshotValid) : null;
      statsInitialized = true;
      if (backgroundTraffic) {
        latestStats = backgroundTraffic.snapshot;
        previousStats = backgroundTraffic.snapshot; previousTime = backgroundTraffic.time;
        traffic.replaceChildren(details(backgroundTraffic.entries, 'network-details network-overview', reportError));
        updateWifiLabels();
        return;
      }
      const result = await zebar.shellExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', networkStatsCommand]);
      if (statsClosed) return;
      if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr || 'Network statistics unavailable.');
      const snapshot = JSON.parse(result.stdout.trim());
      latestStats = snapshot;
      updateWifiLabels();
      const now = Date.now();
      const entries = [
        ...networkMetrics(snapshot, previousStats, (now - previousTime) / 1000),
        ['IP Address', ipv4(latestInterface) || '--'],
        ['Link rate', linkRate(latestInterface) || '--'],
      ];
      traffic.replaceChildren(details(entries, 'network-details network-overview', reportError));
      if (snapshot) writeSnapshot(trafficCacheKey, { snapshot, time: now, entries });
      else clearSnapshot(trafficCacheKey);
      previousStats = snapshot; previousTime = now;
    } catch (error) { console.warn('Network statistics:', error.message); }
    finally { statsBusy = false; }
  }
  void updateStats();
  const statsTimer = setInterval(() => void updateStats(), 1000);
  const onNetworkStorage = event => {
    if (event.key === trafficCacheKey) void updateStats();
  };
  window.addEventListener('storage', onNetworkStorage);
  onPopupSessionEnd(() => {
    statsClosed = true; clearInterval(statsTimer);
    window.removeEventListener('storage', onNetworkStorage);
  });
  function heading(icon, title, meta) {
    const node = hero(icon, title, meta);
    node.classList.add('network-hero');
    const label = node.querySelector('.hero__title');
    label.id = 'network-title';
    node.append(wifiOpen);
    return node;
  }
  subscribe({ network: { type: 'network', refreshInterval: 1000 } }, (output, errors) => {
    if (output.network || errors.network) liveNetworkSeen = true;
    const net = output.network || (!liveNetworkSeen ? cachedNetwork : null);
    if (output.network) writeSnapshot(networkCacheKey, {
      defaultInterface: output.network.defaultInterface ?? null,
      interfaces: output.network.interfaces ?? [],
      defaultGateway: output.network.defaultGateway ?? null,
    });
    if (!net) {
      if (liveNetworkSeen) { clearSnapshot(networkCacheKey); clearSnapshot(trafficCacheKey); }
      traffic.hidden = true;
      latestInterface = null;
      connection.replaceChildren(heading('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE'), unavailable('Network', errors.network));
      return;
    }
    const { iface, link } = networkConnection(net);
    const kind = link === 'none' ? 'No physical connection' : link === 'wifi' ? 'Wi-Fi' : 'Ethernet';
    const name = link === 'wifi' ? latestStats?.ssid || net.defaultGateway?.ssid || iface?.friendlyName || iface?.name : kind;
    const rate = linkRate(iface);
    const nodes = [
      heading(link === 'wifi' ? 'wifi' : link === 'ethernet' ? 'ethernet' : 'wifi-off',
        link === 'ethernet' && rate ? `${name} (${rate})` : name || kind, link === 'none' ? 'NOT CONNECTED' : `${kind.toUpperCase()} CONNECTION`),
    ];
    latestInterface = iface;
    if (iface && link !== 'wifi') nodes.push(details([
      ['IP Address', ipv4(iface) || '--'],
    ], 'network-details network-overview', reportError));
    traffic.hidden = link !== 'wifi';
    if (errors.network) nodes.push(unavailable('Network', errors.network));
    connection.replaceChildren(...nodes);
    updateWifiLabels();
  });
}

function renderPower(root) {
  const stats = element('div', undefined, 'power-stats');
  root.append(stats);
  let capacity = null;
  let disposed = false;
  onPopupSessionEnd(() => { disposed = true; });
  void zebar.shellExec('powershell.exe', batteryCapacityArgs).then(result => {
    if (disposed || result.code !== 0) return;
    const value = JSON.parse(result.stdout);
    capacity = Number.isFinite(value) && value > 0 ? value / 1000 : null;
    update(group.outputMap, group.errorMap);
  }).catch(() => {}); // Unsupported firmware/WMI data remains unavailable.
  const group = subscribe({
    battery: { type: 'battery', refreshInterval: 15000 },
  }, update);
  function update(output, errors) {
    const nodes = [];
    const battery = output.battery;
    const charge = Number.isFinite(battery?.chargePercent) && battery.chargePercent >= 0 && battery.chargePercent <= 100
      ? battery.chargePercent : null;
    const state = charge === null ? 'No battery data' : battery.isCharging ? 'Soaking amps'
      : battery.state ? String(battery.state).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
        : 'Battery status unavailable';
    const heading = hero('battery-outline', 'Battery', state.toUpperCase(), charge === null ? '—' : percent(charge));
    heading.classList.add('power-hero');
    heading.querySelector('.hero__title').id = 'power-title';
    const icon = createBatteryIcon();
    const fill = icon.querySelector('.battery__fill');
    const fillHeight = 14 * (charge ?? 0) / 100;
    fill.setAttribute('height', String(fillHeight));
    fill.setAttribute('y', String(20 - fillHeight));
    icon.querySelector('.battery__bolt').style.display = charge !== null && battery.isCharging ? '' : 'none';
    icon.querySelector('.battery__unknown').style.display = charge === null ? '' : 'none';
    heading.querySelector('.hero__icon').replaceChildren(icon);
    nodes.push(heading);
    if (charge !== null) {
      const progress = meter(charge);
      progress.classList.add('battery-progress');
      progress.dataset.charging = String(battery.isCharging === true);
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', 'Battery charge');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.setAttribute('aria-valuenow', String(charge));
      nodes.push(progress, details(batteryDetails(battery, capacity), 'power-details battery-details'));
      if (errors.battery) nodes.push(unavailable('Battery', errors.battery));
    } else {
      nodes.push(element('p', errors.battery
        ? `No battery data: ${errors.battery.message ?? errors.battery}`
        : 'No battery data reported (desktop PCs may have no battery).', errors.battery ? 'error' : 'note'));
    }

    stats.replaceChildren(...nodes);
  }
}

export function renderSystemPopup(type, reportError) {
  const root = document.getElementById('system-content');
  const renderers = { audio: renderAudio, network: renderNetwork, globalprotect: renderGlobalProtect, bluetooth: renderBluetooth, display: renderDisplay, power: renderPower };
  if (!Object.hasOwn(renderers, type)) throw new Error(`Unknown system popup: ${type}`);
  document.documentElement.dataset.popupType = type;
  const omarchyPanel = ['audio', 'network', 'globalprotect', 'bluetooth', 'display', 'power'].includes(type);
  document.querySelector('header').hidden = omarchyPanel;
  document.querySelector('main').setAttribute('aria-labelledby', omarchyPanel ? `${type}-title` : 'month-label');
  document.getElementById('month-label').textContent = {
    audio: 'Audio', network: 'Network', globalprotect: 'GlobalProtect', bluetooth: 'Bluetooth', display: 'Displays', power: 'Battery',
  }[type];
  let disposed = false;
  onPopupSessionEnd(() => { disposed = true; });
  return renderers[type](root, error => { if (!disposed) reportError(error); });
}
