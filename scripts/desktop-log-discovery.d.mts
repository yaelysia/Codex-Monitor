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
export function desktopLogRoots(localAppData: string, appData?: string): Promise<DesktopLogRoot[]>;
export function discoverDesktopLogFiles(localAppData: string, now?: number, appData?: string):
  Promise<{ validLocalAppData: boolean; roots: DesktopLogRootStats[]; files: DesktopLogCandidate[] }>;
