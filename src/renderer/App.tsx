
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ConfigResponse, ScanResponse, SessionRecord, SessionStatus, Settings, RecentReplyExcerpt, ResidentOptions, OriginalWindowStatus, MonitorAlert, SignalAppearance, FloatingCompactSize } from '../shared/types';
import { sessionEvidenceLabel } from '../shared/session-evidence';
import { groupByExecutionLocation, workspaceGroupKey, type WorkspaceGroup } from '../shared/grouping';
import { filterSessions, makeStatusLanes, type ViewFilter } from '../shared/monitor-view';
import { visibleAlerts, visibleSessions } from '../shared/session-visibility';

type View = 'board' | 'sessions' | 'locations' | 'chronicle';

type StoredViewPreferences = { view: View; recentOnly: boolean; filter: SessionStatus | 'all'; showSubagents: boolean };
const VIEW_PREFERENCES_KEY = 'codex-monitor-view-v1';
function readViewPreferences(): StoredViewPreferences {
  const fallback: StoredViewPreferences = { view: 'board', recentOnly: true, filter: 'all', showSubagents: false };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const row = JSON.parse(localStorage.getItem(VIEW_PREFERENCES_KEY) || 'null');
    if (!row || typeof row !== 'object') return fallback;
    const validView = row.view === 'board' || row.view === 'sessions' || row.view === 'locations' || row.view === 'chronicle';
    const validFilter = ['all', 'working', 'waiting', 'finished', 'interrupted', 'failed', 'unknown'].includes(row.filter);
    return { view: validView ? row.view : 'board',
      recentOnly: typeof row.recentOnly === 'boolean' ? row.recentOnly : true,
      filter: validFilter ? row.filter : 'all',
      showSubagents: row.showSubagents === true };
  } catch { return fallback; }
}


type GlyphName = 'grid' | 'list' | 'folder' | 'monitor' | 'server' | 'search' | 'refresh' | 'settings' |
  'copy' | 'clock' | 'check' | 'alert' | 'close' | 'chevron-right' | 'chevron-down' | 'chevron-left' | 'activity' | 'sliders' | 'bell' | 'palette' | 'arrow-up-right';

const STATUS: Record<SessionStatus, { text: string; className: string; short: string }> = {
  working: { text: '可能执行中', className: 'working', short: '执行中 · 推断' },
  waiting: { text: '可能待处理', className: 'waiting', short: '待处理 · 推断' },
  finished: { text: '本轮已完成', className: 'finished', short: '本轮完成' },
  interrupted: { text: '本轮已中断', className: 'interrupted', short: '已中断' },
  failed: { text: '本轮失败', className: 'failed', short: '失败' },
  unknown: { text: '状态未知', className: 'unknown', short: '状态未知' },
};
const REFRESH_MS = 12_000;
const MAX_SIDEBAR_FOLDERS = 6;
const BATCH_SIZE = 8;

const ICONS: Record<GlyphName, ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01" strokeWidth="3" strokeLinecap="round"/></>,
  folder: <path d="M3 7.5v11A2.5 2.5 0 0 0 5.5 21h13a2.5 2.5 0 0 0 2.5-2.5v-9A2.5 2.5 0 0 0 18.5 7H12l-2.2-2H5.5A2.5 2.5 0 0 0 3 7.5Z"/>,
  monitor: <><rect x="2.5" y="4" width="19" height="14" rx="2"/><path d="M8 22h8M12 18v4"/></>,
  server: <><rect x="3" y="3" width="18" height="8" rx="2"/><rect x="3" y="13" width="18" height="8" rx="2"/><path d="M7 7h.01M7 17h.01"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  refresh: <><path d="M20 10a8 8 0 0 0-14.8-4M4 4v5h5M4 14a8 8 0 0 0 14.8 4M20 20v-5h-5"/></>,
  settings: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></>,
  sliders: <><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  check: <path d="m5 12 4.5 4.5L19 7"/>,
  alert: <><path d="m12 3 9 16H3L12 3Z"/><path d="M12 9v4M12 17h.01"/></>,
  close: <path d="M5 5 19 19M19 5 5 19"/>,
  'chevron-right': <path d="m9 5 7 7-7 7"/>,
  'chevron-down': <path d="m5 9 7 7 7-7"/>,
  'chevron-left': <path d="m15 5-7 7 7 7"/>,
  activity: <path d="M2 12h4l3-7 5 14 3-7h5"/>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 8-3 8-3 10h18c0-2-3-2-3-10M10 21h4"/></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h2a2.5 2.5 0 0 0 1-4.8 2 2 0 0 1 .9-3.8H19a2 2 0 0 0 2-2c0-4-4-7.4-9-7.4Z"/><path d="M7.5 11h.01M9 7h.01M14 6.5h.01M17.4 9.5h.01" strokeWidth="2.8"/></>,
  'arrow-up-right': <path d="M6 18 18 6M8 6h10v10"/>, 
};
function Icon({ name, size = 16 }: { name: GlyphName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[name]}</svg>;
}
function ageText(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return seconds + ' 秒前';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时前';
  return Math.floor(seconds / 86400) + ' 天前';
}
function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit' }).format(value);
}
function workspaceName(value: string | null): string {
  if (!value) return '未记录目录';
  return value.split(/[\\/]/).filter(Boolean).pop() || value;
}
function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={'status-pill status-' + status}>
    <span className="status-dot" />{STATUS[status].text}
  </span>;
}

function SessionCard({ session, now, selected, onSelect }: {
  session: SessionRecord; now: number; selected: boolean; onSelect: (session: SessionRecord) => void;
}) {
  return <button type="button" className={'task-card status-' + session.status + (selected ? ' is-selected' : '')}
    aria-pressed={selected} onClick={() => onSelect(session)}>
    <div className="task-topline">
      <span className="task-source">{session.sourceLabel}{session.isSubagent && <span className="child-badge"> · 子代理</span>}</span>
      <span className="task-age">{ageText(session.updatedAt, now)}</span>
    </div>
    <div className="task-title">{session.title || '未命名会话'}</div>
    {session.pendingQuestionToken && <div className="task-question" title={session.questionText || ''}>
      <Icon name="alert" size={13}/>待回答：{session.questionText || '请查看 Codex 的问题'}
    </div>}
    <div className="task-path" title={session.workspace || '未记录工作目录'}>{session.workspace || '未记录工作目录'}</div>
    <div className="task-footer"><span className="task-state"><span className="status-dot" />{STATUS[session.status].short}</span>
      {session.status === 'working' && <span className="task-evidence" title={session.statusReason}>
        {sessionEvidenceLabel(session)}</span>}
      <Icon name="chevron-right" size={15}/>
    </div>
  </button>;
}


