import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('minimal display popup uses only monitor data, without native helpers or settings links', async () => {
  const source = await readFile(new URL('../widgets/popup/display.mjs', import.meta.url), 'utf8');
  assert.match(source, /availableMonitors/);
  assert.match(source, /currentMonitor/);
  assert.doesNotMatch(source, /shellExec|shellSpawn|ms-settings|WmiMonitor|display-model/);
  assert.doesNotMatch(source, /node\('(?:button|input|a)'/);
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  for (const widget of pack.widgets) {
    for (const permission of widget.privileges.shellCommands) {
      assert.doesNotMatch(permission.argsRegex, /WmiMonitorBrightness|easeofaccess-display|nightlight/);
    }
  }
});
