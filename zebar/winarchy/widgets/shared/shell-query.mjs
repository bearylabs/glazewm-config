// Read-only processes may be cancelled. Never use this executor for actions.
export function createShellQueryExecutor(spawn, kill, {
  schedule = setTimeout, cancel = clearTimeout, reportError = console.error,
} = {}) {
  const active = new Map();
  return function query(program, args, {
    timeout = 15000, timeoutMessage = 'Status query timed out.',
  } = {}) {
    const key = JSON.stringify([program, args]);
    if (active.has(key)) {
      return Promise.reject(new Error('The previous status query is still running; no new process was started.'));
    }
    return new Promise((resolve, reject) => {
      const task = { process: null, expired: false, exited: false };
      active.set(key, task);
      let stdout = '';
      let stderr = '';
      const finish = () => {
        if (task.exited) return;
        task.exited = true;
        cancel(timer);
        active.delete(key);
      };
      const stop = () => {
        Promise.resolve().then(() => {
          if (!task.exited) return Promise.resolve(kill(task.process)).then(finish);
        }).catch(error => {
          reportError(new Error(`Could not stop timed-out status query: ${error.message ?? error}`));
        });
      };
      const timer = schedule(() => {
        task.expired = true;
        reject(new Error(timeoutMessage));
        if (task.process && !task.exited) stop();
      }, timeout);
      Promise.resolve().then(() => spawn(program, args)).then(process => {
        task.process = process;
        process.onStdout(line => { stdout += `${line}\n`; });
        process.onStderr(line => { stderr += `${line}\n`; });
        process.onExit(status => {
          finish();
          if (!task.expired) resolve({ code: status.code ?? status.exitCode ?? null, stdout, stderr });
        });
        // A slow spawn can finish after the deadline. It still needs cleanup.
        if (task.expired && !task.exited) stop();
      }).catch(error => {
        finish();
        reject(error);
      });
    });
  };
}

// Zebar 3.3.1 forwards native {code, success, signal} unchanged, and killing
// stops its event loop without emitting "terminated". Own listener cleanup.
export async function spawnShellQuery(invoke, listen, program, args) {
  let pid;
  let disposed = false;
  const early = [];
  const pending = { stdout: [], stderr: [], terminated: [] };
  const handlers = {};
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unlisten();
  };
  function dispatch(event) {
    const type = event.type === 'error' ? 'stderr' : event.type;
    if (!Object.hasOwn(pending, type)) return;
    if (handlers[type]) handlers[type](event.data);
    else pending[type].push(event.data);
    if (event.type === 'terminated') {
      dispose();
      // The native backend retains finished process handles until shell_kill.
      void invoke('shell_kill', { pid }).catch(error => console.error('Releasing status query:', error));
    }
  }
  const unlisten = await listen('shell-emit', ({ payload }) => {
    if (disposed) return;
    if (pid === undefined) early.push(payload);
    else if (payload.pid === pid) dispatch(payload.event);
  });
  try {
    pid = await invoke('shell_spawn', { program, args, options: {} });
    for (const payload of early) {
      if (payload.pid === pid) dispatch(payload.event);
    }
    early.length = 0;
  } catch (error) {
    dispose();
    throw error;
  }
  function subscribe(type, callback) {
    handlers[type] = callback;
    for (const data of pending[type]) callback(data);
    pending[type].length = 0;
  }
  return {
    processId: pid,
    onStdout: callback => subscribe('stdout', callback),
    onStderr: callback => subscribe('stderr', callback),
    onExit: callback => subscribe('terminated', callback),
    async kill() {
      await invoke('shell_kill', { pid });
      dispose();
    },
  };
}
