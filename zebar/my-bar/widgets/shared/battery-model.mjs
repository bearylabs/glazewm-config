// Read-only Windows power status; also detects AC when charging is paused or complete.
export const powerStatusScript = 'Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.SystemInformation]::PowerStatus; [pscustomobject]@{ac=$p.PowerLineStatus.ToString(); charge=$p.BatteryLifePercent; battery=$p.BatteryChargeStatus.ToString()} | ConvertTo-Json -Compress';
export const powerStatusArgs = ['-NoProfile', '-NonInteractive', '-Command', powerStatusScript];

export function batteryIndicator(status) {
  const hasBattery = typeof status?.battery === 'string' && !status.battery.includes('NoSystemBattery');
  const charge = hasBattery && Number.isFinite(status?.charge) && status.charge >= 0 && status.charge <= 1
    ? Math.round(status.charge * 100) : null;
  const online = status?.ac === 'Online';
  const level = charge === null ? 'unknown' : charge <= 20 ? 'low' : charge >= 80 ? 'full' : 'mid';
  const state = online ? 'ac' : status?.ac === 'Offline' ? level : 'unknown';
  const label = online ? 'Am Netz' : state === 'unknown' ? 'Power status unavailable' : `Battery ${level}`;
  return { state, charge, label: `${label}${charge === null ? '' : ` — ${charge}%`}` };
}
