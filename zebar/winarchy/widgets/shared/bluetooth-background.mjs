import { bluetoothArgs, bluetoothCacheKey, cacheBluetoothSnapshot, executeBluetooth } from './bluetooth-model.mjs';
import { withPollingLease, releasePollingLease } from './snapshot-cache.mjs';

// Status only: discovery, pairing and radio changes remain popup-only.
export const bluetoothBackgroundPermission = {
  program: 'powershell.exe',
  argsRegex: '^' + bluetoothArgs('status').join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$',
};

export function startBluetoothBackground(exec, { storage, locks = globalThis.navigator?.locks, interval = 30000, now = Date.now, schedule = setInterval, cancel = clearInterval, warn = console.warn } = {}) {
  if (storage === undefined) {
    try { storage = globalThis.localStorage; } catch { /* Optional cache. */ }
  }
  let busy = false;
  let stopped = false;
  const owner = globalThis.crypto?.randomUUID?.() ?? `${now()}-${Math.random()}`;
  const leaseKey = 'winarchy.bluetooth.poller.v1';
  const cacheValue = () => {
    try { return storage?.getItem(bluetoothCacheKey); } catch { return null; }
  };
  async function refresh() {
    if (busy || stopped || !storage) return;
    busy = true;
    try {
      await withPollingLease(leaseKey, owner, Math.max(90000, interval * 3), async () => {
        if (stopped) return;
        const before = cacheValue();
        const snapshot = await executeBluetooth(exec, 'status');
        if (typeof snapshot?.available !== 'boolean' || typeof snapshot?.enabled !== 'boolean' || !Array.isArray(snapshot.devices)) {
          throw new Error('Invalid Bluetooth status.');
        }
        // Do not overwrite a newer popup result/action with a late background read.
        if (!stopped && cacheValue() === before) cacheBluetoothSnapshot(storage, snapshot);
      }, { storage, locks, now, requireStorage: true });
    } catch (error) {
      if (!stopped) warn('Background Bluetooth status:', error.message ?? error);
    } finally { busy = false; }
  }
  void refresh();
  const timer = schedule(() => void refresh(), interval);
  return () => {
    stopped = true;
    cancel(timer);
    return releasePollingLease(leaseKey, owner, { storage, locks, now }).catch(error => warn('Releasing Bluetooth poller:', error));
  };
}
