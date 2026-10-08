// Windows has no public DND setter. These Quiet Hours COM interface IDs/slots
// are documented at https://gist.github.com/riverar/085d98ffb1343e92225a10817109b2e3.
const dndNative = `
using System;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("6BFF4732-81EC-4FFB-AE67-B6C1BC29631F"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWinarchyQuietHours {
  void GetUserProfile([MarshalAs(UnmanagedType.LPWStr)] out string profile);
  void SetUserProfile([MarshalAs(UnmanagedType.LPWStr)] string profile);
  void GetProfile(IntPtr id, out IntPtr profile);
  void GetAllProfileData(out uint count, out IntPtr data);
  void GetDisplayName(IntPtr id, out IntPtr name);
  void GetQuietMoments([MarshalAs(UnmanagedType.Interface)] out IWinarchyQuietMoments manager);
  void GetOffProfile([MarshalAs(UnmanagedType.LPWStr)] out string profile);
  void GetMomentProfile([MarshalAs(UnmanagedType.LPWStr)] out string profile);
  void SetMomentProfile([MarshalAs(UnmanagedType.LPWStr)] string profile);
  void GetActiveProfile([MarshalAs(UnmanagedType.LPWStr)] out string profile);
}

[ComImport, Guid("B0217783-87B7-422C-B902-5C148C14F150"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWinarchyQuietMoments {
  void GetAllModes(out uint count, out IntPtr modes);
  void GetMoment(uint id, out IntPtr moment);
  void TurnOffActiveMoment();
}

public static class WinarchyDnd {
  const string Off = "Microsoft.QuietHoursProfile.Unrestricted";
  const string On = "Microsoft.QuietHoursProfile.PriorityOnly";
  const string Alarms = "Microsoft.QuietHoursProfile.AlarmsOnly";

  static IWinarchyQuietHours Open() {
    var type = Type.GetTypeFromCLSID(new Guid("F53321FA-34F8-4B7F-B9A3-361877CB94CF"), true);
    return (IWinarchyQuietHours)Activator.CreateInstance(type);
  }

  static string Read(IWinarchyQuietHours settings) {
    string profile;
    settings.GetActiveProfile(out profile);
    if (profile != Off && profile != On && profile != Alarms)
      throw new InvalidOperationException("Unknown Windows Do not disturb profile: " + profile);
    return profile;
  }

  public static string Status() {
    var settings = Open();
    try { return Read(settings); }
    finally { Marshal.ReleaseComObject(settings); }
  }

  public static string Toggle() {
    using (var mutex = new Mutex(false, @"Local\\Winarchy.DoNotDisturb")) {
      if (!mutex.WaitOne(2000))
        throw new InvalidOperationException("Another Do not disturb operation is still running.");
      try {
        var settings = Open();
        try {
          string target = Read(settings) == Off ? On : Off;
          settings.SetUserProfile(target);
          if (target == Off && Read(settings) != Off) {
            IWinarchyQuietMoments moments;
            settings.GetQuietMoments(out moments);
            try { moments.TurnOffActiveMoment(); }
            finally { Marshal.ReleaseComObject(moments); }
          }
          var deadline = DateTime.UtcNow.AddSeconds(3);
          do {
            string profile = Read(settings);
            if (profile == target) return profile;
            Thread.Sleep(50);
          } while (DateTime.UtcNow < deadline);
          throw new InvalidOperationException("Windows did not confirm the Do not disturb change.");
        } finally { Marshal.ReleaseComObject(settings); }
      } finally { mutex.ReleaseMutex(); }
    }
  }
}`;

function dndArgs(action) {
  return ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$dndAction = '${action}'
Add-Type -TypeDefinition @'
${dndNative.trim()}
'@
$profile = if ($dndAction -eq 'toggle') { [WinarchyDnd]::Toggle() } else { [WinarchyDnd]::Status() }
[pscustomobject]@{ available = $true; enabled = $profile -ne 'Microsoft.QuietHoursProfile.Unrestricted'; profile = $profile } | ConvertTo-Json -Compress
`.trim()];
}

export const dndStatusArgs = dndArgs('status');
export const dndToggleArgs = dndArgs('toggle');
export const dndPermissions = [dndStatusArgs, dndToggleArgs].map(args => ({
  program: 'powershell.exe',
  argsRegex: `^${args.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
}));
const profiles = new Map([
  ['Microsoft.QuietHoursProfile.Unrestricted', false],
  ['Microsoft.QuietHoursProfile.PriorityOnly', true],
  ['Microsoft.QuietHoursProfile.AlarmsOnly', true],
]);
async function runDnd(exec, args, options) {
  const result = await exec('powershell.exe', [...args], options);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Windows Do not disturb command failed.');
  const state = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (!state || state.available !== true || !profiles.has(state.profile) ||
      state.enabled !== profiles.get(state.profile)) throw new Error('Invalid Windows Do not disturb status.');
  return state;
}
export const queryDnd = exec => runDnd(exec, dndStatusArgs, {
  timeout: 15000, timeoutMessage: 'Windows Do not disturb status query timed out.',
});
// Mutations must not be killed or retried by the read-only query executor.
export const toggleDnd = exec => runDnd(exec, dndToggleArgs);
