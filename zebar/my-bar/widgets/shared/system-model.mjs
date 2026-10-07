export function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value)}%` : 'Unavailable';
}

export function gib(bytes) {
  return Number.isFinite(bytes) ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : 'Unavailable';
}

export function diskUsage(disk) {
  const total = disk.totalSpace?.bytes;
  const free = disk.availableSpace?.bytes;
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(free)) return null;
  return (total - free) / total * 100;
}

export const powerCommands = Object.freeze({
  lock: { program: 'rundll32.exe', args: ['user32.dll,LockWorkStation'], confirmation: null },
  logout: { program: 'shutdown', args: ['/l'], confirmation: 'Log out? Unsaved work may be lost.' },
  shutdown: {
    program: 'shutdown', args: ['/s', '/t', '0'],
    confirmation: 'Shut down? Unsaved work may be lost.',
  },
});

export async function executePowerAction(shellExec, action, confirmed = false) {
  if (!Object.hasOwn(powerCommands, action)) throw new Error(`Unknown power action: ${action}`);
  const command = powerCommands[action];
  if (command.confirmation && !confirmed) throw new Error('Explicit confirmation is required.');
  const result = await shellExec(command.program, [...command.args]);
  if (result.code !== 0) {
    throw new Error(`${action} failed (${result.code ?? result.signal ?? 'no exit code'}): ${result.stderr || result.stdout || 'No error details'}`);
  }
}
