export const networkStatsCommand = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$nics = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -eq 'Wireless80211' })
$ssids = @{}
$interfaceId = $null
foreach ($line in (& netsh.exe wlan show interfaces)) {
  if ($line -match '^\\s*GUID\\s*:\\s*\\{?([0-9a-fA-F-]{36})\\}?\\s*$') { $interfaceId = $Matches[1].ToLowerInvariant() }
  elseif ($interfaceId -and $line -match '^\\s*SSID\\s*:\\s*(.+)$') { $ssids[$interfaceId] = $Matches[1].Trim() }
}
$snapshots = @(foreach ($nic in $nics) {
$props = $nic.GetIPProperties()
$gateway = $props.GatewayAddresses | ForEach-Object { $_.Address } | Where-Object { $_.AddressFamily -eq 'InterNetwork' -and $_.ToString() -ne '0.0.0.0' } | Select-Object -First 1
$stats = $nic.GetIPv4Statistics()
$addresses = @($props.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.Address.ToString() })
$latency = $null
if ($gateway) {
  $ping = [System.Net.NetworkInformation.Ping]::new()
  try { $reply = $ping.Send($gateway, 800); if ($reply.Status -eq 'Success') { $latency = $reply.RoundtripTime } } finally { $ping.Dispose() }
}
[pscustomobject]@{ id = $nic.Id; macAddress = $nic.GetPhysicalAddress().ToString(); ipv4Addresses = $addresses; ssid = $ssids[$nic.Id.Trim('{}').ToLowerInvariant()]; received = $stats.BytesReceived; sent = $stats.BytesSent; gateway = $(if ($gateway) { $gateway.ToString() }); ping = $latency }
})
ConvertTo-Json -InputObject $snapshots -Depth 4 -Compress`;
export const networkStatsArgsRegex = '^' + ('-NoProfile -NonInteractive -Command ' + networkStatsCommand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
export function networkStatsValid(snapshot) {
  return snapshot && typeof snapshot.id === 'string' && snapshot.id.length > 0 &&
    Array.isArray(snapshot.ipv4Addresses) && snapshot.ipv4Addresses.every(address => typeof address === 'string') &&
    (snapshot.macAddress == null || typeof snapshot.macAddress === 'string') &&
    (snapshot.ssid == null || typeof snapshot.ssid === 'string') &&
    (snapshot.gateway == null || typeof snapshot.gateway === 'string') &&
    (snapshot.ping == null || (Number.isFinite(snapshot.ping) && snapshot.ping >= 0)) &&
    Number.isFinite(snapshot.received) && snapshot.received >= 0 && Number.isFinite(snapshot.sent) && snapshot.sent >= 0;
}
export function networkStatsMatch(snapshot, iface) {
  if (!snapshot || !iface || !/wifi|wireless|802\.11/i.test(iface.type ?? '')) return false;
  const normalizeId = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
  if (normalizeId(snapshot.id) === normalizeId(iface.name) && snapshot.id) return true;
  const mac = value => String(value ?? '').replace(/[:-]/g, '').toLowerCase();
  if (snapshot.macAddress && iface.macAddress) return mac(snapshot.macAddress) === mac(iface.macAddress);
  return snapshot.ipv4Addresses?.some(address =>
    !address.startsWith('169.254.') && address !== '0.0.0.0' &&
    iface.ipv4Addresses?.some(candidate => candidate.split('/')[0] === address)) ?? false;
}
export function selectNetworkStats(snapshots, iface) {
  if (!Array.isArray(snapshots) || !snapshots.every(networkStatsValid)) throw new Error('Invalid network statistics snapshot.');
  const matches = snapshots.filter(snapshot => networkStatsMatch(snapshot, iface));
  if (matches.length > 1) throw new Error('Multiple network statistics adapters match the selected interface.');
  return matches[0] ?? null;
}
export function byteSize(value, rate = false) {
  if (!Number.isFinite(value) || value < 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}${rate ? '/s' : ''}`;
}
// Apply at render time too, so older cached entries use the current layout.
export function networkOverviewEntries(entries) {
  const ordered = entries.slice();
  const gateway = ordered.findIndex(([label]) => label === 'Gateway');
  const rate = ordered.findIndex(([label]) => label === 'Link rate');
  if (gateway >= 0 && rate >= 0 && gateway < rate) {
    [ordered[gateway], ordered[rate]] = [ordered[rate], ordered[gateway]];
  }
  return ordered;
}

export function networkMetrics(snapshot, previous, elapsed) {
  const same = snapshot && previous && snapshot.id === previous.id && elapsed > 0;
  return [
    ['Ping', snapshot?.ping == null ? '--' : `${snapshot.ping} ms`],
    ['Gateway', snapshot?.gateway || '--'],
    ['Receiving', same ? byteSize((snapshot.received - previous.received) / elapsed, true) : '--'],
    ['Sending', same ? byteSize((snapshot.sent - previous.sent) / elapsed, true) : '--'],
    ['Downloaded', byteSize(snapshot?.received)],
    ['Uploaded', byteSize(snapshot?.sent)],
  ];
}
