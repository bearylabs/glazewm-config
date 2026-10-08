// Keep the existing default-route VPN heuristic; this is not an internet check.
const VIRTUAL_NAME =
  /vpn|pangp|globalprotect|anyconnect|zscaler|forticlient|wireguard|openvpn|tailscale|tap-windows|\btap\b|\btun\b|virtual|vethernet|hyper-v|loopback|pseudo/i;

export function isVirtual(iface) {
  if (!iface) return false;
  const type = String(iface.type ?? '').toLowerCase();
  return ['tunnel', 'ppp', 'loopback'].includes(type) ||
    VIRTUAL_NAME.test(`${iface.friendlyName ?? ''} ${iface.description ?? ''} ${iface.name ?? ''}`);
}

export function ipv4(iface) {
  return (iface?.ipv4Addresses ?? [])
    .map(entry => String(entry).split('/')[0])
    .find(entry => entry && !entry.startsWith('169.254.') && entry !== '0.0.0.0');
}

export function linkType(iface) {
  if (!iface) return 'none';
  return /wifi|wireless|802\.11/.test(String(iface.type ?? '').toLowerCase())
    ? 'wifi' : 'ethernet';
}

export function physicalInterface(net) {
  const candidates = (net.interfaces ?? []).filter(entry => !isVirtual(entry) && ipv4(entry));
  return candidates.find(entry => linkType(entry) === 'wifi') ?? candidates[0] ?? null;
}

export function networkConnection(net) {
  const tunnel = isVirtual(net?.defaultInterface) ? net.defaultInterface : null;
  const iface = tunnel ? physicalInterface(net) : net?.defaultInterface;
  return { tunnel, iface, link: linkType(iface) };
}

export function linkRate(iface) {
  const bits = Math.max(iface?.receiveSpeed ?? 0, iface?.transmitSpeed ?? 0);
  if (!bits) return null;
  return bits >= 1e9
    ? `${(bits / 1e9).toFixed(bits % 1e9 ? 1 : 0)} Gb/s`
    : `${Math.round(bits / 1e6)} Mb/s`;
}
