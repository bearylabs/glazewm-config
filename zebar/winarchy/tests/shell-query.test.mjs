import assert from 'node:assert/strict';
import test from 'node:test';
import { createShellQueryExecutor, spawnShellQuery } from '../widgets/shared/shell-query.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const processes = [];
  const timers = new Set();
  const errors = [];
  let spawnError;
  let killError;
  let completeSpawn;
  const query = createShellQueryExecutor(async (program, args) => {
    if (spawnError) throw spawnError;
    const process = { program, args, handlers: {}, kills: 0 };
    for (const name of ['Stdout', 'Stderr', 'Exit']) {
      process[`on${name}`] = callback => { process.handlers[name] = callback; };
    }
    processes.push(process);
    if (completeSpawn) await new Promise(resolve => { completeSpawn = resolve; });
    return process;
  }, async process => {
    process.kills++;
    if (killError) throw killError;
  }, {
    schedule: callback => { timers.add(callback); return callback; },
    cancel: callback => timers.delete(callback),
    reportError: error => errors.push(error.message),
  });
  return {
    query, processes, timers, errors,
    set spawnError(value) { spawnError = value; },
    set killError(value) { killError = value; },
    holdSpawn() { completeSpawn = true; },
    finishSpawn() { completeSpawn(); completeSpawn = null; },
    timeout() { for (const callback of [...timers]) callback(); },
  };
}

test('read-only executor collects stdout, stderr and Zebar native code status', async () => {
  const env = fixture();
  const pending = env.query('powershell.exe', ['fixed-command']);
  await settle();
  const process = env.processes[0];
  process.handlers.Stdout('{"connected":');
  process.handlers.Stdout('true}');
  process.handlers.Stderr('native diagnostic');
  process.handlers.Exit({ code: 0, success: true, signal: null });
  const result = await pending;
  assert.deepEqual(JSON.parse(result.stdout), { connected: true });
  assert.equal(result.stderr, 'native diagnostic\n');
  assert.equal(result.code, 0);
  assert.equal(env.timers.size, 0);
});

test('timeout kills the exact process and permits retry even without a termination event', async () => {
  const env = fixture();
  const pending = env.query('powershell.exe', ['status'], { timeoutMessage: 'Status timed out.' });
  const failure = assert.rejects(pending, /Status timed out/);
  await settle();
  env.timeout();
  await failure;
  await settle();
  assert.equal(env.processes[0].kills, 1);
  assert.equal(env.processes.length, 1);
  const retry = env.query('powershell.exe', ['status']);
  await settle();
  env.processes[1].handlers.Stdout('null');
  env.processes[1].handlers.Exit({ code: 0, success: true, signal: null });
  assert.equal((await retry).stdout.trim(), 'null');
});

test('spawn finishing after the deadline is killed, not abandoned', async () => {
  const env = fixture();
  env.holdSpawn();
  const pending = env.query('powershell.exe', ['status']);
  const failure = assert.rejects(pending, /timed out/);
  await settle();
  env.timeout();
  await failure;
  await assert.rejects(env.query('powershell.exe', ['status']), /still running/);
  env.finishSpawn();
  await settle();
  assert.equal(env.processes[0].kills, 1);
});

test('failed kill is reported and never permits overlapping native queries', async () => {
  const env = fixture();
  env.killError = new Error('Access denied');
  const pending = env.query('powershell.exe', ['status']);
  const failure = assert.rejects(pending, /timed out/);
  await settle();
  env.timeout();
  await failure;
  await settle();
  assert.match(env.errors[0], /Could not stop.*Access denied/);
  await assert.rejects(env.query('powershell.exe', ['status']), /still running/);
  env.processes[0].handlers.Exit({ code: 1, success: false, signal: null });
});

test('spawn failures release the query slot and report the original error', async () => {
  const env = fixture();
  env.spawnError = new Error('Process launch failed');
  await assert.rejects(env.query('powershell.exe', ['status']), /Process launch failed/);
  assert.equal(env.timers.size, 0);
  env.spawnError = null;
  const retry = env.query('powershell.exe', ['status']);
  await settle();
  env.processes[0].handlers.Exit({ exitCode: 1 });
  assert.equal((await retry).code, 1);
});

function nativeFixture({ earlyExit = false } = {}) {
  const calls = [];
  let callback;
  let subscriptions = 0;
  let killError;
  const emit = event => callback({ payload: { pid: 123, event } });
  const invoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'shell_spawn') {
      if (earlyExit) {
        emit({ type: 'stdout', data: '{"available":true,"connected":false}' });
        emit({ type: 'terminated', data: { code: 0, success: true, signal: null } });
      }
      return 123;
    }
    assert.equal(command, 'shell_kill');
    assert.deepEqual(args, { pid: 123 });
    if (killError) throw killError;
    // Zebar's kill branch stops forwarding events: no terminated event.
  };
  const listen = async (name, handler) => {
    assert.equal(name, 'shell-emit');
    callback = handler;
    subscriptions++;
    return () => { subscriptions--; };
  };
  return {
    calls, emit, invoke, listen,
    get subscriptions() { return subscriptions; },
    set killError(value) { killError = value; },
  };
}

test('native query transport buffers events before spawn resolves and uses the Rust payload', async () => {
  const env = nativeFixture({ earlyExit: true });
  const query = createShellQueryExecutor(
    (program, args) => spawnShellQuery(env.invoke, env.listen, program, args),
    process => process.kill(),
  );
  const output = await query('powershell.exe', ['fixed-command']);
  assert.equal(output.code, 0);
  assert.deepEqual(JSON.parse(output.stdout), { available: true, connected: false });
  assert.equal(env.subscriptions, 0);
  assert.deepEqual(env.calls, [
    ['shell_spawn', { program: 'powershell.exe', args: ['fixed-command'], options: {} }],
    ['shell_kill', { pid: 123 }],
  ]);
});

test('native query kill releases listeners without requiring an exit event', async () => {
  const env = nativeFixture();
  const process = await spawnShellQuery(env.invoke, env.listen, 'powershell.exe', ['status']);
  assert.equal(env.subscriptions, 1);
  await process.kill();
  assert.equal(env.subscriptions, 0);
});

test('failed native query kill retains its listener until actual exit', async () => {
  const env = nativeFixture();
  const process = await spawnShellQuery(env.invoke, env.listen, 'powershell.exe', ['status']);
  env.killError = new Error('Access denied');
  await assert.rejects(process.kill(), /Access denied/);
  assert.equal(env.subscriptions, 1);
  env.killError = null;
  env.emit({ type: 'terminated', data: { code: 1, success: false, signal: null } });
  assert.equal(env.subscriptions, 0);
});
