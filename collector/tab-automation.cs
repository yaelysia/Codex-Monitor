namespace CodexMonitor {
  using System;
  using System.Text;
  using System.Windows.Automation;
  // Never reads tab labels, terminal content, process command lines or file paths.
  // Runtime IDs identify UIA objects only while the original GUI window survives.
  public static class TabProbe {
    public sealed class Snapshot {
      public string Id;
      public int Count;
      public Snapshot(string id, int count) { Id = id; Count = count; }
    }
    const int MaxTabs = 80;

    public static string EncodeRuntimeId(int[] id) {
      if (id == null || id.Length < 1 || id.Length > 20) return null;
      StringBuilder result = new StringBuilder("rid:");
      for (int i = 0; i < id.Length; i++) {
        if (i > 0) result.Append('.');
        result.Append(id[i].ToString(System.Globalization.CultureInfo.InvariantCulture));
      }
      return result.Length <= 192 ? result.ToString() : null;
    }

    public static bool VerifyTokenEncoding() {
      return EncodeRuntimeId(new int[] { 42, -7, 3 }) == "rid:42.-7.3" &&
        EncodeRuntimeId(new int[] { 123 }) == "rid:123" &&
        EncodeRuntimeId(new int[0]) == null;
    }

    static string Token(AutomationElement element) {
      try { return EncodeRuntimeId(element.GetRuntimeId()); }
      catch { return null; }
    }

    static AutomationElementCollection Items(IntPtr hwnd) {
      AutomationElement root = AutomationElement.FromHandle(hwnd);
      if (root == null) return null;
      return root.FindAll(TreeScope.Descendants,
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
    }

    static bool Selected(AutomationElement element, out SelectionItemPattern selection) {
      selection = null;
      try {
        object pattern = element.GetCurrentPattern(SelectionItemPattern.Pattern);
        selection = pattern as SelectionItemPattern;
        return selection != null && selection.Current.IsSelected;
      } catch { return false; }
    }

    public static Snapshot Read(IntPtr hwnd) {
      // MobaXterm's UIA tree can report an unrelated settings/sidebar tab,
      // while the actual SSH tab strip is exposed via legacy MSAA. Prefer an
      // unambiguous multi-tab MSAA group specifically for that application.
      // Both providers are read-only; a single unrelated TabItem is not proof.
      Snapshot legacy = null;
      if (MobaTabProbe.IsMobaWindow(hwnd)) {
        legacy = MobaTabProbe.Read(hwnd);
        if (legacy.Id != null && legacy.Count >= 2) return legacy;
      }
      Snapshot uia = ReadUia(hwnd);
      if (uia.Id != null && uia.Count >= 2) return uia;
      return new Snapshot(null, Math.Max(uia.Count, legacy == null ? 0 : legacy.Count));
    }

    private static Snapshot ReadUia(IntPtr hwnd) {
      try {
        AutomationElementCollection items = Items(hwnd);
        if (items == null || items.Count == 0) return new Snapshot(null, 0);
        if (items.Count > MaxTabs) return new Snapshot(null, MaxTabs + 1);
        string selected = null;
        int selectedCount = 0;
        foreach (AutomationElement item in items) {
          SelectionItemPattern pattern;
          if (!Selected(item, out pattern)) continue;
          selectedCount++;
          selected = Token(item);
        }
        // Several tab bars in the same GUI may report independent selections.
        // Ambiguous (or unimplemented) providers must NOT yield a tab identity.
        return new Snapshot(selectedCount == 1 ? selected : null, items.Count);
      } catch { return new Snapshot(null, 0); }
    }

    public static bool Select(IntPtr hwnd, string id) {
      if (String.IsNullOrEmpty(id) || id.Length > 192) return false;
      if (id.StartsWith("msaa:", StringComparison.Ordinal))
        return MobaTabProbe.Select(hwnd, id);
      if (!id.StartsWith("rid:", StringComparison.Ordinal)) return false;
      try {
        AutomationElementCollection items = Items(hwnd);
        if (items == null || items.Count < 2 || items.Count > MaxTabs) return false;
        AutomationElement target = null;
        SelectionItemPattern chosen = null;
        int matches = 0;
        foreach (AutomationElement item in items) {
          if (!String.Equals(Token(item), id, StringComparison.Ordinal)) continue;
          SelectionItemPattern pattern;
          // A TabItem may implement SelectionItem while not currently selected.
          try {
            pattern = item.GetCurrentPattern(SelectionItemPattern.Pattern)
              as SelectionItemPattern;
          } catch { pattern = null; }
          if (pattern == null) return false;
          target = item;
          chosen = pattern;
          matches++;
        }
        if (matches != 1 || target == null || chosen == null) return false;
        if (!chosen.Current.IsSelected) chosen.Select();
        // Verify that this UIA runtime element, not merely a tab of the same
        // name or index, is selected after the action.
        return String.Equals(Read(hwnd).Id, id, StringComparison.Ordinal);
      } catch { return false; }
    }
  }
}
