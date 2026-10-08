function awakeArgs(action) {
  return ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$awakeAction = '${action}'
$mutex = [System.Threading.Mutex]::new($false, 'Local\\Winarchy.PowerToys.Awake')
$locked = $false
try {
  $locked = $mutex.WaitOne(2000)
  if (-not $locked) { throw 'Another Awake operation is still running.' }
  $path = Join-Path $env:LOCALAPPDATA 'Microsoft\\PowerToys\\Awake\\settings.json'
  $session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  $running = @([System.Diagnostics.Process]::GetProcessesByName('PowerToys.Awake') | Where-Object { $_.SessionId -eq $session }).Count -gt 0
  $available = Test-Path -LiteralPath $path -PathType Leaf
  $enabled = $false
  if ($available) {
    $settings = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
    $mode = $settings.properties.mode
    if ($null -eq $mode -or $mode -notin @(0, 1, 2, 3)) { throw 'Invalid PowerToys Awake settings.' }
    $enabled = $running -and $mode -ne 0
  }
  if ($awakeAction -eq 'toggle') {
    if (-not $available -or -not $running) { throw 'Enable Awake in PowerToys Settings first.' }
    $settings.properties.mode = if ($enabled) { 0 } else { 1 }
    $json = $settings | ConvertTo-Json -Depth 32 -Compress
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
    $enabled = -not $enabled
  }
  [pscustomobject]@{ available = $available -and $running; enabled = $enabled } | ConvertTo-Json -Compress
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}`.trim()];
}

export const awakeStatusArgs = awakeArgs('status');
export const awakeToggleArgs = awakeArgs('toggle');
export const awakePermissions = [awakeStatusArgs, awakeToggleArgs].map(args => ({
  program: 'powershell.exe',
  argsRegex: `^${args.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
}));

async function runAwake(exec, args, options) {
  const result = await exec('powershell.exe', [...args], options);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'PowerToys Awake command failed.');
  const state = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (!state || typeof state.available !== 'boolean' || typeof state.enabled !== 'boolean' ||
      (!state.available && state.enabled)) throw new Error('Invalid PowerToys Awake status.');
  return state;
}

export const queryAwake = exec => runAwake(exec, awakeStatusArgs, {
  timeout: 15000, timeoutMessage: 'PowerToys Awake status query timed out.',
});
// Settings mutations use one-shot execution, never the cancellable query executor.
export const toggleAwake = exec => runAwake(exec, awakeToggleArgs);
