import assert from 'node:assert/strict';
import test from 'node:test';
import { batteryIndicator, batteryDetails, batteryCapacityArgs, batteryCapacityArgsRegex, queryPowerStatus, queryBatteryCapacity } from '../widgets/shared/battery-model.mjs';
import { createShellQueryExecutor } from '../widgets/shared/shell-query.mjs';
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

test('battery reads distinguish missing firmware data from query errors and malformed output', async () => {
  assert.equal(await queryBatteryCapacity(async () => ({ code: 0, stdout: '\uFEFFnull' })), null);
  assert.equal(await queryBatteryCapacity(async () => ({ code: 0, stdout: '\uFEFF38000' })), 38);
  for (const stdout of ['"38000"', '-1', '4294967295']) {
    await assert.rejects(queryBatteryCapacity(async () => ({ code: 0, stdout })), /Invalid battery capacity/);
  }
  await assert.rejects(queryBatteryCapacity(async () => ({ code: 1, stderr: 'Access denied' })), /Access denied/);
  await assert.rejects(queryPowerStatus(async () => ({ code: 0, stdout: '{}' })), /Invalid power status/);
  const status = { ac: 'Online', charge: 0.8, battery: 'High' };
  assert.deepEqual(await queryPowerStatus(async () => ({ code: 0, stdout: JSON.stringify(status) })), status);
});

for (const [name, read, stdout] of [
  ['Power status', queryPowerStatus, '{"ac":"Online","charge":0.8,"battery":"High"}'],
  ['Battery capacity', queryBatteryCapacity, '38000'],
]) {
  test(`${name} kills stalled reads and prevents duplicates across popup reopening`, async () => {
    const timers = new Map();
    let spawns = 0;
    let kills = 0;
    let finish;
    let output;
    const query = createShellQueryExecutor(async () => {
      spawns++;
      return { onStdout(fn) { output = fn; }, onStderr() {}, onExit(fn) { finish = fn; } };
    }, async () => { kills++; }, {
      schedule(fn, timeout) { assert.equal(timeout, 15000); timers.set(fn, timeout); return fn; },
      cancel: fn => timers.delete(fn),
    });
    const pending = assert.rejects(read(query), /query timed out/);
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(read(query), /previous status query is still running/);
    assert.equal(spawns, 1);
    [...timers.keys()][0]();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(kills, 1);
    const retry = read(query);
    await new Promise(resolve => setImmediate(resolve));
    output(stdout);
    finish({ code: 0 });
    await retry;
    assert.equal(spawns, 2);
    assert.equal(timers.size, 0);
  });
}
