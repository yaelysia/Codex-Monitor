export interface DesktopLogRoot {
  kind: 'standard' | 'msix' | 'roaming';
  path: string;
}
export interface DesktopLogCandidate {
  path: string;
  size: number;
  mtimeMs: number;
}
export interface DesktopLogRootStats {
  kind: DesktopLogRoot['kind'];
  exists: boolean;
  accessibleDateFolders: number;
  anyLogFiles: number;
  matchedNames: number;
  recentCandidates: number;
}
export function desktopLogRoots(localAppData: string, appData?: string,
  cache?: DesktopDirectoryCache | null, now?: number): Promise<DesktopLogRoot[]>;
export function discoverDesktopLogFiles(localAppData: string, now?: number, appData?: string,
  cache?: DesktopDirectoryCache | null):
  Promise<{ validLocalAppData: boolean; roots: DesktopLogRootStats[]; files: DesktopLogCandidate[] }>;

export interface DirectoryCacheStats { cacheHits: number; enumerations: number; }
export class DesktopDirectoryCache {
  read(directory: string, now?: number, mode?: 'packages' | 'logs'):
    Promise<import('node:fs').Dirent[] | null>;
  stats(): DirectoryCacheStats;
}
