import assert from 'node:assert/strict';
import test from 'node:test';
import { attachPopupSizing } from '../widgets/shared/popup-sizing.mjs';

async function harness(resize) {
  let height = 180.2;
  let notify;
  let disconnected = false;
  const sizes = [];
  const errors = [];
  const stop = await attachPopupSizing({
    main: { getBoundingClientRect: () => ({ height }) },
    maxHeight: 540,
    resize: async value => { sizes.push(value); await resize?.(value); },
    reportError: error => errors.push(error),
    Observer: class {
      constructor(callback) { notify = callback; }
      observe() {}
      disconnect() { disconnected = true; }
    },
  });
  return {
    sizes, errors, stop,
    get disconnected() { return disconnected; },
    change(value) { height = value; notify(); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); },
  };
}

test('height fits content, grows with loaded data, shrinks again and caps long lists', async () => {
  const env = await harness();
  assert.deepEqual(env.sizes, [185]);
  for (const [contentHeight, expected] of [[320, 324], [800, 540], [160, 164]]) {
    env.change(contentHeight);
    await env.settle();
    assert.equal(env.sizes.at(-1), expected);
  }
  const count = env.sizes.length;
  env.change(160);
  await env.settle();
  assert.equal(env.sizes.length, count, 'Unchanged size must not trigger another native resize.');
  env.stop();
  env.change(400);
  await env.settle();
  assert.equal(env.disconnected, true);
  assert.equal(env.sizes.length, count);
  assert.deepEqual(env.errors, []);
});

test('provider updates during a native resize are coalesced, never run concurrently', async () => {
  let release;
  let active = 0;
  let maximumActive = 0;
  const env = await harness(async height => {
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (height === 304) await new Promise(resolve => { release = resolve; });
    active--;
  });
  env.change(300);
  env.change(350);
  env.change(400);
  release();
  await env.settle();
  assert.deepEqual(env.sizes, [185, 304, 404]);
  assert.equal(maximumActive, 1);
  env.stop();
});

test('resize failures are reported and later content changes can retry', async () => {
  const env = await harness(async height => {
    if (height === 304) throw new Error('Native resize failed');
  });
  env.change(300);
  await env.settle();
  assert.equal(env.errors[0].message, 'Native resize failed');
  env.change(350);
  await env.settle();
  assert.equal(env.sizes.at(-1), 354);
  env.stop();
});
