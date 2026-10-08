import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { networkStatsCommand, networkStatsArgsRegex, networkMetrics, networkOverviewEntries, byteSize, selectNetworkStats } from '../widgets/shared/network-stats.mjs';

test('network read permission allows only the fixed statistics query', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url)));
  const permission = pack.widgets.find(w => w.name === 'popup').privileges.shellCommands.find(p => p.argsRegex === networkStatsArgsRegex);
  assert.equal(permission.argsRegex, networkStatsArgsRegex);
  const allowed = new RegExp(permission.argsRegex);
  assert(allowed.test('-NoProfile -NonInteractive -Command ' + networkStatsCommand));
  assert(!allowed.test('-NoProfile -NonInteractive -Command ' + networkStatsCommand + '; shutdown /s /t 0'));
});
test('network overview swaps gateway and link rate for fresh and cached entries without mutation', () => {
  const entries = [...networkMetrics({ gateway: '10.0.0.1' }), ['IP Address', '10.0.0.2'], ['Link rate', '1 Gb/s']];
  const ordered = networkOverviewEntries(entries);
  assert.deepEqual(ordered.map(([label]) => label), ['Ping', 'Link rate', 'Receiving', 'Sending', 'Downloaded', 'Uploaded', 'IP Address', 'Gateway']);
  assert.equal(ordered[7][1], '10.0.0.1');
  assert.equal(entries[1][0], 'Gateway');
  assert.deepEqual(networkOverviewEntries(ordered), ordered);
  assert.deepEqual(networkOverviewEntries([['IP Address', '10.0.0.2']]), [['IP Address', '10.0.0.2']]);
});

test('traffic rates use elapsed time and adapter identity, not link speed', () => {
  const before = { id: 'a', received: 1024, sent: 4096 };
  const after = { id: 'a', received: 3072, sent: 5120, ping: 0, gateway: '10.0.0.1' };
  const metrics = Object.fromEntries(networkMetrics(after, before, 2));
  assert.equal(metrics.Receiving, '1.0 KB/s');
  assert.equal(metrics.Sending, '512 B/s');
  assert.equal(metrics.Ping, '0 ms');
  assert.equal(Object.fromEntries(networkMetrics({ ...after, id: 'b' }, before, 2)).Receiving, '--');
  assert.equal(Object.fromEntries(networkMetrics(before, after, 2)).Receiving, '--');
  assert.equal(byteSize(null), '--');
  assert.equal(Object.fromEntries(networkMetrics(null)).Downloaded, '--');
});

test('statistics select the UI adapter, not the first active Wi-Fi interface', () => {
  const make = (id, macAddress, address) => ({ id, macAddress, ipv4Addresses: [address], received: 100, sent: 20, ssid: id });
  const first = make('first', '001122334455', '10.0.0.2');
  const selected = make('selected', 'AABBCCDDEEFF', '192.168.1.2');
  const iface = { name: 'Wi-Fi', type: 'wifi', macAddress: 'aa:bb:cc:dd:ee:ff', ipv4Addresses: ['192.168.1.2/24'] };
  assert.equal(selectNetworkStats([first, selected], iface), selected);
  assert.equal(selectNetworkStats([first], iface), null);
  assert.equal(selectNetworkStats([selected], { ...iface, macAddress: '00:11:22:33:44:55' }), null,
    'Conflicting MAC identities cannot match by IP.');
  assert.equal(selectNetworkStats([first, selected], { ...iface, macAddress: null }), selected);
  assert.equal(selectNetworkStats([first, selected], { ...iface, type: 'ethernet' }), null);
  assert.throws(() => selectNetworkStats([selected, selected], iface), /Multiple/);
  for (const value of [null, {}, [{ ...selected, ipv4Addresses: null }], [{ ...selected, sent: -1 }]]) {
    assert.throws(() => selectNetworkStats(value, iface), /Invalid/);
  }
  assert(networkStatsCommand.includes('$ssids[$nic.Id.Trim'));
  assert(!networkStatsCommand.includes("-eq 'Wireless80211' } | Select-Object -First 1"));
});

test('Windows SSID parsing associates each network with its own interface GUID', {
  skip: process.platform !== 'win32',
}, async () => {
  const first = '11111111-1111-1111-1111-111111111111';
  const second = '22222222-2222-2222-2222-222222222222';
  const lines = [
    `    GUID                   : ${first}`,
    '    SSID                   : First network',
    '    BSSID                  : aa:bb:cc:dd:ee:ff',
    `    GUID                   : {${second}}`,
    "    SSID                   : Selected network's SSID",
  ];
  const output = lines.map(line => `'${line.replaceAll("'", "''")}'`).join(',');
  const parser = networkStatsCommand.slice(networkStatsCommand.indexOf('$ssids ='), networkStatsCommand.indexOf('$snapshots ='));
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `function global:netsh.exe { @(${output}) }\n${parser}\n$ssids | ConvertTo-Json -Compress`,
  ], { timeout: 5000 });
  assert.deepEqual(JSON.parse(stdout.trim()), { [first]: 'First network', [second]: "Selected network's SSID" });
});
