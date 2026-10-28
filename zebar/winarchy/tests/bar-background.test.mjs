import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('bar uses the normal window layer without dynamic fullscreen overrides', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  const bar = pack.widgets.find(widget => widget.name === 'bar');
  assert.equal(bar.zOrder, 'normal');
  assert.equal(bar.transparent, true);
  assert.equal(pack.widgets.find(widget => widget.name === 'popup').transparent, true);
  const [css, script] = await Promise.all([
    readFile(new URL('../widgets/bar/bar.css', import.meta.url), 'utf8'),
    readFile(new URL('../widgets/bar/bar.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(css, /--ctp-base: #1e1e2e;/);
  assert.match(css, /background: var\(--ctp-base\);/);
  assert.doesNotMatch(script, /setZOrder|updateBarZOrder|bar-z-order/);
  assert.doesNotMatch(css, /\.workspace\.is-focused\s*\{[^}]*background:/);
  assert.match(css, /\.workspace\.is-focused::after,/);
});

test('GlazeWM alone reserves the DPI-scaled bar height, without double docking space', async () => {
  const [source, config] = await Promise.all([
    readFile(new URL('../zpack.json', import.meta.url), 'utf8'),
    readFile(new URL('../../../glazewm/config.yaml', import.meta.url), 'utf8'),
  ]);
  const bar = JSON.parse(source).widgets.find(widget => widget.name === 'bar');
  const gaps = config.match(/^gaps:\r?\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert(gaps);
  assert.match(gaps, /^  scale_with_dpi: true\r?$/m);
  const top = gaps.match(/^    top: "([^"]+)"\r?$/m)?.[1];
  assert.equal(top, '28px');
  for (const preset of bar.presets) {
    assert.equal(preset.height, top);
    assert.equal(preset.dockToEdge.enabled, false);
  }
});

test('left-side controls have no mouseover highlight while keyboard focus stays visible', async () => {
  const css = await readFile(new URL('../widgets/bar/bar.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.(?:split|workspace):hover\b/);
  assert.match(css, /button:focus-visible\s*\{[^}]*outline:/);
  assert.match(css, /\.workspace\.is-focused::after,/);
});
