param(
    [ValidateSet('watch', 'focus', 'verify', 'sample', 'inspect-tabs')][string]$Mode = 'watch',
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
using System.Collections.Generic;
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
    [StructLayout(LayoutKind.Sequential)]
    struct Rect {
      public int left, top, right, bottom;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct WindowPlacement {
      public int length, flags, showCmd;
      public Point min, max;
      public Rect normal, device;
    }
    delegate void WinEvent(IntPtr hook, uint kind, IntPtr hwnd, int obj, int child,
      uint thread, uint time);
    delegate bool EnumTopWindow(IntPtr hwnd, IntPtr unused);
    static readonly WinEvent callback = OnEvent;
    static string lastSignature = null;
    static long lastEmittedAt = 0;
    static readonly object outputLock = new object();
    // UI Automation providers are external processes and may hang in FindAll.
    // Never call them synchronously on the WinEventHook message-loop thread.
    static int tabProbeInFlight = 0;
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max,
      IntPtr module, WinEvent callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern int GetMessage(out Msg msg,
      IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Msg msg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Msg msg);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumTopWindow callback,
      IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")]
    static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(
      IntPtr hwnd, ref WindowPlacement placement);
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
      // Terminal tab probes keep their existing 1.1s cadence. VS Code and
      // Codex Desktop only emit a lightweight HWND/PID heartbeat at most once
      // per five seconds; without it a foreground sample could be hours old.
      // Never poll UI Automation for those apps or emit background "other"
      // heartbeats. The WinEvent foreground hook still detects app switches.
      if (periodic && app != "terminal" &&
          (app == "other" || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() -
            Interlocked.Read(ref lastEmittedAt) < 5000)) return;
      // Immediate HWND sample is the primary reliable input. A slow/malformed
      // UIA provider must never prevent window evidence for ANY application.
      WriteSample(app, handle, pid, startedAt, tabHost, null, periodic);
      if (app != "terminal" || window == IntPtr.Zero ||
          Interlocked.CompareExchange(ref tabProbeInFlight, 1, 0) != 0) return;
      IntPtr queried = window;
      string sourceHandle = handle;
      uint sourcePid = pid;
      long sourceStarted = startedAt;
      string sourceHost = tabHost;
      // At most one read runs in the background. A permanently blocked provider
      // loses optional tab metadata but cannot stall native foreground events.
      bool queued = ThreadPool.QueueUserWorkItem(delegate(object unused) {
        try {
          TabProbe.Snapshot tab = TabProbe.Read(queried);
          IntPtr foreground = GetForegroundWindow();
          IntPtr root = GetAncestor(foreground, 2);
          uint currentPid;
          GetWindowThreadProcessId(queried, out currentPid);
          if ((foreground == queried || root == queried) &&
              currentPid == sourcePid && tab != null) {
            WriteSample("terminal", sourceHandle, sourcePid, sourceStarted,
              sourceHost, tab, false);
          }
        } catch { /* Provider failure cannot affect HWND tracking. */ }
        finally { Interlocked.Exchange(ref tabProbeInFlight, 0); }
      });
      if (!queued) Interlocked.Exchange(ref tabProbeInFlight, 0);
    }

    static void WriteSample(string app, string handle, uint pid, long startedAt,
      string tabHost, TabProbe.Snapshot tab, bool periodic) {
      string tabJson = "";
      if (tab != null) {
        if (tab.Id != null) tabJson = ",\"tabId\":\"" + tab.Id + "\"";
        tabJson += ",\"tabCount\":" +
          tab.Count.ToString(CultureInfo.InvariantCulture);
      }
      lock (outputLock) {
        long at = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (at < lastEmittedAt) at = lastEmittedAt;
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
    }

    public static void Sample() { Emit(false); }
    static bool MainCandidatePolicy(bool unowned, int exStyle, int width, int height) {
      // Ignore owned tooltips, launcher panes and tiny native utility windows.
      return unowned && (exStyle & 0x80) == 0 && width >= 300 && height >= 200;
    }
    public static bool VerifyMainCandidatePolicy() {
      return MainCandidatePolicy(true, 0, 1300, 800) &&
        !MainCandidatePolicy(false, 0, 1300, 800) &&
        !MainCandidatePolicy(true, 0x80, 1300, 800) &&
        !MainCandidatePolicy(true, 0, 40, 60);
    }
    private static string DescribeMobaTabs(IntPtr hwnd, int index) {
      TabProbe.Snapshot selected = TabProbe.Read(hwnd);
      TabProbe.Snapshot uia = TabProbe.InspectUia(hwnd);
      MobaTabProbe.Diagnostics msaa = MobaTabProbe.Inspect(hwnd);
      int count = selected == null ? 0 : selected.Count;
      bool identified = selected != null && selected.Id != null;
      string provider = identified && selected.Id.StartsWith("msaa:") ? "msaa" :
        identified && selected.Id.StartsWith("rid:") ? "uia" : "none";
      string reason = identified ? "unique_tab_selectable" : msaa.Reason;
      if (!identified && reason == "no_msaa_tab_group" && uia.Count > 0)
        reason = "uia_tabs_without_unique_selection";
      return "{\"index\":" + index.ToString(CultureInfo.InvariantCulture) +
        ",\"count\":" + count.ToString(CultureInfo.InvariantCulture) +
        ",\"identified\":" + (identified ? "true" : "false") +
        ",\"provider\":\"" + provider + "\"" +
        ",\"reason\":\"" + reason + "\"" +
        ",\"uiaTabItems\":" + (uia == null ? 0 : uia.Count).ToString(CultureInfo.InvariantCulture) +
        ",\"msaaGroups\":" + msaa.GroupCount.ToString(CultureInfo.InvariantCulture) +
        ",\"msaaMaxTabs\":" + msaa.MaxTabCount.ToString(CultureInfo.InvariantCulture) +
        ",\"msaaSelected\":" + msaa.SelectedCount.ToString(CultureInfo.InvariantCulture) +
        ",\"msaaDuplicateNames\":" + (msaa.DuplicateNames ? "true" : "false") +
        ",\"nativeTabLikeChildren\":" + msaa.NativeTabLikeChildren.ToString(CultureInfo.InvariantCulture) +
        "}";
    }
    // Metadata-only classification: never return titles, HWNDs, PIDs or paths.
    // A rejected large window may be the actual MobaXterm GUI in some builds.
    // The read-only diagnostic may inspect it, but cannot select/focus it.
    private static string MobaWindowPolicy(IntPtr hwnd, int index, bool hasRect,
      bool unowned, bool toolWindow, int width, int height, bool accepted) {
      string geometry = !hasRect ? "unavailable" :
        width >= 300 && height >= 200 ? "large" : "small";
      return "{\"index\":" + index.ToString(CultureInfo.InvariantCulture) +
        ",\"mainCandidate\":" + (accepted ? "true" : "false") +
        ",\"hasOwner\":" + (unowned ? "false" : "true") +
        ",\"toolWindow\":" + (toolWindow ? "true" : "false") +
        ",\"geometry\":\"" + geometry + "\"" +
        ",\"minimized\":" + (IsIconic(hwnd) ? "true" : "false") +
        "}";
    }
    public static void InspectTabs() {
      const int MAX_DIAGNOSTIC_WINDOWS = 6;
      const int MAX_REJECTED_PROBES = 2;
      var candidates = new List<IntPtr>();
      var allVisible = new List<IntPtr>();
      var policies = new List<string>();
      var rejectedProbes = new List<IntPtr>();
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        if (!IsWindowVisible(hwnd) || !MobaTabProbe.IsMobaWindow(hwnd)) return true;
        allVisible.Add(hwnd);
        Rect bounds;
        bool hasRect = GetWindowRect(hwnd, out bounds);
        int width = hasRect ? bounds.right - bounds.left : 0;
        int height = hasRect ? bounds.bottom - bounds.top : 0;
        bool unowned = GetWindow(hwnd, 4) == IntPtr.Zero;
        bool toolWindow = (GetWindowLong(hwnd, -20) & 0x80) != 0;
        bool accepted = hasRect &&
          MainCandidatePolicy(unowned, toolWindow ? 0x80 : 0, width, height);
        if (allVisible.Count <= MAX_DIAGNOSTIC_WINDOWS)
          policies.Add(MobaWindowPolicy(hwnd, allVisible.Count, hasRect,
            unowned, toolWindow, width, height, accepted));
        if (accepted) candidates.Add(hwnd);
        else if (hasRect && width >= 300 && height >= 200 &&
          rejectedProbes.Count < MAX_REJECTED_PROBES)
          rejectedProbes.Add(hwnd);
        return true;
      }, IntPtr.Zero);
      string visible = String.Join(",", policies.ToArray());
      if (candidates.Count == 0) {
        // A strict geometry/ownership policy can filter a legitimate GUI.
        // Safely inspect up to two large rejected windows without activating
        // any of them; identities are still NOT valid navigation bindings.
        var rejected = new List<string>();
        for (int n = 0; n < rejectedProbes.Count; n++)
          rejected.Add(DescribeMobaTabs(rejectedProbes[n], n + 1));
        string reason = allVisible.Count == 0 ? "no_visible_mobaxterm" :
          "no_visible_main_mobaxterm_window";
        Console.WriteLine("{\"type\":\"tab-probe\",\"count\":0,\"identified\":false," +
          "\"provider\":\"none\",\"reason\":\"" + reason +
          "\",\"visibleProcessWindows\":" + allVisible.Count.ToString(CultureInfo.InvariantCulture) +
          ",\"mainCandidates\":0,\"visibleWindows\":[" + visible +
          "],\"rejectedProbes\":[" + String.Join(",", rejected.ToArray()) +
          "],\"candidates\":[]}");
        return;
      }
      // With several genuine main windows, inspect each safely rather than
      // reporting empty tab metrics. Never select a window by index.
      var details = new List<string>();
      int identifiedCount = 0;
      for (int n = 0; n < candidates.Count && n < MAX_DIAGNOSTIC_WINDOWS; n++) {
        string item = DescribeMobaTabs(candidates[n], n + 1);
        details.Add(item);
        if (item.Contains("\"identified\":true")) identifiedCount++;
      }
      bool unique = candidates.Count == 1;
      string summary = details.Count == 1 ? details[0] : null;
      if (unique && summary != null) {
        Console.WriteLine("{\"type\":\"tab-probe\"," + summary.Substring(1, summary.Length - 2) +
          ",\"visibleProcessWindows\":" + allVisible.Count.ToString(CultureInfo.InvariantCulture) +
          ",\"mainCandidates\":1,\"visibleWindows\":[" + visible +
          "],\"rejectedProbes\":[],\"candidates\":[" + summary + "]}");
      } else {
        Console.WriteLine("{\"type\":\"tab-probe\",\"count\":0,\"identified\":false," +
          "\"provider\":\"none\",\"reason\":\"multiple_main_mobaxterm_windows\"," +
          "\"visibleProcessWindows\":" + allVisible.Count.ToString(CultureInfo.InvariantCulture) +
          ",\"mainCandidates\":" + candidates.Count.ToString(CultureInfo.InvariantCulture) +
          ",\"selectableCandidates\":" + identifiedCount.ToString(CultureInfo.InvariantCulture) +
          ",\"visibleWindows\":[" + visible +
          "],\"rejectedProbes\":[],\"candidates\":[" + String.Join(",", details.ToArray()) + "]}");
      }
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
    // A foreground switch must NEVER restore a visible maximized or fullscreen
    // window: SW_RESTORE (9) would shrink it to its normal window size.
    // Only explicitly restore a minimized window, respecting its max-restore flag.
    static int FocusShowCommand(bool minimized, bool restoreMaximized) {
      return !minimized ? 0 : (restoreMaximized ? 3 : 9);
    }

    // Non-interactive Windows CI regression for the show-state policy.
    public static bool VerifyFocusShowCommands() {
      return FocusShowCommand(false, false) == 0 &&
        FocusShowCommand(false, true) == 0 &&
        FocusShowCommand(true, false) == 9 &&
        FocusShowCommand(true, true) == 3;
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
        if (IsIconic(hwnd)) {
          WindowPlacement placement = new WindowPlacement();
          placement.length = Marshal.SizeOf(typeof(WindowPlacement));
          bool restoreMaximized =
            (GetWindowPlacement(hwnd, ref placement) && (placement.flags & 2) != 0) ||
            IsZoomed(hwnd);
          // A minimized window must be shown before it can become foreground.
          // A visible window of ANY size is left exactly as it is.
          ShowWindow(hwnd, FocusShowCommand(true, restoreMaximized));
        }
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
    $mobaSource = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'mobaxterm-tabs.cs'))
    try {
        Add-Type -ErrorAction Stop -TypeDefinition ($nativeSource + "`n" + $tabSource + "`n" + $mobaSource) -ReferencedAssemblies @('UIAutomationClient', 'UIAutomationTypes', 'Accessibility')
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
    if ($Mode -eq 'verify') {
        # All embedded code is static first-party source. On CI compile errors
        # must identify the actual broken C# line, not conceal it behind a
        # generic native_bridge_unavailable summary.
        Write-Error ($_.Exception.ToString())
    }
    Write-Output '{"ok":false,"reason":"native_bridge_unavailable"}'
    exit 2
}
if ($Mode -eq 'sample') {
    [CodexMonitor.WindowProbe]::Sample()
} elseif ($Mode -eq 'inspect-tabs') {
    [CodexMonitor.WindowProbe]::InspectTabs()
} elseif ($Mode -eq 'verify') {
    if (-not [CodexMonitor.WindowProbe]::VerifyFocusShowCommands()) {
        Write-Output '{"ok":false,"reason":"focus_show_policy_failed"}'
        exit 3
    }
    if (-not [CodexMonitor.TabProbe]::VerifyTokenEncoding()) {
        Write-Output '{"ok":false,"reason":"tab_runtime_id_encoding_failed"}'
        exit 3
    }
    if (-not [CodexMonitor.MobaTabProbe]::VerifyIdentityEncoding()) {
        Write-Output '{"ok":false,"reason":"moba_accessible_id_encoding_failed"}'
        exit 3
    }
    if (-not [CodexMonitor.WindowProbe]::VerifyMainCandidatePolicy()) {
        Write-Output '{"ok":false,"reason":"main_window_candidate_policy_failed"}'
        exit 3
    }
    Write-Output '{"ok":true}'
} elseif ($Mode -eq 'focus') {
    [CodexMonitor.WindowProbe]::Focus($WindowHandle, $TargetPid, $ProcessStart, $TabId)
} else {
    [CodexMonitor.WindowProbe]::Watch()
}
