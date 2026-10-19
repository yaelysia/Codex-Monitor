export type ProbeEndpoint = { kind: 'socket'; path: string } | { kind: 'ws'; url: string };
export function parseProbeEndpoint(value: { socket?: string; ws?: string; allowRemote?: boolean; home?: string }): ProbeEndpoint;
export class AppServerProbeClient {
  constructor(endpoint: ProbeEndpoint, options?: { onEvent?: (event: unknown) => void; timeoutMs?: number; showIds?: boolean });
  closed: boolean;
  stats: { pushEvents: number; serverRequests: number };
  start(): Promise<unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  loadedThreads(limit?: number, targetThreadId?: string | null): Promise<{
    ids: string[]; observedCount: number; listComplete: boolean; targetMatched: boolean | null;
  }>;
  readStatus(threadId: string): Promise<unknown>;
  close(): Promise<void>;
}
