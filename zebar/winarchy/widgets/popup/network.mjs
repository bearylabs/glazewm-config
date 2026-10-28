import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { networkConnection, linkType, linkRate, ipv4 } from '../shared/network-model.mjs';
import { networkStatsCommand, networkMetrics, networkOverviewEntries, selectNetworkStats, networkStatsMatch } from '../shared/network-stats.mjs';
import { openWifiSettings } from '../shared/wifi-settings.mjs';
import { handoffPopupToNative } from '../shared/popup-controller.mjs';
import { readSnapshot, writeSnapshot, clearSnapshot, networkSnapshotValid, trafficSnapshotValid } from '../shared/snapshot-cache.mjs';
import { readBackgroundSnapshot } from '../shared/network-background.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';
import { element, button, hero, unavailable } from './dom.mjs';
import { subscribe } from './providers.mjs';
import { createIcon, createExternalLinkIcon } from '../shared/icons.mjs';
import { shellQuery } from '../shared/native-query.mjs';

function networkDetails(entries, reportError) {
  const list = element('dl', undefined, 'network-overview');
  const values = new Map();
  for (const [label] of networkOverviewEntries(entries)) {
    const caption = label === 'IP Address' ? 'IP' : label;
    const item = element('div');
    const description = element('dd');
    const text = element('span');
    description.append(text);
    let currentValue;
    let copy;
    if (['IP Address', 'Gateway'].includes(label)) {
      copy = button('', () => {
        const address = currentValue;
        void Promise.resolve().then(() => navigator.clipboard.writeText(String(address))).then(() => {
          if (address !== currentValue) return;
          copy.title = 'Copied to clipboard';
          copy.setAttribute('aria-label', `${caption} ${address} copied to clipboard`);
        }).catch(reportError);
      });
      copy.className = 'network-copy';
      description.append(copy);
    }
    values.set(label, next => {
      const changed = currentValue !== next;
      currentValue = next;
      const canCopy = Boolean(copy && next && !['--', 'Unavailable'].includes(next));
      text.textContent = canCopy ? '' : next ?? 'Unavailable';
      text.hidden = canCopy;
      if (copy) {
        copy.hidden = !canCopy;
        copy.disabled = !canCopy;
        copy.textContent = canCopy ? next : '';
        if (!canCopy) {
          copy.removeAttribute('title');
          copy.removeAttribute('aria-label');
        } else if (changed) {
          copy.title = `Copy ${caption}: ${next}`;
          copy.setAttribute('aria-label', copy.title);
        }
      }
    });
    item.append(element('dt', caption), description);
    list.append(item);
  }
  function update(next) {
    const entries = new Map(next);
    for (const [label, render] of values) render(entries.get(label));
  }
  update(entries);
  return { list, update };
}

