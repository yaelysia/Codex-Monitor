import type { AlertKind } from './types';

const PREFIX = '@source:';
export type SourceAlertKind = 'source-offline' | 'source-recovered';

export function isSourceAlertKind(kind: AlertKind): kind is SourceAlertKind {
  return kind === 'source-offline' || kind === 'source-recovered';
}

export function sourceAlertKey(id: string): string {
  return PREFIX + id;
}

/** A synthetic navigation key, never a Codex thread identity. */
export function sourceIdFromAlertKey(key: string): string | null {
  return key.startsWith(PREFIX) && key.length > PREFIX.length &&
    key.length <= 350 ? key.slice(PREFIX.length) : null;
}
