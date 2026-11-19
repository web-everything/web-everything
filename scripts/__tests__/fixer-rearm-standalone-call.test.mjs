/**
 * @file scripts/__tests__/fixer-rearm-standalone-call.test.mjs
 * @description #6399 — the fixer's hand-back `rearm-review.mjs` must be its OWN Bash call, starting with `node`.
 * The per-session allow rule is the prefix `Bash(node <root>/scripts/conveyor/rearm-review.mjs:*)`; a command
 * that starts with `cd`, or chains other commands (`&&`, `;`, `|`, newline), does not match it and falls to the
 * auto-mode classifier, which denied it live (blocked-on-permission). The brief must not teach the chain.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/check-standards-rules-fixtures.mjs';

const body = readFileSync(join(ROOT, 'skills-src/conveyor/fix-agent-brief.md'), 'utf8');

describe('fix-agent-brief hand-back: rearm-review.mjs is a standalone call', () => {
  it('no example line chains rearm-review.mjs with another command', () => {
    const lines = body.split('\n').filter((l) => /^\s*(>\s*)?node\s+"\{\{WE_ROOT\}\}\/scripts\/conveyor\/rearm-review\.mjs"/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).not.toMatch(/&&|;|\||\\$/);
  });
  it('tells the fixer to run it alone, never behind cd or chained', () => {
    expect(body).toMatch(/rearm-review\.mjs` as its OWN Bash call/);
    expect(body).toMatch(/never behind `cd`/);
  });
});
