import { networkStatsValid } from './network-stats.mjs';

// Short-lived, best-effort display cache. Native actions must verify live state.
export const snapshotCacheMaxAge = 120000;
function localStorageOrNull() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
export function readSnapshot(key, validate, storage = localStorageOrNull(), now = Date.now(), maxAge = snapshotCacheMaxAge) {
  try {
    const entry = JSON.parse(storage?.getItem(key));
    if (!entry || !Number.isFinite(entry.time) || entry.time > now || now - entry.time > maxAge || !validate(entry.value)) return null;
    return entry.value;
  } catch { return null; }
}
export function writeSnapshot(key, value, storage = localStorageOrNull(), now = Date.now()) {
  try { storage?.setItem(key, JSON.stringify({ time: now, value })); } catch { /* Disabled/full storage never prevents live updates. */ }
}
export function clearSnapshot(key, storage = localStorageOrNull()) {
  try { storage?.removeItem(key); } catch { /* Optional cache. */ }
}
const validLease = value => value && typeof value.owner === 'string' && Number.isFinite(value.until);
export async function withPollingLease(key, owner, duration, action, {
  storage, now = Date.now, locks = globalThis.navigator?.locks, requireStorage = false,
} = {}) {
  if (!locks) throw new Error('Web Locks are required for background polling.');
  return locks.request(`${key}:ownership`, { ifAvailable: true }, async lock => {
    if (!lock) return;
    const lease = readSnapshot(key, validLease, storage, now());
    if (lease && lease.owner !== owner && lease.until > now()) return;
    writeSnapshot(key, { owner, until: now() + duration }, storage, now());
    if (requireStorage && readSnapshot(key, validLease, storage, now())?.owner !== owner) return;
    await action();
  });
}
export async function releasePollingLease(key, owner, { storage, now = Date.now, locks = globalThis.navigator?.locks } = {}) {
  if (!locks) return;
  await locks.request(`${key}:ownership`, () => {
    if (readSnapshot(key, validLease, storage, now())?.owner === owner) clearSnapshot(key, storage);
  });
}
export function vpnSnapshotValid(value) {
  return value && typeof value.available === 'boolean' && typeof value.connected === 'boolean';
}
export function networkSnapshotValid(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'defaultInterface') || !Array.isArray(value.interfaces)) return false;
  const validInterface = iface => iface == null || (typeof iface === 'object' &&
    (iface.type == null || typeof iface.type === 'string') &&
    (iface.ipv4Addresses == null || (Array.isArray(iface.ipv4Addresses) && iface.ipv4Addresses.every(address => typeof address === 'string'))));
  return validInterface(value.defaultInterface) &&
    (value.interfaces == null || (Array.isArray(value.interfaces) && value.interfaces.every(validInterface))) &&
    (value.defaultGateway == null || typeof value.defaultGateway === 'object');
}
export function trafficSnapshotValid(value) {
  return value && Number.isFinite(value.time) && networkStatsValid(value.snapshot) &&
    Array.isArray(value.entries) && value.entries.length === 8 && value.entries.every(entry =>
      Array.isArray(entry) && entry.length === 2 && entry.every(part => typeof part === 'string'));
}
