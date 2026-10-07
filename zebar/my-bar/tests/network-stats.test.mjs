import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { networkStatsCommand, networkStatsArgsRegex, networkMetrics, byteSize } from '../widgets/shared/network-stats.mjs';

test('network read permission allows only the fixed statistics query', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url)));
  const permission = pack.widgets.find(w => w.name === 'popup').privileges.shellCommands.find(p => p.argsRegex === networkStatsArgsRegex);
  assert.equal(permission.argsRegex, networkStatsArgsRegex);
  const allowed = new RegExp(permission.argsRegex);
  assert(allowed.test('-NoProfile -NonInteractive -Command ' + networkStatsCommand));
  assert(!allowed.test('-NoProfile -NonInteractive -Command ' + networkStatsCommand + '; shutdown /s /t 0'));
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
