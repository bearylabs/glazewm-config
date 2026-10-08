// Windows stores Night light in Bond CompactBinary v1, not a public toggle API.
// Schema reference: https://github.com/kvnxiao/win-nightlight-cli.
export const nightLightNative = `
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Microsoft.Win32;

public sealed class WinarchyNightLightState {
  public bool available;
  public bool enabled;
}

public static class WinarchyNightLight {
  const string KeyPath = @"Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.bluelightreduction.bluelightreductionstate\\windows.data.bluelightreduction.bluelightreductionstate";
  static readonly byte[] Header = { 0x43, 0x42, 1, 0 };

  sealed class Reader {
    readonly byte[] data;
    public int Position;
    public Reader(byte[] bytes) { data = bytes; }
    public byte Byte() {
      if (Position >= data.Length) throw new InvalidDataException("Truncated Night light state.");
      return data[Position++];
    }
    public void Expect(params byte[] bytes) {
      foreach (byte value in bytes)
        if (Byte() != value) throw new InvalidDataException("Unsupported Night light state format.");
    }
    public ulong Number() {
      ulong value = 0;
      for (int shift = 0; shift < 70; shift += 7) {
        byte next = Byte();
        if (shift == 63 && next > 1) throw new InvalidDataException("Invalid Night light integer.");
        value |= (ulong)(next & 127) << shift;
        if ((next & 128) == 0) return value;
      }
      throw new InvalidDataException("Invalid Night light integer.");
    }
    public byte[] Bytes(ulong count) {
      if (count > (ulong)(data.Length - Position)) throw new InvalidDataException("Invalid Night light payload size.");
      byte[] value = new byte[(int)count];
      Array.Copy(data, Position, value, 0, value.Length);
      Position += value.Length;
      return value;
    }
    public void End() {
      if (Position != data.Length) throw new InvalidDataException("Unexpected Night light state data.");
    }
  }

  sealed class State {
    public bool Enabled;
    public bool Usable = true;
    public bool HasUsable;
    public ulong Modified;
  }

  static State Parse(byte[] bytes) {
    var reader = new Reader(bytes);
    reader.Expect(Header);
    reader.Expect(0x0a, 0x02, 0x01, 0x00, 0x2a, 0x06);
    var state = new State();
    state.Modified = reader.Number();
    reader.Expect(0x2a, 0x2b, 0x0e);
    var inner = new Reader(reader.Bytes(reader.Number()));
    reader.Expect(0, 0, 0);
    reader.End();
    inner.Expect(Header);
    var seen = new HashSet<int>();
    while (true) {
      byte field = inner.Byte();
      if (field == 0) break;
      int id;
      int type = field & 31;
      int tag = field >> 5;
      if (tag < 6) id = tag;
      else if (tag == 6) id = inner.Byte();
      else throw new InvalidDataException("Unsupported Night light field identifier.");
      if (!seen.Add(id)) throw new InvalidDataException("Duplicate Night light field.");
      if (id == 0 && type == 16) {
        if (inner.Number() != 0) throw new InvalidDataException("Unsupported Night light activation state.");
        state.Enabled = true;
      } else if (id == 10 && type == 16) {
        ulong cause = inner.Number();
        if (cause != 0 && cause != 2) throw new InvalidDataException("Unsupported Night light transition cause.");
      } else if (id == 20 && type == 6) {
        inner.Number();
      } else if (id == 30 && type == 2) {
        byte usable = inner.Byte();
        if (usable > 1) throw new InvalidDataException("Invalid Night light availability.");
        state.Usable = usable == 1;
        state.HasUsable = true;
      } else {
        // Refuse unknown fields rather than dropping data on a newer Windows build.
        throw new InvalidDataException("Unsupported Night light state field.");
      }
    }
    inner.End();
    return state;
  }

  static void Number(List<byte> bytes, ulong value) {
    do {
      byte next = (byte)(value & 127);
      value >>= 7;
      bytes.Add((byte)(next | (value != 0 ? 128 : 0)));
    } while (value != 0);
  }

  public static WinarchyNightLightState Decode(byte[] bytes) {
    var state = Parse(bytes);
    return new WinarchyNightLightState { available = state.Usable, enabled = state.Enabled };
  }

  public static byte[] Encode(byte[] original, bool enabled) {
    var state = Parse(original);
    if (!state.Usable) throw new InvalidOperationException("Windows Night light is unavailable on this display.");
    DateTime now = DateTime.UtcNow;
    var inner = new List<byte>(Header);
    if (enabled) inner.AddRange(new byte[] { 0x10, 0 });
    inner.AddRange(new byte[] { 0xd0, 10, 2, 0xc6, 20 });
    Number(inner, (ulong)now.ToFileTimeUtc());
    if (state.HasUsable) inner.AddRange(new byte[] { 0xc2, 30, 1 });
    inner.Add(0);
    var output = new List<byte>(Header);
    output.AddRange(new byte[] { 0x0a, 2, 1, 0, 0x2a, 6 });
    ulong seconds = (ulong)(now - new DateTime(1970, 1, 1)).TotalSeconds;
    Number(output, Math.Max(seconds, checked(state.Modified + 1)));
    output.AddRange(new byte[] { 0x2a, 0x2b, 0x0e });
    Number(output, (ulong)inner.Count);
    output.AddRange(inner);
    output.AddRange(new byte[] { 0, 0, 0 });
    return output.ToArray();
  }

  static byte[] Read(RegistryKey key) {
    if (key.GetValueKind("Data") != RegistryValueKind.Binary)
      throw new InvalidDataException("Windows Night light state is not binary.");
    return (byte[])key.GetValue("Data");
  }

  public static WinarchyNightLightState Status() {
    using (var key = Registry.CurrentUser.OpenSubKey(KeyPath)) {
      if (key == null) return new WinarchyNightLightState();
      return Decode(Read(key));
    }
  }

  public static WinarchyNightLightState Toggle() {
    using (var mutex = new Mutex(false, @"Local\\Winarchy.NightLight")) {
      if (!mutex.WaitOne(2000)) throw new InvalidOperationException("Another Night light operation is still running.");
      try {
        using (var key = Registry.CurrentUser.OpenSubKey(KeyPath, true)) {
          if (key == null) throw new InvalidOperationException("Configure Night light in Windows Settings first.");
          byte[] original = Read(key);
          var before = Decode(original);
          byte[] updated = Encode(original, !before.enabled);
          if (!Convert.ToBase64String(original).Equals(Convert.ToBase64String(Read(key))))
            throw new InvalidOperationException("Windows changed Night light during the toggle. Try again.");
          key.SetValue("Data", updated, RegistryValueKind.Binary);
          key.Flush();
          Thread.Sleep(200);
          var after = Decode(Read(key));
          if (!after.available || after.enabled == before.enabled)
            throw new InvalidOperationException("Windows did not retain the Night light change.");
          return after;
        }
      } finally { mutex.ReleaseMutex(); }
    }
  }
}`;

function nightLightArgs(action) {
  return ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$nightLightAction = '${action}'
Add-Type -TypeDefinition @'
${nightLightNative.trim()}
'@
$state = if ($nightLightAction -eq 'toggle') { [WinarchyNightLight]::Toggle() } else { [WinarchyNightLight]::Status() }
$state | ConvertTo-Json -Compress
`.trim()];
}
export const nightLightStatusArgs = nightLightArgs('status');
export const nightLightToggleArgs = nightLightArgs('toggle');
export const nightLightPermissions = [nightLightStatusArgs, nightLightToggleArgs].map(args => ({
  program: 'powershell.exe',
  argsRegex: `^${args.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
}));
async function runNightLight(exec, args, options) {
  const result = await exec('powershell.exe', [...args], options);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Windows Night light command failed.');
  const state = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (!state || typeof state.available !== 'boolean' || typeof state.enabled !== 'boolean') {
    throw new Error('Invalid Windows Night light status.');
  }
  return state;
}
export const queryNightLight = exec => runNightLight(exec, nightLightStatusArgs, {
  timeout: 15000, timeoutMessage: 'Windows Night light status query timed out.',
});
export const toggleNightLight = exec => runNightLight(exec, nightLightToggleArgs);
