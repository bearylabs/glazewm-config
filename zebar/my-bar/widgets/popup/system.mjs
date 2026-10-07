import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { availableMonitors, currentMonitor } from 'https://esm.sh/@tauri-apps/api@2.0.2/window';
import { networkConnection, linkRate } from '../shared/network-model.mjs';
import { outputVolumeName, selectOutputDevice } from '../shared/audio-model.mjs';
import { createBatteryIcon, createIcon } from '../shared/icons.mjs';
import { diskUsage, executePowerAction, gib, percent, powerCommands } from '../shared/system-model.mjs';

import { renderBluetooth } from './bluetooth.mjs';
import { renderGlobalProtect } from './globalprotect.mjs';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function details(entries, className = '') {
  const list = element('dl', undefined, className);
  for (const [label, value] of entries) {
    const item = element('div');
    item.append(element('dt', label), element('dd', value ?? 'Unavailable'));
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
  const update = () => render(group.outputMap, group.errorMap);
  group.onOutput(update);
  group.onError(update);
  window.addEventListener('pagehide', () => {
    group.stopAll().catch(error => console.error('Stopping popup providers:', error));
  }, { once: true });
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

  async function switchDevice(deviceId) {
    if (switchBusy || muteBusy) return;
    if (group.outputMap.audio?.defaultPlaybackDevice?.deviceId === deviceId) return;
    switchBusy = true;
    update(group.outputMap, group.errorMap);
    try {
      await volumeQueue;
      await selectOutputDevice(zebar.shellExec, group.outputMap.audio, deviceId);
    } catch (error) {
      reportError(error);
    } finally {
      switchBusy = false;
      update(group.outputMap, group.errorMap);
    }
  }

  function run(action) {
    muteBusy = true;
    mute.disabled = true;
    Promise.resolve().then(action).catch(reportError).finally(() => {
      muteBusy = false;
      update(group.outputMap, group.errorMap);
    });
  }

  function update(output, errors) {
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
  const group = subscribe({ audio: { type: 'audio' } }, update);
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
      if (group.outputMap.audio?.defaultPlaybackDevice?.deviceId !== device.deviceId) {
        throw new Error('Output device changed. Adjust volume again.');
      }
      await audio.setVolume(volume, { deviceId: device.deviceId });
    }).catch(reportError).finally(() => {
      pendingVolume--;
      if (!pendingVolume) update(group.outputMap, group.errorMap);
    });
  });
}

function renderNetwork(root, reportError) {
  const connection = element('div');
  root.append(connection);
  renderGlobalProtect(root, reportError);
  function heading(icon, title, meta) {
    const node = hero(icon, title, meta);
    node.classList.add('network-hero');
    const label = node.querySelector('.hero__title');
    label.id = 'network-title';
    label.title = title;
    return node;
  }
  function section(title, entries, state) {
    const node = element('section', undefined, 'network-section');
    const header = element('div', undefined, 'network-section__heading');
    header.append(element('h2', title));
    if (state) header.append(element('span', state, 'network-section__state'));
    node.append(header, details(entries, 'network-details'));
    return node;
  }
  subscribe({ network: { type: 'network', refreshInterval: 5000 } }, (output, errors) => {
    const net = output.network;
    if (!net) {
      connection.replaceChildren(heading('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE'), unavailable('Network', errors.network));
      return;
    }
    const { tunnel, iface, link } = networkConnection(net);
    const signal = net.defaultGateway?.signalStrength ?? iface?.signalStrength;
    const kind = link === 'none' ? 'No physical connection' : link === 'wifi' ? 'Wi-Fi' : 'Ethernet';
    const name = link === 'wifi' ? net.defaultGateway?.ssid || iface?.friendlyName || iface?.name : kind;
    const rate = linkRate(iface);
    const detail = link === 'wifi' && Number.isFinite(signal) ? percent(signal) : link === 'ethernet' ? rate : null;
    const nodes = [
      heading(link === 'wifi' ? 'wifi' : link === 'ethernet' ? 'ethernet' : 'wifi-off',
        detail ? `${name} (${detail})` : name || kind, link === 'none' ? 'NOT CONNECTED' : `${kind.toUpperCase()} CONNECTION`),
      section('Connection', [
        ['Link', kind],
        ['Adapter', iface?.friendlyName ?? iface?.name],
        ['Link rate', rate],
        ...(link === 'wifi' ? [['Signal', Number.isFinite(signal) ? `${percent(signal)} signal` : 'Unavailable']] : []),
      ]),
      section('Addresses', [
        ['IPv4', iface?.ipv4Addresses?.join('\n') || 'Unavailable'],
        ['IPv6', iface?.ipv6Addresses?.join('\n') || 'Unavailable'],
      ]),
    ];
    if (tunnel) {
      nodes.push(section('Company VPN', [
        ['Adapter', tunnel.friendlyName ?? tunnel.name],
        ['IPv4', tunnel.ipv4Addresses?.join('\n') || 'Unavailable'],
        ['IPv6', tunnel.ipv6Addresses?.join('\n') || 'Unavailable'],
      ], 'VPN active'));
    } else {
      const state = element('p', 'Physical default route', 'note network-direct');
      nodes.push(state);
    }
    if (errors.network) nodes.push(unavailable('Network', errors.network));
    nodes.push(element('p', 'Route details use the default route; GlobalProtect status below also detects split tunnels. This is not an internet reachability check.', 'note network-note'));
    connection.replaceChildren(...nodes);
  });
}

