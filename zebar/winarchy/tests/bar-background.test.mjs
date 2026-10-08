import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBarZOrder } from '../widgets/shared/bar-z-order.mjs';

test('bar stays above other window shadows and focused workspaces have no background highlight', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  assert.equal(pack.widgets.find(widget => widget.name === 'bar').zOrder, 'top_most');
  assert.equal(pack.widgets.find(widget => widget.name === 'bar').transparent, true);
  assert.equal(pack.widgets.find(widget => widget.name === 'popup').transparent, true);
  const html = await readFile(new URL('../widgets/bar/index.html', import.meta.url), 'utf8');
  assert.match(html, /--ctp-base: #1e1e2e;/);
  assert.match(html, /background: var\(--ctp-base\);/);
  assert.match(html, /updateBarZOrder\(glazewm\)/);
  assert.doesNotMatch(html, /\.workspace\.is-focused\s*\{[^}]*background:/);
  assert.match(html, /\.workspace\.is-focused::after,/);
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
