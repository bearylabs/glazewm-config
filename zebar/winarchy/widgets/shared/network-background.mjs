import { networkConnection, ipv4, linkRate } from './network-model.mjs';
import { networkStatsCommand, networkStatsArgsRegex, networkMetrics, selectNetworkStats } from './network-stats.mjs';
import { executeGlobalProtect, globalProtectArgs } from './globalprotect-model.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot, withPollingLease, releasePollingLease } from './snapshot-cache.mjs';

const exactPermission = args => '^' + args.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
// The bar can read status only. VPN actions remain popup-only.
export const networkBackgroundPermissions = [
  { program: 'powershell.exe', argsRegex: networkStatsArgsRegex },
  { program: 'powershell.exe', argsRegex: exactPermission(globalProtectArgs('status')) },
];

export function readBackgroundSnapshot(key, validate, storage, now = Date.now()) {
  const lease = readSnapshot('winarchy.network.poller.v1', value => value && typeof value.owner === 'string' && Number.isFinite(value.until), storage, now);
  return lease && lease.until > now ? readSnapshot(key, validate, storage, now, 35000) : null;
}

export function startNetworkBackground(exec, getNetwork, { storage, locks = globalThis.navigator?.locks, interval = 30000, now = Date.now, schedule = setInterval, cancel = clearInterval, onVpn = () => {} } = {}) {
  let busy = false;
  let stopped = false;
  let previous = null;
  let previousTime = 0;
  const owner = globalThis.crypto?.randomUUID?.() ?? `${now()}-${Math.random()}`;
  const leaseKey = 'winarchy.network.poller.v1';
  async function poll() {
    if (stopped) return;
    const net = getNetwork();
    if (net) writeSnapshot('winarchy.network.connection.v1', {
      defaultInterface: net.defaultInterface ?? null,
      interfaces: net.interfaces ?? [],
      defaultGateway: net.defaultGateway ?? null,
    }, storage, now());
    const queries = [
      (async () => {
        const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', networkStatsCommand], {
          timeout: 15000, timeoutMessage: 'Network statistics query timed out.',
        });
        if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr || 'Network statistics unavailable.');
        const snapshots = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
        if (stopped) return;
        const time = now();
        const { iface } = networkConnection(getNetwork());
        const snapshot = selectNetworkStats(snapshots, iface);
        const entries = [
          ...networkMetrics(snapshot, previous, (time - previousTime) / 1000),
          ['IP Address', ipv4(iface) || '--'],
          ['Link rate', linkRate(iface) || '--'],
        ];
        if (snapshot) writeSnapshot('winarchy.network.traffic.v2', { snapshot, time, entries }, storage, time);
        else clearSnapshot('winarchy.network.traffic.v2', storage);
        previous = snapshot; previousTime = time;
      })(),
      executeGlobalProtect(exec, 'status').then(vpn => {
        if (!stopped) {
          writeSnapshot('winarchy.network.vpn.v1', vpn, storage, now());
          onVpn(vpn);
        }
      }),
    ];
    const results = await Promise.allSettled(queries);
    const keys = ['winarchy.network.traffic.v2', 'winarchy.network.vpn.v1'];
    results.forEach((result, index) => {
      if (!stopped && result.status === 'rejected') {
        clearSnapshot(keys[index], storage);
        if (index === 0) previous = null;
        else onVpn(null);
        console.warn('Background network status:', result.reason?.message ?? result.reason);
      }
    });
  }
  async function refresh() {
    if (busy || stopped) return;
    busy = true;
    try {
      await withPollingLease(leaseKey, owner, Math.max(90000, interval * 3), poll, { storage, locks, now });
    } catch (error) {
      if (!stopped) console.warn('Background network polling:', error.message ?? error);
    } finally { busy = false; }
  }
  void refresh();
  const timer = schedule(() => void refresh(), interval);
  return () => {
    stopped = true; cancel(timer);
    return releasePollingLease(leaseKey, owner, { storage, locks, now }).catch(error => console.warn('Releasing network poller:', error));
  };
}
