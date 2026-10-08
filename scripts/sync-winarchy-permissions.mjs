import { readFile, writeFile } from 'node:fs/promises';
import { outputDeviceArgsRegex, inputDeviceArgsRegex } from '../zebar/winarchy/widgets/shared/audio-model.mjs';
import { powerStatusArgs, batteryCapacityArgsRegex } from '../zebar/winarchy/widgets/shared/battery-model.mjs';
import { bluetoothArgsRegex, bluetoothSettingsPermission } from '../zebar/winarchy/widgets/shared/bluetooth-model.mjs';
import { bluetoothBackgroundPermission } from '../zebar/winarchy/widgets/shared/bluetooth-background.mjs';
import { globalProtectArgsRegex } from '../zebar/winarchy/widgets/shared/globalprotect-model.mjs';
import { networkBackgroundPermissions } from '../zebar/winarchy/widgets/shared/network-background.mjs';
import { networkStatsArgsRegex } from '../zebar/winarchy/widgets/shared/network-stats.mjs';
import { outsideClickArgsRegex } from '../zebar/winarchy/widgets/shared/popup-dismissal.mjs';
import { wifiSettingsPermission } from '../zebar/winarchy/widgets/shared/wifi-settings.mjs';
import { awakePermissions } from '../zebar/winarchy/widgets/shared/awake-model.mjs';
import { dndPermissions } from '../zebar/winarchy/widgets/shared/dnd-model.mjs';
import { nightLightPermissions } from '../zebar/winarchy/widgets/shared/night-light-model.mjs';

const flags = process.argv.slice(2);
if (flags.some(flag => flag !== '--check') || flags.length > 1) {
  throw new Error('Usage: node scripts\\sync-winarchy-permissions.mjs [--check]');
}
const powershell = argsRegex => ({ program: 'powershell.exe', argsRegex });
const permissions = {
  bar: [
    powershell('^' + powerStatusArgs.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
    powershell(outsideClickArgsRegex()),
    ...networkBackgroundPermissions,
    bluetoothBackgroundPermission,
    ...awakePermissions,
    ...dndPermissions,
    ...nightLightPermissions,
  ],
  popup: [
    powershell(outputDeviceArgsRegex()),
    powershell(inputDeviceArgsRegex()),
    powershell(bluetoothArgsRegex()),
    bluetoothSettingsPermission,
    powershell(globalProtectArgsRegex()),
    powershell(networkStatsArgsRegex),
    wifiSettingsPermission,
    powershell(batteryCapacityArgsRegex()),
  ],
};
const path = new URL('../zebar/winarchy/zpack.json', import.meta.url);
const source = await readFile(path, 'utf8');
const pack = JSON.parse(source);
let changed = false;
for (const [name, shellCommands] of Object.entries(permissions)) {
  const widget = pack.widgets.find(widget => widget.name === name);
  if (!widget) throw new Error(`Missing Winarchy widget: ${name}`);
  if (JSON.stringify(widget.privileges.shellCommands) !== JSON.stringify(shellCommands)) {
    widget.privileges.shellCommands = shellCommands;
    changed = true;
  }
}
if (flags.includes('--check')) {
  if (changed) throw new Error('Winarchy permissions are out of sync. Run node scripts\\sync-winarchy-permissions.mjs.');
} else if (changed) {
  await writeFile(path, JSON.stringify(pack, null, 2) + (source.endsWith('\n') ? '\n' : ''));
}
