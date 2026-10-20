import fs from 'node:fs';
import path from 'node:path';
import { parseProbeEndpoint } from '../scripts/app-server-probe/client.mjs';
import { MAX_NATIVE_CONNECTIONS, nativeConnectionKey, type NativeConnection } from '../src/shared/native-state';

export function validateNativeConnections(raw: unknown): NativeConnection[] {
  if (!Array.isArray(raw) || raw.length > MAX_NATIVE_CONNECTIONS) throw new Error('原生连接最多配置 8 个数据源');
  const connections = new Set<string>();
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原生连接格式无效');
    const row = value as Record<string, unknown>;
    if (typeof row.sourceId !== 'string' || row.sourceId.length > 200 ||
        !/^(local|(?:wsl|ssh):[^\s\u0000-\u001f]+)$/.test(row.sourceId) ||
        typeof row.enabled !== 'boolean' || !['auto','socket','ws'].includes(String(row.transport)) ||
        typeof row.endpoint !== 'string' || row.endpoint.length > 2048 || /[\u0000-\u001f]/.test(row.endpoint))
      throw new Error('连接的数据源、类型或地址无效；每个来源只能配置一个端点');
    const transport = row.transport as NativeConnection['transport'];
    const endpoint = row.endpoint.trim();
    if (transport === 'auto') {
      if (row.sourceId !== 'local' || endpoint) throw new Error('自动套接字仅适用于本地来源，地址请留空');
    } else {
      if (!endpoint || (transport === 'socket' && (/^[\\/]{2}/.test(endpoint) || endpoint.startsWith('\\'))))
        throw new Error('套接字必须是本机绝对路径，不能使用网络共享或设备管道');
      try { parseProbeEndpoint(transport === 'ws' ? { ws: endpoint } : { socket: endpoint }); }
      catch { throw new Error('仅支持无凭据、无查询参数的本机回环 WebSocket，或本机绝对套接字路径'); }
    }
    const normalized = { sourceId: row.sourceId, enabled: row.enabled, transport, endpoint };
    const key = nativeConnectionKey(normalized);
    if (connections.has(key)) throw new Error('同一来源不能重复配置相同端点');
    connections.add(key);
    return normalized;
  });
}

/** Separate opt-in settings; old Monitor settings and alert persistence are untouched. */
export class NativeSettingsStore {
  private readonly file: string | null;
  constructor(directory?: string) { this.file = directory ? path.join(directory, 'native-connections.json') : null; }
  load(): NativeConnection[] {
    if (!this.file) return [];
    try {
      if (fs.statSync(this.file).size > 32_768) return [];
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data?.version === 1 ? validateNativeConnections(data.connections) : [];
    } catch { return []; }
  }
  save(connections: readonly NativeConnection[]): void {
    if (!this.file) return;
    const temp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(temp, JSON.stringify({ version: 1, connections }), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch {
      try { fs.unlinkSync(temp); } catch { /* best effort cleanup */ }
      throw new Error('无法保存原生连接设置；当前设置保持不变');
    }
  }
}
