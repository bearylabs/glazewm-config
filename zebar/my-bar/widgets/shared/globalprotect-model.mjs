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
  if ($action -ne 'hide') { Start-Process -FilePath $app }
  if ($action -eq 'open') { [pscustomobject]@{ requested = 'open' } | ConvertTo-Json -Compress; exit 0 }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -ReferencedAssemblies System.dll,System.Core.dll,System.Windows.Forms.dll,System.Drawing.dll -TypeDefinition 'using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class GlobalProtectButton {
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  public static string PlaceBesidePopup(IntPtr client) {
    var popup = FindWindow(null, "Zebar - my-bar / popup");
    if (popup == IntPtr.Zero || !IsWindowVisible(popup)) return null;
    uint pid;
    GetWindowThreadProcessId(popup, out pid);
    using (var process = Process.GetProcessById((int)pid)) {
      if (!String.Equals(process.ProcessName, "zebar", StringComparison.OrdinalIgnoreCase)) return "Popup identity could not be verified.";
    }
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previous == IntPtr.Zero) return "Could not establish physical window coordinates.";
    try {
      Rect p, c;
      if (!GetWindowRect(popup, out p) || !GetWindowRect(client, out c)) return "Could not read window bounds.";
      var area = Screen.FromHandle(popup).WorkingArea;
      int width = c.Right - c.Left, height = c.Bottom - c.Top;
      if (width <= 0 || height <= 0 || width > area.Width || height > area.Height) return "GlobalProtect does not fit beside the popup on this screen.";
      int gap = 12;
      int alignedX = Math.Max(area.Left, Math.Min(p.Left, area.Right - width));
      int alignedY = Math.Max(area.Top, Math.Min(p.Top, area.Bottom - height));
      var candidates = new [] {
        new Rectangle(p.Right + gap, alignedY, width, height),
        new Rectangle(p.Left - gap - width, alignedY, width, height),
        new Rectangle(alignedX, p.Bottom + gap, width, height),
        new Rectangle(alignedX, p.Top - gap - height, width, height)
      };
      foreach (var target in candidates) {
        if (!area.Contains(target)) continue;
        // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE: move only, no focus stealing.
        return SetWindowPos(client, IntPtr.Zero, target.X, target.Y, 0, 0, 0x0015)
          ? null : "Windows rejected the GlobalProtect window move.";
      }
      return "No non-overlapping position is available on this screen.";
    } finally { SetThreadDpiAwarenessContext(previous); }
  }
}'
  $expected = if ($action -eq 'connect') { @('Connect') } elseif ($action -eq 'disconnect') { @('Disconnect') } else { @('Connect', 'Disconnect') }
  $button = $null
  $buttonWindow = $null
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
        if ($c.Name -in $expected -and $c.ClassName -eq 'Button' -and $c.IsEnabled -and !$c.IsOffscreen -and $c.NativeWindowHandle -ne 0) { $matches += [pscustomobject]@{ button = $control; window = $window } }
      }
    }
    if ($matches.Count -gt 1) { throw 'Multiple GlobalProtect buttons found; no click sent.' }
    if ($matches.Count -eq 1) { $button = $matches[0].button; $buttonWindow = $matches[0].window; break }
    # The client can already have dismissed its tray popup after disconnecting.
    if ($action -eq 'hide') { [pscustomobject]@{ requested = 'hide' } | ConvertTo-Json -Compress; exit 0 }
    Start-Sleep -Milliseconds 250
  }
  if (!$button) { throw ('No enabled ' + $expected + ' button found. Use the official client; its state or language may have changed.') }
  # Recheck immediately: never use the shared button ID as a blind toggle.
  $c = $button.Current
  if ($c.Name -notin $expected -or !$c.IsEnabled -or $c.IsOffscreen) { throw 'GlobalProtect state changed; no action sent.' }
  if ($action -eq 'hide') {
    # Hide only the verified main popup, never login/MFA windows or the process.
    $w = $buttonWindow.Current
    if ($w.ProcessId -notin $ids -or $w.NativeWindowHandle -eq 0) { throw 'GlobalProtect window changed; not hidden.' }
    if (!$w.IsOffscreen -and ![GlobalProtectButton]::ShowWindowAsync([IntPtr]$w.NativeWindowHandle, 0)) { throw 'Could not hide the GlobalProtect window.' }
    [pscustomobject]@{ requested = 'hide' } | ConvertTo-Json -Compress
    exit 0
  }
  $placementWarning = $null
  if ($action -eq 'connect' -or $action -eq 'disconnect') {
    # Only the verified main window is moved. Never enumerate/move login or MFA windows.
    $w = $buttonWindow.Current
    if ($w.ProcessId -notin $ids -or $w.NativeWindowHandle -eq 0 -or $w.IsOffscreen) { throw 'GlobalProtect window changed; no action sent.' }
    try { $placementWarning = [GlobalProtectButton]::PlaceBesidePopup([IntPtr]$w.NativeWindowHandle) }
    catch { $placementWarning = $_.Exception.GetBaseException().Message }
  }
  $c = $button.Current
  if ($c.Name -notin $expected -or !$c.IsEnabled -or $c.IsOffscreen) { throw 'GlobalProtect state changed after placement; no action sent.' }
  $result = [UIntPtr]::Zero
  $sent = [GlobalProtectButton]::SendMessageTimeout([IntPtr]$c.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero, 2, 2000, [ref]$result)
  if ($sent -eq [IntPtr]::Zero) { throw 'GlobalProtect click failed or timed out. Check the client before retrying.' }
  # Delivery is not connection success. The popup polls the adapter separately.
  [pscustomobject]@{ requested = $action; placementWarning = $placementWarning } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
}`;

const actions = ['status', 'connect', 'disconnect', 'open', 'hide'];
export function globalProtectArgs(action) {
  if (!actions.includes(action)) throw new Error('Invalid GlobalProtect action.');
  return ['-NoProfile', '-NonInteractive', '-Command', script.replace('__ACTION__', action)];
}
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function globalProtectArgsRegex() {
  return '^' + escape(['-NoProfile', '-NonInteractive', '-Command', script].join(' '))
    .replace('__ACTION__', '(?:status|connect|disconnect|open|hide)') + '$';
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
