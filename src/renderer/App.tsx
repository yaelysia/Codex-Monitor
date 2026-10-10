import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { ConfigResponse, ScanResponse, SessionRecord, SessionStatus, Settings } from '../shared/types';
import { groupByExecutionLocation, type WorkspaceGroup } from '../shared/grouping';

const STATUS: Record<SessionStatus, { text: string; className: string }> = {
  working: { text: '可能执行中', className: 'working' },
  waiting: { text: '可能待处理', className: 'waiting' },
  finished: { text: '本轮已完成', className: 'finished' },
  unknown: { text: '状态未知', className: 'unknown' },
};
const EMPTY: Settings = { localRoot: '', wslRoots: {}, remotes: [] };
const REFRESH_MS = 12_000;
const LAST_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function ageText(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
}
function workspaceName(path: string | null): string {
  if (!path) return '未记录工作目录';
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }


function SessionRow({ item, now, grouped = false }: { item: SessionRecord; now: number; grouped?: boolean }) {
  return <tr>
    <td>
      <div className="session-title" title={item.title || '未命名会话'}>{item.title || '未命名会话'}</div>
      {!grouped && <div className="workspace-path" title={item.workspace || '会话未记录 cwd'}>
        <span>{item.workspace || '未记录工作目录'}</span>
        {item.workspace && <button className="copy-button" title="复制工作目录" onClick={() => void window.monitorApi.copyWorkspace(item.workspace!)}>复制</button>}
      </div>}
      <div className="session-id">{item.id}</div>
    </td>
    {!grouped && <td><span className="source-name">{item.sourceLabel}</span></td>}
    <td><span className={`status ${STATUS[item.status].className}`} title={item.statusReason}>
      <span className="status-dot"/>{STATUS[item.status].text}</span></td>
    <td><span className="activity" title={formatTime(item.updatedAt)}>{ageText(item.updatedAt, now)}</span>
      <span className="timestamp">{formatTime(item.updatedAt)}</span></td>
  </tr>;
}

