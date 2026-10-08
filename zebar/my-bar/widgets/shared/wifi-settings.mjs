// Open the native Windows network flyout, without PowerShell or radio queries.
export const wifiSettingsPermission = {
  program: 'explorer.exe',
  argsRegex: '^ms-availablenetworks:$',
};

export async function openWifiSettings(shellExec) {
  const result = await shellExec(wifiSettingsPermission.program, ['ms-availablenetworks:']);
  if ((result.code ?? result.exitCode) !== 0) {
    throw new Error(result.stderr || 'Could not open Windows network selection.');
  }
}
