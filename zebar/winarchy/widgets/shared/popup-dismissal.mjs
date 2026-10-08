// WebView/Tauri focus events are unreliable here: a popup can remain unfocused
// after opening, so the first outside click produces no usable focus-loss event.
// Tauri setFocus() is also forbidden by Zebar's widget ACL. A read-only Windows
// mouse hook therefore detects outside clicks without stealing focus/input.
// Keep one helper alive per bar, prewarmed at startup: launching PowerShell and
// compiling C# for every popup delayed opening. Only arm/disarm over stdin per
// popup; request IDs make late clicks harmless when another popup replaces it.
const source = `using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class PopupMouse {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Mouse { public Point Position; public uint Data, Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Position; public uint Private; }
  delegate IntPtr Hook(int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int count);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, Hook callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  public static bool Contains(Rect rect, Point point) {
    return point.X >= rect.Left && point.X < rect.Right && point.Y >= rect.Top && point.Y < rect.Bottom;
  }
  public static bool IsOutsideClick(IntPtr popup, Point point) {
    // Windows invokes the low-level hook in a DPI-unaware context, even if
    // Run() set the message-loop thread to per-monitor aware beforehand.
    // MSLLHOOKSTRUCT.Position stays physical. Set the context HERE, inside
    // every callback, so GetWindowRect/WindowFromPoint use physical pixels too.
    var previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previousDpi == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      // A transparent WebView can hit-test as a different HWND during activation.
      // Its physical bounds are authoritative, including before first focus.
      Rect rect;
      if (!GetWindowRect(popup, out rect)) return false;
      if (Contains(rect, point)) return false;
      var target = GetAncestor(WindowFromPoint(point), 2);
      var title = new StringBuilder(256);
      GetWindowText(target, title, title.Capacity);
      return title.ToString() != "Zebar - winarchy / bar";
    } finally {
      SetThreadDpiAwarenessContext(previousDpi);
    }
  }
  public static void Run() {
    var gate = new object();
    string request = null;
    bool running = true;
    var input = new Thread(delegate() {
      try {
        string line;
        while ((line = Console.ReadLine()) != null) {
          lock (gate) {
            if (line.StartsWith("arm:")) {
              request = line.Substring(4);
              Console.WriteLine("armed:" + request);
            } else if (line == "disarm:" + request) request = null;
          }
        }
      } finally { lock (gate) { running = false; } }
    });
    input.IsBackground = true;
    Hook callback = delegate(int code, IntPtr message, IntPtr data) {
      int id = message.ToInt32();
      if (code >= 0 && (id == 0x201 || id == 0x204 || id == 0x207 || id == 0x20B)) {
        lock (gate) {
          if (request != null) {
            var popup = FindWindow(null, "Zebar - winarchy / popup");
            if (popup != IntPtr.Zero) {
              var mouse = (Mouse)Marshal.PtrToStructure(data, typeof(Mouse));
              if (IsOutsideClick(popup, mouse.Position)) {
                Console.WriteLine("outside:" + request);
                request = null;
              }
            }
          }
        }
      }
      return CallNextHookEx(IntPtr.Zero, code, message, data);
    };
    var hook = SetWindowsHookEx(14, callback, GetModuleHandle(null), 0);
    if (hook == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      input.Start();
      Console.WriteLine("ready");
      while (true) {
        lock (gate) { if (!running) break; }
        Message message;
        while (PeekMessage(out message, IntPtr.Zero, 0, 0, 1)) {
          TranslateMessage(ref message);
          DispatchMessage(ref message);
        }
        Thread.Sleep(10);
      }
    } finally {
      UnhookWindowsHookEx(hook);
      GC.KeepAlive(callback);
    }
  }
}`;

export const outsideClickArgs = Object.freeze([
  '-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference = 'Stop'; Add-Type -TypeDefinition '${source}'; [PopupMouse]::Run()`,
]);

