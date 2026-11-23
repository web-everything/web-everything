import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import b, { probe } from './orphan-guard-bounded-per-pr.mjs';
import { defineBreakTest } from '../define-break-test.mjs';

defineBreakTest(b);

describe('bounded orphan-guard replay', () => {
  // Require a green current tree even when historical replay would be expected-fail.
  it('bounds redispatches, stops at the deadline, and resumes with minimum progress', () => {
    expect(b.judge(b.run({}))).toEqual([]);
  });

  it.each(['unlimited-redispatch', 'legacy-options', 'ignored-deadline'])('rejects the %s regression behaviorally', regression => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-guard-regression-'));
    try {
      mkdirSync(join(dir, 'scripts/conveyor'), { recursive: true });
      const source = new URL('../../orphan-fix-round.mjs', import.meta.url).href;
      writeFileSync(join(dir, 'scripts/conveyor/orphan-fix-round.mjs'), `
        import { runOrphanFixRoundPass as realPass } from ${JSON.stringify(source)};
        export async function runOrphanFixRoundPass(options) {
          ${regression === 'ignored-deadline' ? 'return realPass({ ...options, deadlineAt: Infinity });' : ''}
          const { deadlineAt, now, cursor, reconcile, ...legacy } = options;
          const base = ${regression === 'legacy-options' ? 'legacy' : 'options'};
          // Separate per-PR passes remove the shared one-redispatch limit.
          const result = { enabled: true, rows: [], handled: 0, deferred: [], nextCursor: null };
          for (const repo of base.repos) {
            for (const pr of base.listBounced(repo.slug).sort((a, b) => a.number - b.number)) {
              if (base.cursor && pr.number < base.cursor.pr) continue;
              if (result.handled > 0 && base.now && base.now() >= base.deadlineAt) {
                result.deferred.push({ repo: repo.slug, pr: pr.number });
                continue;
              }
              const one = await realPass({ ...base, repos: [repo], listBounced: () => [pr] });
              result.rows.push(...one.rows);
              result.handled += one.handled;
            }
          }
          result.nextCursor = result.deferred[0] ?? null;
          return ${regression === 'legacy-options' ? '{ enabled: result.enabled, rows: result.rows }' : 'result'};
        }
      `);
      const report = probe(dir);
      expect(report.violations.length).toBeGreaterThan(0);
      if (regression === 'unlimited-redispatch') {
        expect(report.violations.join('\n')).toContain('at most one redispatch call in a pass');
      }
      if (regression === 'ignored-deadline') {
        expect(report.violations.join('\n')).toContain('deadline must prevent another non-redispatch PR read');
      }
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable checkout as missing fix evidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orphan-guard-missing-'));
    try {
      expect(b.fixPresent(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
