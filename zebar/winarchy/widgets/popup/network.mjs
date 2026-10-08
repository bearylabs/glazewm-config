import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { networkConnection, linkRate, ipv4 } from '../shared/network-model.mjs';
import { networkStatsCommand, networkMetrics, networkOverviewEntries } from '../shared/network-stats.mjs';
import { openWifiSettings } from '../shared/wifi-settings.mjs';
import { handoffPopupToNative } from '../shared/popup-controller.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot, networkSnapshotValid, trafficSnapshotValid } from '../shared/snapshot-cache.mjs';
import { readBackgroundSnapshot } from '../shared/network-background.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';
import { element, button, hero, unavailable } from './dom.mjs';
import { subscribe } from './providers.mjs';

function networkDetails(entries, reportError) {
  const list = element('dl', undefined, 'network-details network-overview');
  for (const [label, value] of networkOverviewEntries(entries)) {
    const item = element('div');
    const displayValue = value ?? 'Unavailable';
    const description = element('dd');
    if (['IP Address', 'Gateway'].includes(label) && value && !['--', 'Unavailable'].includes(value)) {
      const copy = button(displayValue, () => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(String(value))).then(() => {
          copy.title = 'Copied to clipboard';
          copy.setAttribute('aria-label', `${label} ${value} copied to clipboard`);
        }).catch(reportError);
      });
      copy.className = 'network-copy';
      copy.title = `Copy ${label}: ${value}`;
      copy.setAttribute('aria-label', copy.title);
      description.append(copy);
    } else description.textContent = displayValue;
    item.append(element('dt', label), description);
    list.append(item);
  }
  return list;
}

