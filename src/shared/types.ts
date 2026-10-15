export type SessionStatus = 'working' | 'waiting' | 'finished' | 'interrupted' | 'failed' | 'unknown';
/** Evidence provenance does not claim that a client process is currently alive. */
export type SessionEvidenceKind =
  'recent-start' | 'recent-activity' | 'retained-activity' | 'historical-start';
export type SourceKind = 'local' | 'wsl' | 'ssh';
export type SessionClientKind = 'desktop' | 'vscode' | 'terminal' | 'unknown';

export interface SessionRecord {
  /** Stable within a source; source + id is the global identity. */
  key: string;
  id: string;
  sourceId: string;
  sourceLabel: string;
  workspace: string | null;
  /** Client identified by session_meta.originator, not window title or cwd. */
  clientKind?: SessionClientKind;
  /** A GUI-owned Codex Desktop lifecycle event matched this exact thread UUID.
   * Unlike clientKind, this identifies the observed running client, not creator.
   */
  desktopRuntimeObserved?: boolean;
  /** User input age according to source machine clock; may be absent. */
  lastUserInputAgeAtSourceMs?: number | null;
  /** Stable event timestamp in source clock, used only to deduplicate binding attempts. */
  lastUserInputAtSourceMs?: number | null;
  /** True only when Codex's own session_meta identifies a subagent. */
  isSubagent?: boolean;
  /** Optional root/parent thread identifier from the persisted metadata. */
  parentThreadId?: string | null;
  /** Read-only relative locator under CODEX_HOME/sessions, not an absolute disk path. */
  rolloutPath?: string | null;
  /** Codex's user-facing thread name or title, with a first-user-message fallback. */
  title: string | null;
  status: SessionStatus;
  /** Strength and provenance of the tentative status, independent of status. */
  evidenceKind?: SessionEvidenceKind;
  /** User-facing evidence; no transcript contents are exposed. */
  statusReason: string;
  /** Persisted terminal/approval event fingerprint when present; helps dedupe notifications. */
  finishedToken?: string | null;
  /** Fingerprint of a persisted turn_aborted event, distinct from successful completion. */
  interruptedToken?: string | null;
  /** Bounded stable fingerprints of aborted turns in the scanned JSONL tail.
   * Includes aborts followed by a later turn; never includes message text.
   */
  interruptionTokens?: string[];
  waitingToken?: string | null;
  /** Stable ID for an unanswered persisted question/approval call or async AgentMessage. */
  pendingQuestionToken?: string | null;
  /** Optional short user-facing question; never raw tool arguments or model reasoning. */
  questionText?: string | null;
  updatedAt: number;
  /** File metadata used only for observing activity across scans. */
  byteSize?: number;
  /** Age of the rollout as measured by its source machine; unaffected by host clock skew. */
  ageAtSourceMs?: number;
  startedAt: number | null;
}

export interface SourceScanMetrics {
  durationMs: number;
  sessionCount: number;
  indexMode?: 'full' | 'incremental';
  indexedFiles?: number;
  statCalls?: number;
  parsedFiles?: number;
  cacheHits?: number;
}

export interface SourceResult {
  id: string;
  label: string;
  kind: SourceKind;
  /** Host timestamps bounding this source's scan; the remote scan moment lies between them. */
  captureStartedAt?: number;
  /** Local wall-clock time when THIS source scan completed, not the merged scan time. */
  capturedAt?: number;
  sessions: SessionRecord[];
  error: string | null;
  /** Failed source with retained historical session metadata, not live evidence. */
  stale?: boolean;
  lastHealthyAt?: number;
  /** Source-specific collection cost; never includes paths or conversation content. */
  scanMetrics?: SourceScanMetrics;
}

export interface ScanResponse {
  sources: SourceResult[];
  scannedAt: number;
}

export interface RemoteHost {
  id: string;
  alias: string;
  root: string;
}

export interface Settings {
  /** Empty means environment CODEX_HOME, then ~/.codex. */
  localRoot: string;
  wslRoots: Record<string, string>;
  remotes: RemoteHost[];
}

export interface ConfigResponse {
  settings: Settings;
  distros: string[];
}

export type AlertKind = 'finished' | 'waiting' | 'interrupted';
export type FloatingSide = 'left' | 'right';
export type SignalAppearance = 'moonsea' | 'ember' | 'mist';
export type FloatingCompactSize = 'micro' | 'compact';
export type FloatingTab = 'running' | 'alerts' | 'completed';

