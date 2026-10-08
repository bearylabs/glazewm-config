import assert from 'node:assert/strict';
import test from 'node:test';
import { startNetworkBackground } from '../widgets/shared/network-background.mjs';
import { startBluetoothBackground } from '../widgets/shared/bluetooth-background.mjs';
import { withPollingLease } from '../widgets/shared/snapshot-cache.mjs';
import { testLocks } from './locks.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));

for (const [name, start, leaseKey, expectedCalls] of [
  ['Network', (exec, options) => startNetworkBackground(exec, () => null, options), 'winarchy.network.poller.v1', 2],
  ['Bluetooth', startBluetoothBackground, 'winarchy.bluetooth.poller.v1', 1],
]) {
  test(`${name} serializes competing lease reads before any native query`, async () => {
    const values = new Map();
    const locks = testLocks();
    let interleave = true;
    let stopOther;
    let calls = 0;
    const storage = {
      getItem(key) {
        const value = values.get(key) ?? null;
        if (key === leaseKey && interleave) {
          interleave = false;
          stopOther = start(exec, options);
        }
        return value;
      },
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
    };
    const exec = async (_program, args) => {
      calls++;
      return { code: 0, stdout: args[3].includes('class BluetoothMenu')
        ? '{"available":true,"enabled":true,"devices":[]}'
        : args[3].includes('GetIPv4Statistics') ? '[]' : '{"available":true,"connected":false}' };
    };
    const options = { storage, locks, now: () => 1000, schedule: () => 1, cancel() {} };
    const stop = start(exec, options);
    await settle();
    assert.equal(calls, expectedCalls);
    await stop();
    await stopOther();
  });
}

test('polling locks remain held through native completion even after lease expiry', async () => {
  const locks = testLocks();
  let finish;
  let calls = 0;
  const first = withPollingLease('test.poller', 'first', 1, () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, { storage: null, locks });
  await settle();
  await withPollingLease('test.poller', 'other', 1, () => { calls++; }, { storage: null, locks });
  assert.equal(calls, 1);
  finish();
  await first;
});

test('missing Web Locks rejects background ownership rather than racing', async () => {
  await assert.rejects(withPollingLease('test.poller', 'owner', 90000, assert.fail, {
    locks: null,
  }), /Web Locks are required/);
});