export function outsideClickArgsRegex() {
  return `^${outsideClickArgs.join(' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function startWatcher(shellSpawn, onOutsideClick, reportError, timeout) {
  const process = await shellSpawn('powershell.exe', [...outsideClickArgs]);
  let stopped = false;
  let ready = false;
  let activeRequest = null;
  let stderr = '';
  const pendingArms = new Map();
  function rejectArms(error) {
    for (const pending of pendingArms.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingArms.clear();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    rejectArms(new Error('Outside-click watcher stopped.'));
    Promise.resolve().then(() => process.kill()).catch(reportError);
  }
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Outside-click watcher startup timed out.')), timeout);
      process.onStderr(line => { stderr += line; });
      process.onStdout(line => {
        if (stopped) return;
        for (const message of String(line).trim().split(/\r?\n/)) {
          if (message === 'ready') {
            ready = true;
            resolve();
          } else if (message.startsWith('armed:')) {
            const requestId = message.slice(6);
            const pending = pendingArms.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingArms.delete(requestId);
              pending.resolve();
            }
          } else if (message.startsWith('outside:')) {
            const requestId = message.slice(8);
            if (activeRequest === requestId) activeRequest = null;
            Promise.resolve().then(() => onOutsideClick(requestId)).catch(reportError);
          }
        }
      });
      process.onExit(({ exitCode }) => {
        if (stopped) return;
        stopped = true;
        const error = new Error(`Outside-click watcher exited (${exitCode}): ${stderr || 'unexpected termination'}`);
        rejectArms(error);
        if (!ready) reject(error);
        else reportError(error);
      });
    });
    return {
      get alive() { return !stopped; },
      arm(requestId) {
        if (stopped) return Promise.reject(new Error('Outside-click watcher is not running.'));
        activeRequest = requestId;
        return new Promise((resolve, reject) => {
          const fail = error => {
            const pending = pendingArms.get(requestId);
            if (!pending) return;
            clearTimeout(pending.timer);
            pendingArms.delete(requestId);
            reject(error);
          };
          const timer = setTimeout(() => {
            fail(new Error('Outside-click watcher arm timed out.'));
            stop();
          }, timeout);
          pendingArms.set(requestId, { resolve, reject, timer });
          Promise.resolve().then(() => process.write(`arm:${requestId}\n`)).catch(error => {
            fail(error);
            stop();
          });
        });
      },
      disarm() {
        if (stopped || !activeRequest) return;
        const requestId = activeRequest;
        activeRequest = null;
        Promise.resolve().then(() => process.write(`disarm:${requestId}\n`)).catch(error => {
          reportError(error);
          stop();
        });
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function spawnOutsideClickProcess(shellSpawn, invoke, program, args) {
  const process = await shellSpawn(program, args);
  // Zebar 3.3.1's ShellProcess.write()/kill() send { processId }, but its Rust
  // shell_write/shell_kill commands require { pid }. Bypass only those broken
  // wrappers; spawning, privilege validation and event delivery stay in Zebar.
  return {
    ...process,
    write: buffer => invoke('shell_write', { pid: process.processId, buffer }),
    kill: () => invoke('shell_kill', { pid: process.processId }),
  };
}

export function createOutsideClickWatcher(shellSpawn, onOutsideClick, reportError, timeout = 10000) {
  let starting = null;
  let watcher = null;
  let disposed = false;
  function prewarm() {
    if (disposed) return Promise.reject(new Error('Outside-click watcher disposed.'));
    if (watcher?.alive) return Promise.resolve(watcher);
    if (!starting) {
      starting = startWatcher(shellSpawn, onOutsideClick, reportError, timeout).then(result => {
        watcher = result;
        if (disposed) {
          watcher.stop();
          throw new Error('Outside-click watcher disposed.');
        }
        return watcher;
      }).finally(() => { starting = null; });
    }
    return starting;
  }
  return {
    prewarm,
    async arm(requestId) {
      if (!/^[a-zA-Z0-9-]+$/.test(requestId)) throw new Error('Invalid popup request ID.');
      const worker = await prewarm();
      await worker.arm(requestId);
    },
    disarm() { watcher?.disarm(); },
    stop() {
      disposed = true;
      watcher?.stop();
    },
  };
}
