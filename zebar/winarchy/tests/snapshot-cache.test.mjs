import test from 'node:test';
import assert from 'node:assert/strict';
import { readSnapshot, writeSnapshot, clearSnapshot, snapshotCacheMaxAge, vpnSnapshotValid, networkSnapshotValid, trafficSnapshotValid } from '../widgets/shared/snapshot-cache.mjs';
function storage() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
}
test('snapshots survive reopening, expire, and reject future timestamps', () => {
  const store = storage(); const value = { available: true, connected: false };
  writeSnapshot('vpn', value, store, 1000);
  assert.deepEqual(readSnapshot('vpn', vpnSnapshotValid, store, 2000), value);
  assert.equal(readSnapshot('vpn', vpnSnapshotValid, store, 1000 + snapshotCacheMaxAge + 1), null);
  assert.equal(readSnapshot('vpn', vpnSnapshotValid, store, 999), null);
  clearSnapshot('vpn', store);
  assert.equal(readSnapshot('vpn', vpnSnapshotValid, store, 2000), null);
});
test('malformed and unavailable storage never prevents live updates', () => {
  const store = storage(); store.setItem('vpn', 'not json');
  assert.equal(readSnapshot('vpn', vpnSnapshotValid, store), null);
  writeSnapshot('vpn', {}, store);
  assert.equal(readSnapshot('vpn', vpnSnapshotValid, store), null);
  const denied = { getItem() { throw new Error(); }, setItem() { throw new Error(); }, removeItem() { throw new Error(); } };
  assert.equal(readSnapshot('vpn', vpnSnapshotValid, denied), null);
  assert.doesNotThrow(() => writeSnapshot('vpn', {}, denied));
  assert.doesNotThrow(() => clearSnapshot('vpn', denied));
});
test('network caches validate the data needed for rendering', () => {
  assert(vpnSnapshotValid({ available: true, connected: false }));
  assert(!vpnSnapshotValid({ available: true, connected: 'yes' }));
  assert(networkSnapshotValid({ defaultInterface: { type: 'wifi', ipv4Addresses: ['10.0.0.1'] }, interfaces: [] }));
  assert(!networkSnapshotValid({ defaultInterface: { ipv4Addresses: 'bad' }, interfaces: [] }));
  assert(!networkSnapshotValid({}));
  assert(trafficSnapshotValid({ time: 1, snapshot: { id: 'wifi', ipv4Addresses: ['10.0.0.2'], received: 1, sent: 2 }, entries: Array.from({ length: 8 }, () => ['Ping', '--']) }));
  assert(!trafficSnapshotValid({ time: 1, snapshot: {}, entries: [] }));
});
