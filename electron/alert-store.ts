import fs from 'node:fs';
import path from 'node:path';
import type { AlertTrackerPersistence, SavedAlert } from '../src/shared/alert-tracker';

const MAX_FILE_BYTES = 128 * 1024;
const MAX_ALERTS = 60;
const MAX_SEEN_IDS = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60_000;

function validString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
/** Alert IDs must be generated from the existing [sessionKey,kind,token] scheme.
 * Validating this envelope rejects accidental persisted chat text.
 */
function validAlertId(id: unknown, key?: string, kind?: string): id is string {
  if (!validString(id, 1024)) return false;
  try {
    const parsed: unknown = JSON.parse(id);
    if (!Array.isArray(parsed) || parsed.length !== 3 ||
        !validString(parsed[0], 350) ||
        (parsed[1] !== 'finished' && parsed[1] !== 'waiting' &&
         parsed[1] !== 'interrupted') ||
        !validString(parsed[2], 500)) return false;
    return (!key || parsed[0] === key) && (!kind || parsed[1] === kind);
  } catch { return false; }
}
function validRecord(value: unknown, now: number): SavedAlert | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!validString(row.sessionKey, 350) || !validString(row.sessionId, 128) ||
      (row.kind !== 'finished' && row.kind !== 'waiting' &&
       row.kind !== 'interrupted') ||
      !validAlertId(row.id, row.sessionKey, row.kind) ||
      typeof row.at !== 'number' || !Number.isSafeInteger(row.at) ||
      row.at <= 0 || row.at > now + 60_000 || now - row.at > MAX_AGE_MS ||
      typeof row.read !== 'boolean') return null;
  return { id: row.id, sessionKey: row.sessionKey, sessionId: row.sessionId,
    kind: row.kind, at: row.at, read: row.read };
}
/** Normalize read AND write; malformed, stale, oversized or extra content is discarded. */
export function normalizeAlertState(raw: unknown, now = Date.now()): AlertTrackerPersistence | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.version !== 1 || typeof row.muted !== 'boolean' ||
      !Array.isArray(row.alerts) || !Array.isArray(row.seenAlertIds)) return null;
  const alerts: SavedAlert[] = [];
  const unique = new Set<string>();
  for (const value of row.alerts.slice(0, MAX_ALERTS * 2)) {
    const alert = validRecord(value, now);
    if (alert && !unique.has(alert.id)) { alerts.push(alert); unique.add(alert.id); }
    if (alerts.length >= MAX_ALERTS) break;
  }
  const seen = new Set<string>();
  for (const id of row.seenAlertIds.slice(-MAX_SEEN_IDS)) if (validAlertId(id)) seen.add(id);
  for (const item of alerts) seen.add(item.id);
  return { version: 1, muted: row.muted, alerts, seenAlertIds: [...seen].slice(-MAX_SEEN_IDS) };
}

/** Atomic, debounced, tiny local store. Never writes prompts, titles or paths. */
export class AlertStateStore {
  private readonly file: string;
  private lastJSON = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(directory: string) {
    this.file = path.join(directory, 'alert-state.json');
  }
  load(now = Date.now()): AlertTrackerPersistence | null {
    try {
      const stat = fs.statSync(this.file);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) return null;
      const value: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const normalized = normalizeAlertState(value, now);
      if (normalized) this.lastJSON = JSON.stringify(normalized);
      return normalized;
    } catch { return null; }
  }
  update(snapshot: AlertTrackerPersistence, now = Date.now()): void {
    const safe = normalizeAlertState(snapshot, now);
    if (!safe) return;
    const json = JSON.stringify(safe);
    if (json === this.lastJSON) return;
    this.lastJSON = json;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 600);
    this.timer.unref?.();
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.lastJSON) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temporary = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(temporary, this.lastJSON, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch {
      // A locked disk or AV product must not block monitoring or notifications.
    }
  }
}
