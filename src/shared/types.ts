export type SessionStatus = 'working' | 'waiting' | 'finished' | 'unknown';
export type SourceKind = 'local' | 'wsl' | 'ssh';

export interface SessionRecord {
  /** Stable within a source; source + id is the global identity. */
  key: string;
  id: string;
  sourceId: string;
  sourceLabel: string;
  workspace: string | null;
  /** True only when Codex's own session_meta identifies a subagent. */
  isSubagent?: boolean;
  /** Optional root/parent thread identifier from the persisted metadata. */
  parentThreadId?: string | null;
  /** Read-only relative locator under CODEX_HOME/sessions, not an absolute disk path. */
  rolloutPath?: string | null;
  /** Codex's user-facing thread name or title, with a first-user-message fallback. */
  title: string | null;
  status: SessionStatus;
  /** User-facing evidence; no transcript contents are exposed. */
  statusReason: string;
  /** Persisted terminal/approval event fingerprint when present; helps dedupe notifications. */
  finishedToken?: string | null;
  waitingToken?: string | null;
  updatedAt: number;
  /** File metadata used only for observing activity across scans. */
  byteSize?: number;
  /** Age of the rollout as measured by its source machine; unaffected by host clock skew. */
  ageAtSourceMs?: number;
  startedAt: number | null;
}

export interface SourceResult {
  id: string;
  label: string;
  kind: SourceKind;
  sessions: SessionRecord[];
  error: string | null;
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

export type AlertKind = 'finished' | 'waiting';
export type FloatingSide = 'left' | 'right';
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
}

export interface MonitorState {
  scan: ScanResponse | null;
  alerts: MonitorAlert[];
  muted: boolean;
}

export interface FloatingWindowState {
  visible: boolean;
  expanded: boolean;
  side: FloatingSide;
}

export interface RecentReplyExcerpt {
  text: string | null;
  phase: 'final_answer' | 'commentary' | 'partial_answer' | 'unspecified' | null;
  timestamp: string | null;
  truncated: boolean;
}

export interface MonitorApi {
  getConfig(): Promise<ConfigResponse>;
  setConfig(settings: Settings): Promise<ConfigResponse>;
  refresh(): Promise<ScanResponse>;
  copyWorkspace(text: string): Promise<void>;
  getRecentReply(sessionKey: string): Promise<RecentReplyExcerpt>;
  getMonitorState(): Promise<MonitorState>;
  onMonitorState(listener: (state: MonitorState) => void): () => void;
  acknowledgeAlert(id: string): Promise<MonitorState>;
  setNotificationsMuted(muted: boolean): Promise<MonitorState>;
  getFloatingState(): Promise<FloatingWindowState>;
  setFloatingVisible(visible: boolean): Promise<FloatingWindowState>;
  setFloatingExpanded(expanded: boolean): Promise<FloatingWindowState>;
  onFloatingState(listener: (state: FloatingWindowState) => void): () => void;
  showMainWindow(sessionKey?: string): Promise<void>;
  onFocusSession(listener: (sessionKey: string) => void): () => void;
  consumePendingFocusKey(): Promise<string | null>;
}
