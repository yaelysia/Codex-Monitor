import { useEffect, useRef, useState } from 'react';
import type { DiagnosticsApi, DiagnosticView } from '../shared/diagnostics';
import type { NativeConnection, NativeHealthReason, NativeCoverageReason,
  NativeLocalDiscovery } from '../shared/native-state';
import type { MonitorState, OriginalWindowStatus } from '../shared/types';
import SignalSelect from './SignalSelect';
import { useVisibleInterval } from './useVisibleInterval';

declare global { interface Window { diagnosticsApi?: DiagnosticsApi } }
const EMPTY: MonitorState = { scan: null, alerts: [], muted: false };
const KIND = { source: '数据源变化', session: '状态变化', 'popup-requested': '已请求系统弹窗',
  'popup-suppressed': '前台规则抑制弹窗', read: '提醒已读' };
const STATUS = { working: '执行中', waiting: '待处理', finished: '本轮完成',
  failed: '本轮失败', interrupted: '本轮中断', unknown: '未知' };
const REASON: Record<NativeHealthReason, string> = {
  disabled: '未启用', 'source-unavailable': '来源不可用，保留日志监控', connecting: '连接现有服务中',
  'no-matching-threads': '已连接，但没有匹配到当前来源的会话', 'metadata-only': '只读原生状态采集中',
  'partial-coverage': '部分覆盖；列表分页或单批读取有上限', 'connection-unavailable': '连接不可用，已降级',
  'request-failed': '部分状态读取失败，未确认项使用日志', 'protocol-unsupported': '未识别的协议或状态，未作运行推断',
  stale: '原生证据已过期',
};
const COVERAGE: Record<NativeCoverageReason, string> = {
  covered: '原生已确认', 'not-configured': '此来源尚未启用连接',
  'source-unavailable': '来源采集失败或数据已过期', subagent: '子代理不参与主线程原生匹配',
  'invalid-thread-id': '会话缺少可匹配的标准 UUID',
  'endpoint-unavailable': '没有可用的已配置服务连接',
  'not-loaded': '所有已完整枚举的服务均未加载该会话',
  'list-incomplete': '已加载列表未完整，无法确认此会话是否存在',
  'pending-verification': '已匹配，等待下一次只读核验',
  'sample-expired': '最近的原生证据已过期',
  'file-newer-than-native': '日志文件比原生读取更新，等待重新核验',
  'status-unrecognized': '原生状态未识别或暂不可用',
};
const time = (at: number | null) => at == null ? '—' : new Date(at).toLocaleTimeString('zh-CN', { hour12: false });

