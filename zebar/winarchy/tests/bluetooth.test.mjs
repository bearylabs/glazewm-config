import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { bluetoothAudioSource } from '../widgets/shared/bluetooth-audio-native.mjs';
import test from 'node:test';
import { bluetoothArgs, bluetoothArgsRegex, bluetoothGroups, executeBluetooth, mergeBluetoothSnapshot, cachedBluetoothSnapshot, cacheBluetoothSnapshot, bluetoothCacheKey, bluetoothSettingsPermission, openBluetoothSettings } from '../widgets/shared/bluetooth-model.mjs';

test('Bluetooth groups connected, paired and available devices, excluding unnamed endpoints', () => {
  const connected = { id: '1', name: 'Headset', paired: true, connected: true };
  const paired = { id: '2', name: 'Keyboard', paired: true };
  const available = { id: '3', name: 'Mouse' };
  assert.deepEqual(bluetoothGroups([available, paired, connected, { id: '4', name: '' }]), {
    connected: [connected], paired: [paired], available: [available],
  });
  assert.deepEqual(bluetoothGroups(), { connected: [], paired: [], available: [] });
});

test('discovery replaces only available devices and never overwrites paired state', () => {
  const known = { id: 'known', name: 'Headset', paired: true, connected: true };
  const old = { id: 'old', name: 'Old nearby device' };
  const nearby = { id: 'new', name: 'New nearby device' };
  const state = { available: true, enabled: true, devices: [known, old] };
  const snapshot = { available: true, enabled: true, devices: [nearby, { ...known, paired: false, connected: false }] };
  const merged = mergeBluetoothSnapshot(state, snapshot, true);
  assert.deepEqual(merged.devices, [known, nearby]);
  assert.equal(merged.devices[0], known, 'Known device identity must survive scans.');
  assert.deepEqual(mergeBluetoothSnapshot(merged, { ...snapshot, devices: [] }, true).devices, [known]);
  const updated = { ...known, connected: false };
  assert.deepEqual(mergeBluetoothSnapshot(merged, { ...snapshot, devices: [updated] }).devices, [updated, nearby]);
  assert.deepEqual(mergeBluetoothSnapshot(merged, { ...snapshot, enabled: false, devices: [updated] }).devices, [updated]);
});

test('paired cache is immediate, excludes nearby devices and tolerates invalid or blocked storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(cachedBluetoothSnapshot(storage), null);
  const known = { id: 'known', name: 'Keyboard', paired: true, connected: false };
  const state = { available: true, enabled: true, devices: [known, { id: 'nearby', name: 'Mouse' }] };
  cacheBluetoothSnapshot(storage, state);
  assert.deepEqual(cachedBluetoothSnapshot(storage), { ...state, devices: [known] });
  values.set(bluetoothCacheKey, 'broken JSON');
  assert.equal(cachedBluetoothSnapshot(storage), null);
  values.set(bluetoothCacheKey, JSON.stringify({ devices: [] }));
  assert.equal(cachedBluetoothSnapshot(storage), null);
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.equal(cachedBluetoothSnapshot(blocked), null);
  assert.doesNotThrow(() => cacheBluetoothSnapshot(blocked, state));
});

test('Bluetooth permission matches fixed scripts and encoded IDs but rejects injected commands', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const permission = pack.widgets.find(w => w.name === 'popup').privileges.shellCommands.find(p => p.argsRegex === bluetoothArgsRegex());
  assert.deepEqual(permission, { program: 'powershell.exe', argsRegex: bluetoothArgsRegex() });
  const allowed = new RegExp(permission.argsRegex);
  for (const action of ['status', 'scan', 'on', 'off', 'pair', 'connect', 'disconnect', 'forget']) {
    const args = bluetoothArgs(action, 'Bluetooth#device-ä😀\'; Stop-Process');
    assert(allowed.test(args.join(' ')), action);
    assert(!allowed.test(args.join(' ') + '; Stop-Process'));
  }
  assert(!allowed.test('-NoProfile -NonInteractive -Command Get-Process'));
  assert.throws(() => bluetoothArgs('arbitrary', 'id'), /Invalid Bluetooth action/);
  assert.throws(() => bluetoothArgs('pair', ''), /Invalid Bluetooth device ID/);
  assert.throws(() => bluetoothArgs('pair', 'x'.repeat(2049)), /Invalid Bluetooth device ID/);
});

