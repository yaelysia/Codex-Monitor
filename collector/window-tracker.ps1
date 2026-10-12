param(
    [ValidateSet('watch', 'focus', 'verify')][string]$Mode = 'watch',
    [string]$WindowHandle = '',
    [int]$TargetPid = 0,
    [long]$ProcessStart = 0,
    [string]$TabId = ''
)
$ErrorActionPreference = 'Stop'
# No window titles, UI text, commands or screen content are read or transmitted.
try {
    $nativeSource = @'
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
    static string lastSignature = null;
    static long lastEmittedAt = 0;
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
    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr timerId,
      uint interval, IntPtr callback);
    [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd, UIntPtr timerId);

    static long Start(Process process) {
      return new DateTimeOffset(process.StartTime).ToUnixTimeMilliseconds();
    }
    static bool MultiTabHost(string name) {
      string lower = name.ToLowerInvariant();
      return lower.StartsWith("mobaxterm") || lower == "windowsterminal" ||
        lower == "windowsterminalpreview" || lower == "wezterm-gui" ||
        lower == "conemu" || lower == "tabby";
    }

    static string App(string name) {
      string lower = name.ToLowerInvariant();
      // Portable MobaXterm executables commonly add edition/version suffixes.
      if (lower == "mobaxterm" || lower.StartsWith("mobaxterm_")) return "terminal";
      switch (lower) {
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
      uint thread, uint time) {
      if (kind != 3) {
        IntPtr current = GetForegroundWindow();
        IntPtr root = GetAncestor(hwnd, 2);
        if (current == IntPtr.Zero || (hwnd != current && root != current)) return;
      }
      Emit(false);
    }

    static void Emit(bool periodic) {
      string app = "other", handle = "0x0", tabHost = "unknown";
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
              if (app == "terminal") tabHost = MultiTabHost(process.ProcessName)
                ? "multi" : "single";
            }
          }
        } catch { /* Still emit an unknown transition, never reuse old focus. */ }
      }
      if (periodic && app != "terminal") return;
      string tabJson = "";
      if (app == "terminal") {
        TabProbe.Snapshot tab = TabProbe.Read(window);
        if (tab.Id != null) tabJson = ",\"tabId\":\"" + tab.Id + "\"";
        tabJson += ",\"tabCount\":" +
          tab.Count.ToString(CultureInfo.InvariantCulture);
      }
      long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      string signature = handle + "|" + pid + "|" + tabHost + "|" + tabJson;
      if (!periodic && signature == lastSignature && at - lastEmittedAt < 250) return;
      lastSignature = signature;
      lastEmittedAt = at;
      Console.WriteLine("{\"type\":\"foreground\",\"at\":" +
        at.ToString(CultureInfo.InvariantCulture) + ",\"app\":\"" + app +
        "\",\"hwnd\":\"" + handle + "\",\"pid\":" +
        pid.ToString(CultureInfo.InvariantCulture) + ",\"startedAt\":" +
        startedAt.ToString(CultureInfo.InvariantCulture) +
        ",\"tabHost\":\"" + tabHost + "\"" + tabJson + "}");
    }
    public static void Watch() {
      IntPtr foregroundHook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0);
      if (foregroundHook == IntPtr.Zero)
        throw new InvalidOperationException("win_event_hook_failed");
      // Focus/selection notifications supplement low-frequency active-tab
      // sampling. A tab switch often does NOT change the top-level HWND.
      IntPtr selectionHook = SetWinEventHook(0x8005, 0x8006,
        IntPtr.Zero, callback, 0, 0, 0);
      UIntPtr timerId = new UIntPtr(1);
      UIntPtr timer = SetTimer(IntPtr.Zero, timerId, 1100, IntPtr.Zero);
      try {
        Emit(false);
        Msg msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
          if (msg.message == 0x0113 && msg.wParam == (IntPtr)1) {
            Emit(true);
            continue;
          }
          TranslateMessage(ref msg);
          DispatchMessage(ref msg);
        }
      } finally {
        if (timer != UIntPtr.Zero) KillTimer(IntPtr.Zero, timerId);
        if (selectionHook != IntPtr.Zero) UnhookWinEvent(selectionHook);
        UnhookWinEvent(foregroundHook);
      }
    }
    public static string Focus(string hex, int expectedPid, long startedAt, string tabId) {
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
        if (!okay) return "{\"ok\":false,\"reason\":\"foreground_denied\"}";
        if (!String.IsNullOrEmpty(tabId)) {
          if (!TabProbe.Select(hwnd, tabId))
            return "{\"ok\":false,\"reason\":\"tab_unavailable\",\"windowFocused\":true}";
          return "{\"ok\":true,\"tabFocused\":true}";
        }
        return "{\"ok\":true,\"tabFocused\":false}";
      } catch { return "{\"ok\":false,\"reason\":\"invalid_or_stale_window\"}"; }
    }
  }
}
'@
    # Compose one native assembly so the UIA module and Win32 tracker share
    # a concrete, minimal API. Windows PowerShell 5.1 ships these assemblies.
    $tabSource = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'tab-automation.cs'))
    try {
        Add-Type -ErrorAction Stop -TypeDefinition ($nativeSource + "`n" + $tabSource) -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes')
    } catch {
        # A system lacking UIAutomation must still support original HWND jumps.
        # Verify mode fails in CI instead of concealing a compilation regression.
        if ($Mode -eq 'verify') { throw }
        $tabFallback = @'
namespace CodexMonitor {
  public static class TabProbe {
    public sealed class Snapshot {
      public string Id; public int Count;
      public Snapshot(string id, int count) { Id = id; Count = count; }
    }
    public static Snapshot Read(System.IntPtr hwnd) { return new Snapshot(null, 0); }
    public static bool Select(System.IntPtr hwnd, string id) { return false; }
  }
}
'@
        Add-Type -ErrorAction Stop -TypeDefinition ($nativeSource + "`n" + $tabFallback)
    }
} catch {
    Write-Output '{"ok":false,"reason":"native_bridge_unavailable"}'
    exit 2
}
if ($Mode -eq 'verify') {
    Write-Output '{"ok":true}'
} elseif ($Mode -eq 'focus') {
    [CodexMonitor.WindowProbe]::Focus($WindowHandle, $TargetPid, $ProcessStart, $TabId)
} else {
    [CodexMonitor.WindowProbe]::Watch()
}