export default function DiagnosticsApp() {
  const [view, setView] = useState<DiagnosticView | null>(null);
  const [monitor, setMonitor] = useState<MonitorState>(EMPTY);
  const [connections, setConnections] = useState<NativeConnection[]>([]);
  const [discovery, setDiscovery] = useState<NativeLocalDiscovery | null>(null);
  const [tab, setTab] = useState('overview');
  const [selected, setSelected] = useState('all');
  const [windowStatus, setWindowStatus] = useState<OriginalWindowStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [frozenAt, setFrozenAt] = useState<number | null>(null);
  const refreshing = useRef(false), alive = useRef(true), selectionVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    void window.diagnosticsApi?.getConnections().then(rows => {
      if (alive.current) setConnections(rows);
    }).catch(() => { if (alive.current) setNotice('原生连接设置读取失败'); });
    return () => { alive.current = false; selectionVersion.current++; };
  }, []);
  const refresh = async () => {
    if (refreshing.current || !window.diagnosticsApi) return;
    refreshing.current = true;
    try {
      const [report, state] = await Promise.all([window.diagnosticsApi.get(), window.monitorApi.getMonitorState()]);
      if (alive.current) { setView(report); setMonitor(state); }
    } catch { if (alive.current) setNotice('诊断数据读取失败'); }
    finally { refreshing.current = false; }
  };
  useVisibleInterval(() => { void refresh(); }, 2000);

  async function choose(ref: string) {
    setSelected(ref); setWindowStatus(null);
    const version = ++selectionVersion.current;
    const session = view?.sessions.find(row => row.ref === ref);
    if (!session) return;
    try {
      const result = await window.monitorApi.getOriginalWindowStatus(session.key);
      if (alive.current && version === selectionVersion.current) setWindowStatus(result);
    } catch { if (alive.current && version === selectionVersion.current) setNotice('窗口绑定诊断读取失败'); }
  }
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setNotice('');
    try { await operation(); }
    catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
    finally { if (alive.current) setBusy(false); }
  }
  const report = view?.report;
  const sources = monitor.scan?.sources ?? [];
  const sessions = new Map(view?.sessions.map(row => [row.ref, row]));
  const refs = [...new Set([...(view?.sessions.map(row => row.ref) ?? []),
    ...(report?.events.flatMap(row => row.session ? [row.session] : []) ?? [])])];
  const events = (report?.events ?? []).filter(event =>
    (selected === 'all' || event.session === selected) && (frozenAt == null || event.sequence <= frozenAt));
  const maxSequence = report?.events.at(-1)?.sequence ?? 0;
  const selectedRow = view?.sessions.find(row => row.ref === selected);
  const selectedCoverage = view?.coverage.find(row => row.ref === selected);
  const coverageSummary = report?.coverage ?? [];
  const live = sources.flatMap(source => source.sessions).find(row => row.key === selectedRow?.key);
  const updateConnection = (index: number, patch: Partial<NativeConnection>) =>
    setConnections(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row));

  return <main className="diagnostics-app">
    <header className="diagnostics-header">
      <div><span className="eyebrow">CODEX MONITOR / OBSERVABILITY</span><h1>诊断中心</h1>
        <p>查看证据、定位漏报或误报；不接管 Codex，不代答审批。</p></div>
      <div className="actions"><button onClick={() => void refresh()}>刷新视图</button>
        <button disabled={busy} onClick={() => void action(async () => {
          const result = await window.diagnosticsApi!.exportReport();
          setNotice(result === 'saved' ? '脱敏诊断报告已保存' : '已取消导出');
        })}>导出脱敏报告</button></div>
    </header>
    <nav className="diagnostics-tabs" aria-label="诊断分类">
      {[['overview','健康总览'],['trace','状态轨迹'],['native','原生状态接入']].map(([value,label]) =>
        <button key={value} aria-pressed={tab === value} onClick={() => setTab(value!)}>{label}</button>)}
    </nav>
    {notice && <p className="notice" role="status">{notice}</p>}
    {tab === 'overview' && <>
      <section className="metrics" aria-label="诊断概览">
        <article><span>监控来源</span><strong>{report?.sources.length ?? 0}</strong></article>
        <article><span>原生覆盖会话</span><strong>{sources.reduce((sum, source) =>
          sum + source.sessions.filter(row => !!row.nativeStatus).length, 0)}</strong></article>
        <article><span>近期诊断事件</span><strong>{report?.events.length ?? 0}<small> / 400</small></strong></article>
        <article><span>最近扫描</span><strong>{monitor.performance?.sourceScanDurationMs ?? '—'}<small> ms</small></strong></article>
      </section>
      <section className="panel"><h2>来源健康与采集成本</h2>
        <p>文件监听正常不等于原生状态已接入；两条链路分开显示。</p>
        <div className="table-scroll"><table><thead><tr><th>来源</th><th>采集</th><th>文件事件通道</th><th>最近采集</th><th>耗时 / stat / 缓存</th></tr></thead>
          <tbody>{report?.sources.map((row, i) => <tr key={row.ref}>
            <td>{row.ref} · {sources[i]?.label ?? '来源'}</td><td>{row.healthy && !row.stale ? '正常' : '异常 / 过期'}</td>
            <td>{row.channel === 'active' ? '监听中' : row.channel === 'connecting' ? '连接中' : '轮询兜底'}</td>
            <td>{time(row.capturedAt)}</td><td>{row.durationMs ?? '—'} ms / {row.statCalls ?? '—'} / {row.cacheHits ?? '—'}</td>
          </tr>)}</tbody></table></div>
        {!report?.sources.length && <p>尚未完成首次采集。诊断视图不会主动启动额外扫描。</p>}
      </section>
      <section className="panel"><h2>原生连接覆盖</h2>
        {!report?.native.length && <p>尚未启用原生接入。现有日志监控保持不变，可在「原生状态接入」中配置。</p>}
        {report?.native.map((row, i) => <article className="health-row" key={i}>
          <div><b>连接 {i + 1} · {row.source} · {row.transport}</b><p>{REASON[row.reason]}</p></div>
          <div>已加载 {row.loaded} · 匹配 {row.matched} · 有效证据 {row.covered}<p>最近成功 {time(row.lastSuccessAt)} · 重试 {row.retries} · 未代答请求 {row.ignoredRequests} · 状态读取 {row.readRequests ?? 0} · 被动唤醒 {row.passiveHints ?? 0}</p></div>
        </article>)}
        {!!coverageSummary.length && <div className="table-scroll"><table>
          <thead><tr><th>来源</th><th>会话覆盖原因</th><th>数量</th></tr></thead>
          <tbody>{coverageSummary.map((row, i) => <tr key={i}>
            <td>{row.source}</td><td>{COVERAGE[row.reason]}</td><td>{row.count}</td>
          </tr>)}</tbody></table></div>}
      </section>
      <aside className="help">导出只含时间、计数、状态和本次运行的匿名编号。不含对话、标题、工作区、连接地址、原始错误、窗口句柄或进程 ID。未自动上传任何报告。</aside>
    </>}
    {tab === 'trace' && <section className="panel">
      <div className="section-heading"><h2>状态轨迹回看</h2><button disabled={busy} onClick={() => void action(async () => {
        setView(await window.diagnosticsApi!.clear()); setSelected('all'); setFrozenAt(null); setWindowStatus(null);
      })}>清空诊断记录</button></div>
      <p>只保留最近 400 条元数据变化；这是决策轨迹，不是原始对话或日志回放。已淘汰 {report?.dropped ?? 0} 条。</p>
      <SignalSelect label="选择诊断会话" value={selected} appearance="moonsea" options={[
        { value: 'all', label: '全部会话与来源' }, ...refs.map(ref => ({ value: ref,
          label: sessions.has(ref) ? ref + ' · ' + sessions.get(ref)!.title : ref + ' · 已离开当前视图' })),
      ]} onChange={ref => void choose(ref)} />
      {selectedRow && <div className="session-summary"><b>{selectedRow.title}</b><p>{selectedRow.sourceLabel} · {live ? STATUS[live.status] : '暂无当前记录'} · {live?.nativeStatus ? '原生证据' : '日志证据'}</p>
        {live && <p>{live.statusReason}</p>}
        {selectedCoverage && <p>原生覆盖：{COVERAGE[selectedCoverage.reason]}</p>}
        <p>窗口绑定：{windowStatus?.message ?? '正在读取只读诊断…'}</p>
      </div>}
      <div className="replay-controls"><label>回看位置 <input aria-label="状态轨迹回看位置" type="range" min={0} max={maxSequence}
        value={frozenAt ?? maxSequence} onChange={event => setFrozenAt(Number(event.target.value))} /></label>
        <button onClick={() => setFrozenAt(null)}>{frozenAt == null ? '实时' : '返回实时'}</button></div>
      <div className="table-scroll trace"><table><thead><tr><th>时间</th><th>来源 / 会话</th><th>事件</th><th>状态与证据</th></tr></thead>
        <tbody>{events.slice().reverse().map(event => <tr key={event.sequence}>
          <td>{time(event.at)}</td><td>{event.source} / {event.session ?? '—'}</td><td>{KIND[event.kind]}</td>
          <td>{event.status ? STATUS[event.status] : event.healthy != null ? event.healthy ? '健康' : '采集异常' : '—'}
            {event.evidence && ' · ' + (event.evidence === 'native' ? '原生确认' : event.evidence === 'desktop-log' ? 'Desktop 日志' : '日志推断')}</td>
        </tr>)}</tbody></table></div>
      {!events.length && <p>当前范围没有诊断事件。</p>}
    </section>}
    {tab === 'native' && <section className="panel">
      <h2>连接已有 App Server</h2>
      <p>默认关闭。同一来源可连接多个现有 App Server；按配置顺序选择同一会话的优先证据。仅执行只读调用，不启动新服务，不恢复、订阅或操作会话。</p>
      <div className="help">本地自动模式只尝试当前 CODEX_HOME 的已有控制套接字；不会扫描端口或接管私有 stdio。WSL / SSH 仍需使用现成的本机回环转发端点。共享端点不存在时，日志监控继续工作。</div>
      <div className="actions"><button disabled={busy} onClick={() => void action(async () => {
        setDiscovery(await window.diagnosticsApi!.discoverLocal());
      })}>检查已知本地共享端点</button>
      {discovery && <span role="status">{({
        'socket-found': '发现现有 Unix 套接字候选（尚未验证协议或会话匹配）',
        'candidate-found': '发现候选文件，但不能确认是可用套接字',
        'not-found': '当前本地 CODEX_HOME 没有共享控制套接字，客户端可能使用私有 stdio',
        inaccessible: '无法访问已知控制套接字路径',
        unsafe: '候选路径不安全或不是普通的本地文件/套接字',
      } as const)[discovery.state]}</span>}
      {discovery && ['socket-found', 'candidate-found'].includes(discovery.state) &&
        !connections.some(row => row.sourceId === 'local' && row.transport === 'auto') &&
        connections.length < 8 && <button disabled={busy} onClick={() =>
          setConnections(rows => [...rows, { sourceId: 'local', transport: 'auto', endpoint: '', enabled: false }])
        }>添加已发现的本地连接（需手动启用并保存）</button>}</div>
      {connections.map((row, index) => <fieldset key={index} className="connection" disabled={busy}>
        <legend>连接 {index + 1}</legend>
        <SignalSelect label={'连接来源 ' + (index + 1)} value={row.sourceId} appearance="moonsea"
          options={[...sources.map(source => ({ value: source.id, label: source.label })),
            ...(!sources.some(source => source.id === row.sourceId) ? [{ value: row.sourceId, label: row.sourceId + '（当前未采集）' }] : [])]}
          onChange={sourceId => updateConnection(index, { sourceId, transport: sourceId === 'local' ? 'auto' : 'ws', endpoint: '' })} />
        <SignalSelect label={'连接类型 ' + (index + 1)} value={row.transport} appearance="moonsea" options={[
          { value: 'auto', label: '当前本地 CODEX_HOME', disabled: row.sourceId !== 'local' },
          { value: 'socket', label: '已有本机套接字' }, { value: 'ws', label: '本机回环 WebSocket' },
        ]} onChange={transport => updateConnection(index, { transport, endpoint: '' })} />
        {row.transport !== 'auto' && <label className="endpoint">已有端点
          <input aria-label={'已有端点 ' + (index + 1)} value={row.endpoint} maxLength={2048} spellCheck={false}
            placeholder={row.transport === 'ws' ? 'ws://127.0.0.1:端口/' : '本机绝对套接字路径'}
            onChange={event => updateConnection(index, { endpoint: event.target.value })} /></label>}
        <label><input type="checkbox" checked={row.enabled} onChange={event => updateConnection(index, { enabled: event.target.checked })} /> 启用只读状态采集</label>
        <button onClick={() => setConnections(rows => rows.filter((_, i) => i !== index))}>移除</button>
      </fieldset>)}
      <div className="actions"><button disabled={busy || connections.length >= 8 || !sources.length}
        onClick={() => { const source = sources.find(source => !connections.some(row => row.sourceId === source.id)) ?? sources[0];
          if (source) setConnections(rows => [...rows, { sourceId: source.id, enabled: false,
            transport: source.id === 'local' && !rows.some(row => row.sourceId === 'local') ? 'auto' : 'ws',
            endpoint: '' }]); }}>添加现有端点</button>
        <button disabled={busy} onClick={() => void action(async () => {
          setConnections(await window.diagnosticsApi!.setConnections(connections));
          setNotice('设置已保存；可在健康总览核对实际覆盖范围'); await refresh();
        })}>保存并应用</button></div>
      <p className="help">正常连接约每 3 秒读取一批摘要；单批最多 64 个匹配会话、4 个并行请求，轮转补齐。证据 15 秒内有效，失败退避重连并回退日志。初次接入或重连的第一份状态只建立基线；之后新出现的待处理变化使用原有通知规则。idle 不会生成成功完成通知。</p>
    </section>}
    <footer>诊断窗口关闭后释放界面资源 · 最近视图 {time(report?.generatedAt ?? null)}</footer>
  </main>;
}
