export type SessionStatus = 'working' | 'waiting' | 'finished' | 'unknown';
export type SourceKind = 'local' | 'wsl' | 'ssh';

export interface SessionRecord {
  /** Stable within a source; source + id is the global identity. */
  key: string;
  id: string;
  sourceId: string;
  sourceLabel: string;
  workspace: string | null;
  /** Codex's user-facing thread name or title, with a first-user-message fallback. */
  title: string | null;
  status: SessionStatus;
  /** User-facing evidence; no transcript contents are exposed. */
  statusReason: string;
  updatedAt: number;
  /** File metadata used only for observing activity across scans. */
  byteSize?: number;
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

export interface MonitorApi {
  getConfig(): Promise<ConfigResponse>;
  setConfig(settings: Settings): Promise<ConfigResponse>;
  refresh(): Promise<ScanResponse>;
  copyWorkspace(text: string): Promise<void>;
}
