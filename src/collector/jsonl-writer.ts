import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Streaming JSONL writer — appends one JSON object per line.
 * Handles backpressure and graceful close.
 */
export class JsonlWriter {
  private stream: WriteStream | null = null;
  private path: string;
  private lineCount = 0;

  constructor(path: string) {
    this.path = path;
  }

  async open(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.stream = createWriteStream(this.path, { flags: 'a', encoding: 'utf-8' });
  }

  write(data: Record<string, unknown>): void {
    if (!this.stream) throw new Error('Writer not opened');
    this.stream.write(JSON.stringify(data) + '\n');
    this.lineCount++;
  }

  getLineCount(): number {
    return this.lineCount;
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.stream) return resolve();
      this.stream.end(() => resolve());
      this.stream.on('error', reject);
    });
  }
}
