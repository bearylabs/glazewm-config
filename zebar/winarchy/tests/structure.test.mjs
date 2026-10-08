import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('widget HTML loads packaged styles and module entry points without inline code', async () => {
  const pack = JSON.parse(await readFile(new URL('../zpack.json', import.meta.url), 'utf8'));
  for (const [name, entry] of [['bar', 'bar'], ['popup', 'bootstrap']]) {
    const html = await readFile(new URL(`../widgets/${name}/index.html`, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<style\b/);
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      assert.equal(script[1].trim(), '');
    }
    assert.match(html, new RegExp(`<link rel="stylesheet" href="\\./${name}\\.css"`));
    assert.match(html, new RegExp(`<script type="module" src="\\./${entry}\\.mjs">`));
    const widget = pack.widgets.find(widget => widget.name === name);
    assert(widget.includeFiles.includes(`widgets/${name}/**`));
    const [css, script] = await Promise.all([
      readFile(new URL(`../widgets/${name}/${name}.css`, import.meta.url), 'utf8'),
      readFile(new URL(`../widgets/${name}/${entry}.mjs`, import.meta.url), 'utf8'),
    ]);
    assert(css.length > 0);
    assert(script.length > 0);
  }
});

test('system dispatcher uses separate renderers and obsolete styles are absent', async () => {
  const [dispatcher, css] = await Promise.all([
    readFile(new URL('../widgets/popup/system.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../widgets/popup/popup.css', import.meta.url), 'utf8'),
  ]);
  for (const type of ['audio', 'network', 'power']) {
    assert(dispatcher.includes(`from './${type}.mjs'`));
    const renderer = await readFile(new URL(`../widgets/popup/${type}.mjs`, import.meta.url), 'utf8');
    assert(renderer.includes("from './dom.mjs'"));
    assert.match(renderer, /export function render/);
  }
  assert.doesNotMatch(dispatcher, /shellExec|createProviderGroup|createAudioClient/);
  assert.doesNotMatch(css, /power-confirmation|power-actions|power-drive|power-section|network-vpn__row|details-grid|\.badge|\.card|\.controls/);
});
