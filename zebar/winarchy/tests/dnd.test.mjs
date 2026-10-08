import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dndStatusArgs, dndToggleArgs, dndPermissions, queryDnd, toggleDnd,
} from '../widgets/shared/dnd-model.mjs';

const state = (profile, enabled) => ({
  available: true, enabled, profile: `Microsoft.QuietHoursProfile.${profile}`,
});
test('DND validates the effective native profile, including alarms-only', async () => {
  for (const action of [queryDnd, toggleDnd]) {
    for (const value of [state('Unrestricted', false), state('PriorityOnly', true), state('AlarmsOnly', true)]) {
      assert.deepEqual(await action(async () => ({
        code: 0, stdout: '\uFEFF' + JSON.stringify(value),
      })), value);
    }
    for (const value of [null, {}, state('Unknown', true), state('Unrestricted', true),
      { ...state('PriorityOnly', true), available: false }]) {
      await assert.rejects(action(async () => ({
        code: 0, stdout: JSON.stringify(value),
      })), /Invalid Windows Do not disturb status/);
    }
    await assert.rejects(action(async () => ({
      code: 1, stderr: 'Native interface unavailable',
    })), /Native interface unavailable/);
    await assert.rejects(action(async () => { throw new Error('Launch failed'); }), /Launch failed/);
  }
});

test('DND bounds reads, executes mutations once and permits only exact commands', async () => {
  const calls = [];
  const exec = async (...args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify(state('Unrestricted', false)) };
  };
  await queryDnd(exec);
  await toggleDnd(exec);
  assert.deepEqual(calls[0], ['powershell.exe', dndStatusArgs, {
    timeout: 15000, timeoutMessage: 'Windows Do not disturb status query timed out.',
  }]);
  assert.deepEqual(calls[1], ['powershell.exe', dndToggleArgs, undefined]);
  for (const [index, args] of [dndStatusArgs, dndToggleArgs].entries()) {
    const permission = new RegExp(dndPermissions[index].argsRegex);
    assert(permission.test(args.join(' ')));
    assert(!permission.test(args.join(' ') + '; extra-command'));
    assert(!permission.test(args.join(' ').replace("$dndAction = '", "$dndAction = 'invalid")));
  }
  assert.match(dndToggleArgs[3], /settings\.SetUserProfile\(target\)/);
  assert.match(dndToggleArgs[3], /moments\.TurnOffActiveMoment\(\)/);
  assert.match(dndToggleArgs[3], /if \(profile == target\) return profile/);
  assert.match(dndToggleArgs[3], /mutex\.WaitOne\(2000\)/);
  assert.doesNotMatch(dndToggleArgs[3], /Set-ItemProperty|SendKeys|keybd_event|NtUpdateWnfStateData/);
});
