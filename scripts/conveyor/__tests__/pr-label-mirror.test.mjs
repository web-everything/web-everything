import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planMirror, renderPlan, runMirrorReport } from '../pr-label-mirror.mjs';
import { buildDerivedRows } from '../../review-ledger-check.mjs';

const fam = (family, missing = [], extra = []) => ({ family, missing, extra, agree: !missing.length && !extra.length });
const row = (pr, families, status = 'mismatch', lifecycleState = 'X') => ({ pr, status, lifecycleState, families });

describe('planMirror', () => {
  it('lists the exact add and remove set, sorted, and skips in-sync and unreadable PRs', () => {
    const plan = planMirror([
      row(1, [fam('review', ['review:accepted'], ['review:pending']), fam('ruling-needed', [], ['advisory:ruling-needed'])]),
      row(2, [fam('review')], 'agree'),
      row(3, [], 'unreadable', null),
      row(4, [fam('ready-to-merge', ['ready-to-merge'])]),
    ]);
    expect(plan.changes).toEqual([
      { pr: 1, lifecycleState: 'X', add: ['review:accepted'], remove: ['advisory:ruling-needed', 'review:pending'] },
      { pr: 4, lifecycleState: 'X', add: ['ready-to-merge'], remove: [] },
    ]);
    expect(plan).toMatchObject({ mode: 'report', writes: 0, total: 4, inSync: 1, unreadable: 1, counts: { add: 2, remove: 2 } });
    expect(renderPlan(plan)).toContain('#1 (X): add [review:accepted] remove [advisory:ruling-needed, review:pending]');
  });
});

describe('runMirrorReport (fixture dry run)', () => {
  it('derives from fixtures through slice F and plans only a diff', async () => {
    const prs = [{ number: 7, labels: [{ name: 'review:pending' }, { name: 'bug' }] }, { number: 8, labels: [] }];
    const facts = { headSha: 'a'.repeat(40), labels: [], checks: [], requiredChecks: [], probeErrors: [] };
    const plan = await runMirrorReport({
      repo: 'web-everything/web-everything',
      listPrs: () => prs,
      readEvents: async () => ({ status: 'ok', rows: [], store: { name: 'home', shared: false } }),
      buildRows: (o) => buildDerivedRows({ ...o, readFacts: (n) => (n === 8 ? null : facts) }),
    });
    expect(plan.writes).toBe(0);
    expect(plan.unreadable).toBe(1);
    expect(plan.changes.find((c) => c.pr === 7)?.remove).toContain('review:pending');
    expect(JSON.stringify(plan)).not.toContain('bug');
  });
});

describe('report only', () => {
  it('the source has no label write, comment, or gh mutation', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pr-label-mirror.mjs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const bad of ['setLabels', 'ensureLabel', 'createGhProvider', '--add-label', '--remove-label', 'pr edit', 'pr comment', 'writeRun', 'execFileSync']) {
      expect(src).not.toContain(bad);
    }
  });
});


describe('shared-store mirror reporting', () => {
  it('unreadable ledger plans nothing and retains the store failure', async () => {
    const store = { name: 'git', shared: true };
    const plan = await runMirrorReport({ store: 'git',
      listPrs: async () => [{ number: 7, labels: [{ name: 'review:pending' }] }],
      readEvents: async (_repo, opts) => { expect(opts.store).toBe('git'); return { status: 'unreadable', store, reason: 'no-board', error: 'missing board' }; },
      buildRows: (opts) => buildDerivedRows({ ...opts, readFacts: () => ({}) }) });
    expect(plan).toMatchObject({ store, ledgerUnreadable: { reason: 'no-board', error: 'missing board' }, unreadable: 1, inSync: 0, changes: [], counts: { add: 0, remove: 0 } });
    expect(renderPlan(plan)).toContain('ledger store: git (shared)');
    expect(renderPlan(plan)).toContain('no-board');
  });
  it('home report explicitly declares that other machines are invisible', async () => {
    const plan = await runMirrorReport({ listPrs: () => [], readEvents: async () => ({ status: 'ok', rows: [], store: { name: 'home', shared: false } }) });
    expect(renderPlan(plan)).toContain('ledger store: home (NOT shared - rows written on other machines are invisible here)');
  });
});
