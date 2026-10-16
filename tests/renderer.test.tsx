import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/renderer/App';
import { alertKindLabel } from '../src/shared/alert-presentation';


afterEach(() => vi.unstubAllGlobals());

describe('notification copy across renderer and Windows surfaces', () => {
  it('makes interruption distinct from completion and waiting', () => {
    expect(alertKindLabel('finished')).toBe('本轮回复已结束');
    expect(alertKindLabel('waiting')).toBe('可能待处理');
    expect(alertKindLabel('interrupted')).toBe('本轮已中断');
    expect(alertKindLabel('failed')).toBe('本轮失败');
    expect(alertKindLabel('source-offline')).toBe('数据源采集异常');
    expect(alertKindLabel('source-recovered')).toBe('数据源已恢复');
    const main = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    const floating = readFileSync(new URL('../src/renderer/FloatingApp.tsx', import.meta.url), 'utf8');
    const native = readFileSync(new URL('../electron/desktop-notifications.ts', import.meta.url), 'utf8');
    expect(main).toContain('alertKindLabel(alert.kind)');
    expect(floating).toContain('alertKindLabel(alert.kind)');
    expect(native).toContain('alertKindLabel(alert.kind)');
    expect(main).toContain('openAlertTarget(alert)');
    expect(main).toContain('sourceIdFromAlertKey(key)');
    expect(floating).toContain('isSourceAlertKind(alert.kind)');
    expect(floating).toContain('openMain(alert.sessionKey)');
    expect(main).toContain("setView('board')");
    expect(main).toContain('sourceIdFromAlertKey(alert.sessionKey)');
  });
});

describe('reusable SignalSelect controls', () => {
  it('uses a styled combobox rather than an unthemed Windows native select', () => {
    const html = renderToStaticMarkup(createElement(App));
    // Radix retains one visually hidden native select for form integration.
    // The interactive trigger is a combobox; the native dropdown is never shown.
    expect(html).toContain('<select aria-hidden="true"');
    expect(html).not.toContain('<option');
    expect(html).toContain('aria-label="执行位置筛选"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('signal-select-trigger');
  });

  it('uses the same dropdown component for status and source in the sessions view', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({
        view: 'sessions', filter: 'waiting', recentOnly: true, showSubagents: false,
      }),
    });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="运行状态筛选"');
    expect(html).toContain('aria-label="执行位置筛选"');
    expect((html.match(/role="combobox"/g) || [])).toHaveLength(2);
    expect((html.match(/<select aria-hidden="true"/g) || [])).toHaveLength(2);
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('<SignalSelect label="运行状态筛选"');
    expect(source).toContain('<SignalSelect label="执行位置筛选"');
  });

  it('supports animated, collision-aware menus with reduced-motion fallback', () => {
    const component = readFileSync(new URL('../src/renderer/SignalSelect.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/renderer/signal-select.css', import.meta.url), 'utf8');
    expect(component).toContain('position="popper"');
    expect(component).toContain('avoidCollisions');
    expect(component).toContain('<Select.Portal>');
    expect(styles).toContain('[data-state="open"]');
    expect(styles).toContain('[data-highlighted]');
    expect(styles).toContain('prefers-reduced-motion:reduce');
  });
});

describe('decision desk and session drill-down interaction contract', () => {
  it('does not render session status filtering on the decision desk', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('signal-overview-stats');
    expect(html).toContain('查看可能待处理会话，共 0 条');
    expect(html).not.toContain('aria-label="运行状态筛选"');
    expect(html).not.toContain('返回决策台');
  });

  it('offers one-click return and clearing for saved filtered session lists', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({
        view: 'sessions', filter: 'waiting', recentOnly: true, showSubagents: false,
      }),
    });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('aria-label="运行状态筛选"');
    expect(html).toContain('返回决策台');
    expect(html).toContain('清除状态筛选');
    expect(html).toContain('signal-filter-tag');
    expect(html).not.toContain('signal-overview-stats');
  });

  it('discard stale status after returning to a non-session saved view', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => JSON.stringify({
        view: 'board', filter: 'waiting', recentOnly: true, showSubagents: false,
      }),
    });
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('signal-overview-stats');
    expect(html).not.toContain('aria-label="运行状态筛选"');
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('filter: view === \'sessions\' ? filter : \'all\'');
    expect(source).toContain("setFilter('all');");
    expect(source).toContain("onClick={() => openOverview('waiting')}");
    expect(source).toContain("onClick={() => openOverview('abnormal')}");
    expect(source).toContain("onClick={() => openOverview('working')}");
  });
});

