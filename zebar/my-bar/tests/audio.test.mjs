import assert from 'node:assert/strict';
import test from 'node:test';
import { outputVolumeName, outputDeviceArgs, outputDeviceArgsRegex, selectOutputDevice } from '../widgets/shared/audio-model.mjs';

test('hero status matches Omarchy volume bands and muted state', () => {
  for (const [volume, expected] of [
    [0, 'Silenced'], [1, 'Whisper'], [14, 'Whisper'], [15, 'Murmur'],
    [29, 'Murmur'], [30, 'Easy listening'], [49, 'Easy listening'],
    [50, 'Steady groove'], [69, 'Steady groove'], [70, 'Cranked up'],
    [84, 'Cranked up'], [85, 'Party mode'], [99, 'Party mode'], [100, 'Concert hall'],
  ]) {
    assert.equal(outputVolumeName(volume, false), expected);
    assert.equal(outputVolumeName(volume, true), 'Muted');
  }
  assert.equal(outputVolumeName(undefined, false), 'Unavailable');
});

const id = '{0.0.0.00000000}.{12345678-1234-1234-1234-123456789abc}';
const audio = { playbackDevices: [{ deviceId: id }] };

test('output selection permits only the fixed Windows command and playback IDs', () => {
  const args = outputDeviceArgs(id);
  const permitted = new RegExp(outputDeviceArgsRegex());
  assert(permitted.test(args.join(' ')));
  assert(!permitted.test(args.join(' ') + '; Get-Process'));
  assert(!permitted.test(args.join(' ').replace('role < 3', 'role < 4')));
  assert(!permitted.test('-NoProfile -NonInteractive -Command Get-Process'));
  for (const value of ['', 'speakers', id + "'); Get-Process; ('", id.replace('0.0.0.', '0.0.1.')]) {
    assert.throws(() => outputDeviceArgs(value), /Invalid Windows playback device ID/);
  }
});

test('selection rechecks connected devices, sends the endpoint ID and surfaces native errors', async () => {
  const calls = [];
  await selectOutputDevice(async (...args) => { calls.push(args); return { code: 0 }; }, audio, id);
  assert.deepEqual(calls, [['powershell.exe', outputDeviceArgs(id)]]);
  await assert.rejects(selectOutputDevice(() => assert.fail('Must not execute'), { playbackDevices: [] }, id), /no longer connected/);
  await assert.rejects(selectOutputDevice(async () => ({ code: 1, stderr: 'Access denied' }), audio, id), /Access denied/);
});
