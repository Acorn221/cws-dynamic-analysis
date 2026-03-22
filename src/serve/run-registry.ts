/**
 * Run registry — discovers and tracks active analysis runs by scanning
 * output directories for run-state.json files.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunState } from './run-state.js';
import { logger } from '../logger.js';

const log = logger.child({ component: 'registry' });

export class RunRegistry {
  private baseDir: string;
  private runs = new Map<string, RunState>();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /** Scan for active and recent runs */
  async refresh(): Promise<void> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stateFile = join(this.baseDir, entry.name, 'run-state.json');
        try {
          const data = JSON.parse(await readFile(stateFile, 'utf-8')) as RunState;

          // Check if still alive (for running processes)
          if (data.status === 'running' && data.pid) {
            try {
              process.kill(data.pid, 0); // signal 0 = check if alive
            } catch {
              data.status = 'failed'; // process died
            }
          }

          this.runs.set(data.runId ?? entry.name, data);
        } catch {
          // No run-state.json or invalid — skip
        }
      }
    } catch {
      // Base dir doesn't exist yet — fine
    }
  }

  /** Get all known runs, most recent first */
  getRuns(): RunState[] {
    return [...this.runs.values()]
      .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  /** Get active (running) runs only */
  getActiveRuns(): RunState[] {
    return this.getRuns().filter((r) => r.status === 'running');
  }

  /** Get a specific run by ID */
  getRun(runId: string): RunState | undefined {
    return this.runs.get(runId);
  }
}
