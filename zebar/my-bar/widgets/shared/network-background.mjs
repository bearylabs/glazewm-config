import { networkConnection, ipv4, linkRate } from './network-model.mjs';
import { networkStatsCommand, networkStatsArgsRegex, networkMetrics } from './network-stats.mjs';
import { executeGlobalProtect, globalProtectArgs } from './globalprotect-model.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot } from './snapshot-cache.mjs';

const exactPermission = args => '^' + args.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
// The bar can read status only. VPN actions remain popup-only.
export const networkBackgroundPermissions = [
  { program: 'powershell.exe', argsRegex: networkStatsArgsRegex },
  { program: 'powershell.exe', argsRegex: exactPermission(globalProtectArgs('status')) },
];

export function readBackgroundSnapshot(key, validate, storage, now = Date.now()) {
  const lease = readSnapshot('my-bar.network.poller.v1', value => value && typeof value.owner === 'string' && Number.isFinite(value.until), storage, now);
  return lease && lease.until > now ? readSnapshot(key, validate, storage, now, 35000) : null;
}

export function startNetworkBackground(exec, getNetwork, { storage, interval = 30000, now = Date.now, schedule = setInterval, cancel = clearInterval, onVpn = () => {} } = {}) {
  let busy = false;
  let stopped = false;
  let previous = null;
  let previousTime = 0;
  const owner = globalThis.crypto?.randomUUID?.() ?? `${now()}-${Math.random()}`;
  const leaseKey = 'my-bar.network.poller.v1';
  const validLease = value => value && typeof value.owner === 'string' && Number.isFinite(value.until);
  async function refresh() {
    if (busy || stopped) return;
    const lease = readSnapshot(leaseKey, validLease, storage, now());
    if (lease && lease.owner !== owner && lease.until > now()) return;
    writeSnapshot(leaseKey, { owner, until: now() + Math.max(90000, interval * 3) }, storage, now());
    const acquired = readSnapshot(leaseKey, validLease, storage, now());
    if (acquired && acquired.owner !== owner) return;
    busy = true;
    const net = getNetwork();
    if (net) writeSnapshot('my-bar.network.connection.v1', {
      defaultInterface: net.defaultInterface ?? null,
      interfaces: net.interfaces ?? [],
      defaultGateway: net.defaultGateway ?? null,
    }, storage, now());
    const queries = [
      (async () => {
        let timeout;
        let result;
        try {
          result = await Promise.race([
            exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', networkStatsCommand]),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Network statistics query timed out.')), 15000); }),
          ]);
        } finally { clearTimeout(timeout); }
        if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr || 'Network statistics unavailable.');
        const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
        if (stopped) return;
        const time = now();
        const { iface } = networkConnection(getNetwork());
        const entries = [
          ...networkMetrics(snapshot, previous, (time - previousTime) / 1000),
          ['IP Address', ipv4(iface) || '--'],
          ['Link rate', linkRate(iface) || '--'],
        ];
        if (snapshot) writeSnapshot('my-bar.network.traffic.v1', { snapshot, time, entries }, storage, time);
        else clearSnapshot('my-bar.network.traffic.v1', storage);
        previous = snapshot; previousTime = time;
      })(),
      executeGlobalProtect(exec, 'status').then(vpn => {
        if (!stopped) {
          writeSnapshot('my-bar.network.vpn.v1', vpn, storage, now());
          onVpn(vpn);
        }
      }),
    ];
    try {
      const results = await Promise.allSettled(queries);
      const keys = ['my-bar.network.traffic.v1', 'my-bar.network.vpn.v1'];
      results.forEach((result, index) => {
        if (!stopped && result.status === 'rejected') {
          clearSnapshot(keys[index], storage);
          if (index === 0) previous = null;
          else onVpn(null);
          console.warn('Background network status:', result.reason?.message ?? result.reason);
        }
      });
    } finally { busy = false; }
  }
  void refresh();
  const timer = schedule(() => void refresh(), interval);
  return () => {
    stopped = true; cancel(timer);
    if (readSnapshot(leaseKey, validLease, storage, now())?.owner === owner) clearSnapshot(leaseKey, storage);
  };
}
