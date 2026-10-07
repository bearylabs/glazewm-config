import assert from 'node:assert/strict';
import test from 'node:test';
import { createOutsideClickWatcher, spawnOutsideClickProcess } from '../widgets/shared/popup-dismissal.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(timeout = 10000, autoAck = true) {
  const processes = [];
  const errors = [];
  const clicks = [];
  const spawn = async () => {
    const process = { handlers: {}, writes: [], kills: 0 };
    processes.push(process);
    return {
      onStdout: callback => { process.handlers.stdout = callback; },
      onStderr: callback => { process.handlers.stderr = callback; },
      onExit: callback => { process.handlers.exit = callback; },
      write: async line => {
        if (process.writeError) throw process.writeError;
        process.writes.push(line);
        if (autoAck && line.startsWith('arm:')) process.handlers.stdout(`armed:${line.slice(4).trim()}`);
      },
      kill: async () => { process.kills++; },
    };
  };
  const watcher = createOutsideClickWatcher(spawn, id => clicks.push(id), error => errors.push(error), timeout);
  return { processes, errors, clicks, watcher };
}

async function warm(env) {
  const pending = env.watcher.prewarm();
  await tick();
  env.processes.at(-1).handlers.stdout('ready\r\n');
  await pending;
}

test('Zebar 3.3.1 compatibility sends pid to the native write and kill commands', async () => {
  const calls = [];
  const onStdout = () => {};
  const child = await spawnOutsideClickProcess(async (program, args) => {
    assert.equal(program, 'powershell.exe');
    assert.deepEqual(args, ['fixed-command']);
    return {
      processId: 1234,
      onStdout,
      write() { throw new Error('Broken processId wrapper called.'); },
      kill() { throw new Error('Broken processId wrapper called.'); },
    };
  }, async (command, args) => {
    assert(Object.hasOwn(args, 'pid'), 'command shell_write missing required key pid');
    assert(!Object.hasOwn(args, 'processId'));
    calls.push([command, args]);
  }, 'powershell.exe', ['fixed-command']);
  assert.equal(child.onStdout, onStdout, 'Keep Zebar event handling unchanged.');
  await child.write('arm:request-1\n');
  await child.kill();
  assert.deepEqual(calls, [
    ['shell_write', { pid: 1234, buffer: 'arm:request-1\n' }],
    ['shell_kill', { pid: 1234 }],
  ]);
});

test('concurrent prewarming starts one helper, and opening many popups reuses it', async () => {
  const env = harness();
  const first = env.watcher.prewarm();
  const second = env.watcher.prewarm();
  await tick();
  assert.equal(env.processes.length, 1);
  env.processes[0].handlers.stdout('ready');
  await Promise.all([first, second]);
  for (let index = 0; index < 20; index++) {
    await env.watcher.arm(`request-${index}`);
    env.watcher.disarm();
  }
  await tick();
  assert.equal(env.processes.length, 1, 'No PowerShell startup or C# compilation on subsequent opens.');
  assert.equal(env.processes[0].writes.length, 40);
  env.watcher.stop();
  await tick();
  assert.equal(env.processes[0].kills, 1);
  assert.deepEqual(env.errors, []);
});

test('arm waits for the matching native acknowledgement', async () => {
  const env = harness(10000, false);
  await warm(env);
  let armed = false;
  const pending = env.watcher.arm('new-request').then(() => { armed = true; });
  await tick();
  assert.equal(armed, false);
  env.processes[0].handlers.stdout('armed:old-request');
  await tick();
  assert.equal(armed, false);
  env.processes[0].handlers.stdout('armed:new-request');
  await pending;
  assert.equal(armed, true);
  env.watcher.stop();
});

test('outside clicks carry the exact request ID and the helper stays alive', async () => {
  const env = harness();
  await warm(env);
  await env.watcher.arm('request-1');
  env.processes[0].handlers.stdout('outside:request-1\r\n');
  await tick();
  assert.deepEqual(env.clicks, ['request-1']);
  await env.watcher.arm('request-2');
  assert.equal(env.processes.length, 1);
  env.watcher.disarm();
  await tick();
  assert.equal(env.processes[0].writes.at(-1), 'disarm:request-2\n');
  env.watcher.stop();
  env.processes[0].handlers.stdout('outside:request-2');
  await tick();
  assert.deepEqual(env.clicks, ['request-1'], 'Disposed watchers must ignore buffered output.');
});

test('native startup failure is surfaced and a later open can retry', async () => {
  const env = harness();
  const pending = env.watcher.prewarm();
  const rejected = assert.rejects(pending, /Access denied/);
  await tick();
  env.processes[0].handlers.stderr('Access denied');
  env.processes[0].handlers.exit({ exitCode: 1 });
  await rejected;
  assert.equal(env.processes[0].kills, 0);
  await warm(env);
  assert.equal(env.processes.length, 2);
  await env.watcher.arm('request-1');
  env.watcher.stop();
});

test('startup timeout stops the helper process', async () => {
  const env = harness(10);
  await assert.rejects(env.watcher.prewarm(), /startup timed out/);
  await tick();
  assert.equal(env.processes[0].kills, 1);
});

test('runtime process exit rejects an outstanding arm and recovers on next open', async () => {
  const env = harness(10000, false);
  await warm(env);
  const arm = env.watcher.arm('request-1');
  const rejected = assert.rejects(arm, /watcher exited/);
  await tick();
  env.processes[0].handlers.exit({ exitCode: 1 });
  await rejected;
  assert.equal(env.errors.length, 1);
  await warm(env);
  assert.equal(env.processes.length, 2);
  env.watcher.stop();
});

test('arm timeout stops the unresponsive helper so the next open can restart it', async () => {
  const env = harness(20, false);
  await warm(env);
  await assert.rejects(env.watcher.arm('request-1'), /arm timed out/);
  await tick();
  assert.equal(env.processes[0].kills, 1);
  await warm(env);
  assert.equal(env.processes.length, 2);
  env.watcher.stop();
});

test('bar teardown during prewarming kills the helper when startup finishes', async () => {
  const env = harness();
  const pending = env.watcher.prewarm();
  const rejected = assert.rejects(pending, /disposed/);
  await tick();
  env.watcher.stop();
  env.processes[0].handlers.stdout('ready');
  await rejected;
  await tick();
  assert.equal(env.processes[0].kills, 1);
  await assert.rejects(env.watcher.arm('request-1'), /disposed/);
  assert.equal(env.processes.length, 1);
});

test('failed stdin writes stop the broken helper and permit recovery on the next open', async () => {
  const env = harness();
  await warm(env);
  env.processes[0].writeError = new Error('Broken pipe');
  await assert.rejects(env.watcher.arm('request-1'), /Broken pipe/);
  await tick();
  assert.equal(env.processes[0].kills, 1);
  await warm(env);
  await env.watcher.arm('request-2');
  assert.equal(env.processes.length, 2);
  env.watcher.stop();
});

test('request IDs cannot inject additional stdin commands', async () => {
  const env = harness();
  await assert.rejects(env.watcher.arm('request-1\narm:request-2'), /Invalid popup request ID/);
  assert.equal(env.processes.length, 0);
});