function SignalTaskRow({ session, now, onSelect }: {
  session: SessionRecord; now: number; onSelect: (value: SessionRecord) => void;
}) {
  const label = session.status === 'working' ? sessionEvidenceLabel(session) : STATUS[session.status].text;
  return <button type="button" className={'signal-task status-' + session.status}
    onClick={() => onSelect(session)} title={session.statusReason || label}>
    <span className="signal-task-icon"><Icon name={session.status === 'waiting' ? 'alert' :
      session.status === 'finished' ? 'check' : 'activity'} size={16}/></span>
    <span className="signal-task-copy">
      <strong>{session.title || '未命名会话'}{session.isSubagent && <small className="signal-child">子代理</small>}</strong>
      <small title={session.workspace || ''}>{session.sourceLabel} · {workspaceName(session.workspace)}</small>
    </span>
    <span className="signal-task-state"><span>{label}</span><small>{ageText(session.updatedAt, now)}</small></span>
    <Icon name="chevron-right" size={15}/>
  </button>;
}

function SessionTable({ sessions, now, selectedKey, onSelect }: {
  sessions: SessionRecord[]; now: number; selectedKey: string | null;
  onSelect: (session: SessionRecord) => void;
}) {
  return <div className="table-scroll">
    <table className="session-table">
      <thead><tr><th>会话标题 / 工作目录</th><th>执行位置</th><th>状态</th><th>最后活动</th></tr></thead>
      <tbody>{sessions.map(item => <tr key={item.key} className={selectedKey === item.key ? 'is-selected' : ''}>
        <td><button type="button" className="table-title" onClick={() => onSelect(item)}>
          {item.title || '未命名会话'}</button>{item.isSubagent && <span className="child-badge">子代理</span>}
          {item.pendingQuestionToken && <span className="table-question" title={item.questionText || ''}>
            待回答：{item.questionText || '查看 Codex 的问题'}</span>}
          <div className="table-path-line">
            <span className="mono table-path" title={item.workspace || '未记录工作目录'}>{item.workspace || '未记录工作目录'}</span>
            {item.workspace && <button type="button" className="table-copy" title="复制工作目录"
              aria-label={'复制 ' + item.workspace}
              onClick={() => { if (item.workspace) void window.monitorApi.copyWorkspace(item.workspace); }}>
              <Icon name="copy" size={13}/></button>}
          </div>
          <div className="mono session-identifier">{item.id}</div>
        </td>
        <td><span className="table-source">{item.sourceLabel}</span></td>
        <td><StatusPill status={item.status}/>
          {item.status === 'working' && <span className="table-evidence">{sessionEvidenceLabel(item)}</span>}</td>
        <td><span className="table-age">{ageText(item.updatedAt, now)}</span>
          <span className="table-date">{formatTime(item.updatedAt)}</span></td>
      </tr>)}</tbody>
    </table>
    {!sessions.length && <EmptyState text="没有符合条件的会话" />}
  </div>;
}

function WorkspaceSection({ group, now, selectedKey, onSelect }: {
  group: WorkspaceGroup; now: number; selectedKey: string | null;
  onSelect: (session: SessionRecord) => void;
}) {
  const [expanded, setExpanded] = useState(group.working > 0 || group.waiting > 0);
  useEffect(() => { if (group.working || group.waiting) setExpanded(true); }, [group.working, group.waiting]);
  return <section className="workspace-section">
    <button type="button" className="workspace-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      <span className="workspace-identity"><strong>{workspaceName(group.workspace)}</strong>
        <span className="mono truncate" title={group.workspace || ''}>{group.workspace || '未记录工作目录'}</span></span>
      <span className="workspace-totals">{group.sessions.length} 会话{group.working ? ' · ' + group.working + ' 活动' : ''}</span>
      <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={16}/>
    </button>
    {expanded && <div className="workspace-rows">{group.sessions.map(item =>
      <button key={item.key} type="button" className={'workspace-session' + (selectedKey === item.key ? ' is-selected' : '')}
        onClick={() => onSelect(item)}>
        <span className={'workspace-session-indicator status-' + item.status}/>
        <span className="workspace-session-name">{item.title || '未命名会话'}</span>
        <span className="workspace-session-time">{ageText(item.updatedAt, now)}</span>
        <Icon name="chevron-right" size={14}/>
      </button>
    )}</div>}
  </section>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><Icon name="search" size={22}/><strong>{text}</strong>
    <span>可调整搜索、时间范围或执行位置筛选。</span></div>;
}

