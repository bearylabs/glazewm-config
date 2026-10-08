import assert from 'node:assert/strict';
import test from 'node:test';
import { batteryIndicator, batteryDetails, batteryCapacityArgs, batteryCapacityArgsRegex } from '../widgets/shared/battery-model.mjs';
import { readFile } from 'node:fs/promises';

test('screenshot details use real units and explicit missing values', () => {
  assert.deepEqual(batteryDetails({ isCharging: true, timeTillFull: 960000, cycleCount: 93, powerConsumption: 16.4 }, 38), [
    ['Battery size', '38Wh'], ['Time to full', '16m'], ['Charge cycles', '93'], ['Charging', '16.4W'],
  ]);
  assert.deepEqual(batteryDetails(null, null).map(entry => entry[1]), ['—', '—', '—', '—']);
  assert.deepEqual(batteryDetails({ isCharging: false, timeTillFull: 60000, cycleCount: -1, powerConsumption: NaN }, 0).map(entry => entry[1]), ['—', '—', '—', '—']);
  assert.equal(batteryDetails({ cycleCount: 0, powerConsumption: 0 }, null)[2][1], '0');
});

test('capacity query permission is exact and read-only', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const permission = pack.widgets.find(widget => widget.name === 'popup').privileges.shellCommands.find(item => item.argsRegex === batteryCapacityArgsRegex());
  assert.equal(permission.argsRegex, batteryCapacityArgsRegex());
  const pattern = new RegExp(permission.argsRegex);
  assert(pattern.test(batteryCapacityArgs.join(' ')));
  assert(!pattern.test(batteryCapacityArgs.join(' ') + '; shutdown /s /t 0'));
});

test('battery levels use actual charge and AC wins even when not charging', () => {
  for (const [charge, state] of [[0, 'critical'], [0.09, 'critical'], [0.1, 'low'], [0.2, 'low'], [0.21, 'mid'], [0.79, 'mid'], [0.8, 'full'], [1, 'full']]) {
    assert.equal(batteryIndicator({ ac: 'Offline', charge, battery: 'High' }).state, state);
    assert.equal(batteryIndicator({ ac: 'Online', charge, battery: 'High' }).state, 'ac');
  }
});

test('absent battery and invalid data never imply an empty or full battery', () => {
  assert.deepEqual(batteryIndicator({ ac: 'Online', charge: 1, battery: 'NoSystemBattery' }), {
    state: 'ac', charge: null, label: 'Am Netz',
  });
  for (const charge of [-1, 2, NaN, null, undefined]) {
    const result = batteryIndicator({ ac: 'Offline', charge, battery: 'Unknown' });
    assert.equal(result.charge, null);
    assert.equal(result.state, 'unknown');
  }
  assert.equal(batteryIndicator(null).state, 'unknown');
});
