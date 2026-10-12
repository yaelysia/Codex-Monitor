import { useEffect, useMemo, useState } from 'react';
import type { FloatingTab, FloatingWindowState, MonitorState, SessionRecord } from '../shared/types';

const EMPTY: MonitorState = { scan: null, alerts: [], muted: false };
const DEFAULT_DOCK: FloatingWindowState = { visible: true, expanded: false, side: 'right' };
const DAY_MS = 24 * 60 * 60 * 1000;

type IconName = 'play' | 'bell' | 'check' | 'fold' | 'open' | 'close' | 'volume' | 'mute' | 'arrow';
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
  return (state.scan?.sources.flatMap(source => source.sessions) || [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export default function FloatingApp() {
  const [monitor, setMonitor] = useState<MonitorState>(EMPTY);
  const [dock, setDock] = useState<FloatingWindowState>(DEFAULT_DOCK);
  const [tab, setTab] = useState<FloatingTab>('running');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let alive = true;
    const offMonitor = window.monitorApi.onMonitorState(state => { if (alive) setMonitor(state); });
    const offDock = window.monitorApi.onFloatingState(state => { if (alive) setDock(state); });
    void window.monitorApi.getMonitorState().then(state => { if (alive) setMonitor(state); }).catch(console.error);
    void window.monitorApi.getFloatingState().then(state => { if (alive) setDock(state); }).catch(console.error);
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => { alive = false; offMonitor(); offDock(); clearInterval(timer); };
  }, []);

  const sessions = useMemo(() => recentSessions(monitor), [monitor.scan]);
  const running = sessions.filter(s => s.status === 'working');
  const waiting = sessions.filter(s => s.status === 'waiting');
  const completed = sessions.filter(s => s.status === 'finished' && now - s.updatedAt <= DAY_MS);
  const unread = monitor.alerts.filter(a => !a.read);
  const alerts = [...monitor.alerts].sort((a, b) => b.at - a.at);
  const dataSources = monitor.scan?.sources.filter(s => !s.error).length || 0;

  function showTab(target: FloatingTab) {
    setTab(target);
    void window.monitorApi.setFloatingExpanded(true).then(setDock).catch(console.error);
  }
  function collapse() {
    void window.monitorApi.setFloatingExpanded(!dock.expanded).then(setDock).catch(console.error);
  }
  function openMain(key?: string) {
    void window.monitorApi.showMainWindow(key).catch(console.error);
  }
  function acknowledge(id: string) {
    void window.monitorApi.acknowledgeAlert(id).then(setMonitor).catch(console.error);
  }

  const heading = tab === 'running' ? '可能执行中' : tab === 'alerts' ? '提醒收件箱' : '最近完成';
  const count = tab === 'running' ? running.length : tab === 'alerts' ? unread.length : completed.length;
  const description = tab === 'running' ? '近期有活动证据，状态仍为推断' :
    tab === 'alerts' ? '仅显示新检测到的变化' : '最近 24 小时完成的轮次';

  return <div className={'float-shell side-' + dock.side + (dock.expanded ? ' expanded' : ' collapsed')}>
    {dock.expanded && <section className="dock-panel" aria-label={heading}>
      <header className="dock-head">
        <span className={'small-dot ' + (tab === 'running' ? 'green' : tab === 'alerts' ? 'amber' : 'gray')}/>
        <strong>{heading} · {count}</strong><small>{dataSources} 个数据源</small>
      </header>
      <p className="dock-description">{description}</p>
      <div className="dock-rows">
        {tab === 'running' && (running.length ? running.slice(0, 10).map(session =>
          <button key={session.key} type="button" className="dock-task"
            onClick={() => openMain(session.key)}>
            <span className="small-dot green"/>
            <span className="task-info"><strong title={session.title || ''}>{session.title || '未命名会话'}</strong>
              <small title={session.workspace || ''}>{session.sourceLabel}{session.isSubagent ? ' · 子代理' : ''} · {session.workspace || '未知目录'}</small></span>
            <Icon name="open" size={13}/>
          </button>) : <p className="dock-empty">暂无可确认的活动会话</p>)}
        {tab === 'alerts' && <>
          {alerts.slice(0, 12).map(alert =>
            <div key={alert.id} className={'alert-item' + (alert.read ? ' is-read' : '')}>
              <button type="button" className="alert-body" onClick={() => openMain(alert.sessionKey)}>
                <span className={'small-dot ' + (alert.kind === 'waiting' ? 'amber' : 'green')}/>
                <span className="task-info"><strong>{alert.title}</strong>
                  <small>{alert.kind === 'waiting' ? '可能需要处理' : '本轮完成'} · {alert.sourceLabel}</small></span>
              </button>
              {!alert.read && <button className="ack-button" type="button" title="标记已读"
                aria-label={'标记已读：' + alert.title} onClick={() => acknowledge(alert.id)}>
                <Icon name="check" size={14}/></button>}
            </div>)}
          {waiting.filter(s => !alerts.some(a => a.sessionKey === s.key && a.kind === 'waiting'))
            .slice(0, 3).map(session => <button className="dock-task" key={session.key}
              type="button" onClick={() => openMain(session.key)}>
              <span className="small-dot amber"/>
              <span className="task-info"><strong>{session.title || '未命名会话'}</strong>
                <small>待处理状态 · {session.sourceLabel} · 推断</small></span>
            </button>)}
          {!alerts.length && !waiting.length && <p className="dock-empty">目前没有新的提醒</p>}
        </>}
        {tab === 'completed' && (completed.length ? completed.slice(0, 10).map(session =>
          <button key={session.key} type="button" className="dock-task"
            onClick={() => openMain(session.key)}>
            <span className="small-dot gray"/>
            <span className="task-info"><strong>{session.title || '未命名会话'}</strong>
              <small>{session.sourceLabel} · {ageText(session.updatedAt, now)}</small></span>
            <Icon name="open" size={13}/>
          </button>) : <p className="dock-empty">24 小时内没有已完成的轮次</p>)}
      </div>
      <footer className="dock-foot">
        <button type="button" onClick={() => openMain()}>打开完整看板 <Icon name="arrow" size={12}/></button>
        <button type="button" onClick={() =>
          void window.monitorApi.setNotificationsMuted(!monitor.muted).then(setMonitor).catch(console.error)}
          title={monitor.muted ? '恢复系统通知' : '静音系统通知'}
          aria-label={monitor.muted ? '恢复通知' : '通知静音'}>
          <Icon name={monitor.muted ? 'mute' : 'volume'} size={15}/>
        </button>
        <button type="button" onClick={collapse} title="收起">
          <Icon name="fold" size={15}/>
        </button>
      </footer>
    </section>}
    <aside className="dock-rail" aria-label="Codex Monitor 边缘悬浮窗">
      <div className="rail-grab" title="按住拖动至屏幕左侧或右侧" aria-label="拖动悬浮窗">C</div>
      <span className="rail-rule"/>
      <button type="button" className={'rail-tab' + (tab === 'running' && dock.expanded ? ' selected' : '')}
        aria-label={'可能执行中 ' + running.length} aria-pressed={tab === 'running' && dock.expanded}
        onClick={() => showTab('running')} title="可能执行中">
        <Icon name="play"/>{running.length > 0 && <span className="rail-badge green">{Math.min(99, running.length)}</span>}
      </button>
      <button type="button" className={'rail-tab' + (tab === 'alerts' && dock.expanded ? ' selected' : '')}
        aria-label={'未读提醒 ' + unread.length} aria-pressed={tab === 'alerts' && dock.expanded}
        onClick={() => showTab('alerts')} title="新提醒与待处理">
        <Icon name="bell"/>{unread.length > 0 && <span className="rail-badge amber">{Math.min(99, unread.length)}</span>}
      </button>
      <button type="button" className={'rail-tab' + (tab === 'completed' && dock.expanded ? ' selected' : '')}
        aria-label={'最近完成 ' + completed.length} aria-pressed={tab === 'completed' && dock.expanded}
        onClick={() => showTab('completed')} title="最近完成">
        <Icon name="check"/>{completed.length > 0 && <span className="rail-mini-dot"/>}
      </button>
      <div className="rail-spacer"/>
      <button type="button" className="rail-tab rail-collapse" aria-label={dock.expanded ? '收起悬浮窗' : '展开悬浮窗'}
        title={dock.expanded ? '收起' : '展开'} onClick={collapse}><Icon name="fold"/></button>
      <button type="button" className="rail-tab rail-hide" title="隐藏悬浮窗，可从主窗口重新开启"
        aria-label="隐藏悬浮窗" onClick={() =>
          void window.monitorApi.setFloatingVisible(false).catch(console.error)}>
        <Icon name="close" size={13}/>
      </button>
    </aside>
  </div>;
}