test('Bluetooth execution decodes snapshots and surfaces native errors and malformed data', async () => {
  const state = { available: true, enabled: true, devices: [] };
  assert.deepEqual(await executeBluetooth(async (program, args) => {
    assert.equal(program, 'powershell.exe');
    assert.deepEqual(args, bluetoothArgs('scan'));
    return { code: 0, stdout: '\uFEFF' + JSON.stringify(state) };
  }, 'scan'), state);
  assert.equal(await executeBluetooth(async () => ({ code: 0 }), 'connect', 'id'), null);
  await assert.rejects(executeBluetooth(async () => ({ code: 1, stderr: 'Access denied' }), 'off'), /Access denied/);
  await assert.rejects(executeBluetooth(async () => ({ code: 0, stdout: 'bad' }), 'status'), SyntaxError);
});

test('audio reconnect uses valid SDK interfaces and verifies active endpoints', () => {
  for (const match of bluetoothAudioSource.matchAll(/(?:Guid\(|new Guid\()"([^"]+)"/g)) {
    assert.match(match[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  }
  assert(bluetoothAudioSource.includes('7FA06C40-B8F6-4C7E-8556-E8C33A12E54D'));
  assert(bluetoothAudioSource.includes('id = connect ? 0u : 1u, flags = 1'));
  assert(bluetoothAudioSource.includes('if (IsConnected(address) == connect) return true;'));
  assert(bluetoothAudioSource.includes('throw new TimeoutException'));
  const command = bluetoothArgs('connect', 'device')[3];
  assert(command.includes('BluetoothAudio.Request(address, action != "disconnect")'));
  assert(command.includes('connected = LiveConnected(d)'));
  assert(!command.includes('BluetoothSetServiceState'), 'Connecting must never disable/install Bluetooth profiles.');
  assert(!command.includes('BluetoothEnumerateInstalledServices'));
  assert(command.includes('[Console]::Error.WriteLine($_.Exception.GetBaseException().Message)'));
  assert(command.includes('Windows has no usable Bluetooth audio endpoint'));
  assert(command.indexOf('if (Connected(d)) return true;') < command.indexOf('BluetoothAudio.ConnectionStatus(address)'));
  assert(!command.includes('if (audio.HasValue) return audio.Value;'), 'Old audio endpoints must not override a connected AEP.');
  assert(bluetoothAudioSource.includes('previous == 1 ? previous : state'), 'Active endpoints must win over stale duplicates.');
});

test('recovery settings launcher has one narrowly allowed URI and reports failures', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const permission = pack.widgets.find(w => w.name === 'popup').privileges.shellCommands.find(p => p.argsRegex === bluetoothSettingsPermission.argsRegex);
  assert.deepEqual(permission, bluetoothSettingsPermission);
  assert(new RegExp(permission.argsRegex).test('ms-settings:bluetooth'));
  for (const args of ['ms-settings:bluetooth extra', 'ms-settings:appsfeatures', 'cmd.exe', 'ms-settings:bluetooth; shutdown /s']) {
    assert(!new RegExp(permission.argsRegex).test(args));
  }
  const calls = [];
  await openBluetoothSettings(async (...args) => { calls.push(args); return { code: 0 }; });
  assert.deepEqual(calls, [['explorer.exe', ['ms-settings:bluetooth']]]);
  await assert.rejects(openBluetoothSettings(async () => ({ code: 1, stderr: 'Settings unavailable' })), /Settings unavailable/);
});

test('stalled Bluetooth queries time out instead of keeping the popup loading', async () => {
  await assert.rejects(executeBluetooth(() => new Promise(() => {}), 'status', undefined, 5), /timed out/);
  await assert.rejects(executeBluetooth(() => new Promise(() => {}), 'scan', undefined, 5), /timed out/);
});

// Opt-in, read-only Windows integration test: exercise the exact -Command invocation,
// not a temporary -File script, and bound runtime even if a native API stalls.
test('Windows inline Bluetooth status returns a bounded snapshot', {
  skip: process.env.RUN_WINDOWS_BLUETOOTH_TEST !== '1', timeout: 25000,
}, async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', bluetoothArgs('status'), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Native Bluetooth status stalled.')); }, 20000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  assert.equal(typeof snapshot.available, 'boolean');
  assert.equal(typeof snapshot.enabled, 'boolean');
  assert(Array.isArray(snapshot.devices));
  assert(snapshot.devices.every(device => device.paired), 'Status must enumerate only paired devices.');
  if (process.env.EXPECT_CONNECTED_BLUETOOTH_ADDRESS) {
    const normalize = address => address.replace(/[:-]/g, '').toLowerCase();
    const device = snapshot.devices.find(d => normalize(d.address) === normalize(process.env.EXPECT_CONNECTED_BLUETOOTH_ADDRESS));
    assert(device?.connected, 'The connected Windows device must be reported as connected.');
  }
});
