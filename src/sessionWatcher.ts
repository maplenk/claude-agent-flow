import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

/**
 * Watches Claude Code JSONL transcript files for changes.
 * Uses stat-based polling (fs.watchFile) instead of fs.watch because
 * fs.watch is unreliable on macOS for detecting file appends.
 */
export class SessionWatcher extends EventEmitter {
  private pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private lastSizes: Map<string, number> = new Map();
  private lastMtimes: Map<string, number> = new Map();
  private claudeDir: string;
  private projectPollTimer?: NodeJS.Timeout;
  private pollIntervalMs: number;

  constructor(claudeDir: string, pollIntervalMs = 500) {
    super();
    this.claudeDir = claudeDir;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Watch a specific JSONL file for changes (live mode).
   * Polls the file every pollIntervalMs using fs.stat.
   */
  watchFile(filePath: string): void {
    if (this.pollTimers.has(filePath)) { return; }

    try {
      const stats = fs.statSync(filePath);
      this.lastSizes.set(filePath, stats.size);
      this.lastMtimes.set(filePath, stats.mtimeMs);
    } catch {
      this.lastSizes.set(filePath, 0);
      this.lastMtimes.set(filePath, 0);
    }

    const timer = setInterval(() => {
      this.checkFile(filePath);
    }, this.pollIntervalMs);

    this.pollTimers.set(filePath, timer);

    // Also poll for subagent files
    const sessionId = path.basename(filePath, '.jsonl');
    const subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents');
    this.watchSubagentDir(subagentsDir);

    this.emit('watching', filePath);
  }

  private watchSubagentDir(dirPath: string): void {
    const key = `dir_${dirPath}`;
    if (this.pollTimers.has(key)) { return; }

    // Poll for new/changed subagent files
    const knownFiles = new Map<string, number>();

    const timer = setInterval(() => {
      try {
        if (!fs.existsSync(dirPath)) { return; }
        const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
        for (const f of files) {
          const fullPath = path.join(dirPath, f);
          try {
            const stats = fs.statSync(fullPath);
            const lastMtime = knownFiles.get(fullPath) || 0;
            if (stats.mtimeMs > lastMtime) {
              knownFiles.set(fullPath, stats.mtimeMs);
              if (lastMtime > 0) {
                // File changed — emit event
                this.emit('newEntries', { filePath: fullPath, lines: [] });
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* dir doesn't exist yet, that's fine */ }
    }, this.pollIntervalMs * 2);

    this.pollTimers.set(key, timer);
  }

  private checkFile(filePath: string): void {
    try {
      const stats = fs.statSync(filePath);
      const lastSize = this.lastSizes.get(filePath) || 0;
      const lastMtime = this.lastMtimes.get(filePath) || 0;

      // Check both size and mtime — some FSes update mtime without size change briefly
      if (stats.size > lastSize || stats.mtimeMs > lastMtime) {
        if (stats.size > lastSize) {
          // Read only the new data
          const fd = fs.openSync(filePath, 'r');
          const newBytes = Buffer.alloc(stats.size - lastSize);
          fs.readSync(fd, newBytes, 0, newBytes.length, lastSize);
          fs.closeSync(fd);

          const newContent = newBytes.toString('utf-8');
          const newLines = newContent.trim().split('\n').filter(l => l.trim());

          this.emit('newEntries', { filePath, lines: newLines });
        } else {
          // mtime changed but size didn't (possible rewrite) — signal a change
          this.emit('newEntries', { filePath, lines: [] });
        }

        this.lastSizes.set(filePath, stats.size);
        this.lastMtimes.set(filePath, stats.mtimeMs);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Watch ~/.claude/projects/ for new session files (polls every 3s)
   */
  watchProjectsDir(): void {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) { return; }

    this.projectPollTimer = setInterval(() => {
      // Find newest file
      const newest = this.findActiveSession();
      if (newest) {
        this.emit('newSession', newest);
      }
    }, 3000);
  }

  /**
   * Find the most recently modified JSONL file (likely the active session)
   */
  findActiveSession(): string | null {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!fs.existsSync(projectsDir)) { return null; }

    let newestFile: string | null = null;
    let newestTime = 0;

    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory() && entry.name !== 'subagents') {
            walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
            const stats = fs.statSync(fullPath);
            if (stats.mtimeMs > newestTime) {
              newestTime = stats.mtimeMs;
              newestFile = fullPath;
            }
          }
        }
      } catch { /* ignore permission errors */ }
    };

    walk(projectsDir);
    return newestFile;
  }

  dispose(): void {
    for (const [, timer] of this.pollTimers) {
      clearInterval(timer);
    }
    this.pollTimers.clear();
    this.lastSizes.clear();
    this.lastMtimes.clear();
    if (this.projectPollTimer) {
      clearInterval(this.projectPollTimer);
    }
  }
}