export function renderNetwork(root, reportError) {
  const networkCacheKey = 'winarchy.network.connection.v1';
  const trafficCacheKey = 'winarchy.network.traffic.v1';
  const cachedNetwork = readSnapshot(networkCacheKey, networkSnapshotValid);
  const cachedTraffic = readSnapshot(trafficCacheKey, trafficSnapshotValid);
  let liveNetworkSeen = false;
  const connection = element('div', undefined, 'network-connection');
  const traffic = element('div', undefined, 'network-traffic');
  traffic.append(networkDetails(cachedTraffic?.entries ?? networkMetrics(null), reportError));
  let wifiOpening = false;
  const wifiOpen = button('', () => {
    if (wifiOpening) return;
    wifiOpening = true;
    wifiOpen.disabled = true;
    void handoffPopupToNative(() => openWifiSettings(zebar.shellSpawn)).catch(reportError).finally(() => {
      wifiOpening = false;
      wifiOpen.disabled = false;
    });
  });
  wifiOpen.id = 'wifi-settings-open';
  wifiOpen.className = 'network-vpn__open';
  wifiOpen.setAttribute('aria-label', 'Open Windows Wi-Fi networks');
  wifiOpen.title = 'Open Windows Wi-Fi networks';
  const arrowIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrowIcon.setAttribute('viewBox', '0 0 24 24');
  arrowIcon.setAttribute('aria-hidden', 'true');
  arrowIcon.setAttribute('focusable', 'false');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M6 18 18 6M6 6h12v12');
  arrow.setAttribute('fill', 'none');
  arrow.setAttribute('stroke', 'currentColor');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('stroke-linecap', 'round');
  arrow.setAttribute('stroke-linejoin', 'round');
  arrowIcon.append(arrow);
  wifiOpen.append(arrowIcon);
  root.append(connection, traffic);
  let previousStats = cachedTraffic?.snapshot ?? null;
  let previousTime = cachedTraffic?.time ?? 0;
  let statsBusy = false;
  let statsInitialized = false;
  let statsClosed = false;
  let latestStats = cachedTraffic?.snapshot ?? null;
  let latestInterface = null;
  function updateWifiLabels() {
    const title = connection.querySelector('#network-title');
    if (latestStats?.ssid && title && latestInterface && /wifi|wireless|802\.11/i.test(latestInterface.type ?? '')) { title.textContent = latestStats.ssid; }
  }
  async function updateStats() {
    if (statsBusy || statsClosed) return;
    statsBusy = true;
    try {
      const backgroundTraffic = !statsInitialized ? readBackgroundSnapshot(trafficCacheKey, trafficSnapshotValid) : null;
      statsInitialized = true;
      if (backgroundTraffic) {
        latestStats = backgroundTraffic.snapshot;
        previousStats = backgroundTraffic.snapshot; previousTime = backgroundTraffic.time;
        traffic.replaceChildren(networkDetails(backgroundTraffic.entries, reportError));
        updateWifiLabels();
        return;
      }
      const result = await zebar.shellExec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', networkStatsCommand]);
      if (statsClosed) return;
      if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr || 'Network statistics unavailable.');
      const snapshot = JSON.parse(result.stdout.trim());
      latestStats = snapshot;
      updateWifiLabels();
      const now = Date.now();
      const entries = [
        ...networkMetrics(snapshot, previousStats, (now - previousTime) / 1000),
        ['IP Address', ipv4(latestInterface) || '--'],
        ['Link rate', linkRate(latestInterface) || '--'],
      ];
      traffic.replaceChildren(networkDetails(entries, reportError));
      if (snapshot) writeSnapshot(trafficCacheKey, { snapshot, time: now, entries });
      else clearSnapshot(trafficCacheKey);
      previousStats = snapshot; previousTime = now;
    } catch (error) { console.warn('Network statistics:', error.message); }
    finally { statsBusy = false; }
  }
  void updateStats();
  const statsTimer = setInterval(() => void updateStats(), 1000);
  const onNetworkStorage = event => {
    if (event.key === trafficCacheKey) void updateStats();
  };
  window.addEventListener('storage', onNetworkStorage);
  onPopupSessionEnd(() => {
    statsClosed = true; clearInterval(statsTimer);
    window.removeEventListener('storage', onNetworkStorage);
  });
  function heading(icon, title, meta) {
    const node = hero(icon, title, meta);
    node.classList.add('network-hero');
    const label = node.querySelector('.hero__title');
    label.id = 'network-title';
    node.append(wifiOpen);
    return node;
  }
  subscribe({ network: { type: 'network', refreshInterval: 1000 } }, (output, errors) => {
    if (output.network || errors.network) liveNetworkSeen = true;
    const net = output.network || (!liveNetworkSeen ? cachedNetwork : null);
    if (output.network) writeSnapshot(networkCacheKey, {
      defaultInterface: output.network.defaultInterface ?? null,
      interfaces: output.network.interfaces ?? [],
      defaultGateway: output.network.defaultGateway ?? null,
    });
    if (!net) {
      if (liveNetworkSeen) { clearSnapshot(networkCacheKey); clearSnapshot(trafficCacheKey); }
      traffic.hidden = true;
      latestInterface = null;
      connection.replaceChildren(heading('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE'), unavailable('Network', errors.network));
      return;
    }
    const { iface, link } = networkConnection(net);
    const kind = link === 'none' ? 'No physical connection' : link === 'wifi' ? 'Wi-Fi' : 'Ethernet';
    const name = link === 'wifi' ? latestStats?.ssid || net.defaultGateway?.ssid || iface?.friendlyName || iface?.name : kind;
    const rate = linkRate(iface);
    const nodes = [
      heading(link === 'wifi' ? 'wifi' : link === 'ethernet' ? 'ethernet' : 'wifi-off',
        link === 'ethernet' && rate ? `${name} (${rate})` : name || kind, link === 'none' ? 'NOT CONNECTED' : `${kind.toUpperCase()} CONNECTION`),
    ];
    latestInterface = iface;
    if (iface && link !== 'wifi') nodes.push(networkDetails([
      ['IP Address', ipv4(iface) || '--'],
    ], reportError));
    traffic.hidden = link !== 'wifi';
    if (errors.network) nodes.push(unavailable('Network', errors.network));
    connection.replaceChildren(...nodes);
    updateWifiLabels();
  });
}
