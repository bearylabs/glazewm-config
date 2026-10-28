import { availableMonitors, currentMonitor } from 'https://esm.sh/@tauri-apps/api@2.0.2/window';
import { createIcon } from '../shared/icons.mjs';
import { percent } from '../shared/system-model.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';
import { element, hero } from './dom.mjs';

function section(title, meta) {
  const result = element('section', undefined, 'display-section');
  const heading = element('div', undefined, 'display-section__heading');
  heading.append(element('h2', title));
  if (meta) heading.append(element('span', meta, 'display-section__meta'));
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
  const heading = hero('monitor', 'Display', '');
  heading.classList.add('display-hero');
  heading.querySelector('.hero__title').id = 'display-title';
  const meta = heading.querySelector('.hero__meta');
  root.append(heading);
  try {
    const [monitors, current] = await Promise.all([availableMonitors(), currentMonitor()]);
    if (disposed) return;
    if (!monitors.length) throw new Error('No connected displays reported.');
    const active = monitors.find(monitor => sameMonitor(monitor, current)) || monitors[0];
    const activeName = active.name || `Display ${monitors.indexOf(active) + 1}`;
    meta.textContent = activeName;
    const scale = section('Scale', activeName);
    scale.append(element('div', percent(active.scaleFactor * 100), 'display-scale__value'));
    const displays = section('Displays');
    const list = element('div', undefined, 'display-list');
    for (const [index, monitor] of monitors.entries()) {
      const isCurrent = sameMonitor(monitor, current);
      const row = element('article', undefined, `display-row${isCurrent ? ' display-row--current' : ''}`);
      const heading = element('div', undefined, 'display-row__heading');
      const glyph = element('span', undefined, 'display-row__icon');
      glyph.append(createIcon('monitor'));
      const name = element('h3', `${monitor.name || `Display ${index + 1}`}${isCurrent ? ' · focused' : ''}`);
      name.title = `${monitor.size.width} × ${monitor.size.height} · ${percent(monitor.scaleFactor * 100)}`;
      const connected = element('span', '✓', 'display-row__state');
      connected.setAttribute('aria-label', 'Connected');
      heading.append(glyph, name, connected);
      row.append(heading);
      list.append(row);
    }
    displays.append(list);
    root.append(scale, displays);
  } catch (error) {
    if (!disposed) { root.append(element('p', error.message, 'error')); reportError(error); }
  }
}
