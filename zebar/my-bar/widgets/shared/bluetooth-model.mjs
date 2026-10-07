import { bluetoothAudioSource } from './bluetooth-audio-native.mjs';

// Windows WinRT backend. Fixed source + hex-encoded device IDs keep shell permissions narrow.
const source = `using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Windows.Devices.Enumeration;
using Windows.Devices.Radios;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
public static class BluetoothMenu {
  const string Selector = "System.Devices.Aep.ProtocolId:=\\\"{e0cbf06c-cd8b-4647-bb8a-263b43f0f974}\\\" OR System.Devices.Aep.ProtocolId:=\\\"{bb7bb05e-5972-42b5-94fc-76eaa7084d49}\\\"";
  static readonly string[] Props = { "System.Devices.Aep.IsConnected", "System.Devices.Aep.DeviceAddress", "System.Devices.Aep.ProtocolId" };
  public sealed class Row {
    public string id, name, address;
    public bool paired, connected;
  }
  public sealed class Snapshot { public bool available, enabled; public Row[] devices; }
  static async Task<T> Wait<T>(Windows.Foundation.IAsyncOperation<T> operation) {
    try {
      var deadline = DateTime.UtcNow.AddSeconds(90);
      while (operation.Status == Windows.Foundation.AsyncStatus.Started) {
        if (DateTime.UtcNow > deadline) { operation.Cancel(); throw new TimeoutException("Bluetooth operation timed out."); }
        await Task.Delay(100);
      }
      return operation.GetResults();
    } finally { operation.Close(); }
  }
  static bool Connected(DeviceInformation d) { object v; return d.Properties.TryGetValue(Props[0], out v) && v is bool && (bool)v; }
  static bool LiveConnected(DeviceInformation d) {
    // A stale/not-present audio endpoint must never negate Windows Bluetooth state.
    if (Connected(d)) return true;
    ulong address;
    if (d.Pairing.IsPaired && UInt64.TryParse(Address(d).Replace(":", "").Replace("-", ""), System.Globalization.NumberStyles.HexNumber, null, out address)) {
      try { if (BluetoothAudio.ConnectionStatus(address) == true) return true; }
      catch (COMException) { }
    }
    return false;
  }
  static string Address(DeviceInformation d) { object v; return d.Properties.TryGetValue(Props[1], out v) ? Convert.ToString(v) : ""; }
  // PowerShell -Command runs on an STA thread. WinRT completion can require that
  // thread to pump COM messages, so blocking it with GetResult deadlocks.
  // Start all WinRT work on a thread-pool (MTA) thread instead.
  public static Task<Snapshot> Read(bool scan) { return Task.Run(() => ReadCore(scan)); }
  static async Task<Snapshot> ReadCore(bool scan) {
    var radios = await Wait(Radio.GetRadiosAsync());
    var bt = radios.Where(r => r.Kind == RadioKind.Bluetooth).ToArray();
    var found = new Dictionary<string, DeviceInformation>();
    if (bt.Length > 0) {
      var selector = "(" + Selector + ") AND System.Devices.Aep.IsPaired:=System.StructuredQueryType.Boolean#" + (scan ? "False" : "True");
      var watcher = DeviceInformation.CreateWatcher(selector, Props, DeviceInformationKind.AssociationEndpoint);
      var enumerated = new TaskCompletionSource<bool>();
      watcher.EnumerationCompleted += (w, e) => enumerated.TrySetResult(true);
      var gate = new object();
      watcher.Added += (w, d) => { lock (gate) found[d.Id] = d; };
      watcher.Updated += (w, u) => { lock (gate) { DeviceInformation d; if (found.TryGetValue(u.Id, out d)) d.Update(u); } };
      watcher.Removed += (w, u) => { lock (gate) found.Remove(u.Id); };
      watcher.Start();
      // FindAllAsync can wait indefinitely for Bluetooth enumeration to complete.
      // Watchers provide incremental results and let us bound both status and scans.
      try {
        if (scan && bt.Any(r => r.State == RadioState.On)) await Task.Delay(8000);
        else await Task.WhenAny(enumerated.Task, Task.Delay(2000));
      }
      finally { watcher.Stop(); }
      lock (gate) return Make(bt, found.Values.ToArray());
    }
    return Make(bt, new DeviceInformation[0]);
  }
  static Snapshot Make(Radio[] radios, DeviceInformation[] devices) {
    return new Snapshot { available = radios.Length > 0, enabled = radios.Any(r => r.State == RadioState.On),
      devices = devices.Select(d => new Row { id = d.Id, name = d.Name, address = Address(d), paired = d.Pairing.IsPaired, connected = LiveConnected(d) }).ToArray() };
  }
  public static Task Power(bool on) { return Task.Run(() => PowerCore(on)); }
  static async Task PowerCore(bool on) {
    var access = await Wait(Radio.RequestAccessAsync());
    if (access != RadioAccessStatus.Allowed) throw new Exception("Windows denied radio access: " + access);
    var radios = await Wait(Radio.GetRadiosAsync());
    var bt = radios.Where(r => r.Kind == RadioKind.Bluetooth).ToArray();
    if (bt.Length == 0) throw new Exception("No Bluetooth adapter.");
    foreach (var radio in bt) { var result = await Wait(radio.SetStateAsync(on ? RadioState.On : RadioState.Off)); if (result != RadioAccessStatus.Allowed) throw new Exception("Cannot change Bluetooth power: " + result); }
  }
  static void PairRequest(DeviceInformationCustomPairing sender, DevicePairingRequestedEventArgs args) {
    if (args.PairingKind == DevicePairingKinds.ConfirmOnly) {
      if (MessageBox.Show("Pair this Bluetooth device?", "Bluetooth pairing", MessageBoxButtons.YesNo) == DialogResult.Yes) args.Accept();
    } else if (args.PairingKind == DevicePairingKinds.ConfirmPinMatch) {
      if (MessageBox.Show("Does this PIN match the device?\\n\\n" + args.Pin, "Bluetooth pairing", MessageBoxButtons.YesNo) == DialogResult.Yes) args.Accept();
    } else if (args.PairingKind == DevicePairingKinds.DisplayPin) {
      MessageBox.Show("Enter this PIN on the Bluetooth device, then press Enter:\\n\\n" + args.Pin, "Bluetooth pairing"); args.Accept();
    } else if (args.PairingKind == DevicePairingKinds.ProvidePin) {
      using (var form = new Form { Text = "Bluetooth PIN", Width = 340, Height = 150, TopMost = true, StartPosition = FormStartPosition.CenterScreen }) {
        var input = new TextBox { Left = 16, Top = 16, Width = 290 };
        var ok = new Button { Text = "Pair", Left = 210, Top = 52, DialogResult = DialogResult.OK };
        form.Controls.Add(input); form.Controls.Add(ok); form.AcceptButton = ok;
        if (form.ShowDialog() == DialogResult.OK && input.Text.Length > 0) args.Accept(input.Text);
      }
    }
  }
  public static Task Act(string action, string id) { return Task.Run(() => ActCore(action, id)); }
  static async Task ActCore(string action, string id) {
    var d = await Wait(DeviceInformation.CreateFromIdAsync(id, Props, DeviceInformationKind.AssociationEndpoint));
    if (d == null) throw new Exception("Device is no longer available. Scan again.");
    if (action == "forget") {
      var result = await Wait(d.Pairing.UnpairAsync());
      if (result.Status != DeviceUnpairingResultStatus.Unpaired && result.Status != DeviceUnpairingResultStatus.AlreadyUnpaired) throw new Exception("Unpair failed: " + result.Status);
      return;
    }
    if (action == "pair" && !d.Pairing.IsPaired) {
      var custom = d.Pairing.Custom; custom.PairingRequested += PairRequest;
      try {
        var result = await Wait(custom.PairAsync(DevicePairingKinds.ConfirmOnly | DevicePairingKinds.ConfirmPinMatch | DevicePairingKinds.DisplayPin | DevicePairingKinds.ProvidePin));
        if (result.Status != DevicePairingResultStatus.Paired && result.Status != DevicePairingResultStatus.AlreadyPaired) throw new Exception("Pairing failed: " + result.Status);
      } finally { custom.PairingRequested -= PairRequest; }
    }
    // Pairing is complete. Windows installs profiles and auto-connects supported
    // peripherals; do not manipulate service installation to force connection.
    if (action == "pair") return;
    ulong address = Convert.ToUInt64(Address(d).Replace(":", "").Replace("-", ""), 16);
    object protocol; d.Properties.TryGetValue(Props[2], out protocol);
    if (Convert.ToString(protocol).IndexOf("bb7bb05e", StringComparison.OrdinalIgnoreCase) >= 0) {
      if (action == "disconnect") throw new Exception("Windows manages Bluetooth LE connections. Turn off the device or remove its pairing.");
      using (var device = await Wait(BluetoothLEDevice.FromBluetoothAddressAsync(address))) {
        if (device == null) throw new Exception("Bluetooth LE device is unavailable.");
        var result = await Wait(device.GetGattServicesAsync(BluetoothCacheMode.Uncached));
        foreach (var service in result.Services) service.Dispose();
        if (result.Status != GattCommunicationStatus.Success) throw new Exception("Device paired, but not reachable: " + result.Status);
      }
      return;
    }
    // Audio must use a one-shot driver connection, not profile uninstall/reinstall.
    if (action == "connect" && LiveConnected(d)) return;
    if (await BluetoothAudio.Request(address, action != "disconnect")) return;
    throw new Exception("Windows has no usable Bluetooth audio endpoint for " + d.Name + ". Connect it in Windows Bluetooth settings. If that also fails, remove its pairing there and pair it again.");
  }
}
${bluetoothAudioSource}`;

