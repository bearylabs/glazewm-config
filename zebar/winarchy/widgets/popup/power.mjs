import * as zebar from 'https://esm.sh/zebar@3.3.1';
import { createBatteryIcon } from '../shared/icons.mjs';
import { percent } from '../shared/system-model.mjs';
import { batteryDetails, batteryCapacityArgs } from '../shared/battery-model.mjs';
import { onPopupSessionEnd } from '../shared/popup-session.mjs';
import { element, hero, unavailable } from './dom.mjs';
import { subscribe } from './providers.mjs';

function details(entries, className) {
  const list = element('dl', undefined, className);
  for (const [label, value] of entries) {
    const item = element('div');
    item.append(element('dt', label), element('dd', value ?? 'Unavailable'));
    list.append(item);
  }
  return list;
}

function meter(value) {
  const track = element('div', undefined, 'meter');
  const fill = element('span');
  fill.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
  track.append(fill);
  return track;
}

export function renderPower(root) {
  const stats = element('div', undefined, 'power-stats');
  root.append(stats);
  let capacity = null;
  let disposed = false;
  onPopupSessionEnd(() => { disposed = true; });
  void zebar.shellExec('powershell.exe', batteryCapacityArgs).then(result => {
    if (disposed || result.code !== 0) return;
    const value = JSON.parse(result.stdout);
    capacity = Number.isFinite(value) && value > 0 ? value / 1000 : null;
    update(group.outputMap, group.errorMap);
  }).catch(() => {}); // Unsupported firmware/WMI data remains unavailable.
  const group = subscribe({
    battery: { type: 'battery', refreshInterval: 15000 },
  }, update);
  function update(output, errors) {
    const nodes = [];
    const battery = output.battery;
    const charge = Number.isFinite(battery?.chargePercent) && battery.chargePercent >= 0 && battery.chargePercent <= 100
      ? battery.chargePercent : null;
    const state = charge === null ? 'No battery data' : battery.isCharging ? 'Soaking amps'
      : battery.state ? String(battery.state).replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
        : 'Battery status unavailable';
    const heading = hero('battery-outline', 'Battery', state.toUpperCase(), charge === null ? '—' : percent(charge));
    heading.classList.add('power-hero');
    heading.querySelector('.hero__title').id = 'power-title';
    const icon = createBatteryIcon();
    const fill = icon.querySelector('.battery__fill');
    const fillHeight = 14 * (charge ?? 0) / 100;
    fill.setAttribute('height', String(fillHeight));
    fill.setAttribute('y', String(20 - fillHeight));
    icon.querySelector('.battery__bolt').style.display = charge !== null && battery.isCharging ? '' : 'none';
    icon.querySelector('.battery__unknown').style.display = charge === null ? '' : 'none';
    heading.querySelector('.hero__icon').replaceChildren(icon);
    nodes.push(heading);
    if (charge !== null) {
      const progress = meter(charge);
      progress.classList.add('battery-progress');
      progress.dataset.charging = String(battery.isCharging === true);
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', 'Battery charge');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.setAttribute('aria-valuenow', String(charge));
      nodes.push(progress, details(batteryDetails(battery, capacity), 'power-details battery-details'));
      if (errors.battery) nodes.push(unavailable('Battery', errors.battery));
    } else {
      nodes.push(element('p', errors.battery
        ? `No battery data: ${errors.battery.message ?? errors.battery}`
        : 'No battery data reported (desktop PCs may have no battery).', errors.battery ? 'error' : 'note'));
    }

    stats.replaceChildren(...nodes);
  }
}
