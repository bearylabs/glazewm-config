import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBarZOrder } from '../widgets/shared/bar-z-order.mjs';

test('bar stays above other window shadows and focused workspaces have no background highlight', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  assert.equal(pack.widgets.find(widget => widget.name === 'bar').zOrder, 'top_most');
  assert.equal(pack.widgets.find(widget => widget.name === 'bar').transparent, true);
  assert.equal(pack.widgets.find(widget => widget.name === 'popup').transparent, true);
  const [css, script] = await Promise.all([
    readFile(new URL('../widgets/bar/bar.css', import.meta.url), 'utf8'),
    readFile(new URL('../widgets/bar/bar.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(css, /--ctp-base: #1e1e2e;/);
  assert.match(css, /background: var\(--ctp-base\);/);
  assert.match(script, /updateBarZOrder\(glazewm\)/);
  assert.doesNotMatch(css, /\.workspace\.is-focused\s*\{[^}]*background:/);
  assert.match(css, /\.workspace\.is-focused::after,/);
});

test('left-side controls have no mouseover highlight while keyboard focus stays visible', async () => {
  const css = await readFile(new URL('../widgets/bar/bar.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.(?:split|workspace):hover\b/);
  assert.match(css, /button:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.workspace\.is-focused::after,/);
});

test('fullscreen can cover the bar and tiling restores its shadow-free layer', async () => {
  const calls = [];
  const update = createBarZOrder(async order => calls.push(order), assert.fail);
  await update(null);
  await update({ focusedContainer: { state: { type: 'tiling' } } });
  assert.deepEqual(calls, []);
  const fullscreen = { focusedContainer: { state: { type: 'fullscreen' } } };
  await update(fullscreen);
  await update(fullscreen);
  await update({ focusedContainer: { state: { type: 'tiling' } } });
  assert.deepEqual(calls, ['normal', 'top_most']);
});

test('rapid fullscreen changes apply window layers in order', async () => {
  const calls = [];
  const update = createBarZOrder(async order => calls.push(order), assert.fail);
  update({ focusedContainer: { state: { type: 'fullscreen' } } });
  await update({ focusedContainer: { state: { type: 'tiling' } } });
  assert.deepEqual(calls, ['normal', 'top_most']);
});
