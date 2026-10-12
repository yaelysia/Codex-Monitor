namespace CodexMonitor {
  using System;
  using System.Collections.Generic;
  using System.Diagnostics;
  using System.Globalization;
  using System.Runtime.InteropServices;
  using System.Security.Cryptography;
  using System.Text;
  using Accessibility;

  /** MobaXterm-specific legacy accessible-tab fallback.
   * Reads MSAA page-tab role/state and temporarily hashes a tab's caption
   * locally. NEVER writes, outputs or persists the caption itself.
   * Disabled for non-MobaXterm processes; no synthetic keyboard commands.
   */
  public static class MobaTabProbe {
    const int ROLE_PAGETAB = 0x25;
    const int STATE_SELECTED = 0x2;
    const uint OBJID_CLIENT = 0xFFFFFFFC;
    const int MAX_CHILD_WINDOWS = 80;
    const int MAX_VISITED = 400;
    static readonly Guid IID_IAccessible =
      new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");

    delegate bool ChildWindowProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent,
      ChildWindowProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(
      IntPtr hwnd, uint idObject, ref Guid iid,
      [MarshalAs(UnmanagedType.Interface)] out IAccessible accessible);

    sealed class TabCandidate {
      public IAccessible Parent;
      public object ChildId;
      public string Token;
      public bool Selected;
      public TabCandidate(IAccessible parent, object id, string token, bool selected) {
        Parent = parent; ChildId = id; Token = token; Selected = selected;
      }
    }
    sealed class TabList {
      public List<TabCandidate> Tabs;
      public string Signature;
      public TabList(List<TabCandidate> tabs) {
        Tabs = tabs;
        var parts = new List<string>();
        foreach (TabCandidate tab in tabs) parts.Add(tab.Token);
        parts.Sort(StringComparer.Ordinal);
        Signature = String.Join(",", parts.ToArray());
      }
    }

    public static bool IsMobaWindow(IntPtr hwnd) {
      try {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) return false;
        using (Process p = Process.GetProcessById((int)pid)) {
          return p.ProcessName.StartsWith("MobaXterm", StringComparison.OrdinalIgnoreCase);
        }
      } catch { return false; }
    }

    private static string TokenFor(IntPtr hwnd, string name) {
      if (String.IsNullOrWhiteSpace(name) || name.Length > 300) return null;
      // A per-window salt avoids identical host labels yielding the same token
      // across unrelated windows. A changed/recreated HWND is verified before use.
      string content = hwnd.ToInt64().ToString("x", CultureInfo.InvariantCulture) +
        ":" + name.Trim();
      using (SHA256 hash = SHA256.Create()) {
        byte[] digest = hash.ComputeHash(Encoding.UTF8.GetBytes(content));
        StringBuilder sb = new StringBuilder("msaa:");
        for (int i = 0; i < 16; i++) sb.Append(digest[i].ToString("x2", CultureInfo.InvariantCulture));
        return sb.ToString();
      }
    }

    public static bool VerifyIdentityEncoding() {
      string a = TokenFor(new IntPtr(50), "ssh-host");
      return a != null && a.StartsWith("msaa:") && a.Length == 37 &&
        a == TokenFor(new IntPtr(50), "ssh-host") &&
        a != TokenFor(new IntPtr(51), "ssh-host") &&
        a != TokenFor(new IntPtr(50), "other-host") &&
        TokenFor(new IntPtr(50), "") == null;
    }

    private static void Visit(IAccessible root, IntPtr owner, List<TabList> lists,
      int depth, ref int visits) {
      if (root == null || depth >= 5 || visits++ >= MAX_VISITED) return;
      int children;
      try { children = root.accChildCount; }
      catch { return; }
      if (children < 1 || children > 120) return;
      var directTabs = new List<TabCandidate>();
      var next = new List<IAccessible>();
      for (int i = 1; i <= children; i++) {
        if (visits++ >= MAX_VISITED) break;
        try {
          object childObject = root.get_accChild(i);
          IAccessible child = childObject as IAccessible;
          IAccessible provider = child ?? root;
          object id = child == null ? (object)i : (object)0;
          object roleObject = provider.get_accRole(id);
          int role = Convert.ToInt32(roleObject, CultureInfo.InvariantCulture);
          if (role == ROLE_PAGETAB) {
            string token = TokenFor(owner, provider.get_accName(id));
            if (token == null) continue;
            object rawState = provider.get_accState(id);
            int state = Convert.ToInt32(rawState, CultureInfo.InvariantCulture);
            directTabs.Add(new TabCandidate(provider, id, token,
              (state & STATE_SELECTED) != 0));
          } else if (child != null) next.Add(child);
        } catch { /* Unavailable access nodes cannot become tab candidates. */ }
      }
      if (directTabs.Count >= 2 && directTabs.Count <= 80)
        lists.Add(new TabList(directTabs));
      foreach (IAccessible child in next) Visit(child, owner, lists, depth + 1, ref visits);
    }

    private static List<TabList> Groups(IntPtr hwnd) {
      var result = new List<TabList>();
      if (!IsMobaWindow(hwnd)) return result;
      var windows = new List<IntPtr>();
      windows.Add(hwnd);
      EnumChildWindows(hwnd, delegate(IntPtr child, IntPtr unused) {
        if (windows.Count >= MAX_CHILD_WINDOWS) return false;
        windows.Add(child);
        return true;
      }, IntPtr.Zero);
      int visits = 0;
      foreach (IntPtr child in windows) {
        if (visits >= MAX_VISITED) break;
        IAccessible root = null;
        try {
          Guid iid = IID_IAccessible;
          int hr = AccessibleObjectFromWindow(child, OBJID_CLIENT, ref iid, out root);
          if (hr >= 0 && root != null) Visit(root, hwnd, result, 0, ref visits);
        } catch { /* Not every Win32 child exports a MSAA accessibility tree. */ }
      }
      // The same native tab strip may be reachable from a parent and a child
      // window. Deduplicate identical whole-strip signatures, not individual
      // names (duplicate tab names remain ambiguous).
      var distinct = new Dictionary<string, TabList>(StringComparer.Ordinal);
      foreach (TabList group in result) {
        if (!distinct.ContainsKey(group.Signature))
          distinct.Add(group.Signature, group);
      }
      return new List<TabList>(distinct.Values);
    }

    private static TabList SingleGroup(IntPtr hwnd) {
      List<TabList> groups = Groups(hwnd);
      if (groups.Count != 1) return null;
      TabList group = groups[0];
      int selectedCount = 0;
      var names = new HashSet<string>(StringComparer.Ordinal);
      foreach (TabCandidate item in group.Tabs) {
        if (!names.Add(item.Token)) return null; // Duplicate captions => unsafe.
        if (item.Selected) selectedCount++;
      }
      return selectedCount == 1 ? group : null;
    }

    public static TabProbe.Snapshot Read(IntPtr hwnd) {
      TabList group = SingleGroup(hwnd);
      if (group == null) return new TabProbe.Snapshot(null, 0);
      foreach (TabCandidate item in group.Tabs) {
        if (item.Selected) return new TabProbe.Snapshot(item.Token, group.Tabs.Count);
      }
      return new TabProbe.Snapshot(null, 0);
    }

    public static bool Select(IntPtr hwnd, string token) {
      if (token == null || token.Length != 37 || !token.StartsWith("msaa:",
        StringComparison.Ordinal)) return false;
      TabList group = SingleGroup(hwnd);
      if (group == null) return false;
      TabCandidate target = null;
      foreach (TabCandidate candidate in group.Tabs) {
        if (candidate.Token == token) {
          if (target != null) return false;
          target = candidate;
        }
      }
      if (target == null) return false;
      try {
        if (!target.Selected) target.Parent.accSelect(2, target.ChildId);
        System.Threading.Thread.Sleep(120);
        return String.Equals(Read(hwnd).Id, token, StringComparison.Ordinal);
      } catch { return false; }
    }
  }
}
