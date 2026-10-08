import { availableMonitors, currentMonitor } from 'https://esm.sh/@tauri-apps/api@2.0.2/window';
import { createIcon } from '../shared/icons.mjs';
import { percent } from '../shared/system-model.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';

function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
function section(title, meta) {
  const result = node('section', undefined, 'display-section');
  const heading = node('div', undefined, 'display-section__heading');
  heading.append(node('h2', title));
  if (meta) heading.append(node('span', meta, 'display-section__meta'));
  result.append(heading);
  return result;
}
function sameMonitor(a, b) {
  return a && b && a.position.x === b.position.x && a.position.y === b.position.y &&
    a.size.width === b.size.width && a.size.height === b.size.height;
}

// Read-only, deliberately matching the other flat Omarchy-style popups.
export async function renderDisplay(root, reportError) {
  let disposed = false;
  onPopupSessionEnd(() => { disposed = true; });
  const hero = node('div', undefined, 'hero display-hero');
  const icon = node('div', undefined, 'hero__icon');
  icon.append(createIcon('monitor'));
  const body = node('div', undefined, 'hero__body');
  const title = node('p', 'Display', 'hero__title');
  title.id = 'display-title';
  const meta = node('div', '', 'hero__meta');
  body.append(title, meta);
  hero.append(icon, body);
  root.append(hero);
  try {
    const [monitors, current] = await Promise.all([availableMonitors(), currentMonitor()]);
    if (disposed) return;
    if (!monitors.length) throw new Error('No connected displays reported.');
    const active = monitors.find(monitor => sameMonitor(monitor, current)) || monitors[0];
    const activeName = active.name || `Display ${monitors.indexOf(active) + 1}`;
    meta.textContent = activeName;
    const scale = section('Scale', activeName);
    scale.append(node('div', percent(active.scaleFactor * 100), 'display-scale__value'));
    const displays = section('Displays');
    const list = node('div', undefined, 'display-list');
    for (const [index, monitor] of monitors.entries()) {
      const isCurrent = sameMonitor(monitor, current);
      const row = node('article', undefined, `display-row${isCurrent ? ' display-row--current' : ''}`);
      const heading = node('div', undefined, 'display-row__heading');
      const glyph = node('span', undefined, 'display-row__icon');
      glyph.append(createIcon('monitor'));
      const name = node('h3', `${monitor.name || `Display ${index + 1}`}${isCurrent ? ' · focused' : ''}`);
      name.title = `${monitor.size.width} × ${monitor.size.height} · ${percent(monitor.scaleFactor * 100)}`;
      const connected = node('span', '✓', 'display-row__state');
      connected.setAttribute('aria-label', 'Connected');
      heading.append(glyph, name, connected);
      row.append(heading);
      list.append(row);
    }
    displays.append(list);
    root.append(scale, displays);
  } catch (error) {
    if (!disposed) { root.append(node('p', error.message, 'error')); reportError(error); }
  }
}
