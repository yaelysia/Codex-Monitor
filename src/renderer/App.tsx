
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ConfigResponse, ScanResponse, SessionRecord, SessionStatus, Settings, RecentReplyExcerpt, ResidentOptions, OriginalWindowStatus } from '../shared/types';
import { groupByExecutionLocation, workspaceGroupKey, type WorkspaceGroup } from '../shared/grouping';
import { filterSessions, makeStatusLanes, type ViewFilter } from '../shared/monitor-view';

type View = 'board' | 'sessions' | 'locations';

type StoredViewPreferences = { view: View; recentOnly: boolean; filter: SessionStatus | 'all' };
const VIEW_PREFERENCES_KEY = 'codex-monitor-view-v1';
function readViewPreferences(): StoredViewPreferences {
  const fallback: StoredViewPreferences = { view: 'board', recentOnly: true, filter: 'all' };
  try {
    if (typeof localStorage === 'undefined') return fallback;
    const row = JSON.parse(localStorage.getItem(VIEW_PREFERENCES_KEY) || 'null');
    if (!row || typeof row !== 'object') return fallback;
    const validView = row.view === 'board' || row.view === 'sessions' || row.view === 'locations';
    const validFilter = ['all', 'working', 'waiting', 'finished', 'interrupted', 'failed', 'unknown'].includes(row.filter);
    return { view: validView ? row.view : 'board',
      recentOnly: typeof row.recentOnly === 'boolean' ? row.recentOnly : true,
      filter: validFilter ? row.filter : 'all' };
  } catch { return fallback; }
}


