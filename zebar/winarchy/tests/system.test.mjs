import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { networkConnection, ipv4, isVirtual, linkRate } from '../widgets/shared/network-model.mjs';
import { diskUsage, executePowerAction, gib, percent, powerCommands } from '../widgets/shared/system-model.mjs';

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

test('missing system data never becomes invented zero values', () => {
  for (const value of [undefined, null, NaN]) {
    assert.equal(percent(value), 'Unavailable');
    assert.equal(gib(value), 'Unavailable');
  }
  assert.equal(percent(0), '0%');
  assert.equal(gib(0), '0.0 GiB');
  assert.equal(diskUsage({ totalSpace: { bytes: 100 } }), null);
  assert.equal(diskUsage({ totalSpace: { bytes: 0 }, availableSpace: { bytes: 0 } }), null);
  assert.equal(diskUsage({ totalSpace: { bytes: 100 }, availableSpace: { bytes: 0 } }), 100);
});

test('logout and shutdown require explicit confirmation; lock runs directly', async () => {
  const calls = [];
  const shell = async (...args) => { calls.push(args); return { code: 0 }; };
  for (const action of ['logout', 'shutdown']) {
    await assert.rejects(executePowerAction(shell, action), /confirmation/);
  }
  assert.equal(calls.length, 0);
  await executePowerAction(shell, 'lock');
  await executePowerAction(shell, 'logout', true);
  await executePowerAction(shell, 'shutdown', true);
  assert.deepEqual(calls, [
    ['rundll32.exe', ['user32.dll,LockWorkStation']],
    ['shutdown', ['/l']],
    ['shutdown', ['/s', '/t', '0']],
  ]);
  await assert.rejects(executePowerAction(shell, 'restart', true), /Unknown/);
});

test('native command failures surface exit details rather than success', async () => {
  for (const code of [1, null]) {
    await assert.rejects(
      executePowerAction(async () => ({ code, stderr: 'Access denied' }), 'lock'),
      /Access denied/,
    );
  }
});

test('popup permissions allow only the exact declared power commands', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const privileges = pack.widgets.find(widget => widget.name === 'popup').privileges.shellCommands;
  for (const command of Object.values(powerCommands)) {
    const permission = privileges.find(item => item.program === command.program);
    assert(new RegExp(permission.argsRegex).test(command.args.join(' ')));
  }
  for (const permission of privileges) {
    const pattern = new RegExp(permission.argsRegex);
    for (const args of ['/r /t 0', '/s /f /t 0', '/l /f', 'evil.dll,EntryPoint', 'user32.dll,LockWorkStation extra']) {
      assert.equal(pattern.test(args), false, args);
    }
  }
});