async function renderDisplay(root, reportError) {
  const content = element('div');
  let busy = false;
  const refresh = button('Refresh displays', () => void update());
  refresh.id = 'display-refresh';
  refresh.className = 'display-refresh';
  const summary = hero('monitor', 'Display', 'READ-ONLY OVERVIEW');
  summary.classList.add('display-hero');
  summary.querySelector('.hero__title').id = 'display-title';
  summary.append(refresh);
  root.append(summary, content);
  async function update() {
    if (busy) return;
    busy = true;
    refresh.disabled = true;
    content.setAttribute('aria-busy', 'true');
    try {
      const [monitors, current] = await Promise.all([availableMonitors(), currentMonitor()]);
      if (!monitors.length) throw new Error('No connected displays reported.');
      const nodes = [];
      if (current && Number.isFinite(current.scaleFactor)) {
        const scale = element('section', undefined, 'display-section display-scale');
        const scaleHeading = element('div', undefined, 'display-section__heading');
        scaleHeading.append(element('h2', 'Scale'));
        if (monitors.length > 1 && current.name) {
          const name = element('span', current.name, 'display-section__meta');
          name.title = current.name;
          scaleHeading.append(name);
        }
        const value = element('div', percent(current.scaleFactor * 100), 'display-scale__value');
        scale.append(scaleHeading, value);
        nodes.push(scale);
      }
      const displays = element('section', undefined, 'display-section');
      const displaysHeading = element('div', undefined, 'display-section__heading');
      displaysHeading.append(element('h2', 'Displays'), element('span',
        `${monitors.length} connected ${monitors.length === 1 ? 'display' : 'displays'}`, 'display-section__meta'));
      const list = element('div', undefined, 'display-list');
      displays.append(displaysHeading, list);
      for (const [index, monitor] of monitors.entries()) {
        const isCurrent = Boolean(current && monitor.position.x === current.position.x &&
          monitor.position.y === current.position.y && monitor.size.width === current.size.width &&
          monitor.size.height === current.size.height);
        const row = element('article', undefined, `display-row${isCurrent ? ' display-row--current' : ''}`);
        const heading = element('div', undefined, 'display-row__heading');
        const icon = element('span', undefined, 'display-row__icon');
        icon.append(createIcon('monitor'));
        const label = element('h3', monitor.name || `Display ${index + 1}`);
        label.title = label.textContent;
        heading.append(icon, label);
        if (isCurrent) heading.append(element('span', 'This bar', 'display-row__state'));
        row.append(heading, details([
          ['Resolution', `${monitor.size.width} x ${monitor.size.height}`],
          ['Scaling', percent(monitor.scaleFactor * 100)],
          ['Desktop position', `${monitor.position.x}, ${monitor.position.y}`],
          ['Orientation', monitor.size.height > monitor.size.width ? 'Portrait' : 'Landscape'],
        ], 'display-details'));
        list.append(row);
      }
      nodes.push(displays, element('p', 'Resolution and position are in physical pixels. Refresh rate, brightness and monitor model are not exposed by this API. No display settings are changed.', 'note display-note'));
      content.replaceChildren(...nodes);
    } catch (error) {
      content.replaceChildren(element('p', error.message ?? String(error), 'error'));
      reportError(error);
    } finally {
      busy = false;
      refresh.disabled = false;
      content.setAttribute('aria-busy', 'false');
    }
  }
  await update();
}