type GlyphName = 'grid' | 'list' | 'folder' | 'monitor' | 'server' | 'search' | 'refresh' | 'settings' |
  'copy' | 'clock' | 'check' | 'alert' | 'close' | 'chevron-right' | 'chevron-down' | 'chevron-left' | 'activity' | 'sliders';

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
      <Icon name="chevron-right" size={15}/>
    </div>
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
        <td><StatusPill status={item.status}/></td>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionStatus | 'all'>(() => readViewPreferences().filter);
  const [recentOnly, setRecentOnly] = useState(() => readViewPreferences().recentOnly);
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
    }).catch(console.error);
    void window.monitorApi.getMonitorState().then(state => {
      if (!mounted.current) return;
      setEventChannels(state.eventChannels || {});
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
    try { localStorage.setItem(VIEW_PREFERENCES_KEY, JSON.stringify({ view, filter, recentOnly })); }
    catch { /* storage permission or quota: viewing and monitoring still work */ }
  }, [view, filter, recentOnly]);

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

  const allSessions = useMemo(() => (scan?.sources.flatMap(source => source.sessions) ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt), [scan]);
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
  const title = view === 'board' ? '任务状态' : view === 'sessions' ? '全部会话' : '执行位置';

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

  return <div className="monitor-layout">
    <aside className="sidebar" aria-label="主导航和执行位置">
      <div className="brand">
        <div className="brand-mark">C<span>·</span></div>
        <div><strong>Codex Monitor</strong><span>AGENT WORKSPACE</span></div>
      </div>

      <nav className="primary-nav" aria-label="页面">
        <span className="nav-caption">工作台</span>
        {([
          ['board', '任务状态', 'grid'],
          ['sessions', '全部会话', 'list'],
          ['locations', '执行位置', 'folder'],
        ] as const).map(([id, label, icon]) => <button key={id} type="button"
          className={'nav-item' + (view === id ? ' active' : '')} onClick={() => setView(id)}
          aria-current={view === id ? 'page' : undefined}>
          <Icon name={icon}/><span>{label}</span>
          {id === 'sessions' && <span className="nav-count">{totals.all}</span>}
        </button>)}
        <button type="button" className="nav-item settings-entry" onClick={() => setShowSettings(true)}
          disabled={!config}><Icon name="settings"/><span>数据源设置</span></button>
      </nav>

      <div className="source-tree" aria-label="数据源及工作目录">
        <div className="source-heading"><span>执行位置</span>
          <button type="button" className="icon-btn" title="清除位置筛选" aria-label="清除位置筛选"
            onClick={() => selectScope(null)}><Icon name="refresh" size={14}/></button>
        </div>
        <button type="button" className={'tree-all' + (!sourceId ? ' active' : '')}
          onClick={() => selectScope(null)}><Icon name="grid" size={15}/><span>所有位置</span>
          <span className="tree-count">{totals.all}</span></button>
        {scan?.sources.map(source => {
          const group = sourceGroups.find(item => item.sourceId === source.id);
          const folders = group?.workspaces ?? [];
          const watchMode = eventChannels[source.id] || 'fallback';
          const watchText = watchMode === 'active' ? '文件事件监听中' :
            watchMode === 'connecting' ? '正在连接事件通道' : '轮询兜底';
          const expanded = expandedSources.includes(source.id);
          const visible = expanded ? folders : folders.slice(0, MAX_SIDEBAR_FOLDERS);
          return <div className="source-node" key={source.id}>
            <button type="button" className={'tree-source' + (sourceId === source.id && !workspaceId ? ' active' : '')}
              onClick={() => selectScope(source.id)} title={source.label + ' · ' +
                (source.error ? source.error + ' · ' : '') + watchText}>
              <Icon name={source.kind === 'ssh' ? 'server' : 'monitor'} size={15}/>
              <span className="tree-label">{source.label}</span>
              <span className={'watch-indicator ' + watchMode} aria-label={watchText} title={watchText}/>
              <span className={'source-light ' + (source.error ? 'error' : 'ok')}/>
              <span className="tree-count">{source.sessions.length}</span>
            </button>
            {visible.map(folder => <button type="button" key={folder.key}
              title={folder.workspace || '未记录工作目录'}
              className={'tree-folder' + (workspaceId === folder.key ? ' active' : '')}
              onClick={() => selectScope(source.id, folder.key)}>
              <Icon name="folder" size={14}/><span className="tree-label">{workspaceName(folder.workspace)}</span>
              {folder.working > 0 && <span className="small-activity" title={folder.working + ' 个可能执行中的会话'}/>}
              <span className="tree-count">{folder.sessions.length}</span>
            </button>)}
            {folders.length > MAX_SIDEBAR_FOLDERS && <button type="button" className="tree-more"
              onClick={() => toggleSource(source.id)}>
              {expanded ? '收起目录' : '更多 ' + (folders.length - MAX_SIDEBAR_FOLDERS) + ' 个目录'}
              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13}/>
            </button>}
          </div>;
        })}
        {!scan && <div className="source-placeholder">正在发现 Windows、WSL 与 SSH…</div>}
      </div>
      <div className="sidebar-footer">
        <span className="footer-state"><span className="live-dot"/>只读 · 本地运行</span>
        <span>{scan ? formatTime(scan.scannedAt) : '尚未扫描'}</span>
      </div>
    </aside>

    <main className="main-content">
      <header className="topbar">
        <div className="breadcrumbs">
          <button type="button" onClick={() => selectScope(null)}>所有位置</button>
          {scopeSource && <><Icon name="chevron-right" size={12}/>
            <button type="button" onClick={() => selectScope(scopeSource.id)}>{scopeSource.label}</button></>}
          {currentWorkspace && <><Icon name="chevron-right" size={12}/>
            <span title={currentWorkspace.workspace || ''}>{workspaceName(currentWorkspace.workspace)}</span></>}
        </div>
        <div className="header-actions">
          <button type="button" className="header-button" onClick={() => setShowResident(true)}>
            <Icon name="settings" size={15}/>常驻设置
          </button>
          <span className="read-only-mark"><span className="live-dot"/>只读模式</span>
          <button type="button" className="header-button float-entry"
            aria-pressed={floatingVisible}
            onClick={() => void window.monitorApi.setFloatingVisible(!floatingVisible)
              .then(state => setFloatingVisible(state.visible)).catch(console.error)}>
            <Icon name="monitor" size={15}/>{floatingVisible ? '隐藏悬浮窗' : '显示悬浮窗'}
          </button>
          <button type="button" className="header-button" disabled={busy} onClick={() => void refresh()}>
            <Icon name="refresh" size={15}/>{busy ? '扫描中…' : '刷新'}
          </button>
        </div>
      </header>

      <div className="main-scroll">
        <div className="page-heading">
          <div><span className="eyebrow">WORKSPACE / MONITOR</span>
            <h1>{title}</h1>
            <p>{view === 'board' ? '优先查看正在发生的工作；状态来自日志，可能并非实时进程状态。'
              : view === 'sessions' ? '查看全部会话标题、执行位置、工作目录与状态。'
              : '按实际执行机器和完整工作目录浏览会话。'}</p>
          </div>
          <div className="scan-meta"><span className={'scan-indicator' + (busy ? ' scanning' : '')}/>
            {scan ? '最后扫描 ' + formatTime(scan.scannedAt) : '等待首次扫描'}</div>
        </div>

        <section className="metrics" aria-label="会话统计">
          <div><strong>{totals.all}</strong><span>会话总数</span></div>
          <div><strong className="positive">{totals.working}</strong><span>可能执行中</span></div>
          <div><strong className="warm">{totals.waiting}</strong><span>可能待处理</span></div>
          <div><strong>{scan?.sources.filter(source => !source.error).length ?? 0}</strong><span>有效数据源</span></div>
        </section>

        <div className="filterbar">
          <div className="filter-tabs" role="group" aria-label="运行状态筛选">
            {([['all', '全部'], ['working', '可能执行中'], ['waiting', '待处理'], ['finished', '本轮完成'], ['interrupted', '中断'], ['failed', '失败'], ['unknown', '未知']] as const)
              .map(([id, label]) => <button type="button" key={id} className={filter === id ? 'active' : ''}
                aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}
          </div>
          <div className="filter-tools">
            <label className="recent-checkbox"><input type="checkbox" checked={recentOnly}
              onChange={event => setRecentOnly(event.target.checked)}/>近 7 天</label>
            <label className="search-box"><Icon name="search" size={15}/><input ref={searchInput}
              aria-label="搜索会话" placeholder="搜索标题 / 工作目录 / ID" value={query}
              onChange={event => setQuery(event.target.value)}/><kbd>Ctrl K</kbd></label>
          </div>
        </div>

        {error && <div className="error-banner" role="alert">{error}</div>}
        {scan?.sources.filter(source => !!source.error).map(source => <div className="error-banner" role="alert"
          key={source.id}><Icon name="alert" size={16}/><strong>{source.label}</strong>{source.error}</div>)}
        {(sourceId || workspaceId) && <div className="scope-banner">
          <Icon name="folder" size={15}/><span>当前位置筛选：
            {scopeSource?.label || '全部'}{currentWorkspace ? ' / ' + (currentWorkspace.workspace || '未记录工作目录') : ''}</span>
          <button type="button" onClick={() => selectScope(null)}>清除筛选 ×</button>
        </div>}

        {view === 'board' && <div className="board">
          {lanes.map(lane => <section className={'board-lane lane-' + lane.id} key={lane.id}
            aria-label={lane.label}>
            <div className="lane-heading"><div><span className="lane-mark"/>
              <strong>{lane.label}</strong></div><span className="lane-count">{lane.sessions.length}</span></div>
            <div className="lane-subtitle">{lane.description}</div>
            <div className="lane-body">{lane.sessions.slice(0, laneLimit[lane.id] ?? BATCH_SIZE).map(session =>
              <SessionCard key={session.key} session={session} now={now}
                selected={selectedKey === session.key} onSelect={openSession}/>)}
              {!lane.sessions.length && <div className="lane-empty">
                <Icon name={lane.id === 'working' ? 'activity' : lane.id === 'finished' ? 'check' : 'clock'} size={22}/>
                <span>{lane.emptyLabel}</span></div>}
            </div>
            {lane.sessions.length > (laneLimit[lane.id] ?? BATCH_SIZE) && <button type="button" className="more-cards"
              onClick={() => setLaneLimit(values => ({
                ...values, [lane.id]: (values[lane.id] ?? BATCH_SIZE) + BATCH_SIZE,
              }))}>再显示 {Math.min(BATCH_SIZE, lane.sessions.length - (laneLimit[lane.id] ?? BATCH_SIZE))} 个
              <Icon name="chevron-down" size={14}/></button>}
          </section>)}
        </div>}

        {view === 'sessions' && <section className="records-panel">
          <div className="panel-heading"><strong>全部会话</strong><span>按最近活动排序 · {shown.length} 条</span></div>
          <SessionTable sessions={shown} now={now} selectedKey={selectedKey} onSelect={openSession}/>
        </section>}

        {view === 'locations' && <div className="location-list">
          {groups.map(group => <section key={group.sourceId} className="location-section">
            <div className="location-heading"><div><Icon name={group.sourceId.startsWith('ssh:') ? 'server' : 'monitor'} size={18}/>
              <div><strong>{group.sourceLabel}</strong>
                <span>{group.workspaces.length} 个工作目录 · {group.count} 个会话</span></div></div>
              {group.working > 0 && <span className="group-working">{group.working} 可能执行中</span>}</div>
            <div className="location-workspaces">{group.workspaces.map(workspace =>
              <WorkspaceSection key={workspace.key} group={workspace} now={now}
                selectedKey={selectedKey} onSelect={openSession}/>)}</div>
          </section>)}
          {!groups.length && <EmptyState text="没有符合条件的执行位置"/>}
        </div>}

        <footer className="content-footer"><span>当前显示 {shown.length} / {totals.all} 条 · 每个来源最多采集 200 条</span>
          <span>每 12 秒自动刷新 · 状态为保守推断</span></footer>
      </div>
    </main>

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