function SettingsPanel({ config, onClose, onSave }: {
  config: ConfigResponse;
  onClose: () => void;
  onSave: (settings: Settings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Settings>(() => JSON.parse(JSON.stringify(config.settings)) as Settings);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [hostAlias, setHostAlias] = useState('');
  const [hostRoot, setHostRoot] = useState('');

  function addHost() {
    const alias = hostAlias.trim();
    if (!alias) return;
    if (draft.remotes.some(h => h.alias === alias)) { setError('SSH 主机已存在'); return; }
    const id = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
    setDraft(old => ({ ...old, remotes: [...old.remotes, { id, alias, root: hostRoot.trim() }] }));
    setHostAlias(''); setHostRoot(''); setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true); setError('');
    try { await onSave(draft); onClose(); }
    catch (err) { setError(describeError(err)); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="modal-top">
        <div><h2 id="settings-title">数据源设置</h2><p>仅读取会话信息，不修改 Codex 数据或远程进程。</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭设置">×</button>
      </header>
      <form onSubmit={submit}>
        <div className="modal-content">
          <h3>Windows 本地</h3>
          <label className="field-label" htmlFor="windows-root">CODEX_HOME（可留空）</label>
          <input id="windows-root" value={draft.localRoot} placeholder="默认读取环境变量或 ~/.codex"
            onChange={e => setDraft({ ...draft, localRoot: e.target.value })} />
          <p className="field-help">仅查看该目录下的 sessions，不扫描其他用户目录。</p>
          <h3>WSL 自动发现</h3>
          {config.distros.length === 0 ? <p className="muted">没有发现 WSL 发行版。</p> : config.distros.map(distro => <div key={distro} className="source-row">
            <label className="field-label" htmlFor={`wsl-${distro}`}>{distro} 的 CODEX_HOME（可留空）</label>
            <input id={`wsl-${distro}`} value={draft.wslRoots[distro] || ''} placeholder="默认 ~/.codex"
              onChange={e => setDraft({ ...draft, wslRoots: { ...draft.wslRoots, [distro]: e.target.value } })} />
          </div>)}
          <h3>SSH 服务器</h3>
          <p className="field-help">使用 Windows 系统 OpenSSH（支持 ~/.ssh/config 的 ProxyJump 和 IdentityFile）；请先在终端通过 ssh 主机名验证登录和主机指纹。远程需安装 Python 3。</p>
          {draft.remotes.map(host => <div key={host.id} className="remote-item">
            <div className="remote-fields">
              <input aria-label="SSH 主机或别名" value={host.alias} onChange={e => setDraft({ ...draft,
                remotes: draft.remotes.map(x => x.id === host.id ? { ...x, alias: e.target.value } : x) })} />
              <input aria-label="远程 CODEX_HOME" value={host.root} placeholder="远程 CODEX_HOME（可留空）"
                onChange={e => setDraft({ ...draft,
                  remotes: draft.remotes.map(x => x.id === host.id ? { ...x, root: e.target.value } : x) })} />
            </div>
            <button type="button" className="text-button danger" onClick={() => setDraft({ ...draft, remotes: draft.remotes.filter(x => x.id !== host.id) })}>移除</button>
          </div>)}
          <div className="remote-add">
            <input aria-label="新 SSH 主机" value={hostAlias} onChange={e => setHostAlias(e.target.value)} placeholder="user@host 或 SSH 别名" />
            <input aria-label="新主机 CODEX_HOME" value={hostRoot} onChange={e => setHostRoot(e.target.value)} placeholder="远程 CODEX_HOME（可选）" />
            <button type="button" className="secondary-button" onClick={addHost}>添加</button>
          </div>
          {error && <p role="alert" className="error-note">{error}</p>}
        </div>
        <footer className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>取消</button>
          <button type="submit" className="primary-button" disabled={saving}>{saving ? '保存中…' : '保存配置'}</button>
        </footer>
      </form>
    </section>
  </div>;
}



export default function App() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [eventChannels, setEventChannels] = useState<Record<string, 'active' | 'connecting' | 'fallback'>>({});
  const [performanceStats, setPerformanceStats] = useState<import('../shared/types').MonitorPerformance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionStatus | 'all'>(() => readViewPreferences().filter);
  const [recentOnly, setRecentOnly] = useState(() => readViewPreferences().recentOnly);
  const [showSubagents, setShowSubagents] = useState(() => readViewPreferences().showSubagents);
  const [view, setView] = useState<View>(() => readViewPreferences().view);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [expandedSources, setExpandedSources] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [replyVersion, setReplyVersion] = useState(0);
  const [originalWindow, setOriginalWindow] = useState<OriginalWindowStatus | null>(null);
  const [originalWindowMessage, setOriginalWindowMessage] = useState<string | null>(null);
  const [recentReply, setRecentReply] = useState<{
    key: string;
    loading: boolean;
    value: RecentReplyExcerpt | null;
    error: string | null;
  } | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showResident, setShowResident] = useState(false);
  const [residentOptions, setResidentOptions] = useState<ResidentOptions | null>(null);
  const [residentError, setResidentError] = useState('');
  const [residentSaving, setResidentSaving] = useState(false);
  const [floatingVisible, setFloatingVisible] = useState(false);
  const [floatingOpacity, setFloatingOpacity] = useState(1);
  const [floatingSide, setFloatingSide] = useState<'left' | 'right'>('right');
  const [appearance, setAppearance] = useState<SignalAppearance>('moonsea');
  const [compactSize, setCompactSize] = useState<FloatingCompactSize>('micro');
  const [alerts, setAlerts] = useState<MonitorAlert[]>([]);
  const [muted, setMuted] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [laneLimit, setLaneLimit] = useState<Record<string, number>>({
    working: BATCH_SIZE, other: BATCH_SIZE, finished: BATCH_SIZE,
  });
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const searchInput = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const next = await window.monitorApi.refresh();
      if (mounted.current) { setScan(next); setError(''); setNow(Date.now()); }
    } catch (err) {
      if (mounted.current) setError(describeError(err));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    window.monitorApi.getConfig().then(value => {
      if (mounted.current) setConfig(value);
    }).catch(err => { if (mounted.current) setError(describeError(err)); });
    void window.monitorApi.getResidentOptions().then(value => {
      if (mounted.current) setResidentOptions(value);
    }).catch(err => { if (mounted.current) setResidentError(describeError(err)); });
    const unsubscribe = window.monitorApi.onMonitorState(state => {
      if (!mounted.current) return;
      setEventChannels(state.eventChannels || {});
      setPerformanceStats(state.performance ?? null);
      setAlerts(state.alerts);
      setMuted(state.muted);
      if (state.scan) {
        setScan(state.scan);
        setNow(Date.now());
      }
    });
    const unsubscribeFloating = window.monitorApi.onFloatingState(state => {
      if (!mounted.current) return;
      setFloatingVisible(state.visible);
      setFloatingOpacity(state.opacity);
      setFloatingSide(state.side);
      setAppearance(state.appearance);
      setCompactSize(state.compactSize);
    });
    const focusSession = (key: string) => {
      setSourceId(null);
      setWorkspaceId(null);
      setFilter('all');
      setQuery('');
      setRecentOnly(false);
      setView('sessions');
      setSelectedKey(key);
      setDetailOpen(true);
    };
    const unsubscribeFocus = window.monitorApi.onFocusSession(focusSession);
    void window.monitorApi.consumePendingFocusKey().then(key => {
      if (mounted.current && key) focusSession(key);
    }).catch(console.error);
    void window.monitorApi.getFloatingState().then(state => {
      if (!mounted.current) return;
      setFloatingVisible(state.visible);
      setFloatingOpacity(state.opacity);
      setFloatingSide(state.side);
      setAppearance(state.appearance);
      setCompactSize(state.compactSize);
    }).catch(console.error);
    void window.monitorApi.getMonitorState().then(state => {
      if (!mounted.current) return;
      setEventChannels(state.eventChannels || {});
      setPerformanceStats(state.performance ?? null);
      setAlerts(state.alerts);
      setMuted(state.muted);
      if (state.scan) setScan(state.scan);
    }).catch(console.error);
    void refresh();
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      mounted.current = false;
      unsubscribe();
      unsubscribeFloating();
      unsubscribeFocus();
      clearInterval(clock);
    };
  }, [refresh]);
  useEffect(() => {
    try { localStorage.setItem(VIEW_PREFERENCES_KEY,
      JSON.stringify({ view, filter, recentOnly, showSubagents })); }
    catch { /* storage permission or quota: viewing and monitoring still work */ }
  }, [view, filter, recentOnly, showSubagents]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailOpen(false);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  const allSessions = useMemo(() => visibleSessions(
    scan?.sources.flatMap(source => source.sessions) ?? [], showSubagents)
    .sort((a, b) => b.updatedAt - a.updatedAt), [scan, showSubagents]);
  const sourceGroups = useMemo(() => groupByExecutionLocation(allSessions), [allSessions]);
  const shown = useMemo(() => filterSessions(allSessions, {
    query, status: filter, recentOnly, sourceId, workspaceId,
  }, now), [allSessions, query, filter, recentOnly, sourceId, workspaceId, now]);
  const groups = useMemo(() => groupByExecutionLocation(shown), [shown]);
  const lanes = useMemo(() => makeStatusLanes(shown), [shown]);
  const selected = useMemo(() => allSessions.find(session => session.key === selectedKey) ?? null,
    [allSessions, selectedKey]);

  // Read reply text only when a session is explicitly opened. The 12-second
  // metadata scan never fetches text for other sessions.
  useEffect(() => {
    if (!detailOpen || !selected) return;
    let cancelled = false;
    const key = selected.key;
    setRecentReply(current => ({
      key, loading: true,
      value: current?.key === key ? current.value : null,
      error: null,
    }));
    void window.monitorApi.getRecentReply(key).then(value => {
      if (!cancelled) setRecentReply({ key, loading: false, value, error: null });
    }).catch((err: unknown) => {
      if (!cancelled) setRecentReply({ key, loading: false, value: null, error: describeError(err) });
    });
    return () => { cancelled = true; };
  }, [detailOpen, selected?.key, selected?.updatedAt, replyVersion]);

  useEffect(() => {
    setOriginalWindow(null);
    setOriginalWindowMessage(null);
    if (!detailOpen || !selected?.key) return;
    let cancelled = false;
    void window.monitorApi.getOriginalWindowStatus(selected.key).then(status => {
      if (!cancelled) setOriginalWindow(status);
    }).catch(() => {
      if (!cancelled) setOriginalWindow({
        ready: false, message: '原窗口定位组件暂不可用',
      });
    });
    return () => { cancelled = true; };
  }, [detailOpen, selected?.key, scan?.scannedAt]);

  useEffect(() => {
    if (!shown.length) { setSelectedKey(null); setDetailOpen(false); return; }
    if (selectedKey && shown.some(session => session.key === selectedKey)) return;
    setSelectedKey((shown.find(session => session.status === 'working') ?? shown[0])?.key ?? null);
  }, [shown, selectedKey]);

  const totals = useMemo(() => ({
    all: allSessions.length,
    working: allSessions.filter(item => item.status === 'working').length,
    waiting: allSessions.filter(item => item.status === 'waiting').length,
    finished: allSessions.filter(item => item.status === 'finished').length,
    errors: scan?.sources.filter(source => source.error).length ?? 0,
  }), [allSessions, scan]);

  const scopeSource = scan?.sources.find(source => source.id === sourceId);
  const currentWorkspace = sourceGroups.flatMap(group => group.workspaces)
    .find(group => group.key === workspaceId);
  const attention = shown.filter(item => item.status === 'waiting' || item.status === 'failed' || item.status === 'interrupted');
  const running = shown.filter(item => item.status === 'working');
  const recentAlerts = visibleAlerts(alerts, allSessions).sort((a, b) => b.at - a.at);
  const unreadCount = recentAlerts.filter(item => !item.read).length;
  const title = view === 'board' ? '决策台' : view === 'locations' ? '机器矩阵' : view === 'chronicle' ? '事件轨迹' : '全部会话';
  async function updateAppearance(next: SignalAppearance): Promise<void> {
    try { setAppearance(next); const saved = await window.monitorApi.setFloatingAppearance(next); setAppearance(saved.appearance); }
    catch (cause) { setError(describeError(cause)); }
  }
  async function updateCompactSize(next: FloatingCompactSize): Promise<void> {
    try { setCompactSize(next); const saved = await window.monitorApi.setFloatingCompactSize(next); setCompactSize(saved.compactSize); }
    catch (cause) { setResidentError(describeError(cause)); }
  }
  async function acknowledgeAlert(id: string): Promise<void> {
    try { const state = await window.monitorApi.acknowledgeAlert(id); setAlerts(state.alerts); }
    catch (cause) { setError(describeError(cause)); }
  }

  async function saveSettings(settings: Settings) {
    const next = await window.monitorApi.setConfig(settings);
    setConfig(next);
    await refresh();
  }
  function selectScope(nextSource: string | null, nextWorkspace: string | null = null) {
    setSourceId(nextSource);
    setWorkspaceId(nextWorkspace);
    setView('board');
    setFilter('all');
  }
  function openSession(session: SessionRecord) {
    setSelectedKey(session.key);
    setDetailOpen(true);
  }
  async function focusOriginalWindow(key: string): Promise<void> {
    setOriginalWindowMessage('正在定位原窗口…');
    try {
      const result = await window.monitorApi.focusOriginalWindow(key);
      if (mounted.current) setOriginalWindowMessage(result.message);
    } catch (error) {
      if (mounted.current) setOriginalWindowMessage('原窗口定位失败：' + describeError(error));
    }
  }
  function toggleSource(id: string) {
    setExpandedSources(ids => ids.includes(id) ? ids.filter(entry => entry !== id) : [...ids, id]);
  }
  async function updateResidentOptions(next: ResidentOptions): Promise<void> {
    if (residentSaving) return;
    setResidentSaving(true);
    setResidentError('');
    try {
      const result = await window.monitorApi.setResidentOptions(next);
      setResidentOptions(result);
    } catch (error) {
      setResidentError(describeError(error));
    } finally {
      setResidentSaving(false);
    }
  }

  return <div className={'monitor-layout signal-app scene-' + appearance}>
    <header className="signal-chrome">
      <div className="signal-brand">
        <div className="signal-brand-symbol"><Icon name="activity" size={21}/></div>
        <div className="signal-brand-copy"><strong>Codex Monitor</strong><small>SIGNAL STUDIO</small></div>
      </div>
      <nav className="signal-nav" aria-label="主视图">
        {([['board', '决策台'], ['locations', '机器矩阵'], ['chronicle', '事件轨迹']] as const)
          .map(([id, label], index) => <button key={id} type="button" aria-current={view === id ? 'page' : undefined}
            className={view === id ? 'active' : ''} onClick={() => setView(id)}>
            <span>{'0' + (index + 1)}</span>{label}</button>)}
      </nav>
      <div className="signal-chrome-right">
        <label className="signal-search"><Icon name="search" size={15}/>
          <input ref={searchInput} aria-label="搜索会话" value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="搜索会话、目录、ID"/><kbd>Ctrl K</kbd></label>
        <button type="button" title="提醒收件箱" className={'signal-icon-button' + (showAlerts ? ' active' : '')}
          onClick={() => { setShowAlerts(value => !value); setShowPalette(false); }}
          aria-label={'提醒收件箱，' + unreadCount + ' 条未读'}>
          <Icon name="bell"/>{unreadCount > 0 && <i className="signal-count-badge">{unreadCount}</i>}</button>
        <button type="button" title="切换视觉氛围" className={'signal-icon-button' + (showPalette ? ' active' : '')}
          onClick={() => { setShowPalette(value => !value); setShowAlerts(false); }}
          aria-label="切换视觉氛围"><Icon name="palette"/></button>
        <button type="button" title="设置" className="signal-icon-button"
          onClick={() => setShowResident(true)} aria-label="常驻设置"><Icon name="settings"/></button>
      </div>
      {showPalette && <div className="signal-popover signal-theme-menu">
        <strong>视觉氛围</strong>
        {([['moonsea', '月海', '深海色 · 冷调玻璃'], ['ember', '岩铜', '暖黑金属 · 铜色高光'],
          ['mist', '凝霜', '浅色陶瓷 · 轻盈留白']] as const).map(([id,label,detail]) =>
          <button type="button" key={id} className={appearance === id ? 'active' : ''}
            onClick={() => { void updateAppearance(id); setShowPalette(false); }}>
            <span className={'signal-scene-swatch swatch-' + id}/><span><b>{label}</b><small>{detail}</small></span>
            {appearance === id && <Icon name="check" size={15}/>}</button>)}
      </div>}
      {showAlerts && <aside className="signal-popover signal-alerts-menu" aria-label="提醒收件箱">
        <div className="signal-popover-heading"><strong>提醒收件箱</strong><span>{unreadCount} 未读</span></div>
        <div className="signal-popover-items">{recentAlerts.slice(0, 12).map(alert =>
          <div key={alert.id} className={'signal-alert-row' + (alert.read ? ' read' : '')}>
            <button type="button" onClick={() => {
              if (!alert.read) void acknowledgeAlert(alert.id);
              const session = allSessions.find(item => item.key === alert.sessionKey);
              if (session) openSession(session);
              setShowAlerts(false);
            }}>
              <span className={'signal-mini-dot ' + (alert.kind === 'waiting' ? 'warning' : '')}/>
              <span><strong>{alert.title}</strong><small>{alert.kind === 'waiting' ? '可能待处理' : '本轮回复已结束'} · {alert.sourceLabel}</small></span>
            </button>
            {!alert.read && <button type="button" className="signal-alert-ack"
              onClick={() => void acknowledgeAlert(alert.id)} title="标记已读"
              aria-label={'标记已读：' + alert.title}><Icon name="check" size={14}/></button>}
          </div>)}
          {!recentAlerts.length && <p className="signal-empty">暂无提醒</p>}
        </div>
        <button type="button" className="signal-popover-foot" onClick={() =>
          void window.monitorApi.setNotificationsMuted(!muted).then(state => setMuted(state.muted))
            .catch(error => setError(describeError(error)))}>
          {muted ? '恢复通知' : '静音通知'}</button>
      </aside>}
    </header>

    <div className="signal-scroll">
      <div className="signal-status-line">
        <span><i className="signal-live-pulse"/> {totals.errors ? totals.errors + ' 个数据源异常' : '监控已连接'}
          <em>·</em> {scan?.sources.filter(source => !source.error).length ?? 0} 个数据源
          <em>·</em> 只读监控</span>
        <span>最近扫描 <b>{scan ? formatTime(scan.scannedAt) : '等待首次扫描'}</b>
          <em>·</em><span>状态以采集证据为准</span></span>
      </div>
      <main className="signal-body">
        <div className="signal-ambient" aria-hidden="true"><svg viewBox="0 0 920 360" preserveAspectRatio="none">
          <path className="signal-ambient-band" d="M10 335 C220 305 205 45 415 111 S670 355 905 30"/>
          <path d="M0 310 C210 275 235 70 420 127 S680 330 920 50"/>
          <path d="M0 288 C210 250 235 95 430 140 S690 308 920 65"/>
          <path d="M0 265 C218 235 250 115 442 149 S702 290 920 85"/>
          <path d="M0 246 C220 223 270 135 462 164 S710 275 920 111"/>
        </svg></div>

        <div className="signal-page-title">
          <div className="signal-eyebrow">WORKSPACE / {view === 'board' ? 'MONITOR' : view === 'locations' ? 'LOCATIONS' : view === 'chronicle' ? 'ACTIVITY' : 'SESSIONS'}</div>
          {view === 'board' ? <><h1>今天的工作，<br/>正在这里发生。</h1>
            <p>让值得注意的事情浮到最前，其余工作安静地继续。</p></> :
            view === 'locations' ? <><h1>每台机器，<br/>都在自己的位置。</h1>
              <p>Windows、WSL 与 SSH，一览各执行环境中的会话。</p></> :
            view === 'chronicle' ? <><h1>看得见变化，<br/>也找得到原因。</h1>
              <p>按时间回看已检测的提醒和会话活动，不把推断当作真实事件。</p></> :
            <><h1>全部会话。</h1><p>按最近活动排序，快速查找并返回原 Codex 窗口。</p></>}
        </div>

        <div className="signal-toolbar" aria-label="筛选与快捷操作">
          <label>状态 <select aria-label="运行状态筛选" value={filter}
            onChange={event => setFilter(event.target.value as SessionStatus | 'all')}>
            <option value="all">全部</option><option value="working">可能执行中</option>
            <option value="waiting">可能待处理</option><option value="finished">本轮完成</option>
            <option value="failed">失败</option><option value="interrupted">中断</option>
            <option value="unknown">未知</option></select></label>
          <label>位置 <select aria-label="执行位置筛选" value={sourceId ?? ''}
            onChange={event => { setSourceId(event.target.value || null); setWorkspaceId(null); }}>
            <option value="">所有位置</option>
            {scan?.sources.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}
          </select></label>
          <label className="signal-check"><input type="checkbox" checked={recentOnly}
            onChange={event => setRecentOnly(event.target.checked)}/>近 7 天</label>
          <label className="signal-check"><input type="checkbox" checked={showSubagents}
            onChange={event => setShowSubagents(event.target.checked)}/>显示子代理</label>
          <span className="signal-toolbar-spacer"/>
          <button type="button" onClick={() => setView('sessions')}
            className={'signal-toolbar-button' + (view === 'sessions' ? ' active' : '')}>全部会话 <span>{totals.all}</span></button>
          <button type="button" className="signal-toolbar-button" disabled={busy}
            onClick={() => void refresh()}><Icon name="refresh" size={14}/>{busy ? '刷新中' : '刷新'}</button>
          <button type="button" className="signal-toolbar-button" onClick={() => setShowSettings(true)}
            disabled={!config}><Icon name="sliders" size={14}/>数据源设置</button>
        </div>
        {error && <div className="error-banner" role="alert">{error}</div>}
        {scan?.sources.filter(source => source.error).map(source =>
          <div className="error-banner" role="alert" key={source.id}><Icon name="alert"/>{source.label}: {source.error}</div>)}
        {workspaceId && <div className="scope-banner">工作目录：{currentWorkspace?.workspace || '未知'}
          <button type="button" onClick={() => setWorkspaceId(null)}>清除 ×</button></div>}

        {view === 'board' && <>
          <div className="signal-key-stats" aria-label="会话统计">
            <span><i className="signal-mini-dot"/> <b>{String(running.length).padStart(2, '0')}</b> 条活动线索</span>
            <span><b>{String(attention.length).padStart(2, '0')}</b> 条需要关注</span>
            <span className="signal-stat-soft">当前 {shown.length} 个会话</span>
          </div>
          <div className="signal-main-grid">
            <section className="signal-focus">
              <div className="signal-section-kicker"><span className="signal-mini-dot warning"/>需要你的关注</div>
              <div className="signal-focus-total"><strong>{String(attention.length).padStart(2, '0')}</strong><span>件待处理</span></div>
              <h2>{attention.length ? '有些任务，<br/>正在等你。' : '当前没有需要<br/>立即处理的任务。'}</h2>
              <p>来自会话的待回答、失败与中断证据；不自动执行确认。</p>
              {attention.length ? <button type="button" className="signal-focus-action"
                onClick={() => openSession(attention[0]!)}>
                <span><strong>{attention[0]?.title || '未命名会话'}</strong>
                  <small>{attention[0]?.sourceLabel} · {ageText(attention[0]!.updatedAt, now)}</small></span>
                <span className="signal-focus-cta">查看任务 <Icon name="arrow-up-right" size={15}/></span>
              </button> : <div className="signal-focus-action signal-no-action">无需立即操作，其他会话继续监控中。</div>}
            </section>
            <section className="signal-panel signal-running" aria-label="可能执行中的会话">
              <div className="signal-panel-heading"><div><h2>可能执行中</h2><small>最新状态与活动证据</small></div>
                <button type="button" onClick={() => {setView('sessions');setFilter('working');}}>查看全部 <Icon name="chevron-right" size={14}/></button></div>
              <div className="signal-task-list">{running.slice(0, 6).map(session =>
                <SignalTaskRow key={session.key} session={session} now={now} onSelect={openSession}/>)}
                {!running.length && <div className="signal-list-empty"><Icon name="activity" size={23}/>
                  <strong>暂无可能执行中的会话</strong><span>等待新的活动证据</span></div>}
              </div>
            </section>
          </div>
          <div className="signal-bottom-grid">
            <section className="signal-panel signal-locations">
              <div className="signal-panel-heading"><h2>执行位置</h2>
                <button type="button" onClick={() => setView('locations')}>查看机器矩阵 <Icon name="chevron-right" size={14}/></button></div>
              <div className="signal-location-tiles">
                {sourceGroups.slice(0, 4).map(group => <button type="button" key={group.sourceId}
                  onClick={() => { setSourceId(group.sourceId); setWorkspaceId(null); setView('locations'); }}>
                  <span className="signal-location-head"><Icon name={group.sourceId.startsWith('ssh:') ? 'server' : 'monitor'} size={17}/>
                    <small>{group.sourceId.startsWith('ssh:') ? 'SSH' : group.sourceId.startsWith('wsl:') ? 'WSL' : 'WIN'}</small></span>
                  <strong title={group.sourceLabel}>{group.sourceLabel}</strong>
                  <small>{group.count} 个会话 · {group.working} 条活动线索</small></button>)}
                {!sourceGroups.length && <span className="signal-empty">等待发现执行位置…</span>}
              </div>
            </section>
            <section className="signal-panel signal-changes">
              <div className="signal-panel-heading"><h2>最近变化</h2><button type="button"
                onClick={() => setView('chronicle')}>查看事件轨迹 <Icon name="chevron-right" size={14}/></button></div>
              <div className="signal-event-list">
                {recentAlerts.length ? recentAlerts.slice(0, 4).map(alert =>
                  <button type="button" key={alert.id} className="signal-event" onClick={() => {
                    const session = allSessions.find(item => item.key === alert.sessionKey);
                    if (session) openSession(session);
                  }}>
                    <span className={'signal-mini-dot' + (alert.kind === 'waiting' ? ' warning' : '')}/>
                    <span><strong>{alert.kind === 'waiting' ? '会话可能需要处理' : '本轮回复已结束'}</strong>
                      <small>{alert.title}</small></span><time>{formatTime(alert.at)}</time></button>) :
                  shown.slice(0, 4).map(session => <button type="button" key={session.key}
                    className="signal-event" onClick={() => openSession(session)}>
                    <span className="signal-mini-dot"/><span><strong>{session.title || '未命名会话'}</strong>
                      <small>最近记录活动 · {sessionEvidenceLabel(session)}</small></span>
                    <time>{ageText(session.updatedAt, now)}</time></button>)}
                {!recentAlerts.length && !shown.length && <p className="signal-empty">暂无会话活动记录</p>}
              </div>
            </section>
          </div>
        </>}

        {view === 'locations' && <div className="signal-matrix">
          {groups.map(group => <section className="signal-panel signal-machine" key={group.sourceId}>
            <div className="signal-machine-head">
              <span className="signal-machine-symbol"><Icon name={group.sourceId.startsWith('ssh:') ? 'server' : 'monitor'} size={21}/></span>
              <span><small>{group.sourceId.startsWith('ssh:') ? 'SSH / REMOTE' : group.sourceId.startsWith('wsl:') ? 'WSL / LINUX' : 'WINDOWS / LOCAL'}</small>
                <h2>{group.sourceLabel}</h2></span>
              <span className="signal-machine-count">{group.count} 会话</span>
            </div>
            <div className="signal-machine-figures"><span><b>{String(group.working).padStart(2,'0')}</b><small>活动线索</small></span>
              <span><b>{group.workspaces.length}</b><small>工作目录</small></span></div>
            <div className="signal-machine-sessions">{group.workspaces.flatMap(workspace => workspace.sessions).slice(0, 6)
              .map(session => <SignalTaskRow key={session.key} session={session} now={now} onSelect={openSession}/>)}
              {!group.count && <p className="signal-empty">当前没有会话</p>}
            </div>
            <button type="button" className="signal-machine-foot" onClick={() => {
              setSourceId(group.sourceId);setWorkspaceId(null);setView('sessions'); }}>
              查看该机器的所有会话 <Icon name="arrow-up-right" size={15}/></button>
          </section>)}
          {!groups.length && <p className="signal-empty">没有符合当前筛选条件的执行位置</p>}
        </div>}

        {view === 'chronicle' && <div className="signal-chronicle">
          <section className="signal-panel signal-chronicle-main">
            <div className="signal-panel-heading"><div><h2>通知与近期活动</h2>
              <small>通知来自真实结束、待处理证据；最近活动来自会话元数据</small></div></div>
            <div className="signal-timeline">
              {recentAlerts.slice(0, 30).map(alert => <div className="signal-timeline-entry" key={alert.id}>
                <span className={'signal-timeline-pin' + (alert.kind === 'waiting' ? ' warning' : '')}/>
                <time>{formatTime(alert.at)}</time>
                <div><strong>{alert.kind === 'waiting' ? '可能需要用户处理' : '本轮回复已结束'}</strong>
                  <p>{alert.title}</p><small>{alert.sourceLabel}</small></div>
                <div className="signal-timeline-actions">
                  <button type="button" onClick={() => {
                    const session = allSessions.find(item => item.key === alert.sessionKey);
                    if (session) openSession(session);
                  }}>会话详情</button>
                  {!alert.read && <button type="button" onClick={() => void acknowledgeAlert(alert.id)}>标记已读</button>}
                </div></div>)}
              {!recentAlerts.length && <p className="signal-list-empty">还没有真实通知事件。下面仅展示最近会话元数据变化。</p>}
              {shown.slice(0, 24).map(session => <div className="signal-timeline-entry" key={'activity:' + session.key}>
                <span className="signal-timeline-pin muted"/><time>{formatTime(session.updatedAt)}</time>
                <div><strong>最近会话活动 · {STATUS[session.status].text}</strong>
                  <p>{session.title || '未命名会话'}</p><small>{session.sourceLabel} · {sessionEvidenceLabel(session)}</small></div>
                <div className="signal-timeline-actions"><button type="button" onClick={() => openSession(session)}>查看详情</button></div>
              </div>)}
            </div>
          </section>
          <aside className="signal-panel signal-chronicle-side">
            <h2>状态分布</h2><p>当前会话快照，而非进程实时数量。</p>
            {(['working','waiting','finished','interrupted','failed','unknown'] as const).map(status => {
              const count = shown.filter(item => item.status === status).length;
              return <button type="button" className="signal-status-distribution" key={status}
                onClick={() => {setFilter(status);setView('sessions');}}>
                <span className={'signal-mini-dot ' + status}/><span>{STATUS[status].text}</span><strong>{count}</strong>
              </button>;
            })}
          </aside>
        </div>}

        {view === 'sessions' && <section className="records-panel signal-records">
          <div className="panel-heading"><strong>全部会话</strong><span>按最近活动排序 · {shown.length} 条</span></div>
          <SessionTable sessions={shown} now={now} selectedKey={selectedKey} onSelect={openSession}/>
        </section>}

        <footer className="signal-footer">
          <span>Codex Monitor · 只读会话观察器 · {shown.length} / {totals.all} 条</span>
          <span>{performanceStats?.desktopAudit
            ? '采集 ' + (performanceStats.sourceScanDurationMs ?? '—') + 'ms · Desktop审计 ' + performanceStats.desktopAudit.durationMs + 'ms'
            : '事件优先 · 兜底扫描 · 状态为保守推断'}</span>
        </footer>
      </main>
    </div>

    {detailOpen && <button type="button" aria-label="关闭会话详情" className="detail-veil"
      onClick={() => setDetailOpen(false)}/>}
    <aside className={'detail-panel' + (detailOpen ? ' detail-open' : '')} aria-label="会话详情">
      <div className="detail-header"><span>当前选中 / SESSION</span><button type="button"
        className="detail-close" title="关闭详情" aria-label="关闭详情"
        onClick={() => setDetailOpen(false)}><Icon name="close" size={16}/></button></div>
      {selected ? <>
        <div className="detail-content">
          <h2>{selected.title || '未命名会话'}</h2>
          <div className="detail-status"><StatusPill status={selected.status}/>
            <span className="source-tag">{selected.sourceLabel}</span>
            {selected.isSubagent && <span className="source-tag child-detail" title={selected.parentThreadId || '子代理会话'}>子代理</span>}
            {selected.pendingQuestionToken && <span className="source-tag pending-question">待回答</span>}</div>
          <div className="detail-original-window" aria-label="返回原窗口">
            <button type="button" className="primary-button" onClick={() => void focusOriginalWindow(selected.key)}>
              <Icon name="monitor" size={15}/> 返回原窗口
            </button>
            <span>{originalWindowMessage ?? originalWindow?.message ??
              '根据用户输入时的前台窗口自动识别；不会新开 Codex 会话'}</span>
          </div>
          {selected.pendingQuestionToken && <div className="detail-pending-question">
            <strong>Codex 正在请求用户输入</strong>
            <span>{selected.questionText || '打开原 Codex 会话查看请求详情。'}</span>
            <small>Monitor 只提醒，不代替用户执行确认。</small>
          </div>}
          <section className="reply-preview" aria-label="最近回复">
            <div className="reply-preview-top">
              <strong>最近回复</strong>
              <button type="button" className="reply-reload" disabled={!detailOpen || recentReply?.loading}
                onClick={() => setReplyVersion(value => value + 1)}
                title="重新读取当前会话的最新回复">↻ 刷新</button>
            </div>
            {recentReply?.key === selected.key && recentReply.value?.text
              ? <>
                <div className="reply-preview-text">{recentReply.value.text}</div>
                <div className="reply-preview-meta">
                  <span>{recentReply.value.phase === 'final_answer' ? '最终回复' :
                    recentReply.value.phase === 'commentary' ? '过程回复' :
                    recentReply.value.phase === 'partial_answer' ? '部分回复' : '助手回复'}
                    {recentReply.value.truncated ? ' · 末尾节选' : ''}</span>
                  {recentReply.value.timestamp && !Number.isNaN(Date.parse(recentReply.value.timestamp)) &&
                    <span>{formatTime(Date.parse(recentReply.value.timestamp))}</span>}
                </div>
              </>
              : <p className="reply-preview-empty">
                {!detailOpen ? '点击一个会话即可读取最近的助手回复。' :
                  recentReply?.key !== selected.key || recentReply.loading ? '正在读取最新回复…' :
                  recentReply.error ? '读取失败：' + recentReply.error :
                  '当前读取范围内没有已保存的助手回复。'}
              </p>}
            <span className="reply-preview-note">仅按需读取已写入日志的回复，不包含推理过程或工具输出。</span>
          </section>
          <div className="detail-divider"/>
          <div className="detail-field"><span>工作空间</span>
            <div className="detail-path mono">{selected.workspace || '未记录工作目录'}</div>
            <button className="copy-workspace" type="button" disabled={!selected.workspace}
              onClick={() => { if (selected.workspace) void window.monitorApi.copyWorkspace(selected.workspace); }}>
              <Icon name="copy" size={15}/>复制工作目录</button>
          </div>
          <div className="detail-field"><span>会话 ID</span><div className="detail-value mono">{selected.id}</div></div>
          <div className="detail-field"><span>最后活动</span><div className="detail-value">{formatTime(selected.updatedAt)}
            <span className="detail-muted"> · {ageText(selected.updatedAt, now)}</span></div></div>
          <div className="detail-divider"/>
          <div className="detail-field"><span>证据可信程度</span>
            <div className="detail-value">{sessionEvidenceLabel(selected)}</div></div>
          <div className="detail-field"><span>状态判断依据</span>
            <div className="detail-reason">{selected.statusReason || '当前没有可靠的状态信息'}</div></div>
          <p className="detail-note">仅展示 Codex 已持久化的元数据。状态可能滞后，不代表实时进程状态。</p>
        </div>
      </> : <div className="detail-placeholder">
        <Icon name="folder" size={24}/><strong>选择一个会话</strong><span>在任务卡片或列表中选择会话以查看详细信息。</span>
      </div>}
    </aside>

    {showSettings && config && <SettingsPanel config={config} onClose={() => setShowSettings(false)} onSave={saveSettings}/>}
    {showResident && <div className="modal-backdrop" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) setShowResident(false);
    }}>
      <section className="modal resident-modal" role="dialog" aria-modal="true" aria-label="常驻设置">
        <header className="modal-top">
          <div><h2>常驻与启动</h2>
            <p>设置 Windows 托盘行为和可选开机启动，不影响 Codex 会话。</p>
          </div>
          <button type="button" className="icon-button" aria-label="关闭常驻设置" onClick={() => setShowResident(false)}>×</button>
        </header>
        <div className="resident-fields">
          <label className="resident-toggle">
            <input type="checkbox" disabled={!residentOptions || residentSaving}
              checked={residentOptions?.keepRunningOnClose ?? true}
              onChange={event => { if (residentOptions) void updateResidentOptions({
                ...residentOptions, keepRunningOnClose: event.target.checked,
              }); }}/>
            <span><strong>关闭主窗口后继续后台监控</strong>
              <small>默认开启。关闭主窗口释放界面资源，托盘仍接收完成提醒；托盘可完全退出。</small>
            </span>
          </label>
          <label className="resident-toggle">
            <input type="checkbox" disabled={!residentOptions?.startupSupported || residentSaving}
              checked={residentOptions?.launchAtLogin ?? false}
              onChange={event => { if (residentOptions) void updateResidentOptions({
                ...residentOptions, launchAtLogin: event.target.checked,
              }); }}/>
            <span><strong>开机自动启动（可选）</strong>
              <small>{residentOptions?.startupSupported
                ? '仅在 Windows 登录后以后台模式启动，不自动打开主窗口。'
                : '仅在正式打包的 Windows 版本中可设置；开发模式不会修改系统开机项。'}</small>
            </span>
          </label>
          <section className="resident-opacity" aria-label="悬浮窗透明度设置">
            <div className="resident-opacity-head"><strong>悬浮窗透明度</strong>
              <output htmlFor="floating-opacity-range">{Math.round(floatingOpacity * 100)}% 不透明度</output>
            </div>
            <input id="floating-opacity-range" type="range" min="40" max="100" step="5"
              aria-label="悬浮窗不透明度" value={Math.round(floatingOpacity * 100)}
              onChange={event => {
                const next = Number(event.currentTarget.value) / 100;
                setFloatingOpacity(next);
                void window.monitorApi.setFloatingOpacity(next).catch(error => {
                  setResidentError(describeError(error));
                  void window.monitorApi.getFloatingState().then(current =>
                    setFloatingOpacity(current.opacity)).catch(console.error);
                });
              }}/>
            <div className="resident-opacity-scale"><span>40% · 更透明</span><span>100% · 不透明</span></div>
            <p>实时调节悬浮窗整体透明程度；收起和展开时共用设置，重启后自动恢复。</p>
          </section>
          <div className="resident-position">
            <div><strong>停靠位置自动记忆</strong>
              <small>当前：{floatingSide === 'left' ? '屏幕左侧' : '屏幕右侧'}。拖动悬浮窗顶部 C 标识可以更换位置；重启后恢复上次的屏幕、边缘和高度。</small>
            </div>
            <button type="button" className="secondary-button" onClick={() => {
              void window.monitorApi.resetFloatingPosition().then(state => {
                setFloatingSide(state.side);
                setFloatingOpacity(state.opacity);
              }).catch(error => setResidentError(describeError(error)));
            }}>重置到主屏幕右侧</button>
          </div>
          <p className="resident-help">Windows 本地文件读取使用缓存；事件监听正常时，远程机器会降低兜底轮询频率。</p>
          {residentError && <p className="error-note" role="alert">{residentError}</p>}
        </div>
        <footer className="modal-actions">
          <button type="button" className="primary-button" onClick={() => setShowResident(false)}>完成</button>
        </footer>
      </section>
    </div>}
  </div>;
}
