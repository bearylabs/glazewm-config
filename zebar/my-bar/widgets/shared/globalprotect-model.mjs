// Tested with the official Windows GlobalProtect 6.3 client. No credentials,
// adapter manipulation, private service protocol or coordinate-based clicks.
const script = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$action = '__ACTION__'
try {
  $app = Join-Path $env:ProgramFiles 'Palo Alto Networks\GlobalProtect\PanGPA.exe'
  if ($action -eq 'status') {
    $adapters = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.Description -match 'PANGP|GlobalProtect' })
    $active = @($adapters | Where-Object {
      $_.OperationalStatus -eq [System.Net.NetworkInformation.OperationalStatus]::Up -and
      @($_.GetIPProperties().UnicastAddresses | Where-Object {
        $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
        $_.Address.ToString() -notmatch '^(169\.254\.|0\.)'
      }).Count -gt 0
    })
    [pscustomobject]@{ available = (Test-Path -LiteralPath $app); connected = ($active.Count -gt 0) } | ConvertTo-Json -Compress
    exit 0
  }
  if (!(Test-Path -LiteralPath $app)) { throw 'GlobalProtect is not installed in its standard location.' }
  Start-Process -FilePath $app
  if ($action -eq 'open') { [pscustomobject]@{ requested = 'open' } | ConvertTo-Json -Compress; exit 0 }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GlobalProtectButton { [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result); }'
  $expected = if ($action -eq 'connect') { 'Connect' } else { 'Disconnect' }
  $button = $null
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $ids = @(Get-Process PanGPA -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $app } | ForEach-Object { $_.Id })
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    $windows = $desktop.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $matches = @()
    foreach ($window in $windows) {
      if ($window.Current.ProcessId -notin $ids -or $window.Current.IsOffscreen) { continue }
      $condition = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '1160')
      $controls = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree, $condition)
      foreach ($control in $controls) {
        $c = $control.Current
        if ($c.Name -eq $expected -and $c.ClassName -eq 'Button' -and $c.IsEnabled -and !$c.IsOffscreen -and $c.NativeWindowHandle -ne 0) { $matches += $control }
      }
    }
    if ($matches.Count -gt 1) { throw 'Multiple GlobalProtect buttons found; no click sent.' }
    if ($matches.Count -eq 1) { $button = $matches[0]; break }
    Start-Sleep -Milliseconds 250
  }
  if (!$button) { throw ('No enabled ' + $expected + ' button found. Use the official client; its state or language may have changed.') }
  # Recheck immediately: never use the shared button ID as a blind toggle.
  $c = $button.Current
  if ($c.Name -ne $expected -or !$c.IsEnabled -or $c.IsOffscreen) { throw 'GlobalProtect state changed; no click sent.' }
  $result = [UIntPtr]::Zero
  $sent = [GlobalProtectButton]::SendMessageTimeout([IntPtr]$c.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$result)
  if ($sent -eq [IntPtr]::Zero) { throw 'GlobalProtect click failed or timed out. Check the client before retrying.' }
  # Delivery is not connection success. The popup polls the adapter separately.
  [pscustomobject]@{ requested = $action } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}`;

const actions = ['status', 'connect', 'disconnect', 'open'];
export function globalProtectArgs(action) {
  if (!actions.includes(action)) throw new Error('Invalid GlobalProtect action.');
  return ['-NoProfile', '-NonInteractive', '-Command', script.replace('__ACTION__', action)];
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function globalProtectArgsRegex() {
  return '^' + escape(['-NoProfile', '-NonInteractive', '-Command', script].join(' '))
    .replace('__ACTION__', '(?:status|connect|disconnect|open)') + '$';
}

export async function executeGlobalProtect(shellExec, action, queryTimeout = 15000) {
  const args = globalProtectArgs(action);
  let timer;
  let result;
  try {
    const operation = shellExec('powershell.exe', args);
    // Only read-only queries can time out locally. A click must not be retried
    // while its native process could still be acting on the client.
    result = action === 'status' ? await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('GlobalProtect status query timed out.')), queryTimeout);
      }),
    ]) : await operation;
  } finally { clearTimeout(timer); }
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'GlobalProtect operation failed.');
  const data = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (action === 'status') {
    if (typeof data.available !== 'boolean' || typeof data.connected !== 'boolean') {
      throw new Error('Invalid GlobalProtect status.');
    }
  } else if (data.requested !== action) throw new Error('GlobalProtect request was not confirmed.');
  return data;
}
