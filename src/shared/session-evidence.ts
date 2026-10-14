import type { SessionRecord } from './types';

/** Evidence provenance, not definitive liveness or a numeric probability. */
export function sessionEvidenceLabel(
  session: Pick<SessionRecord, 'status' | 'evidenceKind'>,
): string {
  if (session.status === 'finished') return '本轮结束事件已记录';
  if (session.status === 'interrupted') return '本轮中断事件已记录';
  if (session.status === 'failed') return '本轮错误事件已记录';
  if (session.status === 'waiting') return '等待输入/审批线索 · 推断';
  if (session.status !== 'working') return '近期证据不足 · 未确认';
  switch (session.evidenceKind) {
    case 'recent-start': return '近期开始事件 · 尚未确认结束';
    case 'recent-activity': return '近期日志活动 · 推断';
    case 'retained-activity': return '静默期延续 · 推断';
    case 'historical-start': return '历史未闭合启动 · 未实时确认';
    default: return '执行状态来自来源推断';
  }
}
