import { bluetoothArgs, bluetoothCacheKey, cacheBluetoothSnapshot, executeBluetooth } from './bluetooth-model.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot } from './snapshot-cache.mjs';

// Status only: discovery, pairing and radio changes remain popup-only.
export const bluetoothBackgroundPermission = {
  program: 'powershell.exe',
  argsRegex: '^' + bluetoothArgs('status').join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
};

export function startBluetoothBackground(exec, { storage, interval = 30000, now = Date.now, schedule = setInterval, cancel = clearInterval, warn = console.warn } = {}) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* Optional cache. */ }
  }
  let busy = false;
  let stopped = false;
  const owner = globalThis.crypto?.randomUUID?.() ?? `${now()}-${Math.random()}`;
  const leaseKey = 'winarchy.bluetooth.poller.v1';
  const validLease = value => value && typeof value.owner === 'string' && Number.isFinite(value.until);
  const cacheValue = () => {
    try { return storage?.getItem(bluetoothCacheKey); } catch { return null; }
  };
  async function refresh() {
    if (busy || stopped || !storage) return;
    const lease = readSnapshot(leaseKey, validLease, storage, now());
    if (lease && lease.owner !== owner && lease.until > now()) return;
    writeSnapshot(leaseKey, { owner, until: now() + Math.max(90000, interval * 3) }, storage, now());
    if (readSnapshot(leaseKey, validLease, storage, now())?.owner !== owner) return;
    busy = true;
    const before = cacheValue();
    try {
      const snapshot = await executeBluetooth(exec, 'status');
      if (typeof snapshot?.available !== 'boolean' || typeof snapshot?.enabled !== 'boolean' || !Array.isArray(snapshot.devices)) {
        throw new Error('Invalid Bluetooth status.');
      }
      // Do not overwrite a newer popup result/action with a late background read.
      if (!stopped && cacheValue() === before) cacheBluetoothSnapshot(storage, snapshot);
    } catch (error) {
      if (!stopped) warn('Background Bluetooth status:', error.message ?? error);
    } finally { busy = false; }
  }
  void refresh();
  const timer = schedule(() => void refresh(), interval);
  return () => {
    stopped = true;
    cancel(timer);
    if (readSnapshot(leaseKey, validLease, storage, now())?.owner === owner) clearSnapshot(leaseKey, storage);
  };
}
