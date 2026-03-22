import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const triageSrc = readFileSync(resolve(__dirname, '../../src/triage.ts'), 'utf-8');

describe('triage query correctness', () => {
  it('Chrome API count query uses "count" alias matching ApiCountRow.count', () => {
    // Bug: SQL used "n" alias but TypeScript type had "count" field → "undefinedx"
    expect(triageSrc).toContain("count(*) count FROM hooks");
    expect(triageSrc).not.toMatch(/count\(\*\) n FROM hooks/);
  });

  it('uses a.count for display (not a.n)', () => {
    expect(triageSrc).toContain('a.count');
    expect(triageSrc).not.toContain('a.n}');
  });
});