export interface MonitorAlert {
  id: string;
  sessionKey: string;
  sessionId: string;
  kind: AlertKind;
  title: string;
  sourceLabel: string;
  workspace: string | null;
  at: number;
  read: boolean;
  statusReason: string;
  questionText?: string | null;
}

export type EventChannelMode = 'active' | 'connecting' | 'fallback';
export interface DesktopAuditMetrics {
  at: number;
  durationMs: number;
  logFilesTracked: number;
  logBytesRead: number;
  backlogFiles: number;
  unchangedFiles: number;
  directoryCacheHits: number;
  directoriesEnumerated: number;
  lastEventLagMs: number | null;
}
export interface NotificationLagMetrics {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}
export interface MonitorPerformance {
  sourceScanDurationMs: number | null;
  desktopAudit: DesktopAuditMetrics | null;
  /** Estimated from persisted event timestamps, not a measurement of OS popup display. */
  notificationLag?: NotificationLagMetrics | null;
}

export interface MonitorState {
  scan: ScanResponse | null;
  /** Metadata-only performance counters; never emits session content or paths. */
  performance?: MonitorPerformance;
  alerts: MonitorAlert[];
  muted: boolean;
  /** Per-source event watcher health. "fallback" still has periodic scans. */
  eventChannels?: Record<string, EventChannelMode>;
}

export interface FloatingWindowState {
  visible: boolean;
  expanded: boolean;
  side: FloatingSide;
  /** 0.4 to 1, where 1 is fully opaque. */
  opacity: number;
  appearance: SignalAppearance;
  compactSize: FloatingCompactSize;
  /** Transient native bounds animation state, never persisted. */
  motion?: 'expanding' | 'collapsing' | null;
}

export interface RecentReplyExcerpt {
  text: string | null;
  phase: 'final_answer' | 'commentary' | 'partial_answer' | 'unspecified' | null;
  timestamp: string | null;
  truncated: boolean;
}

export interface ResidentOptions {
  keepRunningOnClose: boolean;
  launchAtLogin: boolean;
  startupSupported: boolean;
}

export interface OriginalWindowStatus {
  ready: boolean;
  message: string;
  host?: 'desktop' | 'vscode' | 'terminal';
}

export type OriginalWindowFocusResult = {
  state: 'focused' | 'opened' | 'partial' | 'unbound' | 'unavailable' | 'stale' | 'blocked';
  message: string;
};

export interface MonitorApi {
  readonly windowChrome: 'overlay' | 'native';
  getConfig(): Promise<ConfigResponse>;
  getResidentOptions(): Promise<ResidentOptions>;
  setResidentOptions(options: Pick<ResidentOptions, 'keepRunningOnClose' | 'launchAtLogin'>): Promise<ResidentOptions>;
  setConfig(settings: Settings): Promise<ConfigResponse>;
  refresh(): Promise<ScanResponse>;
  copyWorkspace(text: string): Promise<void>;
  getRecentReply(sessionKey: string): Promise<RecentReplyExcerpt>;
  getOriginalWindowStatus(sessionKey: string): Promise<OriginalWindowStatus>;
  focusOriginalWindow(sessionKey: string): Promise<OriginalWindowFocusResult>;
  getMonitorState(): Promise<MonitorState>;
  onMonitorState(listener: (state: MonitorState) => void): () => void;
  acknowledgeAlert(id: string): Promise<MonitorState>;
  setNotificationsMuted(muted: boolean): Promise<MonitorState>;
  getFloatingState(): Promise<FloatingWindowState>;
  setFloatingVisible(visible: boolean): Promise<FloatingWindowState>;
  setFloatingExpanded(expanded: boolean): Promise<FloatingWindowState>;
  setFloatingOpacity(opacity: number): Promise<FloatingWindowState>;
  setFloatingAppearance(appearance: SignalAppearance): Promise<FloatingWindowState>;
  setFloatingCompactSize(size: FloatingCompactSize): Promise<FloatingWindowState>;
  resetFloatingPosition(): Promise<FloatingWindowState>;
  onFloatingState(listener: (state: FloatingWindowState) => void): () => void;
  showMainWindow(sessionKey?: string): Promise<void>;
  onFocusSession(listener: (sessionKey: string) => void): () => void;
  consumePendingFocusKey(): Promise<string | null>;
}
