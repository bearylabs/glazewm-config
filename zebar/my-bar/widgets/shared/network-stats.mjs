export const networkStatsCommand = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$nic = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -eq 'Wireless80211' } | Select-Object -First 1
if (!$nic) { 'null'; exit 0 }
$props = $nic.GetIPProperties()
$gateway = $props.GatewayAddresses | ForEach-Object { $_.Address } | Where-Object { $_.AddressFamily -eq 'InterNetwork' -and $_.ToString() -ne '0.0.0.0' } | Select-Object -First 1
$stats = $nic.GetIPv4Statistics()
$ssid = $null
foreach ($line in (& netsh.exe wlan show interfaces)) {
  if ($line -match '^\\s*SSID\\s*:\\s*(.+)$') { $ssid = $Matches[1].Trim(); break }
}
$latency = $null
if ($gateway) {
  $ping = [System.Net.NetworkInformation.Ping]::new()
  try { $reply = $ping.Send($gateway, 800); if ($reply.Status -eq 'Success') { $latency = $reply.RoundtripTime } } finally { $ping.Dispose() }
}
[pscustomobject]@{ id = $nic.Id; ssid = $ssid; received = $stats.BytesReceived; sent = $stats.BytesSent; gateway = $(if ($gateway) { $gateway.ToString() }); ping = $latency } | ConvertTo-Json -Compress`;
export const networkStatsArgsRegex = '^' + ('-NoProfile -NonInteractive -Command ' + networkStatsCommand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
export function byteSize(value, rate = false) {
  if (!Number.isFinite(value) || value < 0) return '--';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i ? 1 : 0)} ${units[i]}${rate ? '/s' : ''}`;
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
