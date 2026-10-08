import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startBluetoothBackground, bluetoothBackgroundPermission } from '../widgets/shared/bluetooth-background.mjs';
import { bluetoothArgs, bluetoothCacheKey, cachedBluetoothSnapshot, cacheBluetoothSnapshot } from '../widgets/shared/bluetooth-model.mjs';

function memory() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const snapshot = { available: true, enabled: true, devices: [
  { id: 'known', name: 'Keyboard', paired: true, connected: false },
  { id: 'nearby', name: 'Mouse', paired: false, connected: false },
] };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Bluetooth background permission permits status only and is installed on the bar', async () => {
  const regex = new RegExp(bluetoothBackgroundPermission.argsRegex);
  assert(regex.test(bluetoothArgs('status').join(' ')));
  for (const action of ['scan', 'on', 'off', 'pair', 'connect', 'disconnect', 'forget']) {
    assert(!regex.test(bluetoothArgs(action, 'id').join(' ')), action);
  }
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  assert(pack.widgets.find(w => w.name === 'bar').privileges.shellCommands.some(p => p.argsRegex === bluetoothBackgroundPermission.argsRegex));
});

test('Bluetooth polls known status immediately and every 30 seconds with one monitor owner', async () => {
  const storage = memory();
  const callbacks = [];
  const calls = [];
  let time = 1000;
  const options = { storage, now: () => time, schedule: (cb, interval) => { assert.equal(interval, 30000); callbacks.push(cb); return cb; }, cancel: () => {} };
  const exec = async (program, args) => { calls.push([program, args]); return { code: 0, stdout: JSON.stringify(snapshot) }; };
  const stop = startBluetoothBackground(exec, options);
  const stopOther = startBluetoothBackground(exec, options);
  await tick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['powershell.exe', bluetoothArgs('status')]);
  assert.deepEqual(cachedBluetoothSnapshot(storage).devices, [snapshot.devices[0]]);
  time += 30000;
  callbacks.forEach(cb => cb());
  await tick();
  assert.equal(calls.length, 2);
  stop();
  time += 30000;
  callbacks[1]();
  await tick();
  assert.equal(calls.length, 3, 'Another monitor takes over after the owner stops.');
  stopOther();
});

test('Bluetooth background reads do not overlap or overwrite a newer popup cache', async () => {
  const storage = memory();
  let refresh;
  let resolve;
  let calls = 0;
  const stop = startBluetoothBackground(() => { calls++; return new Promise(r => { resolve = r; }); }, {
    storage, schedule: cb => { refresh = cb; return 1; }, cancel: () => {},
  });
  refresh();
  assert.equal(calls, 1);
  const newer = { ...snapshot, devices: [{ ...snapshot.devices[0], connected: true }] };
  cacheBluetoothSnapshot(storage, newer);
  resolve({ code: 0, stdout: JSON.stringify(snapshot) });
  await tick();
  assert.deepEqual(cachedBluetoothSnapshot(storage), newer);
  refresh();
  stop();
  resolve({ code: 0, stdout: JSON.stringify(snapshot) });
  await tick();
  assert.deepEqual(cachedBluetoothSnapshot(storage), newer, 'Disposed reads cannot update the cache.');
});

test('Bluetooth background failures retain cached devices and blocked storage skips polling', async () => {
  const storage = memory();
  cacheBluetoothSnapshot(storage, snapshot);
  const before = storage.getItem(bluetoothCacheKey);
  const warnings = [];
  const stop = startBluetoothBackground(async () => ({ code: 1, stderr: 'Access denied' }), {
    storage, schedule: () => 1, cancel: () => {}, warn: (...args) => warnings.push(args),
  });
  await tick();
  assert.equal(warnings.length, 1);
  assert.equal(storage.getItem(bluetoothCacheKey), before);
  stop();
  const blocked = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } };
  const stopBlocked = startBluetoothBackground(assert.fail, { storage: blocked, schedule: () => 1, cancel: () => {} });
  await tick();
  stopBlocked();
});
