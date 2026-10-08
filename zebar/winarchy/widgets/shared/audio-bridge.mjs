// Only persistent bars own Zebar's native audio provider. Stopping a popup's
// identical provider config stops the shared backend and leaves native callbacks
// dangling in Zebar 3.3.1. Never create/stop/restart that provider in a popup.
const channelName = 'winarchy.audio.v1';
const id = () => globalThis.crypto.randomUUID();
const message = error => error ? String(error.message ?? error) : null;

function snapshot(audio, error) {
  return {
    audio: audio && !error ? {
      playbackDevices: audio.playbackDevices ?? [],
      defaultPlaybackDevice: audio.defaultPlaybackDevice ?? null,
    } : null,
    error: message(error),
  };
}

export function createAudioOwner(read, {
  channel = new BroadcastChannel(channelName), ownerId = id(),
} = {}) {
  let closed = false;
  let previous;
  const send = data => { if (!closed) channel.postMessage({ ...data, ownerId }); };
  function publish(force = false) {
    const { audio, error } = read();
    const state = snapshot(audio, error);
    const signature = JSON.stringify(state);
    if (force || signature !== previous) {
      previous = signature;
      send({ type: 'state', ...state });
    }
  }
  channel.onmessage = async ({ data }) => {
    if (closed || !data) return;
    if (data.type === 'read') { publish(true); return; }
    if (data.type !== 'command' || data.ownerId !== ownerId || typeof data.requestId !== 'string') return;
    try {
      const { audio, error } = read();
      if (error || !audio) throw new Error(message(error) ?? 'Audio provider unavailable.');
      // A queued slider command must not act on a different or removed device.
      if (!audio.playbackDevices?.some(device => device.deviceId === data.deviceId)) {
        throw new Error('Output device is no longer connected.');
      }
      if (data.action === 'volume' && Number.isFinite(data.value) && data.value >= 0 && data.value <= 100) {
        await audio.setVolume(data.value, { deviceId: data.deviceId });
      } else if (data.action === 'mute' && typeof data.value === 'boolean') {
        await audio.setMute(data.value, { deviceId: data.deviceId });
      } else {
        throw new Error('Invalid audio command.');
      }
      publish(true);
      send({ type: 'result', requestId: data.requestId, error: null });
    } catch (error) {
      send({ type: 'result', requestId: data.requestId, error: message(error) });
    }
  };
  return {
    publish,
    close() {
      if (closed) return;
      // Transport cleanup only: intentionally never stop the native provider.
      send({ type: 'gone' });
      closed = true;
      channel.onmessage = null;
      channel.close();
    },
  };
}

export function createAudioClient(render, {
  channel = new BroadcastChannel(channelName), requestId = id,
  now = Date.now, schedule = setInterval, cancel = clearInterval,
  delay = setTimeout, clearDelay = clearTimeout,
  refreshInterval = 2000, staleAfter = 6000, commandTimeout = 5000,
} = {}) {
  let closed = false;
  let ownerId = null;
  let lastSeen = now();
  let audio = null;
  let error = null;
  const pending = new Map();
  const update = () => { if (!closed) render({ audio }, { audio: error }); };
  function finish(key, failure) {
    const task = pending.get(key);
    if (!task) return;
    pending.delete(key);
    clearDelay(task.timer);
    if (failure) task.reject(new Error(failure)); else task.resolve();
  }
  function loseOwner() {
    ownerId = null;
    audio = null;
    error = 'Audio bar unavailable. Open or restart the bar; no popup provider was started.';
    for (const key of pending.keys()) finish(key, 'Audio bar disconnected. Check the volume before retrying.');
    update();
  }
  function command(action, value, options) {
    if (closed || !ownerId || !audio || error) return Promise.reject(new Error('Audio bar unavailable.'));
    const deviceId = options?.deviceId ?? audio.defaultPlaybackDevice?.deviceId;
    const key = requestId();
    return new Promise((resolve, reject) => {
      const timer = delay(() => finish(key, 'Audio command timed out. Check the volume before retrying.'), commandTimeout);
      pending.set(key, { resolve, reject, timer, ownerId });
      try { channel.postMessage({ type: 'command', ownerId, requestId: key, action, value, deviceId }); }
      catch (error) { finish(key, message(error)); }
    });
  }
  channel.onmessage = ({ data }) => {
    if (closed || !data || typeof data.ownerId !== 'string') return;
    if (data.type === 'state') {
      // Pin to one responding bar: commands execute once on multi-monitor setups.
      if (ownerId && ownerId !== data.ownerId) return;
      ownerId = data.ownerId;
      lastSeen = now();
      error = data.error;
      audio = data.audio ? {
        ...data.audio,
        setVolume: (value, options) => command('volume', value, options),
        setMute: (value, options) => command('mute', value, options),
      } : null;
      update();
    } else if (data.type === 'result' && pending.get(data.requestId)?.ownerId === data.ownerId) {
      finish(data.requestId, data.error);
    } else if (data.type === 'gone' && ownerId === data.ownerId) {
      loseOwner();
      channel.postMessage({ type: 'read' });
    }
  };
  const refresh = () => {
    if (now() - lastSeen >= staleAfter) loseOwner();
    channel.postMessage({ type: 'read' });
  };
  const timer = schedule(refresh, refreshInterval);
  channel.postMessage({ type: 'read' });
  update();
  return {
    get outputMap() { return { audio }; },
    get errorMap() { return { audio: error }; },
    close() {
      if (closed) return;
      closed = true;
      cancel(timer);
      for (const key of pending.keys()) finish(key, 'Audio popup closed.');
      channel.onmessage = null;
      channel.close();
    },
  };
}