export function renderNetwork(root, reportError) {
  const networkCacheKey = 'winarchy.network.connection.v1';
  const trafficCacheKey = 'winarchy.network.traffic.v2';
  const cachedNetwork = readSnapshot(networkCacheKey, networkSnapshotValid);
  const cachedTraffic = readSnapshot(trafficCacheKey, trafficSnapshotValid);
  let liveNetworkSeen = false;
  const connection = element('div', undefined, 'network-connection');
  const traffic = element('div', undefined, 'network-traffic');
  const emptyEntries = () => [...networkMetrics(null), ['IP Address', '--'], ['Link rate', '--']];
  const initialInterface = networkConnection(cachedNetwork).iface;
  const matchingCache = networkStatsMatch(cachedTraffic?.snapshot, initialInterface) ? cachedTraffic : null;
  const trafficDetails = networkDetails(matchingCache?.entries ?? emptyEntries(), reportError);
  const statsError = element('p', undefined, 'note error');
  statsError.setAttribute('role', 'status');
  statsError.hidden = true;
  traffic.append(trafficDetails.list, statsError);
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
  wifiOpen.append(createExternalLinkIcon());
  const heading = hero('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE');
  heading.classList.add('network-hero');
  const networkTitle = heading.querySelector('.hero__title');
  networkTitle.id = 'network-title';
  heading.append(wifiOpen);
  const connectionError = unavailable('Network');
  connectionError.hidden = true;
  connection.append(heading, connectionError);
  root.append(connection, traffic);
  let previousStats = matchingCache?.snapshot ?? null;
  let previousTime = matchingCache?.time ?? 0;
  let statsBusy = false;
  let statsInitialized = false;
  let statsClosed = false;
  let latestStats = matchingCache?.snapshot ?? null;
  let latestInterface = initialInterface;
  let connectionTitle = 'No connection';
  function updateConnectionTitle() {
    networkTitle.textContent = linkType(latestInterface) === 'wifi' &&
      latestStats?.ssid && networkStatsMatch(latestStats, latestInterface)
      ? latestStats.ssid : connectionTitle;
  }
  async function updateStats() {
    if (statsBusy || statsClosed) return;
    statsBusy = true;
    try {
      const backgroundTraffic = !statsInitialized ? readBackgroundSnapshot(trafficCacheKey, trafficSnapshotValid) : null;
      statsInitialized = true;
      if (backgroundTraffic && networkStatsMatch(backgroundTraffic.snapshot, latestInterface)) {
        latestStats = backgroundTraffic.snapshot;
        previousStats = backgroundTraffic.snapshot; previousTime = backgroundTraffic.time;
        trafficDetails.update(backgroundTraffic.entries);
        updateConnectionTitle();
        return;
      }
      const result = await shellQuery('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', networkStatsCommand], {
        timeout: 15000, timeoutMessage: 'Network statistics query timed out.',
      });
      if (statsClosed) return;
      if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr || 'Network statistics unavailable.');
      const snapshot = selectNetworkStats(JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()), latestInterface);
      latestStats = snapshot;
      updateConnectionTitle();
      const now = Date.now();
      const entries = [
        ...networkMetrics(snapshot, previousStats, (now - previousTime) / 1000),
        ['IP Address', ipv4(latestInterface) || '--'],
        ['Link rate', linkRate(latestInterface) || '--'],
      ];
      trafficDetails.update(entries);
      statsError.hidden = true;
      statsError.textContent = '';
      if (snapshot) writeSnapshot(trafficCacheKey, { snapshot, time: now, entries });
      else clearSnapshot(trafficCacheKey);
      previousStats = snapshot; previousTime = now;
    } catch (error) {
      if (!statsClosed) {
        latestStats = null;
        previousStats = null;
        previousTime = 0;
        clearSnapshot(trafficCacheKey);
        trafficDetails.update(emptyEntries());
        updateConnectionTitle();
        statsError.textContent = `Network statistics: ${error.message ?? error}`;
        statsError.hidden = false;
      }
    }
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
  function updateHeading(icon, title, meta) {
    heading.querySelector('.hero__icon').replaceChildren(createIcon(icon));
    connectionTitle = title;
    heading.querySelector('.hero__meta').textContent = meta;
    updateConnectionTitle();
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
      latestStats = null;
      previousStats = null;
      previousTime = 0;
      trafficDetails.update(emptyEntries());
      connectionError.hidden = false;
      connectionError.textContent = errors.network ? `Network: ${errors.network.message ?? errors.network}` : 'Network: waiting for data...';
      connectionError.className = errors.network ? 'error' : 'note';
      updateHeading('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE');
      return;
    }
    const { iface, link } = networkConnection(net);
    const kind = link === 'none' ? 'No physical connection' : link === 'wifi' ? 'Wi-Fi' : 'Ethernet';
    const name = link === 'wifi' ? iface?.friendlyName || iface?.name : kind;
    latestInterface = iface;
    if (!networkStatsMatch(latestStats, iface)) {
      latestStats = null;
      previousStats = null;
      previousTime = 0;
      trafficDetails.update(emptyEntries());
    }
    updateHeading(link === 'wifi' ? 'wifi' : link === 'ethernet' ? 'ethernet' : 'wifi-off',
      name || kind, link === 'none' ? 'NOT CONNECTED' : `${kind.toUpperCase()} CONNECTION`);
    traffic.hidden = !iface;
    connectionError.hidden = !errors.network;
    connectionError.textContent = errors.network ? `Network: ${errors.network.message ?? errors.network}` : '';
    connectionError.className = 'error';
  });
}
