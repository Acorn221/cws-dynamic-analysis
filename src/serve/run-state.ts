/**
 * Run state file — written by the analyzer, read by the dashboard.
 * This is the sole coupling point between `da run` and `da serve`.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface RunState {
  runId: string;
  extensionId: string;
  wsEndpoint: string;
  outputDir: string;
  phase: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  updatedAt: string;
  pid: number;
  stats?: {
    totalRequests: number;
    extensionRequests: number;
    flaggedRequests: number;
    canaryDetections: number;
  };
}

const STATE_FILE = 'run-state.json';

export async function writeRunState(outputDir: string, state: Partial<RunState>): Promise<void> {
  const existing = await readRunState(outputDir).catch(() => ({}));
  const merged = { ...existing, ...state, updatedAt: new Date().toISOString() };
  await writeFile(join(outputDir, STATE_FILE), JSON.stringify(merged, null, 2));
}

export async function readRunState(outputDir: string): Promise<RunState> {
  const { readFile } = await import('node:fs/promises');
  return JSON.parse(await readFile(join(outputDir, STATE_FILE), 'utf-8'));
}
