export interface DesktopLogCandidate { path: string; size: number; mtimeMs: number; }
export interface DesktopLogFollowerReport {
  filesRead: number;
  trackedFiles: number;
  truncatedTails: number;
  backlogFiles: number;
}
export class DesktopLogFollower {
  scan(files: readonly DesktopLogCandidate[], onLine: (line: string) => void):
    Promise<DesktopLogFollowerReport>;
}
