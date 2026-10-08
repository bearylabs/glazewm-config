import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { outputVolumeName, selectOutputDevice } from '../shared/audio-model.mjs';
import { createAudioClient } from '../shared/audio-bridge.mjs';
import { createIcon } from '../shared/icons.mjs';
import { percent } from '../shared/system-model.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';
import { element, button, hero } from './dom.mjs';

export function renderAudio(root, reportError) {
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
