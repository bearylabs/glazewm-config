import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startNetworkBackground, readBackgroundSnapshot, networkBackgroundPermissions } from '../widgets/shared/network-background.mjs';
import { readSnapshot, trafficSnapshotValid, radioSnapshotValid, vpnSnapshotValid } from '../widgets/shared/snapshot-cache.mjs';
import { wifiRadioArgs } from '../widgets/shared/wifi-radio.mjs';
import { globalProtectArgs } from '../widgets/shared/globalprotect-model.mjs';
const settle = () => new Promise(resolve => setImmediate(resolve));
function store() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
}
const network = { defaultInterface: { type: 'wifi', ipv4Addresses: ['10.0.0.2'], receiveSpeed: 1e9 }, interfaces: [] };
function execFixture() {
  const calls = [];
  const exec = async (program, args) => {
    calls.push(args[3]);
    if (args[3].includes('GetIPv4Statistics')) return { code: 0, stdout: JSON.stringify({ id: 'wifi', received: calls.length * 10240, sent: calls.length * 5120, ping: 1, gateway: '10.0.0.1' }) };
    if (args[3].includes('GetRadiosAsync')) return { code: 0, stdout: '{"available":true,"enabled":true}' };
    return { code: 0, stdout: '{"available":true,"connected":false}' };
  };
  return { calls, exec };
}
test('background poller updates traffic, WLAN and VPN without any open popup', async () => {
  const storage = store(); let time = 1000; let tick; let canceled = false;
  const { exec, calls } = execFixture();
  const stop = startNetworkBackground(exec, () => network, { storage, now: () => time, schedule: (fn, delay) => { assert.equal(delay, 30000); tick = fn; return 1; }, cancel: () => { canceled = true; } });
  await settle();
  assert.equal(calls.length, 3);
  time += 30000; tick(); await settle();
  assert.equal(calls.length, 6);
  const traffic = readSnapshot('my-bar.network.traffic.v1', trafficSnapshotValid, storage, time);
  assert.equal(Object.fromEntries(traffic.entries).Receiving, '1.0 KB/s');
  assert.equal(Object.fromEntries(traffic.entries)['IP Address'], '10.0.0.2');
  assert.deepEqual(readSnapshot('my-bar.network.radio.v1', radioSnapshotValid, storage, time), { available: true, enabled: true });
  assert.deepEqual(readBackgroundSnapshot('my-bar.network.radio.v1', radioSnapshotValid, storage, time), { available: true, enabled: true });
  assert.equal(readBackgroundSnapshot('my-bar.network.radio.v1', radioSnapshotValid, storage, time + 35001), null);
  assert.deepEqual(readSnapshot('my-bar.network.vpn.v1', vpnSnapshotValid, storage, time), { available: true, connected: false });
  stop(); tick(); await settle(); assert(canceled); assert.equal(calls.length, 6);
  assert.equal(readBackgroundSnapshot('my-bar.network.radio.v1', radioSnapshotValid, storage, time), null);
});
test('multiple monitor bars elect one poller and a remaining bar can take over', async () => {
  const storage = store(); const { exec, calls } = execFixture(); let tick2;
  const options = { storage, now: () => 1000, schedule: () => 1, cancel: () => {} };
  const stop1 = startNetworkBackground(exec, () => network, options);
  const stop2 = startNetworkBackground(exec, () => network, { ...options, schedule: fn => { tick2 = fn; return 2; } });
  await settle(); assert.equal(calls.length, 3);
  stop1(); tick2(); await settle(); assert.equal(calls.length, 6); stop2();
});
test('background permissions allow only exact read queries, never power or VPN actions', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url)));
  assert.deepEqual(pack.widgets.find(w => w.name === 'bar').privileges.shellCommands.slice(2), networkBackgroundPermissions);
  const radio = new RegExp(networkBackgroundPermissions[1].argsRegex);
  assert(radio.test(wifiRadioArgs('status').join(' ')));
  assert(!radio.test(wifiRadioArgs('off').join(' ')));
  const vpn = new RegExp(networkBackgroundPermissions[2].argsRegex);
  assert(vpn.test(globalProtectArgs('status').join(' ')));
  assert(!vpn.test(globalProtectArgs('connect').join(' ')));
});
