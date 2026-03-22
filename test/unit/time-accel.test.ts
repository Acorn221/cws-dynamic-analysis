import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const timeAccelPath = resolve(__dirname, '../../src/scenario/time-accel.ts');
const timeAccelSource = readFileSync(timeAccelPath, 'utf-8');

describe('time-accel safety', () => {
  // The root cause of the ~40% SW capture failure was time-accel.ts
  // replacing globalThis.Date constructor, which crashed service workers.

  it('should NOT replace globalThis.Date constructor', () => {
    // The Date constructor replacement broke Chrome internal APIs.
    // Only Date.now should be overridden.
    expect(timeAccelSource).not.toContain('globalThis.Date = function');
    expect(timeAccelSource).not.toContain('globalThis.Date=function');
  });

  it('should override Date.now', () => {
    expect(timeAccelSource).toContain('Date.now = function');
  });

  it('should save original Date idempotently', () => {
    expect(timeAccelSource).toContain('__cwsOrigDate');
    expect(timeAccelSource).toContain('if (!globalThis.__cwsOrigDate)');
  });

  it('should NOT call chrome.alarms.onAlarm.dispatch()', () => {
    // dispatch() doesn't exist on Chrome extension event objects and crashes SWs
    expect(timeAccelSource).not.toContain('.dispatch(');
    expect(timeAccelSource).not.toContain('.dispatch (');
  });

  it('alarm acceleration should use try/catch', () => {
    expect(timeAccelSource).toContain('try {');
    expect(timeAccelSource).toContain('return orig.call(this, name, info)');
  });

  it('alarm acceleration should check for orig existence', () => {
    expect(timeAccelSource).toContain('if (!orig) return');
  });
});