describe('audit: visibility and inspector consistency', () => {
  it('does not leak child alerts through the main window after filtering its session list', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('visibleAlerts(alerts, rawSessions, showSubagents)');
    expect(source).not.toContain('visibleAlerts(alerts, allSessions)');
  });

  it('preserves the opened session inspector across list filter and status changes', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (detailOpen) {');
    expect(source).toContain('if (selectedKey && allSessions.some(session => session.key === selectedKey)) return;');
    expect(source).not.toContain('if (!shown.length) { setSelectedKey(null); setDetailOpen(false); return; }');
  });

  it('clears modal overlays before focusing an externally requested session', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toMatch(/const focusSession = \(key: string\) => \{[\s\S]*?setOverviewStatus\(null\);[\s\S]*?setView\('sessions'\);/);
  });
});

describe('source-clock and local indexing diagnostics', () => {
  it('exposes source scan timings and local stat count in the existing footer', () => {
    const source=readFileSync(new URL('../src/renderer/App.tsx', import.meta.url),'utf8');
    expect(source).toContain('projectSessionsToLocalTime(scan)');
    expect(source).toContain('sourceDiagnosticTitle');
    expect(source).toContain('aria-label="采集性能诊断"');
    expect(source).toContain('localDiagnostics.metrics.statCalls');
    expect(source).toContain('notificationLag.p95Ms');
    expect(source).toContain('selectedRaw?.updatedAt');
  });
});

describe('renderer performance safeguards', () => {
  it('reuses date formatting and limits initial table DOM work', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const DISPLAY_DATE_FORMATTER = new Intl.DateTimeFormat');
    expect(source).toContain('return DISPLAY_DATE_FORMATTER.format(value)');
    expect(source).toContain('const SESSION_PAGE_SIZE = 100');
    expect(source).toContain('sessions={shown.slice(0, sessionLimit)}');
    expect(source).toContain('setSessionLimit(current =>');
    expect(source).toContain('Math.min(current + SESSION_PAGE_SIZE, shown.length)');
  });

  it('reuses filtered groups within each one-minute recency window', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    expect(source).toContain('const recencyClock = Math.floor(now / 60_000) * 60_000');
    expect(source).toContain('workspaceId, recencyClock]');
    expect(source).toContain("view === 'board' || view === 'locations'");
    expect(source).toContain('const recentAlerts = useMemo');
    expect(source).not.toContain('setInterval(() => setNow(Date.now()), 5000)');
  });

  it('does no clock work in collapsed dock and pauses background-only animations', () => {
    const floating = readFileSync(new URL('../src/renderer/FloatingApp.tsx', import.meta.url), 'utf8');
    const styles = readFileSync(new URL('../src/renderer/signal.css', import.meta.url), 'utf8');
    const clock = readFileSync(new URL('../src/renderer/useVisibleInterval.ts', import.meta.url), 'utf8');
    expect(floating).toContain("dock.expanded && tab === 'completed'");
    expect(floating).not.toContain('setInterval(() => setNow(Date.now()), 5000)');
    expect(clock).toContain("document.addEventListener('visibilitychange', sync)");
    expect(clock).toContain("return () => document.removeEventListener('visibilitychange', sync)");
    expect(styles).toContain('.signal-app.signal-paused .signal-ribbon-body');
    expect(styles).toContain('animation-play-state:paused!important');
    expect(styles).toContain('.signal-app .signal-ambient svg{animation:none}');
  });
});

describe('Signal Studio view switching contract', () => {
  it('uses one persistent title container while changing the view animation', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');
    // A changing key remounts the heading on every navigation; in Electron this
    // produced a stack of stale animated heading layers.
    expect(source).toContain('className="signal-page-title" data-current-view={view}');
    expect(source).not.toContain('className="signal-page-title" key={view}');
    expect(source).toContain("className={'signal-view view-' + view}");
    expect(source).not.toContain('<div key={view} className="signal-view"');
    const html = renderToStaticMarkup(createElement(App));
    expect((html.match(/class="signal-page-title"/g) || [])).toHaveLength(1);
    expect((html.match(/class="signal-view view-board"/g) || [])).toHaveLength(1);
  });
});

