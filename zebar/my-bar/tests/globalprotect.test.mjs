import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { executeGlobalProtect, globalProtectArgs, globalProtectArgsRegex } from '../widgets/shared/globalprotect-model.mjs';

test('GlobalProtect permissions match only fixed status/open/connect/disconnect/hide commands', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const permissions = pack.widgets.find(w => w.name === 'popup').privileges.shellCommands;
  const permission = permissions.find(p => p.argsRegex === globalProtectArgsRegex());
  assert.equal(permission?.program, 'powershell.exe');
  const regex = new RegExp(permission.argsRegex);
  for (const action of ['status', 'open', 'connect', 'disconnect', 'hide']) {
    const args = globalProtectArgs(action).join(' ');
    assert(regex.test(args), action);
    assert(!regex.test(args + '; Start-Process evil.exe'));
    assert(!regex.test(args.replace("$action = '" + action + "'", "$action = 'toggle'")));
    assert(!regex.test(args.replace('0x00F5', '0x0010')));
  }
  assert.throws(() => globalProtectArgs('toggle'), /Invalid/);
  assert.throws(() => globalProtectArgs("connect'; evil"), /Invalid/);
});

test('native helper checks process, button name, visibility and enabled state before a single bounded click', () => {
  const command = globalProtectArgs('connect')[3];
  assert.match(command, /\$_.Path -eq \$app/);
  assert.match(command, /\$c.Name -in \$expected/);
  assert.match(command, /\$c.IsEnabled -and !\$c.IsOffscreen/);
  assert.match(command, /Multiple GlobalProtect buttons/);
  assert.match(command, /2, 2000, \[ref\]\$result/);
  assert(!command.includes('Disable-NetAdapter'));
  assert(!command.includes('Enable-NetAdapter'));
});

test('hide never opens or clicks the client and targets only its verified main popup', () => {
  const command = globalProtectArgs('hide')[3];
  assert.match(command, /if \(\$action -ne 'hide'\) \{ Start-Process/);
  assert.match(command, /\$buttonWindow = \$matches\[0\]\.window/);
  assert.match(command, /\$w.ProcessId -notin \$ids/);
  assert.match(command, /ShowWindowAsync\(\[IntPtr\]\$w.NativeWindowHandle, 0\)/);
  assert(command.indexOf("requested = 'hide'", command.indexOf('$w = $buttonWindow.Current')) < command.indexOf('0x00F5'));
  assert(!command.includes('Stop-Process'));
});

test('status validates booleans and supports split-tunnel adapter detection', async () => {
  const calls = [];
  const data = await executeGlobalProtect(async (...args) => {
    calls.push(args);
    return { code: 0, stdout: '\uFEFF{"available":true,"connected":true}' };
  }, 'status');
  assert.deepEqual(data, { available: true, connected: true });
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1][3], /NetworkInterface\]::GetAllNetworkInterfaces/);
  await assert.rejects(executeGlobalProtect(async () => ({ code: 0, stdout: '{"connected":"true"}' }), 'status'), /Invalid/);
});

test('read-only status queries time out instead of leaving controls stuck', async () => {
  await assert.rejects(executeGlobalProtect(() => new Promise(() => {}), 'status', 5), /timed out/);
});

test('click delivery is only a request, not fabricated connection success', async () => {
  const response = await executeGlobalProtect(async () => ({ code: 0, stdout: '{"requested":"connect"}' }), 'connect');
  assert.deepEqual(response, { requested: 'connect' });
  await assert.rejects(executeGlobalProtect(async () => ({ code: 0, stdout: '{"requested":"disconnect"}' }), 'connect'), /not confirmed/);
  for (const code of [1, null]) {
    await assert.rejects(executeGlobalProtect(async () => ({ code, stderr: 'Access denied' }), 'disconnect'), /Access denied/);
  }
});
