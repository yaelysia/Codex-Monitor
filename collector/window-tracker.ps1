param(
    [ValidateSet('watch', 'focus', 'verify')][string]$Mode = 'watch',
    [string]$WindowHandle = '',
    [int]$TargetPid = 0,
    [long]$ProcessStart = 0
)
$ErrorActionPreference = 'Stop'
# No window titles, UI text, commands or screen content are read or transmitted.
try {
    Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

namespace CodexMonitor {
  public static class WindowProbe {
    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    struct Msg {
      public IntPtr hwnd; public uint message;
      public IntPtr wParam, lParam; public uint time;
      public Point point; public uint lPrivate;
    }
    delegate void WinEvent(IntPtr hook, uint kind, IntPtr hwnd, int obj, int child,
      uint thread, uint time);
    static readonly WinEvent callback = OnEvent;
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max,
      IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out Msg msg,
      IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg msg);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);

    static long Start(Process process) {
      return new DateTimeOffset(process.StartTime).ToUnixTimeMilliseconds();
    }
    static string App(string name) {
      switch (name.ToLowerInvariant()) {
        case "codex": case "codex desktop": return "desktop";
        case "code": case "code - insiders": case "cursor":
        case "vscodium": case "windsurf": return "vscode";
        case "windowsterminal": case "windowsterminalpreview":
        case "powershell": case "pwsh": case "mobaxterm":
        case "conhost": case "mintty": case "wezterm-gui":
        case "alacritty": case "conemu": case "tabby": return "terminal";
        default: return "other";
      }
    }
    static void OnEvent(IntPtr hook, uint kind, IntPtr hwnd, int obj, int child,
      uint thread, uint time) { Emit(); }

    static void Emit() {
      string app = "other", handle = "0x0";
      uint pid = 0; long startedAt = 0;
      IntPtr window = GetForegroundWindow();
      if (window != IntPtr.Zero) {
        IntPtr root = GetAncestor(window, 2);
        if (root != IntPtr.Zero) window = root;
        uint owner; GetWindowThreadProcessId(window, out owner);
        try {
          using (Process process = Process.GetProcessById((int)owner)) {
            string identified = App(process.ProcessName);
            if (identified != "other") {
              startedAt = Start(process);
              pid = owner;
              handle = "0x" + window.ToInt64().ToString("x", CultureInfo.InvariantCulture);
              app = identified;
            }
          }
        } catch { /* Still emit an unknown transition, never reuse old focus. */ }
      }
      long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      Console.WriteLine("{\"type\":\"foreground\",\"at\":" +
        at.ToString(CultureInfo.InvariantCulture) + ",\"app\":\"" + app +
        "\",\"hwnd\":\"" + handle + "\",\"pid\":" +
        pid.ToString(CultureInfo.InvariantCulture) + ",\"startedAt\":" +
        startedAt.ToString(CultureInfo.InvariantCulture) + "}");
    }
    public static void Watch() {
      IntPtr hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
      if (hook == IntPtr.Zero) throw new InvalidOperationException("win_event_hook_failed");
      try {
        Emit();
        Msg msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
          TranslateMessage(ref msg);
          DispatchMessage(ref msg);
        }
      } finally { UnhookWinEvent(hook); }
    }
    public static string Focus(string hex, int expectedPid, long startedAt) {
      try {
        if (!hex.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
          return "{\"ok\":false,\"reason\":\"bad_handle\"}";
        ulong raw = UInt64.Parse(hex.Substring(2),
          NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
        IntPtr hwnd = new IntPtr(unchecked((long)raw));
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd))
          return "{\"ok\":false,\"reason\":\"stale_window\"}";
        uint owner; GetWindowThreadProcessId(hwnd, out owner);
        if (owner != (uint)expectedPid)
          return "{\"ok\":false,\"reason\":\"process_changed\"}";
        using (Process p = Process.GetProcessById(expectedPid)) {
          if (Start(p) != startedAt || App(p.ProcessName) == "other")
            return "{\"ok\":false,\"reason\":\"process_changed\"}";
        }
        ShowWindow(hwnd, 9);
        SetForegroundWindow(hwnd);
        Thread.Sleep(160);
        IntPtr now = GetForegroundWindow();
        bool okay = now == hwnd || GetAncestor(now, 2) == hwnd;
        return okay ? "{\"ok\":true}" :
          "{\"ok\":false,\"reason\":\"foreground_denied\"}";
      } catch { return "{\"ok\":false,\"reason\":\"invalid_or_stale_window\"}"; }
    }
  }
}
'@
} catch {
    Write-Output '{"ok":false,"reason":"native_bridge_unavailable"}'
    exit 2
}
if ($Mode -eq 'verify') {
    Write-Output '{"ok":true}'
} elseif ($Mode -eq 'focus') {
    [CodexMonitor.WindowProbe]::Focus($WindowHandle, $TargetPid, $ProcessStart)
} else {
    [CodexMonitor.WindowProbe]::Watch()
}
