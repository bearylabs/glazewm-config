export function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : 'Unavailable';
}
