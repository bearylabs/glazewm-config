import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wifiSettingsPermission, openWifiSettings } from '../widgets/shared/wifi-settings.mjs';

test('Wi-Fi permission only allows the native network flyout; radio scripts are absent', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url)));
  assert(pack.widgets.find(w => w.name === 'popup').privileges.shellCommands.some(p =>
    p.program === wifiSettingsPermission.program && p.argsRegex === wifiSettingsPermission.argsRegex));
  const allowed = new RegExp(wifiSettingsPermission.argsRegex);
  assert(allowed.test('ms-availablenetworks:'));
  assert(!allowed.test('ms-availablenetworks:; shutdown /s /t 0'));
  assert(!allowed.test('ms-settings:network-wifi'));
  for (const widget of pack.widgets) {
    assert(!widget.privileges.shellCommands.some(p => p.argsRegex.includes('GetRadiosAsync') && !p.argsRegex.includes('BluetoothMenu')));
  }
  for (const path of ['../widgets/popup/system.mjs', '../widgets/shared/network-background.mjs']) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert(!/executeWifiRadio|wifi-radio\.mjs|refreshRadio/.test(source));
  }
});
test('opening native network selection delegates to Explorer and reports launch errors', async () => {
  const calls = [];
  await openWifiSettings(async (...args) => { calls.push(args); return { code: 0 }; });
  assert.deepEqual(calls, [['explorer.exe', ['ms-availablenetworks:']]]);
  await assert.rejects(openWifiSettings(async () => ({ exitCode: 1, stderr: 'Access denied' })), /Access denied/);
  await assert.rejects(openWifiSettings(async () => ({ code: 1 })), /Could not open/);
});