function renderPower(root, reportError) {
  const stats = element('div', undefined, 'power-stats');
  const actions = element('section', undefined, 'power-section power-actions');
  const controls = element('div', undefined, 'controls');
  actions.append(element('h2', 'Session'), controls);
  const confirmation = element('div');
  confirmation.id = 'power-confirmation';
  confirmation.hidden = true;
  const prompt = element('p');
  let pending = null;
  let timer;
  let busy = false;
  let origin;
  function cancel() {
    clearTimeout(timer);
    pending = null;
    confirmation.hidden = true;
    origin?.focus();
  }
  async function execute(action, confirmed = false) {
    if (busy) return;
    busy = true;
    for (const control of controls.children) control.disabled = true;
    yes.disabled = true;
    no.disabled = true;
    try {
      await executePowerAction(zebar.shellExec, action, confirmed);
    } catch (error) {
      reportError(error);
    } finally {
      busy = false;
      for (const control of controls.children) control.disabled = false;
      yes.disabled = false;
      no.disabled = false;
    }
  }
  const yes = button('Confirm', () => {
    const action = pending;
    cancel();
    if (action) void execute(action, true);
  });
  const no = button('Cancel', cancel);
  confirmation.append(prompt, yes, no);
  for (const [action, label] of [['lock', 'Lock'], ['logout', 'Log out'], ['shutdown', 'Shut down']]) {
    const control = button(label, () => {
      if (action === 'lock') {
        cancel();
        void execute(action);
        return;
      }
      origin = control;
      pending = action;
      prompt.textContent = powerCommands[action].confirmation;
      confirmation.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(cancel, 8000);
      no.focus();
    });
    controls.append(control);
  }
  root.append(stats, actions, confirmation);
  window.addEventListener('pagehide', () => clearTimeout(timer), { once: true });
  subscribe({
    battery: { type: 'battery', refreshInterval: 15000 },
    cpu: { type: 'cpu', refreshInterval: 3000 },
    memory: { type: 'memory', refreshInterval: 3000 },
    disk: { type: 'disk', refreshInterval: 60000 },
  }, (output, errors) => {
    const nodes = [];
    const battery = output.battery;
    const charge = Number.isFinite(battery?.chargePercent) && battery.chargePercent >= 0 && battery.chargePercent <= 100
      ? battery.chargePercent : null;
    const state = charge === null ? 'No battery data' : battery.isCharging ? 'Charging'
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
      nodes.push(progress, details([
        ['State', state],
        ['Health', percent(battery.healthPercent)],
      ], 'power-details battery-details'));
      if (errors.battery) nodes.push(unavailable('Battery', errors.battery));
    } else {
      nodes.push(element('p', errors.battery
        ? `No battery data: ${errors.battery.message ?? errors.battery}`
        : 'No battery data reported (desktop PCs may have no battery).', errors.battery ? 'error' : 'note'));
    }

    const system = element('section', undefined, 'power-section');
    system.append(element('h2', 'System'));
    const entries = [];
    if (output.cpu) {
      entries.push(['CPU', percent(output.cpu.usage)],
        ['CPU details', `${output.cpu.physicalCoreCount ?? 'Unavailable'} cores · ${Number.isFinite(output.cpu.frequency) ? `${output.cpu.frequency} MHz` : output.cpu.vendor ?? 'Unavailable'}`]);
    } else system.append(unavailable('CPU', errors.cpu));
    if (output.memory) {
      entries.push(['Memory', percent(output.memory.usage)],
        ['Memory used', `${gib(output.memory.usedMemory)} / ${gib(output.memory.totalMemory)}`]);
    } else system.append(unavailable('RAM', errors.memory));
    if (entries.length) system.append(details(entries, 'power-details'));
    nodes.push(system);

    const drives = element('section', undefined, 'power-section');
    drives.append(element('h2', 'Drives'));
    if (output.disk) {
      if (!output.disk.disks.length) drives.append(element('p', 'No mounted drives reported.', 'note'));
      for (const disk of output.disk.disks) {
        const usage = diskUsage(disk);
        const drive = element('div', undefined, 'power-drive');
        const line = element('div', undefined, 'power-drive__heading');
        const name = `${disk.mountPoint}  ${disk.name ?? disk.fileSystem ?? ''}`;
        const label = element('strong', name);
        label.title = name;
        line.append(label, element('span', `${percent(usage)} used`));
        drive.append(line);
        if (Number.isFinite(usage)) drive.append(meter(usage));
        drive.append(element('p', `${gib(disk.availableSpace?.bytes)} free of ${gib(disk.totalSpace?.bytes)}`, 'note'));
        drives.append(drive);
      }
    } else drives.append(unavailable('Drives', errors.disk));
    nodes.push(drives);
    stats.replaceChildren(...nodes);
  });
}

export function renderSystemPopup(type, reportError) {
  const root = document.getElementById('system-content');
  const renderers = { audio: renderAudio, network: renderNetwork, bluetooth: renderBluetooth, display: renderDisplay, power: renderPower };
  if (!Object.hasOwn(renderers, type)) throw new Error(`Unknown system popup: ${type}`);
  document.documentElement.dataset.popupType = type;
  const omarchyPanel = ['audio', 'network', 'bluetooth', 'display', 'power'].includes(type);
  document.querySelector('header').hidden = omarchyPanel;
  document.querySelector('main').setAttribute('aria-labelledby', omarchyPanel ? `${type}-title` : 'month-label');
  document.getElementById('month-label').textContent = {
    audio: 'Audio', network: 'Network', bluetooth: 'Bluetooth', display: 'Displays', power: 'Power & system',
  }[type];
  return renderers[type](root, reportError);
}
