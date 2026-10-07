export function popupPlacement(monitor, monitors, barPosition, rect, size) {
  const scale = monitor.scaleFactor;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error('Invalid monitor scale factor.');
  }
  const margin = 6 * scale;
  const width = Math.min(size.width * scale, monitor.size.width - margin * 2);
  const height = Math.min(size.height * scale, monitor.size.height - margin * 2);
  if (width <= 0 || height <= 0) {
    throw new Error('Monitor is too small for the popup.');
  }
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const x = clamp(
    barPosition.x + (rect.left + rect.width / 2) * scale - width / 2,
    monitor.position.x + margin,
    monitor.position.x + monitor.size.width - width - margin,
  );
  const y = clamp(
    barPosition.y + rect.bottom * scale + margin,
    monitor.position.y + margin,
    monitor.position.y + monitor.size.height - height - margin,
  );
  const names = monitors.filter(item => item.name === monitor.name);
  const sorted = [...monitors].sort(
    (a, b) => a.position.x - b.position.x || a.position.y - b.position.y,
  );
  const index = sorted.findIndex(item =>
    item.position.x === monitor.position.x &&
    item.position.y === monitor.position.y &&
    item.size.width === monitor.size.width &&
    item.size.height === monitor.size.height,
  );
  if (index < 0) {
    throw new Error('The bar monitor is no longer connected.');
  }
  return {
    anchor: 'top_left',
    offsetX: `${(x - monitor.position.x) / scale}px`,
    offsetY: `${(y - monitor.position.y) / scale}px`,
    width: `${width / scale}px`,
    height: `${height / scale}px`,
    monitorSelection: monitor.name && names.length === 1
      ? { type: 'name', match: monitor.name }
      : { type: 'index', match: index },
    dockToEdge: { enabled: false, edge: null, windowMargin: '0px' },
  };
}

export function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function calendarDays(year, month) {
  const first = new Date(year, month, 1, 12);
  const start = 1 - (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) =>
    new Date(year, month, start + index, 12),
  );
}

export function shiftMonth(date, delta) {
  const first = new Date(date.getFullYear(), date.getMonth() + delta, 1, 12);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(date.getDate(), lastDay), 12);
}
export const popupSizes = Object.freeze({
  calendar: { width: 328, height: 376 },
  audio: { width: 380, height: 480 },
  network: { width: 380, height: 540 },
  display: { width: 380, height: 560 },
  power: { width: 380, height: 620 },
});