const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); Add-Type -AssemblyName System.Runtime.WindowsRuntime; $refs = @('System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Runtime.WindowsRuntime.dll', 'System.Runtime.InteropServices.WindowsRuntime.dll', 'System.ObjectModel.dll', "$env:windir\\Microsoft.NET\\Framework64\\v4.0.30319\\System.Runtime.dll") + @(Get-ChildItem "$env:windir\\System32\\WinMetadata\\*.winmd" | ForEach-Object FullName); $compiler = [Microsoft.CSharp.CSharpCodeProvider]::new(); $parameters = [System.CodeDom.Compiler.CompilerParameters]::new(); $parameters.GenerateInMemory = $true; foreach ($ref in $refs) { [void]$parameters.ReferencedAssemblies.Add($ref) }; $compiled = $compiler.CompileAssemblyFromSource($parameters, '${source}'); if ($compiled.Errors.HasErrors) { throw ($compiled.Errors | Out-String) }; try { __ACTION__ } catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }`;
const actions = {
  status: '[BluetoothMenu]::Read($false).GetAwaiter().GetResult() | ConvertTo-Json -Depth 5 -Compress',
  scan: '[BluetoothMenu]::Read($true).GetAwaiter().GetResult() | ConvertTo-Json -Depth 5 -Compress',
  on: '[BluetoothMenu]::Power($true).GetAwaiter().GetResult()',
  off: '[BluetoothMenu]::Power($false).GetAwaiter().GetResult()',
};
const prefix = ['-NoProfile', '-NonInteractive', '-Command'];
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function actionCommand(action, hex = '') {
  if (Object.hasOwn(actions, action)) return actions[action];
  if (!['pair', 'connect', 'disconnect', 'forget'].includes(action)) throw new Error('Invalid Bluetooth action.');
  return `[BluetoothMenu]::Act('${action}', [System.Text.Encoding]::Unicode.GetString([byte[]]@(${hex.match(/../g)?.map(x => `0x${x}`).join(',') ?? ''}))).GetAwaiter().GetResult()`;
}
export function bluetoothArgs(action, id) {
  if (!Object.hasOwn(actions, action) && (typeof id !== 'string' || !id.length || id.length > 2048)) throw new Error('Invalid Bluetooth device ID.');
  // Encode UTF-16 code units, including surrogate pairs, without shell interpolation.
  const hex = id === undefined ? '' : id.split('').map(c =>
    c.charCodeAt(0).toString(16).padStart(4, '0').match(/../g).reverse().join(''),
  ).join('');
  return [...prefix, script.replace('__ACTION__', actionCommand(action, hex))];
}
export function bluetoothArgsRegex() {
  const base = escape([...prefix, script].join(' '));
  const fixed = Object.values(actions).map(escape);
  const device = escape(actionCommand('pair', 'ab')).replace('pair', '(?:pair|connect|disconnect|forget)').replace('0xab', '0x[0-9a-f]{2}(?:,0x[0-9a-f]{2}){1,4095}');
  return '^' + base.replace('__ACTION__', '(?:' + [...fixed, device].join('|') + ')') + '$';
}
export async function executeBluetooth(shellExec, action, id, queryTimeout = 20000) {
  const args = bluetoothArgs(action, id);
  let timer;
  let result;
  try {
    const operation = shellExec('powershell.exe', args);
    result = ['status', 'scan'].includes(action) ? await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Bluetooth query timed out. Please try again.')), queryTimeout);
      }),
    ]) : await operation;
  } finally { clearTimeout(timer); }
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Bluetooth operation failed.');
  return ['status', 'scan'].includes(action) ? JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) : null;
}
export const bluetoothSettingsPermission = Object.freeze({ program: 'explorer.exe', argsRegex: '^ms-settings:bluetooth$' });
export async function openBluetoothSettings(shellExec) {
  const result = await shellExec(bluetoothSettingsPermission.program, ['ms-settings:bluetooth']);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not open Windows Bluetooth settings.');
}

// Discovery replaces only unpaired devices; paired status replaces only known devices.
export function mergeBluetoothSnapshot(previous, snapshot, scanning = false) {
  const known = scanning ? (previous?.devices ?? []).filter(d => d.paired || d.connected)
    : snapshot.devices.filter(d => d.paired || d.connected);
  const ids = new Set(known.map(d => d.id));
  const nearby = (scanning ? snapshot.devices : previous?.devices ?? [])
    .filter(d => !d.paired && !d.connected && !ids.has(d.id));
  return { ...snapshot, devices: [...known, ...(snapshot.enabled ? nearby : [])] };
}
export const bluetoothCacheKey = 'my-bar.bluetooth.paired.v1';
export function cachedBluetoothSnapshot(storage) {
  try {
    const state = JSON.parse(storage.getItem(bluetoothCacheKey));
    if (typeof state?.available !== 'boolean' || typeof state?.enabled !== 'boolean' || !Array.isArray(state.devices)) return null;
    return { ...state, devices: state.devices.filter(d => typeof d?.id === 'string' && typeof d.name === 'string' && (d.paired || d.connected)) };
  } catch { return null; }
}
export function cacheBluetoothSnapshot(storage, state) {
  try { storage.setItem(bluetoothCacheKey, JSON.stringify({ ...state, devices: state.devices.filter(d => d.paired || d.connected) })); }
  catch { /* Storage may be unavailable; native status still works. */ }
}
export function bluetoothGroups(devices = []) {
  const groups = { connected: [], paired: [], available: [] };
  for (const device of devices) {
    if (!device?.id || !device.name?.trim()) continue;
    groups[device.connected ? 'connected' : device.paired ? 'paired' : 'available'].push(device);
  }
  for (const list of Object.values(groups)) list.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}
