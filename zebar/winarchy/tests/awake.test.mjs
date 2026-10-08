import assert from 'node:assert/strict';
import test from 'node:test';
import {
  awakeStatusArgs, awakeToggleArgs, awakePermissions, queryAwake, toggleAwake,
} from '../widgets/shared/awake-model.mjs';

test('Awake reads are bounded and mutations are one-shot with exact permissions', async () => {
  const calls = [];
  const exec = async (...args) => {
    calls.push(args);
    return { code: 0, stdout: '\uFEFF{"available":true,"enabled":false}\n' };
  };
  assert.deepEqual(await queryAwake(exec), { available: true, enabled: false });
  assert.deepEqual(await toggleAwake(exec), { available: true, enabled: false });
  assert.deepEqual(calls[0], ['powershell.exe', awakeStatusArgs, {
    timeout: 15000, timeoutMessage: 'PowerToys Awake status query timed out.',
  }]);
  assert.deepEqual(calls[1], ['powershell.exe', awakeToggleArgs, undefined]);
  for (const [index, args] of [awakeStatusArgs, awakeToggleArgs].entries()) {
    const permission = new RegExp(awakePermissions[index].argsRegex);
    assert(permission.test(args.join(' ')));
    assert(!permission.test(args.join(' ') + '; Stop-Process -Id 123'));
    assert(!permission.test(args.join(' ').replace("$awakeAction = '", "$awakeAction = 'invalid")));
  }
  assert.match(awakeToggleArgs[3], /WaitOne\(2000\)/);
  assert.match(awakeToggleArgs[3], /properties\.mode = if \(\$enabled\) \{ 0 \} else \{ 1 \}/);
  assert.doesNotMatch(awakeToggleArgs[3], /Stop-Process|Start-Process|keepDisplayOn\s*=/);
});

test('Awake reports native errors and rejects malformed or inconsistent status', async () => {
  for (const action of [queryAwake, toggleAwake]) {
    await assert.rejects(action(async () => ({ code: 1, stderr: 'Access denied' })), /Access denied/);
    await assert.rejects(action(async () => { throw new Error('Spawn failed'); }), /Spawn failed/);
    for (const stdout of ['null', '{}', '{"available":true,"enabled":1}', '{"available":false,"enabled":true}']) {
      await assert.rejects(action(async () => ({ code: 0, stdout })), /Invalid PowerToys Awake status/);
    }
    assert.deepEqual(await action(async () => ({
      code: 0, stdout: '{"available":false,"enabled":false}',
    })), { available: false, enabled: false });
  }
});
