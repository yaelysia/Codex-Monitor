import type { AlertKind } from './types';

const LABELS: Record<AlertKind, string> = {
  finished: '本轮回复已结束',
  waiting: '可能待处理',
  interrupted: '本轮已中断',
  failed: '本轮失败',
  'source-offline': '数据源采集异常',
  'source-recovered': '数据源已恢复',
};

export function alertKindLabel(kind: AlertKind): string {
  return LABELS[kind];
}
