// Read-only Windows power status; also detects AC when charging is paused or complete.
export const powerStatusScript = 'Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.SystemInformation]::PowerStatus; [pscustomobject]@{ac=$p.PowerLineStatus.ToString(); charge=$p.BatteryLifePercent; battery=$p.BatteryChargeStatus.ToString()} | ConvertTo-Json -Compress';
export const powerStatusArgs = ['-NoProfile', '-NonInteractive', '-Command', powerStatusScript];

// Zebar does not expose capacity. Read the first battery's full-charge capacity
// (mWh) once per popup, matching its first-battery provider. No power settings.
export const batteryCapacityScript = "$ErrorActionPreference = 'Stop'; $b = Get-CimInstance -Namespace root/wmi -ClassName BatteryFullChargedCapacity | Select-Object -First 1; if ($b -and $b.FullChargedCapacity -gt 0 -and $b.FullChargedCapacity -lt 4294967295) { $b.FullChargedCapacity | ConvertTo-Json -Compress } else { 'null' }";
export const batteryCapacityArgs = ['-NoProfile', '-NonInteractive', '-Command', batteryCapacityScript];
export function batteryCapacityArgsRegex() {
  return `^${batteryCapacityArgs.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

export function batteryDetails(battery, capacity) {
  const valid = value => Number.isFinite(value) && value >= 0;
  const time = battery?.isCharging ? battery.timeTillFull : null; // milliseconds
  const watts = battery?.powerConsumption;
  return [
    ['Battery size', valid(capacity) && capacity > 0 ? `${Math.round(capacity)}Wh` : '—'],
    ['Time to full', valid(time) ? `${Math.ceil(time / 60000)}m` : '—'],
    ['Charge cycles', Number.isInteger(battery?.cycleCount) && battery.cycleCount >= 0 ? String(battery.cycleCount) : '—'],
    [battery?.isCharging ? 'Charging' : 'Discharging', valid(watts) ? `${watts.toFixed(1)}W` : '—'],
  ];
}

export function batteryIndicator(status) {
  const hasBattery = typeof status?.battery === 'string' && !status.battery.includes('NoSystemBattery');
  const charge = hasBattery && Number.isFinite(status?.charge) && status.charge >= 0 && status.charge <= 1
    ? Math.round(status.charge * 100) : null;
  const online = status?.ac === 'Online';
  const level = charge === null ? 'unknown' : charge < 10 ? 'critical' : charge <= 20 ? 'low' : charge >= 80 ? 'full' : 'mid';
  const state = online ? 'ac' : status?.ac === 'Offline' ? level : 'unknown';
  const label = online ? 'Am Netz' : state === 'unknown' ? 'Power status unavailable' : `Battery ${level}`;
  return { state, charge, label: `${label}${charge === null ? '' : ` — ${charge}%`}` };
}
