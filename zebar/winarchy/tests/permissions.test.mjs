import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('generated Winarchy shell permissions match the checked-in pack', async () => {
  const script = fileURLToPath(new URL('../../../scripts/sync-winarchy-permissions.mjs', import.meta.url));
  const result = await promisify(execFile)(process.execPath, [script, '--check']);
  assert.equal(result.stderr, '');
});
