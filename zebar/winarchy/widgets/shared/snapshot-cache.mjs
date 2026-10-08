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
  return value && Number.isFinite(value.time) && value.snapshot && typeof value.snapshot.id === 'string' &&
    Number.isFinite(value.snapshot.received) && Number.isFinite(value.snapshot.sent) &&
    Array.isArray(value.entries) && value.entries.length === 8 && value.entries.every(entry =>
      Array.isArray(entry) && entry.length === 2 && entry.every(part => typeof part === 'string'));
}
