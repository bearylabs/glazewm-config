import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createAudioOwner, createAudioClient } from '../widgets/shared/audio-bridge.mjs';

function harness() {
  const channels = new Set();
  let sequence = 0;
  let time = 0;
  const intervals = new Set();
  const deadlines = new Map();
  function channel() {
    const value = {
      onmessage: null,
      postMessage(data) {
        const copy = structuredClone(data); // Native functions must never leak into snapshots.
        for (const other of channels) if (other !== value) queueMicrotask(() => other.onmessage?.({ data: copy }));
      },
      close() { channels.delete(value); value.onmessage = null; },
    };
    channels.add(value);
    return value;
  }
  const options = () => ({
    channel: channel(), requestId: () => String(++sequence), now: () => time,
    schedule: fn => { intervals.add(fn); return fn; }, cancel: fn => intervals.delete(fn),
    delay: (fn, ms) => { const key = ++sequence; deadlines.set(key, { fn, at: time + ms }); return key; },
    clearDelay: key => deadlines.delete(key),
  });
  const calls = [];
  const device = { deviceId: 'speakers', name: 'Speakers', volume: 42, isMuted: false };
  const state = { audio: {
    playbackDevices: [device], defaultPlaybackDevice: device,
    async setVolume(value, options) { calls.push(['volume', value, options]); device.volume = value; },
    async setMute(value, options) { calls.push(['mute', value, options]); device.isMuted = value; },
  }, error: null };
  const owner = name => createAudioOwner(() => state, { channel: channel(), ownerId: name });
  const client = render => createAudioClient(render ?? (() => {}), options());
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return {
    owner, client, state, device, calls, channels, intervals, deadlines, flush,
    async advance(ms) {
      time += ms;
      for (const [key, task] of deadlines) if (task.at <= time) { deadlines.delete(key); task.fn(); }
      for (const fn of intervals) fn();
      await flush();
    },
  };
}

test('snapshots and volume/mute commands use the persistent owner', async () => {
  const h = harness();
  const owner = h.owner('bar');
  const seen = [];
  const client = h.client((output, errors) => seen.push([output.audio?.defaultPlaybackDevice?.volume, errors.audio]));
  await h.flush();
  assert.equal(client.outputMap.audio.defaultPlaybackDevice.volume, 42);
  const volume = client.outputMap.audio.setVolume(65, { deviceId: 'speakers' });
  await h.flush(); await volume;
  const mute = client.outputMap.audio.setMute(true, { deviceId: 'speakers' });
  await h.flush(); await mute;
  assert.deepEqual(h.calls, [['volume', 65, { deviceId: 'speakers' }], ['mute', true, { deviceId: 'speakers' }]]);
  assert.equal(client.outputMap.audio.defaultPlaybackDevice.isMuted, true);
  h.device.volume = 12; owner.publish(); await h.flush();
  assert.equal(client.outputMap.audio.defaultPlaybackDevice.volume, 12);
  assert(seen.length >= 4);
  client.close(); owner.close();
});

test('repeated popup closes release all transport resources, never the owner', async () => {
  const h = harness(); const owner = h.owner('bar');
  for (let i = 0; i < 20; i++) {
    let updates = 0;
    const client = h.client(() => updates++);
    await h.flush();
    assert.equal(client.outputMap.audio.defaultPlaybackDevice.volume, 42);
    client.close(); client.close();
    const count = updates;
    owner.publish(true); await h.flush();
    assert.equal(updates, count, 'Hidden sessions receive no updates');
    assert.equal(h.channels.size, 1);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.deadlines.size, 0);
  }
  owner.close(); assert.equal(h.channels.size, 0);
});

test('recording snapshots and commands use the same owner without touching output', async () => {
  const h = harness();
  const microphone = { deviceId: 'microphone', name: 'Microphone', volume: 35, isMuted: false };
  h.state.audio.recordingDevices = [microphone];
  h.state.audio.defaultRecordingDevice = microphone;
  h.state.audio.setVolume = async (value, options) => {
    h.calls.push(['volume', value, options]);
    microphone.volume = value;
  };
  h.state.audio.setMute = async (value, options) => {
    h.calls.push(['mute', value, options]);
    microphone.isMuted = value;
  };
  const owner = h.owner('bar'); const client = h.client(); await h.flush();
  assert.deepEqual(client.outputMap.audio.recordingDevices, [microphone]);
  assert.equal(client.outputMap.audio.defaultRecordingDevice.volume, 35);
  const volume = client.outputMap.audio.setVolume(68, { deviceId: 'microphone' });
  await h.flush(); await volume;
  const mute = client.outputMap.audio.setMute(true, { deviceId: 'microphone' });
  await h.flush(); await mute;
  assert.deepEqual(h.calls, [['volume', 68, { deviceId: 'microphone' }], ['mute', true, { deviceId: 'microphone' }]]);
  assert.equal(client.outputMap.audio.defaultRecordingDevice.isMuted, true);
  assert.equal(client.outputMap.audio.defaultPlaybackDevice.volume, 42);
  h.state.audio.recordingDevices = [];
  h.state.audio.defaultRecordingDevice = null;
  owner.publish(); await h.flush();
  assert.equal(client.outputMap.audio.defaultRecordingDevice, null);
  const removed = client.outputMap.audio.setVolume(10, { deviceId: 'microphone' });
  const rejection = assert.rejects(removed, /no longer connected/);
  await h.flush(); await rejection;
  assert.equal(h.calls.length, 2);
  client.close(); owner.close();
});

