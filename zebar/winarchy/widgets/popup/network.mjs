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
import { createIcon } from '../shared/icons.mjs';
import { shellQuery } from '../shared/native-query.mjs';

function networkDetails(entries, reportError) {
  const list = element('dl', undefined, 'network-details network-overview');
  const values = new Map();
  for (const [label] of networkOverviewEntries(entries)) {
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
          copy.setAttribute('aria-label', `${label} ${address} copied to clipboard`);
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
          copy.title = `Copy ${label}: ${next}`;
          copy.setAttribute('aria-label', copy.title);
        }
      }
    });
    item.append(element('dt', label), description);
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
  const trafficCacheKey = 'winarchy.network.traffic.v1';
  const cachedNetwork = readSnapshot(networkCacheKey, networkSnapshotValid);
  const cachedTraffic = readSnapshot(trafficCacheKey, trafficSnapshotValid);
  let liveNetworkSeen = false;
  const connection = element('div', undefined, 'network-connection');
  const traffic = element('div', undefined, 'network-traffic');
  const emptyEntries = () => [...networkMetrics(null), ['IP Address', '--'], ['Link rate', '--']];
  const trafficDetails = networkDetails(cachedTraffic?.entries ?? emptyEntries(), reportError);
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
  const heading = hero('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE');
  heading.classList.add('network-hero');
  const networkTitle = heading.querySelector('.hero__title');
  networkTitle.id = 'network-title';
  heading.append(wifiOpen);
  const ethernetDetails = networkDetails([['IP Address', '--']], reportError);
  ethernetDetails.list.hidden = true;
  const connectionError = unavailable('Network');
  connectionError.hidden = true;
  connection.append(heading, ethernetDetails.list, connectionError);
  root.append(connection, traffic);
  let previousStats = cachedTraffic?.snapshot ?? null;
  let previousTime = cachedTraffic?.time ?? 0;
  let statsBusy = false;
  let statsInitialized = false;
  let statsClosed = false;
  let latestStats = cachedTraffic?.snapshot ?? null;
  let latestInterface = null;
  let connectionTitle = 'No connection';
  function updateWifiLabels() {
    networkTitle.textContent = latestStats?.ssid && latestInterface && /wifi|wireless|802\.11/i.test(latestInterface.type ?? '')
      ? latestStats.ssid : connectionTitle;
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
        trafficDetails.update(backgroundTraffic.entries);
        updateWifiLabels();
        return;
      }
      const result = await shellQuery('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', networkStatsCommand], {
        timeout: 15000, timeoutMessage: 'Network statistics query timed out.',
      });
      if (statsClosed) return;
      if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr || 'Network statistics unavailable.');
      const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
      latestStats = snapshot;
      updateWifiLabels();
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
        updateWifiLabels();
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
    updateWifiLabels();
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
      ethernetDetails.list.hidden = true;
      connectionError.hidden = false;
      connectionError.textContent = errors.network ? `Network: ${errors.network.message ?? errors.network}` : 'Network: waiting for data...';
      connectionError.className = errors.network ? 'error' : 'note';
      updateHeading('wifi-off', 'No connection', 'NETWORK DATA UNAVAILABLE');
      return;
    }
    const { iface, link } = networkConnection(net);
    const kind = link === 'none' ? 'No physical connection' : link === 'wifi' ? 'Wi-Fi' : 'Ethernet';
    const name = link === 'wifi' ? net.defaultGateway?.ssid || iface?.friendlyName || iface?.name : kind;
    const rate = linkRate(iface);
    latestInterface = iface;
    updateHeading(link === 'wifi' ? 'wifi' : link === 'ethernet' ? 'ethernet' : 'wifi-off',
      link === 'ethernet' && rate ? `${name} (${rate})` : name || kind, link === 'none' ? 'NOT CONNECTED' : `${kind.toUpperCase()} CONNECTION`);
    ethernetDetails.list.hidden = !iface || link === 'wifi';
    ethernetDetails.update([['IP Address', ethernetDetails.list.hidden ? '--' : ipv4(iface) || '--']]);
    traffic.hidden = link !== 'wifi';
    connectionError.hidden = !errors.network;
    connectionError.textContent = errors.network ? `Network: ${errors.network.message ?? errors.network}` : '';
    connectionError.className = 'error';
  });
}
