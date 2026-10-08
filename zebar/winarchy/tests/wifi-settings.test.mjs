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
test('native network selection spawns Explorer once without interpreting its exit code', async () => {
  const calls = [];
  await openWifiSettings(async (...args) => {
    calls.push(args);
    return { processId: 123, onExit: () => { throw new Error('Must not wait for Explorer exit'); } };
  });
  assert.deepEqual(calls, [['explorer.exe', ['ms-availablenetworks:']]]);
  await assert.rejects(openWifiSettings(async () => { throw new Error('Access denied'); }), /Access denied/);
});
