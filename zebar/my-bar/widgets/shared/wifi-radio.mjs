// Fixed WinRT radio operations; no adapter disabling, elevation or WLAN scanning.
const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
[void][Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime]
$action = '__ACTION__'
function Await($operation, $resultType) {
  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\u00601' } | Select-Object -First 1
  $task = $method.MakeGenericMethod($resultType).Invoke($null, @($operation))
  if (!$task.Wait(10000)) { $operation.Cancel(); throw 'Wi-Fi radio operation timed out.' }
  return $task.Result
}
try {
  $radios = @(Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]))
  $wifi = @($radios | Where-Object { $_.Kind.ToString() -eq 'WiFi' })
  if ($action -ne 'status') {
    if ($wifi.Count -eq 0) { throw 'No Wi-Fi radio available.' }
    $access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    if ($access.ToString() -ne 'Allowed') { throw ('Windows denied Wi-Fi radio access: ' + $access) }
    $desired = if ($action -eq 'on') { 'On' } else { 'Off' }
    foreach ($radio in $wifi) {
      $result = Await ($radio.SetStateAsync($desired)) ([Windows.Devices.Radios.RadioAccessStatus])
      if ($result.ToString() -ne 'Allowed') { throw ('Windows denied Wi-Fi power change: ' + $result) }
    }
    Start-Sleep -Milliseconds 300
    if (@($wifi | Where-Object { $_.State.ToString() -ne $desired }).Count -gt 0) { throw 'Windows did not confirm the Wi-Fi power change.' }
  }
  [pscustomobject]@{ available = ($wifi.Count -gt 0); enabled = (@($wifi | Where-Object { $_.State.ToString() -eq 'On' }).Count -gt 0) } | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }`;
export function wifiRadioArgs(action) {
  if (!['status', 'on', 'off'].includes(action)) throw new Error('Invalid Wi-Fi radio action.');
  return ['-NoProfile', '-NonInteractive', '-Command', script.replace('__ACTION__', action)];
}
export const wifiRadioArgsRegex = '^' + wifiRadioArgs('status').join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace("'status'", "'(?:status|on|off)'") + '$';
export async function executeWifiRadio(exec, action) {
  const result = await exec('powershell.exe', wifiRadioArgs(action));
  if ((result.code ?? result.exitCode) !== 0) throw new Error(result.stderr?.trim() || 'Wi-Fi radio operation failed.');
  const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (typeof snapshot.available !== 'boolean' || typeof snapshot.enabled !== 'boolean') throw new Error('Invalid Wi-Fi radio status.');
  return snapshot;
}