function WorkspaceSection({ group, now }: { group: WorkspaceGroup; now: number }) {
  const [expanded, setExpanded] = useState(group.working > 0 || group.waiting > 0);
  useEffect(() => { if (group.working > 0 || group.waiting > 0) setExpanded(true); }, [group.working, group.waiting]);
  return <section className="workspace-group">
    <button type="button" className="workspace-group-head" aria-expanded={expanded}
      onClick={() => setExpanded(value => !value)}>
      <span className="workspace-ident">
        <span className="workspace-name">{workspaceName(group.workspace)}</span>
        <span className="workspace-group-path" title={group.workspace || ''}>{group.workspace || '未记录工作目录'}</span>
      </span>
      <span className="workspace-group-info">{group.sessions.length} 个会话
        {group.working > 0 && <span className="group-active"> · {group.working} 可能执行中</span>}
        {group.waiting > 0 && <span className="group-waiting"> · {group.waiting} 待处理</span>}
      </span>
      <span className="expand-mark" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
    </button>
    {expanded && <div className="workspace-group-body">
      <table className="grouped-table">
        <thead><tr><th>会话标题</th><th>状态</th><th>最后活动</th></tr></thead>
        <tbody>{group.sessions.map(session => <SessionRow key={session.key} item={session} now={now} grouped />)}</tbody>
      </table>
    </div>}
  </section>;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SessionStatus | 'all'>('all');
  const [view, setView] = useState<'list' | 'locations'>('list');
  const [recentOnly, setRecentOnly] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await window.monitorApi.refresh();
      if (mounted.current) { setScan(response); setError(''); setNow(Date.now()); }
    } catch (err) { if (mounted.current) setError(describeError(err)); }
    finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    window.monitorApi.getConfig().then(setConfig).catch(err => setError(describeError(err)));
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const clock = setInterval(() => setNow(Date.now()), 5_000);
    return () => { mounted.current = false; clearInterval(timer); clearInterval(clock); };
  }, [refresh]);

  const allSessions = useMemo(() => (scan?.sources.flatMap(source => source.sessions) ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt), [scan]);
  const shown = useMemo(() => allSessions.filter(session => {
    if (filter !== 'all' && session.status !== filter) return false;
    if (recentOnly && now - session.updatedAt > LAST_WEEK_MS) return false;
    const term = query.trim().toLowerCase();
    return !term || `${session.id} ${session.title || ''} ${session.workspace || ''} ${session.sourceLabel}`.toLowerCase().includes(term);
  }), [allSessions, query, filter, recentOnly, now]);
  const grouped = useMemo(() => groupByExecutionLocation(shown), [shown]);
  const counts = useMemo(() => ({
    total: allSessions.length,
    working: allSessions.filter(s => s.status === 'working').length,
    waiting: allSessions.filter(s => s.status === 'waiting').length,
    errors: scan?.sources.filter(s => !!s.error).length ?? 0,
  }), [allSessions, scan]);

  async function saveSettings(settings: Settings) {
    const next = await window.monitorApi.setConfig(settings);
    setConfig(next);
    // Do not restart a running refresh; the next cycle will use updated settings.
    await refresh();
  }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><div className="brand-mark">C<span>·</span></div><div>
        <h1>Codex Monitor</h1><p>跨环境会话监视器</p>
      </div></div>
      <div className="header-actions">
        <span className="read-only"><span className="read-only-dot"/>只读模式</span>
        <button className="secondary-button" onClick={() => setShowSettings(true)} disabled={!config}>数据源设置</button>
        <button className="primary-button" onClick={() => void refresh()} disabled={busy}>{busy ? '扫描中…' : '↻ 刷新'}</button>
      </div>
    </header>

    <main>
      <nav className="view-tabs" aria-label="会话视图">
        <button type="button" aria-current={view === 'list' ? 'page' : undefined}
          className={view === 'list' ? 'view-tab selected' : 'view-tab'} onClick={() => setView('list')}>全部会话</button>
        <button type="button" aria-current={view === 'locations' ? 'page' : undefined}
          className={view === 'locations' ? 'view-tab selected' : 'view-tab'} onClick={() => setView('locations')}>按执行位置分组</button>
      </nav>
      <section className="intro"><div><h2>{view === 'list' ? '会话总览' : '执行位置'}</h2>
        <p>{view === 'list' ? '所有环境的 Codex 会话、标题、工作目录与当前可推断状态。' : '先按执行机器，再按完整工作目录分组；相同项目名不会跨机器合并。'}</p></div>
        <span className="scan-time">{scan ? `最后扫描 ${formatTime(scan.scannedAt)}` : '尚未完成扫描'}</span>
      </section>

      <section className="summary" aria-label="统计">
        <div className="stat"><span>会话总数</span><strong>{counts.total}</strong></div>
        <div className="stat"><span className="stat-dot working"/> <span>可能执行中</span><strong>{counts.working}</strong></div>
        <div className="stat"><span className="stat-dot waiting"/> <span>可能待处理</span><strong>{counts.waiting}</strong></div>
        <div className="stat"><span>数据源异常</span><strong>{counts.errors}</strong></div>
      </section>

      <section className="source-bar" aria-label="采集来源">
        <span className="source-title">数据源</span>
        {scan?.sources.map(source => <span key={source.id} className={`source-pill ${source.error ? 'source-error' : ''}`}
          title={source.error || `${source.sessions.length} 个会话`}>
          <span className="source-indicator"/>{source.label} <small>{source.error ? '连接失败' : source.sessions.length}</small>
        </span>)}
        {!scan && <span className="muted">正在发现数据源…</span>}
      </section>

      {error && <div role="alert" className="alert">{error}</div>}
      {scan?.sources.filter(s => s.error).map(s => <div role="alert" className="alert" key={s.id}>
        <strong>{s.label}：</strong>{s.error}
      </div>)}

      <section className="data-panel">
        <div className="toolbar">
          <div className="filter-set" role="group" aria-label="运行状态筛选">
            {([['all', '全部'], ['working', '可能执行中'], ['waiting', '待处理'], ['finished', '本轮完成'], ['unknown', '未知']] as const).map(([id, label]) =>
              <button key={id} type="button" className={filter === id ? 'selected' : ''} onClick={() => setFilter(id)}>{label}</button>)}
          </div>
          <div className="toolbar-right">
            <label className="check-field"><input type="checkbox" checked={recentOnly} onChange={e => setRecentOnly(e.target.checked)}/>近 7 天</label>
            <input className="search" aria-label="搜索会话" value={query} placeholder="搜索路径 / 机器 / ID" onChange={e => setQuery(e.target.value)}/>
          </div>
        </div>
        {view === 'list' ? <div className="table-scroll">
          <table><thead><tr><th>会话标题 / 工作目录</th><th>来源</th><th>状态</th><th>最后活动</th></tr></thead>
            <tbody>{shown.map(item => <SessionRow key={item.key} item={item} now={now} />)}</tbody>
          </table>
          {shown.length === 0 && <div className="empty-state"><h3>{busy && !scan ? '扫描进行中…' : '没有匹配的会话'}</h3>
            <p>{scan ? '可调整筛选条件，或在数据源设置中检查 CODEX_HOME / SSH 配置。' : '首次扫描需要读取本地、WSL 和远程服务器的会话索引。'}</p>
          </div>}
        </div> : <div className="location-scroll">
          {grouped.map(location => <section key={location.sourceId} className="location-group">
            <header className="location-heading">
              <div><h3>{location.sourceLabel}</h3><span>{location.workspaces.length} 个工作目录 · {location.count} 个会话</span></div>
              {location.working > 0 && <span className="group-active">{location.working} 可能执行中</span>}
            </header>
            <div className="location-workspaces">
              {location.workspaces.map(workspace => <WorkspaceSection key={workspace.key} group={workspace} now={now} />)}
            </div>
          </section>)}
          {grouped.length === 0 && <div className="empty-state"><h3>没有匹配的会话</h3><p>可调整状态、最近 7 天或搜索筛选条件。</p></div>}
        </div>}
        <div className="panel-footer"><span>显示 {shown.length} / {allSessions.length} 个会话 · 每个来源最多读取最近 200 条</span>
          <span>每 12 秒刷新 · 状态依据日志事件推断</span></div>
      </section>
      <p className="disclaimer">说明：Codex 的历史会话不等于运行中的进程。「可能执行中 / 待处理」是基于近期日志和生命周期事件的推断；无充分证据时显示「状态未知」。</p>
    </main>
    {showSettings && config && <SettingsPanel config={config} onClose={() => setShowSettings(false)} onSave={saveSettings}/>}
  </div>;
}
