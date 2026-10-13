/** Bounded, read-only follow of Codex Desktop logs.
 * Cold start: recent tail from every discovered file.
 * Warm scans: read from each last COMPLETE line, not its moving 320-KiB tail.
 * No raw log body, tab caption, account info or path is returned or persisted.
 */
import fs from 'node:fs/promises';

const MAX_FILES = 32;
const COLD_TAIL_BYTES = 512 * 1024;
const MAX_FILE_READ_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024;
const MAX_LOG_LINE_BYTES = 10_000;

export class DesktopLogFollower {
  constructor() {
    this.positions = new Map();
    this.pending = Promise.resolve();
  }

  /** Serializes overlapping Monitor refresh and four-second native audits. */
  scan(files, onLine) {
    const task = this.pending.then(() => this.scanUnlocked(files, onLine));
    this.pending = task.then(() => {}, () => {});
    return task;
  }

  async scanUnlocked(files, onLine) {
    const selected = files.slice(0, MAX_FILES);
    const retained = new Set(selected.map(item => item.path));
    for (const key of this.positions.keys()) {
      if (!retained.has(key)) this.positions.delete(key);
    }
    let budget = MAX_TOTAL_READ_BYTES;
    let filesRead = 0;
    let truncatedTails = 0;
    let backlogFiles = 0;

    for (const item of selected) {
      const previous = this.positions.get(item.path);
      const rotated = previous && (item.size < previous.offset ||
        item.mtimeMs + 1000 < previous.mtimeMs ||
        (item.size === previous.offset && item.mtimeMs > previous.mtimeMs + 1000));
      const cold = !previous || rotated;
      const start = cold ? Math.max(0, item.size - COLD_TAIL_BYTES) : previous.offset;
      if (cold && start > 0) truncatedTails++;
      if (start >= item.size) {
        if (cold) this.positions.set(item.path, { offset: item.size, mtimeMs: item.mtimeMs });
        continue;
      }
      if (budget <= 0) { backlogFiles++; continue; }
      const length = Math.min(item.size - start, MAX_FILE_READ_BYTES, budget);
      let handle;
      try {
        handle = await fs.open(item.path, 'r');
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        if (!bytesRead) continue;
        filesRead++;
        budget -= bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        // Cold tail may begin mid-UTF8 character or mid-record. Never parse
        // that fragment as a first-party lifecycle log line.
        let first = 0;
        if (cold && start > 0) {
          const firstLF = bytes.indexOf(10);
          first = firstLF >= 0 ? firstLF + 1 : bytesRead;
        }
        const lastLF = bytes.lastIndexOf(10);
        let consumed = lastLF >= first ? lastLF + 1 : first;
        if (lastLF >= first) {
          const complete = bytes.subarray(first, lastLF + 1).toString('utf8');
          for (const line of complete.split(/\r?\n/)) {
            if (line && line.length <= MAX_LOG_LINE_BYTES) onLine(line);
          }
        }
        // An unterminated record larger than the supported log grammar
        // cannot become a lifecycle event. Skip it instead of stalling forever.
        if (!consumed && bytesRead > MAX_LOG_LINE_BYTES) consumed = bytesRead;
        this.positions.set(item.path, { offset: start + consumed, mtimeMs: item.mtimeMs });
        if (start + consumed < item.size) backlogFiles++;
      } catch {
        // Rotated/locked log: preserve last safe cursor for the next audit.
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return { filesRead, trackedFiles: [...this.positions.keys()].filter(key => retained.has(key)).length,
      truncatedTails, backlogFiles };
  }
}
