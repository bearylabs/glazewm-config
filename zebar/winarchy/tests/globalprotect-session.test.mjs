import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { executeGlobalProtect } from '../widgets/shared/globalprotect-model.mjs';

class Element {
  constructor() {
    this.children = [];
    this.listeners = {};
    this.attributes = {};
    this.dataset = {};
    this.classList = { toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  const timers = new Map();
  const failures = [];
  const actions = [];
  let tick;
  let cleanup;
  let retained = false;
  let statusError = false;
  let holdStatus = false;
  let completeStatus;
  let connected = false;
  let holdAction = false;
  let completeAction;
  let actionError = false;
  const query = async () => {
    if (holdStatus) await new Promise(resolve => { completeStatus = resolve; });
    if (statusError) throw new Error('Status unavailable');
    return { code: 0, stdout: JSON.stringify({ available: true, connected }) };
  };
  const dependencies = {
    'https://esm.sh/zebar@3.3.1': {
      shellExec: async (_program, args) => {
        const action = args[3].match(/\$action = '([^']+)'/)[1];
        actions.push(action);
        if (holdAction) await new Promise(resolve => { completeAction = resolve; });
        if (actionError) throw new Error('Native action failed');
        return { code: 0, stdout: JSON.stringify({ requested: action }) };
      },
    },
    '../shared/globalprotect-model.mjs': { executeGlobalProtect },
    '../shared/native-query.mjs': { shellQuery: query },
    '../shared/popup-controller.mjs': {
      retainPopupDuringInteraction: () => { retained = true; return () => { retained = false; }; },
    },
    '../shared/snapshot-cache.mjs': {
      readSnapshot: () => null, writeSnapshot() {}, clearSnapshot() {}, vpnSnapshotValid() {},
    },
    '../shared/network-background.mjs': { readBackgroundSnapshot: () => null },
    '../shared/popup-session.mjs': { onPopupSessionEnd: callback => { cleanup = callback; } },
    '../shared/icons.mjs': { createIcon: () => new Element() },
  };
  const context = vm.createContext({
    document: { createElement: () => new Element(), createElementNS: () => new Element() },
    window: { addEventListener() {}, removeEventListener() {} },
    setTimeout: (callback, delay) => { timers.set(callback, delay); return callback; },
    clearTimeout: callback => timers.delete(callback),
    setInterval: callback => { tick = callback; return 1; },
    clearInterval() {},
    console,
  });
  const module = new vm.SourceTextModule(await readFile(
    new URL('../widgets/popup/globalprotect.mjs', import.meta.url), 'utf8',
  ), { context });
  await module.link(specifier => {
    const exports = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  let section;
  let toggle;
  async function mount() {
    const root = new Element();
    module.namespace.renderGlobalProtect(root, error => failures.push(error.message));
    await settle();
    section = root.children[0];
    toggle = section.children[0].children[2].children[1];
  }
  await mount();
  return {
    timers, failures, actions,
    get section() { return section; },
    get toggle() { return toggle; },
    get retained() { return retained; },
    set statusError(value) { statusError = value; },
    set holdStatus(value) { holdStatus = value; },
    set connected(value) { connected = value; },
    set holdAction(value) { holdAction = value; },
    set actionError(value) { actionError = value; },
    async connect() { toggle.listeners.click(); await settle(); },
    async refresh() { tick(); await settle(); },
    expire() {
      for (const [callback, delay] of [...timers]) {
        assert(delay >= 0 && delay <= 120000);
        timers.delete(callback);
        callback();
      }
    },
    stop() { cleanup(); },
    async finishStatus() { holdStatus = false; completeStatus(); await settle(); },
    async finishAction() { holdAction = false; completeAction(); await settle(); },
    async reopen() { cleanup(); await mount(); },
  };
}

test('VPN deadline ends pending operations even when every status query fails', async () => {
  const env = await fixture();
  await env.connect();
  assert(env.retained);
  env.statusError = true;
  await env.refresh();
  env.expire();
  assert.equal(env.retained, false);
  assert.equal(env.section.attributes['aria-busy'], 'false');
  assert.match(env.failures[0], /did not reach the requested state/);
  env.statusError = false;
  await env.refresh();
  assert.equal(env.toggle.disabled, false);
  assert.deepEqual(env.actions, ['connect'], 'Timeout never retries the VPN action.');
  env.stop();
});

test('VPN deadline covers a stalled action and forbids retries until native completion', async () => {
  const env = await fixture();
  env.holdAction = true;
  await env.connect();
  assert.equal(env.timers.size, 1);
  env.expire();
  await settle();
  assert.equal(env.retained, false);
  assert.equal(env.section.attributes['aria-busy'], 'false');
  assert.match(env.failures[0], /outcome is unknown/);
  await env.connect();
  assert.deepEqual(env.actions, ['connect'], 'An unresolved native action cannot be retried.');
  env.connected = true;
  await env.finishAction();
  await env.refresh();
  assert.equal(env.toggle.disabled, false);
  assert.deepEqual(env.actions, ['connect'], 'Late acceptance cannot restart pending state or hide the client.');
  assert.equal(env.timers.size, 0);
  env.stop();
});

test('closing a session during a native action clears its timer and ignores late acceptance', async () => {
  const env = await fixture();
  env.holdAction = true;
  await env.connect();
  env.stop();
  assert.equal(env.timers.size, 0);
  assert.equal(env.retained, false);
  await env.finishAction();
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.failures, []);
  assert.deepEqual(env.actions, ['connect']);
});

test('reopening the VPN popup cannot duplicate an unresolved action from the previous session', async () => {
  const env = await fixture();
  env.holdAction = true;
  await env.connect();
  await env.reopen();
  assert.equal(env.toggle.disabled, true);
  assert.match(env.section.children[1].textContent, /previous native action/);
  await env.connect();
  assert.deepEqual(env.actions, ['connect']);
  await env.finishAction();
  await env.refresh();
  assert.equal(env.toggle.disabled, false);
  assert.equal(env.timers.size, 0);
  assert.deepEqual(env.failures, []);
  env.stop();
});

test('VPN deadline does not depend on a stalled status query returning', async () => {
  const env = await fixture();
  await env.connect();
  env.holdStatus = true;
  await env.refresh();
  env.expire();
  assert.equal(env.retained, false);
  assert.equal(env.section.attributes['aria-busy'], 'false');
  assert.equal(env.failures.length, 1);
  env.connected = true;
  await env.finishStatus();
  assert.deepEqual(env.actions, ['connect'], 'Late status cannot hide the client after timeout.');
  env.stop();
});

test('confirmation and session teardown cancel the operation deadline', async () => {
  const confirmed = await fixture();
  await confirmed.connect();
  confirmed.connected = true;
  await confirmed.refresh();
  assert.equal(confirmed.timers.size, 0);
  assert.equal(confirmed.retained, false);
  assert.deepEqual(confirmed.actions, ['connect', 'hide']);
  confirmed.expire();
  assert.deepEqual(confirmed.failures, []);
  confirmed.stop();

  const closed = await fixture();
  await closed.connect();
  closed.stop();
  assert.equal(closed.timers.size, 0);
  assert.equal(closed.retained, false);
  closed.expire();
  assert.deepEqual(closed.failures, []);
});
