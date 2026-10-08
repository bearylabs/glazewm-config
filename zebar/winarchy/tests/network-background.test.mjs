import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startNetworkBackground, readBackgroundSnapshot, networkBackgroundPermissions } from '../widgets/shared/network-background.mjs';
import { readSnapshot, trafficSnapshotValid, vpnSnapshotValid } from '../widgets/shared/snapshot-cache.mjs';
import { globalProtectArgs } from '../widgets/shared/globalprotect-model.mjs';
import { testLocks } from './locks.mjs';
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
    assert(!args[3].includes('GetRadiosAsync'), 'background must not query Wi-Fi radio');
    if (args[3].includes('GetIPv4Statistics')) return { code: 0, stdout: JSON.stringify([{ id: 'wifi', ipv4Addresses: ['10.0.0.2'], received: calls.length * 15360, sent: calls.length * 7680, ping: 1, gateway: '10.0.0.1' }]) };
    return { code: 0, stdout: '{"available":true,"connected":false}' };
  };
  return { calls, exec };
}
test('background poller updates traffic and VPN without any open popup or radio queries', async () => {
  const storage = store(); let time = 1000; let tick; let canceled = false;
  const { exec, calls } = execFixture();
  const stop = startNetworkBackground(exec, () => network, { storage, locks: testLocks(), now: () => time, schedule: (fn, delay) => { assert.equal(delay, 30000); tick = fn; return 1; }, cancel: () => { canceled = true; } });
  await settle();
  assert.equal(calls.length, 2);
  time += 30000; tick(); await settle();
  assert.equal(calls.length, 4);
  const traffic = readSnapshot('winarchy.network.traffic.v2', trafficSnapshotValid, storage, time);
  assert.equal(Object.fromEntries(traffic.entries).Receiving, '1.0 KB/s');
  assert.equal(Object.fromEntries(traffic.entries)['IP Address'], '10.0.0.2');
  assert.equal(storage.getItem('winarchy.network.radio.v1'), null);
  assert.deepEqual(readBackgroundSnapshot('winarchy.network.vpn.v1', vpnSnapshotValid, storage, time), { available: true, connected: false });
  assert.equal(readBackgroundSnapshot('winarchy.network.vpn.v1', vpnSnapshotValid, storage, time + 35001), null);
  assert.deepEqual(readSnapshot('winarchy.network.vpn.v1', vpnSnapshotValid, storage, time), { available: true, connected: false });
  stop(); tick(); await settle(); assert(canceled); assert.equal(calls.length, 4);
  await settle();
  assert.equal(readBackgroundSnapshot('winarchy.network.vpn.v1', vpnSnapshotValid, storage, time), null);
});
test('multiple monitor bars elect one poller and a remaining bar can take over', async () => {
  const storage = store(); const { exec, calls } = execFixture(); let tick2;
  const options = { storage, locks: testLocks(), now: () => 1000, schedule: () => 1, cancel: () => {} };
  const stop1 = startNetworkBackground(exec, () => network, options);
  const stop2 = startNetworkBackground(exec, () => network, { ...options, schedule: fn => { tick2 = fn; return 2; } });
  await settle(); assert.equal(calls.length, 2);
  await stop1(); tick2(); await settle(); assert.equal(calls.length, 4); await stop2();
});
test('background permissions allow only exact read queries, never radio or VPN actions', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url)));
  assert.deepEqual(pack.widgets.find(w => w.name === 'bar').privileges.shellCommands.slice(2, 4), networkBackgroundPermissions);
  assert.equal(networkBackgroundPermissions.length, 2);
  const vpn = new RegExp(networkBackgroundPermissions[1].argsRegex);
  assert(vpn.test(globalProtectArgs('status').join(' ')));
  assert(!vpn.test(globalProtectArgs('connect').join(' ')));
});
