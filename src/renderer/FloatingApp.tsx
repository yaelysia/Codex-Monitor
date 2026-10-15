import { useEffect, useMemo, useState } from 'react';
import type { FloatingTab, FloatingWindowState, MonitorState, SessionRecord } from '../shared/types';
import { recentParentCompletions } from '../shared/monitor-view';
import { windowWasActivated } from '../shared/window-navigation';
import { visibleAlerts, visibleSessions } from '../shared/session-visibility';
import { sessionEvidenceLabel } from '../shared/session-evidence';
import { projectSessionsToLocalTime } from '../shared/session-time';
import { alertKindLabel } from '../shared/alert-presentation';
import { isSourceAlertKind } from '../shared/source-alert';
import { useVisibleInterval } from './useVisibleInterval';

const EMPTY: MonitorState = { scan: null, alerts: [], muted: false };
const DEFAULT_DOCK: FloatingWindowState = { visible: true, expanded: false, side: 'right', opacity: 1,
  appearance: 'moonsea', compactSize: 'micro' };

type IconName = 'play' | 'bell' | 'check' | 'fold' | 'open' | 'close' | 'volume' | 'mute' | 'arrow' | 'activity';
const paths: Record<IconName, string> = {
  play: 'M4 4 15 11 4 18V4ZM18 5v12',
  bell: 'M18 8a6 6 0 0 0-12 0c0 8-3 8-3 10h18c0-2-3-2-3-10ZM10 21h4',
  check: 'm4 12 5 5L20 6',
  fold: 'm8 5 7 7-7 7',
  open: 'M7 17 17 7M7 7h10v10',
  close: 'M5 5 19 19M19 5 5 19',
  volume: 'M4 9h4l4-4v14l-4-4H4V9ZM16 8c2 2 2 6 0 8',
  mute: 'M4 9h4l4-4v14l-4-4H4V9ZM16 9l5 6M21 9l-5 6',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  activity: 'M2 12h4l3-7 5 14 3-7h5',
};
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={paths[name]}/>
  </svg>;
}
function ageText(then: number, now: number) {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return seconds + ' 秒前';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  return Math.floor(seconds / 86400) + ' 天前';
}
function recentSessions(state: MonitorState): SessionRecord[] {
  return visibleSessions(projectSessionsToLocalTime(state.scan))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export default function FloatingApp() {
  const [monitor, setMonitor] = useState<MonitorState>(EMPTY);
  const [dock, setDock] = useState<FloatingWindowState>(DEFAULT_DOCK);
  const [tab, setTab] = useState<FloatingTab>('running');
  const [now, setNow] = useState(Date.now());
  // Collapsed rails never display relative time. Keep their renderer idle.
  useVisibleInterval(() => setNow(Date.now()), 30_000, dock.expanded && tab === 'completed');

  useEffect(() => {
    let alive = true;
    const offMonitor = window.monitorApi.onMonitorState(state => { if (alive) setMonitor(state); });
    const offDock = window.monitorApi.onFloatingState(state => { if (alive) setDock(state); });
    void window.monitorApi.getMonitorState().then(state => { if (alive) setMonitor(state); }).catch(console.error);
    void window.monitorApi.getFloatingState().then(state => { if (alive) setDock(state); }).catch(console.error);
    return () => { alive = false; offMonitor(); offDock(); };
  }, []);

  const sessions = useMemo(() => recentSessions(monitor), [monitor.scan]);
  const running = useMemo(() => sessions.filter(s => s.status === 'working'), [sessions]);
  const waiting = useMemo(() => sessions.filter(s => s.status === 'waiting' || !!s.pendingQuestionToken),
    [sessions]);
  const completed = recentParentCompletions(sessions, now);
  const alerts = useMemo(() => visibleAlerts(monitor.alerts,
    monitor.scan?.sources.flatMap(source => source.sessions) || [])
    .sort((a, b) => b.at - a.at), [monitor.alerts, monitor.scan]);
  const unread = alerts.filter(a => !a.read);
  const dataSources = monitor.scan?.sources.filter(s => !s.error).length || 0;

  function showTab(target: FloatingTab) {
    setTab(target);
    if (target === 'completed') setNow(Date.now());
    // The native main process broadcasts the authoritative dock state.
    // Do not apply a possibly stale IPC response after a fast outside click
    // has already collapsed the popup via BrowserWindow.blur.
    void window.monitorApi.setFloatingExpanded(true).catch(console.error);
  }
  function collapse() {
    void window.monitorApi.setFloatingExpanded(!dock.expanded).catch(console.error);
  }
  function openMain(key?: string) {
    void window.monitorApi.showMainWindow(key).catch(console.error);
  }
  function openOriginal(key: string) {
    void window.monitorApi.focusOriginalWindow(key).then(result => {
      if (!windowWasActivated(result)) openMain(key);
    }).catch(() => openMain(key));
  }
  function acknowledge(id: string) {
    void window.monitorApi.acknowledgeAlert(id).then(setMonitor).catch(console.error);
  }

  const heading = tab === 'running' ? '可能执行中' : tab === 'alerts' ? '提醒收件箱' : '最近完成';
  const count = tab === 'running' ? running.length : tab === 'alerts' ? unread.length : completed.length;
  const description = tab === 'running' ? '点击任务优先返回原窗口；无法定位则打开会话详情' :
    tab === 'alerts' ? '仅显示新检测到的变化' : '最近 24 小时完成的轮次';

  // Keep the panel mounted while shrinking so its contents can fade out.
  // The edge rail itself never changes size or position in an open/close turn.
  const panelVisible = dock.expanded || dock.motion === 'collapsing';
  return <div className={'float-shell signal-float scene-' + dock.appearance +
    ' size-' + dock.compactSize + ' side-' + dock.side + (panelVisible ? ' expanded' : ' collapsed') +
    ' motion-' + (dock.motion ?? 'idle')}>
    {panelVisible && <section className="dock-panel" aria-label={heading}
      aria-hidden={!dock.expanded} inert={!dock.expanded}>
      <header className="signal-dock-top">
        <strong>CODEX / AMBIENT SIGNAL</strong>
        <div>
          <button type="button" aria-label={monitor.muted ? '恢复通知' : '通知静音'}
            title={monitor.muted ? '恢复通知' : '通知静音'}
            onClick={() => void window.monitorApi.setNotificationsMuted(!monitor.muted)
              .then(setMonitor).catch(console.error)}>
            <Icon name={monitor.muted ? 'mute' : 'volume'} size={15}/></button>
          <button type="button" title="隐藏悬浮窗" aria-label="隐藏悬浮窗"
            onClick={() => void window.monitorApi.setFloatingVisible(false).catch(console.error)}>
            <Icon name="close" size={15}/></button>
          <button type="button" title="收起" aria-label="收起悬浮窗"
            onClick={collapse}><Icon name="fold" size={16}/></button>
        </div>
      </header>
      <div className="signal-dock-intro">
        <h1>会话动态</h1>
        <p><span className="signal-dock-live"/> {dataSources} 个有效数据源 · 状态来自有界证据</p>
      </div>
      <nav className="signal-dock-tabs" aria-label="悬浮窗视图">
        <button type="button" className={tab === 'running' ? 'active' : ''}
          onClick={() => showTab('running')}>可能执行 <span>{running.length}</span></button>
        <button type="button" className={tab === 'alerts' ? 'active' : ''}
          onClick={() => showTab('alerts')}>提醒 <span>{unread.length}</span></button>
        <button type="button" className={tab === 'completed' ? 'active' : ''}
          onClick={() => showTab('completed')}>本轮结束 <span>{completed.length}</span></button>
      </nav>
      <div className="signal-dock-content" role="region" aria-label={heading}>
        {tab === 'running' && <>
          <div className="signal-dock-section-title">可能执行中的会话 · {running.length}</div>
          {running.slice(0, 12).map(session => <button key={session.key}
            type="button" className="signal-dock-session" onClick={() => openOriginal(session.key)}>
            <span className="signal-dock-session-icon"><Icon name="activity" size={17}/></span>
            <span className="signal-dock-session-info">
              <strong title={session.title || ''}>{session.title || '未命名会话'}</strong>
              <small title={session.statusReason}>{session.sourceLabel} · {sessionEvidenceLabel(session)}</small>
            </span><Icon name="open" size={13}/>
          </button>)}
          {!running.length && <p className="signal-dock-empty">当前没有可靠的活动线索</p>}
        </>}
        {tab === 'alerts' && <>
          <div className="signal-dock-section-title">通知与待处理 · {unread.length} 未读</div>
          {alerts.slice(0, 14).map(alert => <div key={alert.id}
            className={'signal-dock-alert' + (alert.read ? ' is-read' : '')}>
            <button type="button" className="signal-dock-alert-main" onClick={() => {
              if (!alert.read) acknowledge(alert.id);
              if (isSourceAlertKind(alert.kind)) openMain(alert.sessionKey);
              else openOriginal(alert.sessionKey);
            }}>
              <span className={'signal-dock-alert-dot ' + alert.kind}/>
              <span><strong>{alert.title}</strong><small title={alert.questionText || undefined}>
                {alert.kind === 'waiting' ? alert.questionText || '可能需要回答/确认' : alertKindLabel(alert.kind)} · {alert.sourceLabel}
              </small></span>
            </button>
            {!alert.read && <button type="button" className="signal-dock-ack"
              onClick={() => acknowledge(alert.id)} title="标记已读"
              aria-label={'标记已读：' + alert.title}><Icon name="check" size={15}/></button>}
          </div>)}
          {waiting.filter(session => !alerts.some(a => a.sessionKey === session.key && a.kind === 'waiting'))
            .slice(0, 4).map(session => <button type="button" key={session.key}
              className="signal-dock-session" onClick={() => openOriginal(session.key)}>
              <span className="signal-dock-session-icon warn"><Icon name="bell" size={16}/></span>
              <span className="signal-dock-session-info"><strong>{session.title || '未命名会话'}</strong>
                <small>{session.questionText || '有待处理线索'} · {session.sourceLabel}</small></span>
            </button>)}
          {!alerts.length && !waiting.length && <p className="signal-dock-empty">没有新的提醒</p>}
        </>}
        {tab === 'completed' && <>
          <div className="signal-dock-section-title">最近 24 小时本轮结束 · {completed.length}</div>
          {completed.slice(0, 12).map(session => <button type="button" key={session.key}
            className="signal-dock-session" onClick={() => openOriginal(session.key)}>
            <span className="signal-dock-session-icon done"><Icon name="check" size={17}/></span>
            <span className="signal-dock-session-info"><strong>{session.title || '未命名会话'}</strong>
              <small>{session.sourceLabel} · {ageText(session.updatedAt, now)}</small></span>
            <Icon name="open" size={13}/>
          </button>)}
          {!completed.length && <p className="signal-dock-empty">24 小时内没有已检测的完成轮次</p>}
        </>}
      </div>
      <footer className="signal-dock-foot">
        <button type="button" onClick={() => openMain()}><Icon name="open" size={15}/> 打开完整看板</button>
        <button type="button" onClick={() => { if (sessions[0]) openOriginal(sessions[0].key); }}
          disabled={!sessions.length}>返回原窗口 <Icon name="arrow" size={14}/></button>
      </footer>
    </section>}
    <aside className="dock-rail" aria-label="Codex Monitor 边缘悬浮窗">
      <div className="rail-grab" aria-label="按住拖动悬浮窗" title="拖动至屏幕左侧或右侧"/>
      <button type="button" className={'rail-tab rail-activity' + (tab === 'running' && dock.expanded ? ' selected' : '')}
        aria-label={'可能执行中 ' + running.length} aria-pressed={tab === 'running' && dock.expanded}
        onClick={() => showTab('running')} title="展开可能执行中的会话">
        <Icon name="activity" size={dock.expanded ? 19 : 16}/>
        {running.length > 0 && <span className="rail-badge green">{Math.min(99,running.length)}</span>}
      </button>
      <div className="rail-alert-shortcut">
        <button type="button" className={'rail-tab rail-bell' + (tab === 'alerts' && dock.expanded ? ' selected' : '')}
          aria-label={'未读提醒 ' + unread.length} aria-pressed={tab === 'alerts' && dock.expanded}
          onClick={() => showTab('alerts')} title="展开提醒">
          <Icon name="bell" size={dock.expanded ? 18 : 16}/>
          {unread.length > 0 && <span className="rail-badge amber">{Math.min(99,unread.length)}</span>}
        </button>
        {unread.length > 0 && <button type="button" className="rail-quick-ack"
          onClick={() => acknowledge(unread[0]!.id)} title="直接标记最新提醒已读"
          aria-label={'标记最新提醒已读：' + unread[0]!.title}><Icon name="check" size={10}/></button>}
      </div>
      {dock.compactSize === 'compact' && !panelVisible &&
        <button type="button" className="rail-tab rail-completed"
          aria-label={'最近完成 ' + completed.length} title="展开最近完成"
          onClick={() => showTab('completed')}><Icon name="check" size={17}/></button>}
    </aside>
  </div>;
}
