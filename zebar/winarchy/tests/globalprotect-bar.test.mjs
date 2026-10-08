import test from 'node:test';
import assert from 'node:assert/strict';
import { startNetworkBackground } from '../widgets/shared/network-background.mjs';
import { testLocks } from './locks.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

test('VPN bar updates from live background status even when storage is unavailable', async () => {
  let tick;
  let vpn = { available: true, connected: false };
  let fail = false;
  const updates = [];
  const stop = startNetworkBackground(async (_program, args) => {
    if (args[3].includes('GetIPv4Statistics')) return { code: 0, stdout: '[]' };
    if (fail) return { code: 1, stderr: 'Unavailable' };
    return { code: 0, stdout: JSON.stringify(vpn) };
  }, () => null, {
    storage: null,
    locks: testLocks(),
    schedule: fn => { tick = fn; return 1; },
    cancel: () => {},
    onVpn: value => updates.push(value),
  });
  await settle();
  vpn = { available: true, connected: true };
  tick(); await settle();
  vpn = { available: false, connected: false };
  tick(); await settle();
  fail = true;
  tick(); await settle();
  assert.deepEqual(updates, [
    { available: true, connected: false },
    { available: true, connected: true },
    { available: false, connected: false },
    null,
  ]);
  stop(); tick(); await settle();
  assert.equal(updates.length, 4);
});
