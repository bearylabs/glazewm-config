import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { outsideClickArgs } from '../widgets/shared/popup-dismissal.mjs';

test('compiled native classifier handles DPI-unaware hook entry and misleading HWNDs', {
  skip: process.platform !== 'win32', timeout: 20000,
}, () => {
  // Execute the production C# classifier, replacing only the Win32 boundary.
  // In particular, simulate WindowFromPoint returning the application behind
  // the transparent WebView, not the popup or its child HWND.
  let command = outsideClickArgs.at(-1)
    .replace('[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);',
      'public static Rect TestRect; public static bool RectAvailable = true; static bool GetWindowRect(IntPtr window, out Rect rect) { if (PopupHitTest.Awareness() != 2) throw new Exception("GetWindowRect called DPI-unaware"); rect = TestRect; return RectAvailable; }')
    .replace('[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);',
      'public static int HitTests; static IntPtr WindowFromPoint(Point point) { if (PopupHitTest.Awareness() != 2) throw new Exception("WindowFromPoint called DPI-unaware"); HitTests++; return new IntPtr(99); }')
    .replace('[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);',
      'static IntPtr GetAncestor(IntPtr window, uint flag) { return window; }')
    .replace('[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder title, int count);',
      'public static string TargetTitle = "Other application"; static int GetWindowText(IntPtr window, StringBuilder title, int count) { title.Append(TargetTitle); return TargetTitle.Length; }');
  const fixture = `
public static class PopupHitTest {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDpiAwarenessContext();
  [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
  public static int Awareness() { return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()); }
  static void Check(int x, int y, bool outside) {
    if (PopupMouse.IsOutsideClick(new IntPtr(1), new PopupMouse.Point { X = x, Y = y }) != outside)
      throw new Exception("Incorrect click classification at " + x + "," + y);
    if (Awareness() != 0) throw new Exception("Callback did not restore its DPI context");
  }
  public static void Run() {
    // Reproduce the real low-level hook: it enters DPI-unaware regardless of
    // the context previously set by the message-loop thread.
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-1));
    if (previous == IntPtr.Zero) throw new Exception("Cannot set test DPI context");
    try { RunCases(); }
    finally { SetThreadDpiAwarenessContext(previous); }
  }
  static void RunCases() {
    PopupMouse.TestRect = new PopupMouse.Rect { Left = 610, Top = 38, Right = 1310, Bottom = 587 };
    Check(1203, 542, false);
    foreach (double scale in new double[] { 1, 1.25, 1.5, 1.75, 2 }) {
      foreach (int left in new int[] { -2560, 0, 1920 }) {
        int top = -200, right = left + (int)(328 * scale), bottom = top + (int)(304 * scale);
        PopupMouse.TestRect = new PopupMouse.Rect { Left = left, Top = top, Right = right, Bottom = bottom };
        PopupMouse.HitTests = 0;
        Check(left, top, false);
        Check(right - 1, bottom - 1, false);
        Check((left + right) / 2, (top + bottom) / 2, false);
        if (PopupMouse.HitTests != 0) throw new Exception("Internal click queried unrelated HWND");
        Check(left - 1, top, true);
        Check(right, top, true);
        Check(left, bottom, true);
        Check(left, top - 1, true);
        PopupMouse.TargetTitle = "Zebar - my-bar / bar";
        Check(right + 100, top, false);
        PopupMouse.TargetTitle = "Other application";
      }
    }
    PopupMouse.RectAvailable = false;
    Check(9999, 9999, false);
    Console.WriteLine("native hit-test regression passed");
  }
}`;
  command = command.replace("'; [PopupMouse]::Run()", `${fixture}'; [PopupHitTest]::Run()`);
  const result = spawnSync('powershell.exe', [...outsideClickArgs.slice(0, -1), command], {
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /native hit-test regression passed/);
});