test('multiple monitor bars execute a command exactly once and permit owner handover', async () => {
  const h = harness(); const first = h.owner('first'); const second = h.owner('second');
  const client = h.client(); await h.flush();
  const pending = client.outputMap.audio.setMute(true); await h.flush(); await pending;
  assert.equal(h.calls.length, 1);
  first.close(); await h.flush();
  assert(client.outputMap.audio, 'Remaining bar answers immediately');
  const next = client.outputMap.audio.setVolume(20); await h.flush(); await next;
  assert.equal(h.calls.length, 2);
  client.close(); second.close();
});

test('provider errors and missing/removed devices disable or reject actions', async () => {
  const h = harness(); const owner = h.owner('bar'); const client = h.client(); await h.flush();
  const oldAudio = client.outputMap.audio;
  h.state.audio.playbackDevices = [];
  const removed = oldAudio.setVolume(15, { deviceId: 'speakers' });
  const rejection = assert.rejects(removed, /no longer connected/);
  await h.flush(); await rejection;
  assert.equal(h.calls.length, 0);
  h.state.error = new Error('Audio disconnected'); owner.publish(); await h.flush();
  assert.equal(client.errorMap.audio, 'Audio disconnected');
  await assert.rejects(oldAudio.setMute(true), /unavailable/);
  h.state.error = null; h.state.audio.defaultPlaybackDevice = null; owner.publish(); await h.flush();
  assert.equal(client.outputMap.audio.defaultPlaybackDevice, null);
  client.close(); owner.close();
});

test('invalid commands and native command failures are returned without retries', async () => {
  const h = harness(); const owner = h.owner('bar'); const client = h.client(); await h.flush();
  const invalid = client.outputMap.audio.setVolume(101);
  const invalidCheck = assert.rejects(invalid, /Invalid audio command/); await h.flush(); await invalidCheck;
  h.state.audio.setVolume = async () => { throw new Error('Volume command failed'); };
  const failed = client.outputMap.audio.setVolume(25);
  const failedCheck = assert.rejects(failed, /Volume command failed/); await h.flush(); await failedCheck;
  assert.equal(h.deadlines.size, 0);
  client.close(); owner.close();
});

test('pending commands time out once; late results and closed sessions are ignored', async () => {
  const h = harness(); const owner = h.owner('bar'); const client = h.client(); await h.flush();
  let complete;
  h.state.audio.setVolume = () => new Promise(resolve => { complete = resolve; });
  const pending = client.outputMap.audio.setVolume(25);
  const check = assert.rejects(pending, /timed out/); await h.flush(); await h.advance(5000); await check;
  assert.equal(h.deadlines.size, 0);
  complete(); await h.flush();
  const next = client.outputMap.audio.setVolume(30);
  const closedCheck = assert.rejects(next, /popup closed/); await h.flush(); client.close(); await closedCheck;
  complete(); await h.flush();
  assert.equal(h.intervals.size, 0); assert.equal(h.deadlines.size, 0);
  owner.close();
});

test('missing owner fails closed, then recovers without creating a native provider', async () => {
  const h = harness(); const client = h.client();
  await h.advance(6000);
  assert.equal(client.outputMap.audio, null);
  assert.match(client.errorMap.audio, /bar unavailable/);
  const owner = h.owner('new'); await h.advance(2000);
  assert(client.outputMap.audio);
  // Simulate abrupt bar loss (no goodbye message).
  for (const channel of [...h.channels].slice(1)) channel.close();
  await h.advance(6000);
  assert.equal(client.outputMap.audio, null);
  client.close(); owner.close();
});

test('popup source no longer subscribes to the shared native audio provider', async () => {
  const popup = await readFile(new URL('../widgets/popup/audio.mjs', import.meta.url), 'utf8');
  const bar = await readFile(new URL('../widgets/bar/bar.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(popup, /subscribe\(\{\s*audio:/);
  assert.match(popup, /createAudioClient/);
  assert.match(bar, /audio: \{ type: 'audio' \}/);
  assert.match(bar, /createAudioOwner/);
});
