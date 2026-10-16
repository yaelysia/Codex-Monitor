import type { AlertKind, NotificationKinds } from './types';

export const NOTIFICATION_KIND_KEYS = [
  'finished', 'waiting', 'interrupted', 'failed', 'source-offline', 'source-recovered',
] as const satisfies readonly AlertKind[];

export const DEFAULT_NOTIFICATION_KINDS: NotificationKinds = {
  finished: true,
  waiting: true,
  interrupted: true,
  failed: true,
  'source-offline': true,
  'source-recovered': true,
};

/** Old preferences and malformed values revert to the previous "notify all"
 * default. Accept only known boolean fields; never persist extra keys.
 */
export function normalizeNotificationKinds(value: unknown): NotificationKinds {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const result = { ...DEFAULT_NOTIFICATION_KINDS };
  for (const kind of NOTIFICATION_KIND_KEYS) {
    if (typeof input[kind] === 'boolean') result[kind] = input[kind];
  }
  return result;
}

export function isNotificationKind(value: unknown): value is AlertKind {
  return typeof value === 'string' &&
    (NOTIFICATION_KIND_KEYS as readonly string[]).includes(value);
}
