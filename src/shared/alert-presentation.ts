import type { AlertKind } from './types';

const LABELS: Record<AlertKind, string> = {
  finished: '本轮回复已结束',
  waiting: '可能待处理',
  interrupted: '本轮已中断',
};

export function alertKindLabel(kind: AlertKind): string {
  return LABELS[kind];
}
