param(
    [ValidateSet('guard', 'verify')][string]$Mode = 'guard'
)
$ErrorActionPreference = 'Stop'
# No window titles, prompt text, workspace paths, session IDs or executable
# arguments are captured. Never activates or resizes an unrelated process.
try {
    $native = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace CodexMonitor {
  public static class DesktopWindowGuard {
    struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct WindowPlacement {
      public int length, flags, showCmd;
      public Point min, max;
      public Rect normal;
    }
    private sealed class Entry {
      public IntPtr Hwnd;
      public uint Pid;
      public long Started;
      public bool Maximized;
      public Rect Bounds;
    }
    delegate bool WindowEnum(IntPtr hwnd, IntPtr ignored);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowEnum callback, IntPtr ignored);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hwnd, ref WindowPlacement placement);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after,
      int x, int y, int width, int height, uint flags);

    private const int SW_SHOWMAXIMIZED = 3;
    private const int SW_RESTORE = 9;
    private const uint SWP_NOZORDER = 0x0004;
    private const uint SWP_NOACTIVATE = 0x0010;
    private const uint SWP_NOOWNERZORDER = 0x0200;

    private static bool IsCodex(string name) {
      return String.Equals(name, "Codex", StringComparison.OrdinalIgnoreCase) ||
        String.Equals(name, "Codex Desktop", StringComparison.OrdinalIgnoreCase);
    }
    private static bool Identity(IntPtr hwnd, uint pid, long started) {
      if (!IsWindow(hwnd)) return false;
      uint current;
      GetWindowThreadProcessId(hwnd, out current);
      if (pid == 0 || current != pid) return false;
      try {
        using (Process process = Process.GetProcessById((int)pid)) {
          return IsCodex(process.ProcessName) &&
            new DateTimeOffset(process.StartTime).ToUnixTimeMilliseconds() == started;
        }
      } catch { return false; }
    }
    private static bool Different(Rect a, Rect b) {
      return Math.Abs(a.Left - b.Left) > 2 ||
        Math.Abs(a.Top - b.Top) > 2 ||
        Math.Abs(a.Right - b.Right) > 2 ||
        Math.Abs(a.Bottom - b.Bottom) > 2;
    }
    public static bool VerifyPolicy() {
      Rect a = new Rect { Left = -1000, Top = 0, Right = -200, Bottom = 600 };
      Rect b = new Rect { Left = -1000, Top = 0, Right = -200, Bottom = 600 };
      Rect c = new Rect { Left = 0, Top = 0, Right = 800, Bottom = 600 };
      return IsCodex("Codex") && IsCodex("Codex Desktop") &&
        !IsCodex("Codex-Monitor") && !IsCodex("chrome") &&
        !Different(a, b) && Different(a, c);
    }
    private static List<Entry> Capture() {
      var result = new List<Entry>();
      EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
        if (result.Count >= 16 || !IsWindowVisible(hwnd) || IsIconic(hwnd) ||
            GetWindow(hwnd, 4) != IntPtr.Zero) return true;
        Rect bounds;
        if (!GetWindowRect(hwnd, out bounds) ||
            bounds.Right - bounds.Left < 300 || bounds.Bottom - bounds.Top < 200) return true;
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return true;
        try {
          using (Process process = Process.GetProcessById((int)pid)) {
            if (!IsCodex(process.ProcessName)) return true;
            WindowPlacement placement = new WindowPlacement();
            placement.length = Marshal.SizeOf(typeof(WindowPlacement));
            bool maximized = IsZoomed(hwnd) ||
              (GetWindowPlacement(hwnd, ref placement) && placement.showCmd == SW_SHOWMAXIMIZED);
            result.Add(new Entry {
              Hwnd = hwnd, Pid = pid,
              Started = new DateTimeOffset(process.StartTime).ToUnixTimeMilliseconds(),
              Maximized = maximized, Bounds = bounds,
            });
          }
        } catch { /* Inaccessible helper windows are not candidates. */ }
        return true;
      }, IntPtr.Zero);
      return result;
    }
    private static void RestoreForeground(List<Entry> saved) {
      IntPtr hwnd = GetForegroundWindow();
      IntPtr root = GetAncestor(hwnd, 2);
      if (root != IntPtr.Zero) hwnd = root;
      if (hwnd == IntPtr.Zero) return;
      foreach (Entry before in saved) {
        if (before.Hwnd != hwnd || !Identity(hwnd, before.Pid, before.Started) ||
            !IsWindowVisible(hwnd) || IsIconic(hwnd)) continue;
        if (before.Maximized) {
          if (!IsZoomed(hwnd)) ShowWindowAsync(hwnd, SW_SHOWMAXIMIZED);
          return;
        }
        if (IsZoomed(hwnd)) {
          ShowWindowAsync(hwnd, SW_RESTORE);
          Thread.Sleep(25);
        }
        Rect current;
        if (!GetWindowRect(hwnd, out current) || !Different(before.Bounds, current)) return;
        SetWindowPos(hwnd, IntPtr.Zero, before.Bounds.Left, before.Bounds.Top,
          before.Bounds.Right - before.Bounds.Left, before.Bounds.Bottom - before.Bounds.Top,
          SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOOWNERZORDER);
        return;
      }
    }
    public static void Run() {
      List<Entry> previous = Capture();
      Console.WriteLine("{\"type\":\"desktop-window-guard\",\"ready\":true,\"observed\":" +
        previous.Count + "}");
      Console.Out.Flush();
      if (!String.Equals(Console.ReadLine(), "activated", StringComparison.Ordinal)) return;
      // Protocol handoff may complete before Codex actually processes the
      // window-show request. Recheck during this short bounded interval.
      for (int tick = 0; tick < 20; tick++) {
        Thread.Sleep(125);
        RestoreForeground(previous);
      }
    }
  }
}
'@
    Add-Type -ErrorAction Stop -TypeDefinition $native
    if ($Mode -eq 'verify') {
        if (-not [CodexMonitor.DesktopWindowGuard]::VerifyPolicy()) {
            Write-Output '{"ok":false,"reason":"desktop_guard_policy_failed"}'
            exit 3
        }
        Write-Output '{"ok":true}'
    } else {
        [CodexMonitor.DesktopWindowGuard]::Run()
    }
} catch {
    # Optional preservation must never break the ordinary Codex deep link.
    if ($Mode -eq 'verify') { Write-Error ($_.Exception.ToString()) }
    else { Write-Output '{"ok":false,"reason":"desktop_guard_unavailable"}' }
    exit 2
}
