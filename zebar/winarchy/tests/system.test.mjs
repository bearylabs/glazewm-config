import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { networkConnection, ipv4, isVirtual, linkRate } from '../widgets/shared/network-model.mjs';
import { percent } from '../widgets/shared/system-model.mjs';

test('VPN heuristic retains physical Wi-Fi preference and separates tunnel addresses', () => {
  const wifi = { name: 'Wi-Fi', type: 'wifi', ipv4Addresses: ['169.254.1.1', '192.168.1.2/24'] };
  const ethernet = { name: 'Ethernet', type: 'ethernet', ipv4Addresses: ['10.0.0.1'] };
  const tunnel = { name: 'PANGP Virtual Ethernet', type: 'ethernet', ipv4Addresses: ['172.16.0.2'] };
  const result = networkConnection({ defaultInterface: tunnel, interfaces: [ethernet, tunnel, wifi] });
  assert.equal(result.tunnel, tunnel);
  assert.equal(result.iface, wifi);
  assert.equal(result.link, 'wifi');
  assert.equal(ipv4(wifi), '192.168.1.2');
  assert.equal(isVirtual({ name: 'TAP adapter' }), true);
  assert.equal(isVirtual({ name: 'Laptop Ethernet' }), false);
  assert.equal(isVirtual({ type: 'ppp' }), true);
});

test('physical default route does not infer split VPN; absent connections are explicit', () => {
  const physical = { name: 'Ethernet', type: 'ethernet' };
  const vpn = { name: 'GlobalProtect', type: 'tunnel' };
  assert.deepEqual(networkConnection({ defaultInterface: physical, interfaces: [physical, vpn] }), {
    tunnel: null, iface: physical, link: 'ethernet',
  });
  assert.equal(networkConnection(null).link, 'none');
  assert.equal(linkRate({ receiveSpeed: 1e9 }), '1 Gb/s');
  assert.equal(linkRate({ receiveSpeed: 150e6 }), '150 Mb/s');
  assert.equal(linkRate({ receiveSpeed: 0 }), null);
});

test('missing percentages never become invented zero values', () => {
  for (const value of [undefined, null, NaN]) {
    assert.equal(percent(value), 'Unavailable');
  }
  assert.equal(percent(0), '0%');
});

test('removed session actions have no remaining popup permissions', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const privileges = pack.widgets.find(widget => widget.name === 'popup').privileges.shellCommands;
  assert(!privileges.some(permission => ['shutdown', 'rundll32.exe'].includes(permission.program)));
  for (const permission of privileges) {
    const pattern = new RegExp(permission.argsRegex);
    for (const args of ['/r /t 0', '/s /f /t 0', '/l /f', 'evil.dll,EntryPoint', 'user32.dll,LockWorkStation extra']) {
      assert.equal(pattern.test(args), false, args);
    }
  }
});
