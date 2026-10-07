import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('session cleanup runs once and finishes native provider stop before reopening', async () => {
  const window = new EventTarget();
  const context = vm.createContext({ window, console });
  const module = new vm.SourceTextModule(await readFile(
    new URL('../widgets/shared/popup-session.mjs', import.meta.url), 'utf8'), { context });
  await module.link(() => { throw new Error('Unexpected dependency'); });
  await module.evaluate();
  const { onPopupSessionEnd, waitForPopupSessionEnd } = module.namespace;
  let stops = 0;
  let resolveStop;
  const stopped = new Promise(resolve => { resolveStop = resolve; });
  onPopupSessionEnd(() => { stops++; return stopped; });
  window.dispatchEvent(new Event('popup-session-end'));
  window.dispatchEvent(new Event('pagehide'));
  assert.equal(stops, 1);
  let ready = false;
  const waiting = waitForPopupSessionEnd().then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  resolveStop();
  await waiting;
  assert.equal(ready, true);
  onPopupSessionEnd(() => { stops++; });
  window.dispatchEvent(new Event('popup-session-end'));
  assert.equal(stops, 2, 'New session has its own cleanup.');
});
