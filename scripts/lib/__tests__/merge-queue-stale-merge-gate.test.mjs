// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import * as q from '../merge-queue-enqueue.mjs';
import { parsePrResultTable } from '../merge-gate-hold-class.mjs';
import { classifyPr } from '../../merge-ai-prs.mjs';
const head = 'a'.repeat(40);
const hold = (id, reason = 'held') => ({ status: 'hold', id, reason });
const verdict = results => ({ num: 5006, ok: false, head_sha: head, completed_at: '2026-10-12T11:54:00Z', results });
const freezeRow = hold('red-main-freeze', 'main is RED (freeze: manual freeze: merge-queue switch)');
const freeze = { frozen: false, publishedAt: '2026-10-12T12:49:00Z' };
const classify = (results, extra = {}) => q.classifyStaleMergeGate({ verdict: verdict(results), headSha: head, landableApartFromMergeState: true, freeze, ...extra });
const green = name => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const pr = { number: 5006, headRefOid: head, headRefName: 'lane/test', body: 'A real description', labels: [{ name: 'ready-to-merge' }], mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', statusCheckRollup: [green('test'), { ...green('merge-gate'), conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/456' }] };
function options(extra = {}) { return { c: { num: 5006, repo: 'o/r', headRef: 'lane/test', ...classifyPr(pr, { queueRequiredChecks: ['test', 'merge-gate'] }) }, pr, requiredChecks: ['test', 'merge-gate'], classifyPr, setting: 'on', readVerdict: vi.fn(() => verdict([freezeRow])), readFreeze: () => freeze, readAcceptance: vi.fn(), cloneDir: '/clone', statePath: '/unused', readState: () => ({}), record: vi.fn(), refreshStalePr: vi.fn(async () => ({ ok: true, action: 'rerun', newCommit: head })), ...extra }; }
describe('stale merge-gate refresh', () => {
  it('5006: requires a readable manual freeze clear newer than completion', () => {
    expect(classify([freezeRow]).stale).toBe(true);
    for (const f of [{ ...freeze, frozen: true }, { ...freeze, publishedAt: '2026-10-12T11:00:00Z' }, { error: 'unreadable' }]) expect(classify([freezeRow], { freeze: f }).stale).toBe(false);
  });
  it('4965: candidacy and test-gaming require clearance on this head', () => {
    const rows = ['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance', 'test-gaming'].map(id => hold(id)); rows.push(hold('ledger', 'labels: labels hold'));
    expect(classify(rows, { humanClearedSha: head }).stale).toBe(true);
    expect(classify(rows, { humanClearedSha: 'old' })).toMatchObject({ stale: false, reason: expect.stringContaining('test-gaming not cleared on this head') });
    expect(classify([hold('review-acceptance', 'human-only: workflow edit')]).stale).toBe(false);
    expect(classify([hold('review-acceptance', 'human-only: workflow edit')], { humanClearedSha: head }).stale).toBe(true);
  });
  it('fails closed on real holds, fail-closed, mismatched heads and unparsable logs', () => {
    for (const row of [hold('codeql'), hold('manifest-baseline'), { ...hold('candidate-label'), status: 'fail-closed' }]) expect(classify([row]).stale).toBe(false);
    expect(classify([freezeRow], { headSha: 'other' }).stale).toBe(false);
    expect(classify([], { verdict: parsePrResultTable('bad log', 5006) }).stale).toBe(false);
    expect(classify([hold('candidate-label')], { landableApartFromMergeState: false }).stale).toBe(false);
  });
  it('resolves the new setting through each cascade layer', () => {
    const setting = value => ({ mergeQueue: { refreshOnStaleMergeGate: value } });
    for (const [env, settings, platform, value, source] of [[{ WE_MERGE_QUEUE_REFRESH_ON_STALE_MERGE_GATE: 'off' }, setting('on'), {}, 'off', 'env'], [{}, setting('off'), {}, 'off', 'settings'], [{}, {}, setting('off'), 'off', 'platform'], [{}, {}, {}, 'on', 'standard']]) expect(q.resolveRefreshOnStaleMergeGate({ env, settings, platform })).toMatchObject({ value, source });
  });
  it('refreshes the run once per head and records through the shared writer', async () => {
    let state = {}; const o = options({ record: (_p, key, entry) => { state[key] = entry; }, readState: () => state });
    expect((await q.handleStaleMergeGate(o)).reason).toContain('refresh rerun');
    expect(o.refreshStalePr).toHaveBeenCalledWith({ laneRef: 'lane/test', root: '/clone', repo: 'o/r', runId: 123, expectedHead: head });
    expect((await q.handleStaleMergeGate(o)).reason).toContain('already');
    expect(o.refreshStalePr).toHaveBeenCalledTimes(1);
    expect(q.decideStaleMergeGateRefresh({ key: 'k', headSha: 'new', setting: 'on', state: { k: { fromHead: head, newHead: 'new' } } }).action).toBe('skip');
  });
  it.each([{ setting: 'off' }, { dryRun: true }])('makes no refresh or writes: %j', async extra => {
    const o = options(extra); await q.handleStaleMergeGate(o); expect(o.refreshStalePr).not.toHaveBeenCalled(); expect(o.record).not.toHaveBeenCalled();
  });
  it('requires all other gates and required checks, including later body/review gates', async () => {
    for (const extra of [{ body: '' }, { reviewDecision: 'REVIEW_REQUIRED' }, { labels: [{ name: 'ready-to-merge' }, { name: 'review:changes' }] }, { statusCheckRollup: pr.statusCheckRollup.map(r => ({ ...r, conclusion: 'FAILURE' })) }]) {
      const o = options({ pr: { ...pr, ...extra } }); expect((await q.handleStaleMergeGate(o)).handled).toBe(false); expect(o.readVerdict).not.toHaveBeenCalled();
    }
  });
  it('reads clearance once, reuses supplied evidence, and restamps after a rebase', async () => {
    const next = 'b'.repeat(40);
    const o = options({ readVerdict: () => verdict([hold('test-gaming')]),
      readAcceptance: vi.fn(() => ({ headSha: head, humanClearedSha: head })),
      refreshStalePr: vi.fn(async () => ({ ok: true, action: 'rebased', newCommit: next })),
      needsAcceptanceRestamp: () => true, restampAcceptance: vi.fn(() => ({ ok: true })) });
    expect((await q.handleStaleMergeGate(o)).reason).toContain('refresh rebased');
    expect(o.readAcceptance).toHaveBeenCalledTimes(1);
    expect(o.restampAcceptance).toHaveBeenCalledWith({ pr: 5006, repo: 'o/r', newHead: next, cwd: undefined });
    await q.handleStaleMergeGate({ ...o, acceptance: { headSha: head, humanClearedSha: head } });
    expect(o.readAcceptance).toHaveBeenCalledTimes(1);
    const uncleared = await q.handleStaleMergeGate({ ...o, acceptance: { headSha: head } });
    expect(uncleared).toMatchObject({ handled: false, reason: expect.stringContaining('not cleared on this head') });
  });
  it('preserves skips on unreadable, wrong-head, or superseded evidence', async () => {
    for (const readVerdict of [() => ({ error: 'bad log' }), () => ({ ...verdict([freezeRow]), head_sha: 'old' }), () => { throw new Error('offline'); }]) {
      const o = options({ readVerdict }); expect((await q.handleStaleMergeGate(o)).handled).toBe(false); expect(o.refreshStalePr).not.toHaveBeenCalled();
    }
    for (const conclusion of ['SUCCESS', null]) {
      const o = options({ pr: { ...pr, statusCheckRollup: [...pr.statusCheckRollup, { ...green('merge-gate'), conclusion, status: conclusion ? 'COMPLETED' : 'IN_PROGRESS', startedAt: '2099-01-01T00:00:00Z' }] } });
      expect((await q.handleStaleMergeGate(o)).handled).toBe(false); expect(o.readVerdict).not.toHaveBeenCalled();
    }
  });
  it('uses a separate atomic ledger bounded to 500 PRs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stale-gate-'));
    try {
      const path = q.staleMergeGateRefreshStatePath({ WE_COORDINATION_ROOT: dir });
      expect(path).toBe(join(dir, 'drain-stale-merge-gate-refresh.json'));
      const state = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [String(i), { at: new Date(i * 1000).toISOString() }]));
      writeFileSync(path, JSON.stringify(state));
      q.recordRequiredWorkflowsRefresh(path, 'new', { fromHead: head, newHead: null, action: 'rerun', at: new Date(600000).toISOString() });
      const out = q.readRequiredWorkflowsRefreshState(path);
      expect(Object.keys(out)).toHaveLength(500); expect(out['0']).toBeUndefined();
      expect(q.decideStaleMergeGateRefresh({ key: 'new', headSha: head, state: out, setting: 'on' }).action).toBe('skip');
      expect(readdirSync(dir)).toEqual(['drain-stale-merge-gate-refresh.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('wires recovery after the cascade and leaves green admission to existing relief', () => {
    const source = readFileSync('scripts/merge-ai-prs.mjs', 'utf8');
    expect(source.indexOf('await handleStaleMergeGate')).toBeGreaterThan(source.indexOf('if (!progressed) break;'));
    expect(source).toContain('classifyOptions: { requiredCheck: REQUIRED');
    const fresh = { ...pr, statusCheckRollup: [green('test'), green('merge-gate')] };
    expect(classifyPr(fresh, { queueRequiredChecks: ['test', 'merge-gate'] })).toMatchObject({ decision: 'merge', queueBlockedRelief: true });
  });

});