describe('desktop UI rendering smoke', () => {
  it('renders the Signal Studio shell with all monitoring workflows before data arrives', () => {
    const html = renderToStaticMarkup(createElement(App));
    expect(html).toContain('Codex Monitor');
    expect(html).toContain('决策台');
    expect(html).toContain('机器矩阵');
    expect(html).toContain('事件轨迹');
    expect(html).toContain('全部会话');
    expect(html).toContain('执行位置');
    expect(html).toContain('可能待处理');
    expect(html).toContain('失败 / 中断');
    expect(html).toContain('当前没有待处理会话');
    expect(html).toContain('查看可能待处理会话，共 0 条');
    expect(html).toContain('查看失败和中断会话，共 0 条');
    expect(html).not.toContain('件待处理');
    expect(html).not.toContain('signal-focus');
    expect(html).toContain('最近变化');
    expect(html).toContain('数据源设置');
    expect(html).toContain('常驻设置');
    expect(html).toContain('显示子代理');
    // The decorative marketing hero and unused logo were deliberately removed.
    expect(html).toContain('任务概览');
    expect(html).not.toContain('今天的工作');
    expect(html).not.toContain('signal-brand-symbol');
    // Previously a literal <br/> in a string was visible in the task card.
    expect(html).not.toContain('&lt;br/&gt;');
    expect(html).toContain('signal-view');
    expect(html).toContain('nav-board');
  });
});

describe('notification-kind settings UI contract', () => {
  it('exposes all six typed controls through resident settings and live Monitor state', () => {
    const source = readFileSync(new URL('../src/renderer/App.tsx', import.meta.url),'utf8');
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url),'utf8');
    const native = readFileSync(new URL('../electron/ipc-handlers.ts', import.meta.url),'utf8');
    expect(source).toContain('aria-label="通知类型设置"');
    expect(source).toContain('NOTIFICATION_OPTIONS.map');
    expect(source).toContain("setNotificationKinds(state.notificationKinds");
    expect(source).toContain('updateNotificationKind(option.kind, event.target.checked)');
    for (const kind of ['waiting','finished','interrupted','failed',
      'source-offline','source-recovered'])
      expect(source).toContain("kind: '"+kind+"'");
    expect(preload).toContain('monitor:set-notification-kind');
    expect(native).toContain('isNotificationKind(kind)');
    expect(native).toContain("typeof enabled !== 'boolean'");
    expect(source).toContain('关闭后不会弹系统通知，也不增加未读数量');
  });
});

describe('renderer state revision regression guards',()=>{
  it('prevents heavy session recompute after alert-only IPC events',()=>{
    const primary=readFileSync(new URL('../src/renderer/App.tsx', import.meta.url),'utf8');
    const dock=readFileSync(new URL('../src/renderer/FloatingApp.tsx', import.meta.url),'utf8');
    expect(primary).toContain('nextScanRevision(acceptedScanRevision.current, state)');
    expect(primary).toContain('acceptScan(state)');
    expect(dock).toContain('setMonitor(previous => keepStableScan(previous, state))');
    expect(dock).toContain('useMemo(() => recentSessions(monitor), [monitor.scan])');
    expect(dock).toContain('useMemo(() => recentParentCompletions(sessions, now), [sessions, now])');
  });
});

describe('automatic original window read integration', () => {
  it('connects the native foreground event to authoritative per-session acknowledgement', () => {
    const main=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8');
    const tracker=readFileSync(new URL('../electron/window-tracking.ts',import.meta.url),'utf8');
    expect(main).toContain('monitor?.unreadSessionKeys()');
    expect(main).toContain('windowTracker?.isSessionForegroundForRead(key)');
    expect(main).toContain('monitor?.acknowledgeSessionAlerts(key)');
    expect(tracker).toContain('this.onForegroundObservation();');
    expect(tracker).toContain('this.resolver.isSessionForegroundForRead(sessionKey, now)');
  });
});

describe('foreground popup diagnostics stay in the existing session inspector',()=>{
  it('exposes a bounded reason code without content or new polling',()=>{
    const tracker=readFileSync(new URL('../electron/window-tracking.ts',import.meta.url),'utf8');
    const resolver=readFileSync(new URL('../src/shared/auto-window-binding.ts',import.meta.url),'utf8');
    expect(tracker).toContain('this.recentToastDiagnostic(sessionKey)');
    expect(tracker).toContain('TOAST_DIAGNOSTIC_AGE_MS = 15 * 60_000');
    expect(resolver).toContain("reason: 'recent-vscode-input'");
    expect(tracker).not.toContain('process.commandLine');
  });
});
