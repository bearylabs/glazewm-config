import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  nightLightNative, nightLightStatusArgs, nightLightToggleArgs,
  nightLightPermissions, queryNightLight, toggleNightLight,
} from '../widgets/shared/night-light-model.mjs';

test('Night light validates state and surfaces native or malformed responses', async () => {
  for (const action of [queryNightLight, toggleNightLight]) {
    for (const value of [
      { available: true, enabled: false }, { available: true, enabled: true },
      { available: false, enabled: false },
    ]) {
      assert.deepEqual(await action(async () => ({
        code: 0, stdout: '\uFEFF' + JSON.stringify(value),
      })), value);
    }
    for (const value of [null, {}, { available: true, enabled: 1 }, { enabled: true }]) {
      await assert.rejects(action(async () => ({
        code: 0, stdout: JSON.stringify(value),
      })), /Invalid Windows Night light status/);
    }
    await assert.rejects(action(async () => ({
      code: 1, stderr: 'Unsupported Night light state format.',
    })), /Unsupported Night light state format/);
    await assert.rejects(action(async () => { throw new Error('Launch failed'); }), /Launch failed/);
  }
});

test('Night light reads have a deadline, mutations run once, permissions are exact', async () => {
  const calls = [];
  const exec = async (...args) => {
    calls.push(args);
    return { code: 0, stdout: '{"available":true,"enabled":false}' };
  };
  await queryNightLight(exec);
  await toggleNightLight(exec);
  assert.deepEqual(calls[0], ['powershell.exe', nightLightStatusArgs, {
    timeout: 15000, timeoutMessage: 'Windows Night light status query timed out.',
  }]);
  assert.deepEqual(calls[1], ['powershell.exe', nightLightToggleArgs, undefined]);
  for (const [index, args] of [nightLightStatusArgs, nightLightToggleArgs].entries()) {
    const permission = new RegExp(nightLightPermissions[index].argsRegex);
    assert(permission.test(args.join(' ')));
    assert(!permission.test(args.join(' ') + '; extra-command'));
    assert(!permission.test(args.join(' ').replace("$nightLightAction = '", "$nightLightAction = 'invalid")));
  }
  assert.doesNotMatch(nightLightNative, /bluelightreduction\.settings|SendKeys|keybd_event/);
});

test('native Night light codec rejects unsafe layouts and toggles valid states without registry access', {
  skip: process.platform !== 'win32', timeout: 30000,
}, async () => {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${nightLightNative.trim()}
'@
[byte[]]$off = 0x43,0x42,1,0,0x0a,2,1,0,0x2a,6,0x89,0x95,0xfc,0xbe,6,0x2a,0x2b,0x0e,0x13,0x43,0x42,1,0,0xd0,10,2,0xc6,20,0xa9,0xf6,0xe2,0xd3,0xef,0xea,0xe6,0xed,1,0,0,0,0
if ([WinarchyNightLight]::Decode($off).enabled) { throw 'Off fixture decoded as on' }
$on = [WinarchyNightLight]::Encode($off, $true)
if (-not [WinarchyNightLight]::Decode($on).enabled) { throw 'Encoded on state decoded as off' }
$again = [WinarchyNightLight]::Encode($on, $false)
if ([WinarchyNightLight]::Decode($again).enabled) { throw 'Encoded off state decoded as on' }
function Reject([byte[]]$bytes) {
  $rejected = $false
  try { [void][WinarchyNightLight]::Encode($bytes, $true) } catch { $rejected = $true }
  if (-not $rejected) { throw 'Unsafe state was accepted for mutation' }
}
Reject ([byte[]]@())
Reject $off[0..($off.Length - 2)]
$bad = $off.Clone(); $bad[0] = 0; Reject $bad
$bad = $off.Clone(); $bad[18] = 0xff; Reject $bad
$bad = $off.Clone(); $bad[23] = 0xd1; Reject $bad
$bad = $off.Clone(); $bad[25] = 4; Reject $bad
$bad = $off.Clone(); $bad[26] = 0xff; Reject $bad
$bad = [byte[]]($off + 0); Reject $bad
# A newer/unknown payload field is not silently discarded.
$bad = [byte[]]($off[0..($off.Length - 5)] + @(0xc2,40,1,0,0,0,0)); $bad[18] += 3; Reject $bad
# Explicit usable=false is supported for display but cannot be toggled.
$unusable = [byte[]]($off[0..($off.Length - 5)] + @(0xc2,30,0,0,0,0,0)); $unusable[18] += 3
if ([WinarchyNightLight]::Decode($unusable).available) { throw 'Unusable display reported available' }
Reject $unusable
$usable = $unusable.Clone(); $usable[$usable.Length - 5] = 1
$usableOn = [WinarchyNightLight]::Encode($usable, $true)
if (-not [WinarchyNightLight]::Decode($usableOn).available) { throw 'Availability was not preserved' }
'Night light native codec passed'
`.trim();
  const result = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', script,
  ], { timeout: 25000 });
  assert.match(result.stdout, /Night light native codec passed/);
  assert.equal(result.stderr, '');
});
