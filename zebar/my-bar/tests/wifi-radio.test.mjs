import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wifiRadioArgs, wifiRadioArgsRegex, executeWifiRadio } from '../widgets/shared/wifi-radio.mjs';

test('Wi-Fi radio permissions allow only fixed status/on/off scripts', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url)));
  assert(pack.widgets.find(w => w.name === 'popup').privileges.shellCommands.some(p => p.argsRegex === wifiRadioArgsRegex));
  const allowed = new RegExp(wifiRadioArgsRegex);
  for (const action of ['status', 'on', 'off']) {
    const args = wifiRadioArgs(action).join(' ');
    assert(allowed.test(args));
    assert(!allowed.test(args + '; shutdown /s /t 0'));
  }
  assert.throws(() => wifiRadioArgs('scan'));
});
test('Wi-Fi radio status is native, errors do not fabricate success', async () => {
  assert.deepEqual(await executeWifiRadio(async () => ({ code: 0, stdout: '{"available":true,"enabled":false}' }), 'status'), { available: true, enabled: false });
  await assert.rejects(executeWifiRadio(async () => ({ code: 1, stderr: 'Access denied' }), 'on'), /Access denied/);
  await assert.rejects(executeWifiRadio(async () => ({ code: 0, stdout: '{}' }), 'off'), /Invalid/);
});
