/** Bounded, read-only follow of Codex Desktop lifecycle logs.
 * Cold start reads recent tails, warm scans keep exact append offsets.
 * Stream over 64-KiB blocks instead of decoding/splitting multi-megabyte
 * buffers; logs never leave the temporary parser or become persistent data.
 */
import fs from 'node:fs/promises';

const MAX_FILES = 32;
const COLD_TAIL_BYTES = 512 * 1024;
const MAX_FILE_READ_BYTES = 3 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES = 16 * 1024 * 1024;
const MAX_LOG_LINE_BYTES = 10_000;
export const LOG_READ_CHUNK_BYTES = 64 * 1024;

export class DesktopLogFollower {
  constructor() {
    this.positions = new Map();
    this.pending = Promise.resolve();
  }

  /** Serialize overlapping refreshes and native four-second audits. */
  scan(files, onLine) {
    const task = this.pending.then(() => this.scanUnlocked(files, onLine));
    this.pending = task.then(() => {}, () => {});
    return task;
  }

  async scanUnlocked(files, onLine) {
    const selected = files.slice(0, MAX_FILES);
    const retained = new Set(selected.map(item => item.path));
    for (const key of this.positions.keys())
      if (!retained.has(key)) this.positions.delete(key);

    let budget = MAX_TOTAL_READ_BYTES;
    let filesRead = 0;
    let bytesReadTotal = 0;
    let maxReadBytes = 0;
    let skippedUnchanged = 0;
    let coldFiles = 0;
    let truncatedTails = 0;
    let backlogFiles = 0;
    // Reuse a single bounded buffer across every file in this scan. On long
    // logs, the original 3-MiB buffer + full string split amplified V8 memory.
    const chunk = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);

    for (const item of selected) {
      const previous = this.positions.get(item.path);
      const rotated = previous && (item.size < previous.offset ||
        item.mtimeMs + 1000 < previous.mtimeMs ||
        (item.size === previous.offset && item.mtimeMs > previous.mtimeMs + 1000));
      const cold = !previous || rotated;
      const start = cold ? Math.max(0, item.size - COLD_TAIL_BYTES) : previous.offset;
      if (cold) coldFiles++;
      if (cold && start > 0) truncatedTails++;
      if (start >= item.size) {
        skippedUnchanged++;
        if (cold) this.positions.set(item.path, {
          offset: item.size, mtimeMs: item.mtimeMs, skipLongLine: false,
        });
        continue;
      }
      if (budget <= 0) { backlogFiles++; continue; }
      const limit = Math.min(item.size - start, MAX_FILE_READ_BYTES, budget);
      let handle;
      try {
        handle = await fs.open(item.path, 'r');
        let cursor = start;
        let lastComplete = start;
        let skipping = cold && start > 0 || (!cold && previous?.skipLongLine === true);
        let pending = [];
        let pendingLength = 0;
        let readForFile = 0;

        while (readForFile < limit) {
          const want = Math.min(LOG_READ_CHUNK_BYTES, limit - readForFile);
          const { bytesRead } = await handle.read(chunk, 0, want, cursor);
          if (!bytesRead) break;
          readForFile += bytesRead;
          cursor += bytesRead;
          maxReadBytes = Math.max(maxReadBytes, bytesRead);
          let from = 0;
          let newline = chunk.indexOf(10, from);
          while (newline >= 0 && newline < bytesRead) {
            const partLength = newline - from;
            if (!skipping && pendingLength + partLength <= MAX_LOG_LINE_BYTES) {
              let line;
              if (pending.length) {
                if (partLength) pending.push(Buffer.from(chunk.subarray(from, newline)));
                line = Buffer.concat(pending, pendingLength + partLength).toString('utf8');
              } else {
                line = chunk.toString('utf8', from, newline);
              }
              if (line.endsWith('\r')) line = line.slice(0, -1);
              if (line) onLine(line);
            }
            pending = [];
            pendingLength = 0;
            skipping = false;
            lastComplete = cursor - bytesRead + newline + 1;
            from = newline + 1;
            newline = chunk.indexOf(10, from);
          }
          if (from < bytesRead && !skipping) {
            const n = bytesRead - from;
            if (pendingLength + n > MAX_LOG_LINE_BYTES) {
              // Omit this oversized record in its entirety. Preserve only a
              // boolean across boundaries, never the offending log body.
              pending = [];
              pendingLength = 0;
              skipping = true;
            } else {
              pending.push(Buffer.from(chunk.subarray(from, bytesRead)));
              pendingLength += n;
            }
          }
        }
        if (!readForFile) continue;
        filesRead++;
        bytesReadTotal += readForFile;
        budget -= readForFile;
        // Small incomplete tail: rewind to its start so it will be parsed
        // exactly once after the newline arrives. A huge unterminated line:
        // advance and keep skipLongLine until its terminating newline.
        const offset = skipping ? cursor : lastComplete;
        this.positions.set(item.path, {
          offset, mtimeMs: item.mtimeMs, skipLongLine: skipping,
        });
        if (offset < item.size) backlogFiles++;
      } catch {
        // Locked or rotated files retry next audit from their safe cursor.
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return {
      filesRead,
      trackedFiles: [...this.positions.keys()].filter(key => retained.has(key)).length,
      truncatedTails, backlogFiles, bytesRead: bytesReadTotal,
      skippedUnchanged, coldFiles, maxReadBytes,
    };
  }
}
