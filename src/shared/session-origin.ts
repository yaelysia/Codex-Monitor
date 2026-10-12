/** Inspect Codex's own persisted session provenance, not guessed title/path patterns. */
export interface SessionOrigin {
  isSubagent: boolean;
  parentThreadId: string | null;
}

type JsonObject = Record<string, unknown>;
const obj = (v: unknown): JsonObject | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : null;

const stringOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v : null;

/** New Codex rollouts use source:{subagent:...}, thread_source and parent_thread_id. */
export function classifySessionOrigin(metadata: unknown): SessionOrigin {
  const meta = obj(metadata);
  if (!meta) return { isSubagent: false, parentThreadId: null };
  const source = meta.source;
  const sourceObject = obj(source);
  const subSource = sourceObject?.subagent ?? sourceObject?.subAgent;
  const spawn = obj(obj(subSource)?.thread_spawn ?? obj(subSource)?.threadSpawn);
  const parentThreadId = stringOrNull(meta.parent_thread_id) ??
    stringOrNull(meta.parentThreadId) ?? stringOrNull(spawn?.parent_thread_id) ??
    stringOrNull(spawn?.parentThreadId);
  const classified = meta.thread_source === 'subagent' || meta.threadSource === 'subagent' ||
    source === 'subagent' || source === 'subAgent' ||
    (sourceObject != null && ('subagent' in sourceObject || 'subAgent' in sourceObject)) ||
    !!parentThreadId ||
    (typeof meta.session_id === 'string' && typeof meta.id === 'string' &&
      !!meta.session_id && !!meta.id && meta.session_id !== meta.id);
  return { isSubagent: classified, parentThreadId };
}

/** The first session_meta line may exceed the 128-KiB head budget due to base_instructions.
 * Codex serializes source/parent fields before base_instructions; recover only their
 * bounded prefix in that case and never inspect arbitrary later transcript lines. */
export function extractSessionOrigin(head: string): SessionOrigin {
  const line = head.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, '') ?? '';
  if (!/"type"\s*:\s*"session_meta"/.test(line)) {
    return { isSubagent: false, parentThreadId: null };
  }
  try {
    const row = JSON.parse(line) as unknown;
    return classifySessionOrigin(obj(row)?.payload);
  } catch { /* first session_meta may be an incomplete oversized line */ }
  const prefix = line.split(/"base_instructions"\s*:/, 1)[0]!;
  const parent = /"parent_thread_id"\s*:\s*"([^"]+)"/.exec(prefix)?.[1] ??
    /"parentThreadId"\s*:\s*"([^"]+)"/.exec(prefix)?.[1] ?? null;
  const sourceSubagent = /"source"\s*:\s*\{\s*"(?:subagent|subAgent)"\s*:/.test(prefix) ||
    /"source"\s*:\s*"(?:subagent|subAgent)"/.test(prefix);
  const threadSubagent = /"(?:thread_source|threadSource)"\s*:\s*"subagent"/.test(prefix);
  const id = /"id"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(prefix)?.[1];
  const sessionId = /"session_id"\s*:\s*"([0-9a-fA-F-]{32,36})"/.exec(prefix)?.[1];
  return {
    isSubagent: sourceSubagent || threadSubagent || !!parent ||
      (!!id && !!sessionId && id !== sessionId),
    parentThreadId: parent,
  };
}

/** source='vscode' alone cannot establish which UI actually created a session. */
export function classifyClientKind(originator: unknown): import('./types').SessionClientKind {
  if (typeof originator !== 'string') return 'unknown';
  const name = originator.trim().toLowerCase();
  if (name === 'codex desktop' || name === 'codex_work_desktop') return 'desktop';
  if (name === 'codex_vscode' || name === 'codex-vscode') return 'vscode';
  if (['codex-tui', 'codex_cli_rs', 'codex-cli', 'codex_cli'].includes(name)) return 'terminal';
  return 'unknown';
}

export function extractSessionClientKind(head: string): import('./types').SessionClientKind {
  const line = head.split(/\r?\n/, 1)[0]?.replace(/^\uFEFF/, '') ?? '';
  if (!/"type"\s*:\s*"session_meta"/.test(line)) return 'unknown';
  try {
    const parsed = obj(JSON.parse(line));
    return classifyClientKind(obj(parsed?.payload)?.originator);
  } catch { /* Some metadata lines are clipped before base_instructions. */ }
  const prefix = line.split(/"base_instructions"\s*:/, 1)[0]!;
  return classifyClientKind(/"originator"\s*:\s*"([^"]{1,128})"/.exec(prefix)?.[1]);
}
