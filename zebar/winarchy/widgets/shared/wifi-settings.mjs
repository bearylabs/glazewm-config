// Open the native Windows network flyout, without PowerShell or radio queries.
export const wifiSettingsPermission = {
  program: 'explorer.exe',
  argsRegex: '^ms-availablenetworks:$',
};

export async function openWifiSettings(shellSpawn) {
  // Explorer delegates URI activation to the Windows shell asynchronously.
  // Its eventual exit code is not a flyout-success signal, especially on cold start.
  // Only spawn failures are actionable; do not wait for exit or resend the URI.
  await shellSpawn(wifiSettingsPermission.program, ['ms-availablenetworks:']);
}
