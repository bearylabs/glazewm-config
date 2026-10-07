// Omarchy's audio hero status ladder, with Zebar's 0–100 volume scale.
export function outputVolumeName(volume, muted) {
  if (muted) return 'Muted';
  if (!Number.isFinite(volume)) return 'Unavailable';
  const p = Math.round(volume);
  if (p === 0) return 'Silenced';
  if (p >= 100) return 'Concert hall';
  if (p >= 85) return 'Party mode';
  if (p >= 70) return 'Cranked up';
  if (p >= 50) return 'Steady groove';
  if (p >= 30) return 'Easy listening';
  if (p >= 15) return 'Murmur';
  return 'Whisper';
}

// Zebar 3.3.1 exposes active playback devices, but no default-device setter.
// Windows' PolicyConfig COM interface is used only to change playback defaults.
const endpointId = /^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F-]{36}\}$/;
const source = `using System;
using System.Runtime.InteropServices;
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient {}
[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
  void GetMixFormat(); void GetDeviceFormat(); void ResetDeviceFormat(); void SetDeviceFormat();
  void GetProcessingPeriod(); void SetProcessingPeriod(); void GetShareMode(); void SetShareMode();
  void GetPropertyValue(); void SetPropertyValue();
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
}
public class AudioOutput {
  public static void Select(string id) {
    var policy = (IPolicyConfig)new PolicyConfigClient();
    try { for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(id, role)); }
    finally { Marshal.ReleaseComObject(policy); }
  }
}`;
const command = `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition '${source}'; [AudioOutput]::Select('__DEVICE_ID__')`;

export function outputDeviceArgs(deviceId) {
  if (!endpointId.test(deviceId ?? '')) throw new Error('Invalid Windows playback device ID.');
  return ['-NoProfile', '-NonInteractive', '-Command', command.replace('__DEVICE_ID__', deviceId)];
}

// Match the entire fixed script and only permit a playback endpoint ID as input.
export function outputDeviceArgsRegex() {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return '^' + escape(['-NoProfile', '-NonInteractive', '-Command', command].join(' '))
    .replace('__DEVICE_ID__', '\\{0\\.0\\.0\\.00000000\\}\\.\\{[0-9a-fA-F-]{36}\\}') + '$';
}

export async function selectOutputDevice(shellExec, audio, deviceId) {
  if (!audio?.playbackDevices?.some(device => device.deviceId === deviceId)) {
    throw new Error('Output device is no longer connected.');
  }
  const result = await shellExec('powershell.exe', outputDeviceArgs(deviceId));
  if (result.code !== 0) throw new Error(result.stderr?.trim() || 'Could not change the Windows output device.');
}
