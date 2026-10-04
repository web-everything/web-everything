// #5000 — main CI finishes every run it starts. A merge every few minutes used to cancel almost every run on
// main (85 of 100 on 2026-10-03), so main's red/green went unseen for hours. PR branches may still cancel.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ciYml = readFileSync(join(here, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');

function concurrencyBlock(text) {
  const m = text.match(/^concurrency:\n((?:[ \t]+.*\n|[ \t]*#.*\n)+)/m);
  return m ? m[1] : '';
}

describe('CI concurrency (#5000)', () => {
  it('never cancels an in-progress run on main', () => {
    const block = concurrencyBlock(ciYml);
    const line = block.split('\n').find((l) => /^\s*cancel-in-progress:/.test(l)) ?? '';
    expect(line, 'cancel-in-progress must be set').not.toBe('');
    expect(line).not.toMatch(/cancel-in-progress:\s*true\s*$/);
    expect(line).toMatch(/github\.ref\s*!=\s*'refs\/heads\/main'/);
  });

  it('keeps one group per ref, so PR branches still cancel superseded runs', () => {
    expect(concurrencyBlock(ciYml)).toMatch(/group:\s*ci-\$\{\{\s*github\.ref\s*\}\}/);
  });
});
