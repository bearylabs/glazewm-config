import assert from 'node:assert/strict';
import test from 'node:test';
import { batteryIndicator } from '../widgets/shared/battery-model.mjs';

test('battery levels use actual charge and AC wins even when not charging', () => {
  for (const [charge, state] of [[0, 'low'], [0.2, 'low'], [0.21, 'mid'], [0.79, 'mid'], [0.8, 'full'], [1, 'full']]) {
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
