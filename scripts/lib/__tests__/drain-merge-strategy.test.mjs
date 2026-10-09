// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDrainMergeStrategy, resolveDrainMergePolicy, readEnqueueClearance, buildClearanceComment, hasClearanceFor, DRY_RUN_STRATEGY_ENV,
} from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';

const HEAD = 'b'.repeat(40);
const LOCAL = 'web-everything/web-everything';
const policyOf = (strategy) => ({ policy: resolveMergeDeliveryPolicy({ tool: strategy ? { strategy } : undefined }), note: null });

function harness({ strategy = null, dryRun = false, initial = null, ghView = {} , enqueueFails = false } = {}) {
  const calls = [];
  const logs = [];
  let stored = initial;
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'pr' && args[1] === 'merge') throw new Error('merge API must never be called');
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('id')) return '{"id":"PR_NODE"}';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(ghView[args[2]] ?? { state: 'OPEN' });
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (enqueueFails) return JSON.stringify({ errors: [{ message: 'Pull request is not mergeable' }] });
      return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } });
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const readFile = () => { if (stored == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return JSON.stringify(stored); };
  const writeState = (_p, s) => { stored = JSON.parse(JSON.stringify(s)); };
  const s = createDrainMergeStrategy({
    dryRun, isLocalRepo: (r) => r == null || r === LOCAL, localSlug: LOCAL, exec, statePath: '/x/state.json',
    resolved: policyOf(strategy), log: { write: (l) => logs.push(l) }, readFile, writeState,
  });
  return { s, calls, logs, state: () => stored };
}

describe('drain merge strategy — drain-direct (default) is unchanged', () => {
  it('never enqueues, never skips freshness, makes no gh call, and logs strategy + source once', () => {
    const { s, calls, logs } = harness();
    expect(s.strategy).toBe('drain-direct');
    expect(s.enqueues(null)).toBe(false);
    expect(s.queueOwnsFreshness(null)).toBe(false);
    expect(s.reportDryRun([{ num: 1, repo: null }])).toEqual({ enqueue: [], direct: [] });
    const merged = [];
    expect(s.collectQueueMerged({ merged, landedThisPass: new Set() })).toEqual([]);
    expect(merged).toEqual([]);
    expect(calls).toEqual([]);
    expect(logs.filter((l) => l.includes('merge-delivery policy: strategy=drain-direct (standard)'))).toHaveLength(1);
  });
});

describe('drain merge strategy — github-merge-queue', () => {
  it('enqueues only the local repo PRs (sibling-repo impl halves stay direct)', () => {
    const { s } = harness({ strategy: 'github-merge-queue' });
    expect(s.enqueues(null)).toBe(true);
    expect(s.enqueues(LOCAL)).toBe(true);
    expect(s.enqueues('web-everything/frontierui')).toBe(false);
    expect(s.queueOwnsFreshness(null)).toBe(true);
  });

  it('stamps the clearance, enqueues pinned to the judged head, records the follow-up, never calls the merge API', () => {
    const { s, calls, state } = harness({ strategy: 'github-merge-queue' });
    const r = s.enqueue({ num: 42, repo: null, item: 'x1', hasManifest: true, headRef: 'lane/a', title: 't' }, HEAD, { comments: [] });
    expect(r).toEqual({ enqueued: true, already: false });
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'merge')).toBe(false);
    const comment = calls.find((c) => c[1] === 'pr' && c[2] === 'comment');
    expect(comment).toContain(buildClearanceComment(HEAD));
    const gql = calls.find((c) => c[1] === 'api');
    expect(gql).toEqual(expect.arrayContaining(['id=PR_NODE', `sha=${HEAD}`]));
    expect(calls.findIndex((c) => c[2] === 'comment')).toBeLessThan(calls.findIndex((c) => c[1] === 'api'));
    expect(state().pending).toEqual([expect.objectContaining({ num: 42, repo: null, headSha: HEAD, item: 'x1' })]);
  });

  it('does not re-stamp a clearance already on the PR for this head', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue' });
    s.enqueue({ num: 42, repo: null }, HEAD, { comments: [{ body: buildClearanceComment(HEAD) }] });
    expect(calls.some((c) => c[2] === 'comment')).toBe(false);
  });

  it('an enqueue failure throws loudly and never falls back to a direct merge', () => {
    const { s, calls, state } = harness({ strategy: 'github-merge-queue', enqueueFails: true });
    expect(() => s.enqueue({ num: 42, repo: null }, HEAD, { comments: [] })).toThrow(/enqueue FAILED .*NOT merged directly/);
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'merge')).toBe(false);
    expect(state()).toBeNull();
  });

  it('refuses an unpinned head and a sibling-repo PR', () => {
    const { s } = harness({ strategy: 'github-merge-queue' });
    expect(() => s.enqueue({ num: 1, repo: null }, null)).toThrow(/no pinned head/);
    expect(() => s.enqueue({ num: 1, repo: 'web-everything/frontierui' }, HEAD)).toThrow(/outside github-merge-queue/);
  });

  it('runs the follow-up exactly once per GitHub-merged PR; keeps queued ones; drops closed ones', () => {
    const initial = { pending: [
      { num: 1, repo: null, headSha: HEAD, item: 'x1', hasManifest: true },
      { num: 2, repo: null, headSha: HEAD },
      { num: 3, repo: null, headSha: HEAD },
    ], followedUp: [] };
    const ghView = { 1: { state: 'MERGED', mergedAt: '2026-10-09T22:00:00Z', mergeCommit: { oid: 'c'.repeat(40) } }, 2: { state: 'OPEN' }, 3: { state: 'CLOSED' } };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView });
    const merged = [];
    const landed = new Set();
    h.s.collectQueueMerged({ merged, landedThisPass: landed, landedIdsFor: (p) => (p.item ? [p.item] : []) });
    expect(merged).toEqual([expect.objectContaining({ num: 1, mergedBy: 'github-merge-queue' })]);
    expect([...landed]).toEqual(['x1']);
    expect(h.state().pending.map((p) => p.num)).toEqual([2]);
    expect(h.state().followedUp).toEqual(['cwd#1']);
    // next pass: nothing new merged → no second follow-up
    const merged2 = [];
    h.s.collectQueueMerged({ merged: merged2, landedThisPass: new Set() });
    expect(merged2).toEqual([]);
  });

  it('a PR already followed up is not followed up again even if it is still pending (crash between steps)', () => {
    const initial = { pending: [{ num: 1, repo: null }], followedUp: ['cwd#1'] };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView: { 1: { state: 'MERGED', mergedAt: 'z' } } });
    const merged = [];
    h.s.collectQueueMerged({ merged, landedThisPass: new Set() });
    expect(merged).toEqual([]);
    expect(h.state().pending).toEqual([]);
  });

  it('dry run lists exactly the PRs it would enqueue and calls no GitHub API', () => {
    const h = harness({ strategy: 'github-merge-queue', dryRun: true });
    const out = h.s.reportDryRun([{ num: 5, repo: null }, { num: 9, repo: 'web-everything/frontierui' }, { num: 7, repo: LOCAL }]);
    expect(out.enqueue.map((c) => c.num)).toEqual([5, 7]);
    expect(out.direct.map((c) => c.num)).toEqual([9]);
    expect(h.calls).toEqual([]);
    expect(h.logs.join('')).toMatch(/would ENQUEUE #5, web-everything\/web-everything#7 — merge API not called/);
    expect(() => h.s.enqueue({ num: 5, repo: null }, HEAD)).toThrow(/dry run/);
  });
});

describe('dry-run strategy override', () => {
  const load = () => resolveMergeDeliveryPolicy({});
  it('is honoured only with --dry-run', () => {
    const env = { [DRY_RUN_STRATEGY_ENV]: 'github-merge-queue' };
    expect(resolveDrainMergePolicy({ dryRun: true, env, load }).policy.strategy).toBe('github-merge-queue');
    const live = resolveDrainMergePolicy({ dryRun: false, env, load });
    expect(live.policy.strategy).toBe('drain-direct');
    expect(live.note).toMatch(/ignored/);
  });
  it('ignores an invalid value', () => {
    const r = resolveDrainMergePolicy({ dryRun: true, env: { [DRY_RUN_STRATEGY_ENV]: 'yolo' }, load });
    expect(r.policy.strategy).toBe('drain-direct');
    expect(r.note).toMatch(/not one of/);
  });
});

describe('enqueue clearance reader (for merge-gate)', () => {
  const comments = [{ author: { login: 'drain-bot' }, body: buildClearanceComment(HEAD) }];
  it('covers the head only for a trusted author', () => {
    expect(readEnqueueClearance({ comments, headSha: HEAD, trustedAuthors: ['drain-bot'] }).coversHead).toBe(true);
    expect(readEnqueueClearance({ comments, headSha: HEAD, trustedAuthors: ['someone-else'] }).coversHead).toBe(false);
  });
  it('fails closed with no trust list, a different head, or no head', () => {
    expect(readEnqueueClearance({ comments, headSha: HEAD }).coversHead).toBe(false);
    expect(readEnqueueClearance({ comments, headSha: 'c'.repeat(40), trustedAuthors: ['drain-bot'] }).coversHead).toBe(false);
    expect(readEnqueueClearance({ comments, trustedAuthors: ['drain-bot'] }).coversHead).toBe(false);
  });
  it('dedupe check matches any author', () => {
    expect(hasClearanceFor([{ body: buildClearanceComment(HEAD) }], HEAD)).toBe(true);
    expect(hasClearanceFor([], HEAD)).toBe(false);
  });
});

describe('merge-ai-prs hook wiring', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'merge-ai-prs.mjs'), 'utf8');
  it('enqueue returns inside the land lock BEFORE the merge API call', () => {
    const lock = src.slice(src.indexOf('const landLock = withLandWriteLock('), src.indexOf('if (landLock.contended'));
    const enq = lock.indexOf('if (mergeStrategy.enqueues(c.repo)) return mergeStrategy.enqueue(');
    expect(enq).toBeGreaterThan(-1);
    expect(enq).toBeLessThan(lock.indexOf('mergePr('));
  });
  it('a queued PR is never recorded as merged by the cascade', () => {
    const i = src.indexOf("if (mergeStrategy.enqueues(c.repo)) { const cc = remaining.find");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(src.indexOf('merged.push({ num: c.num, repo: c.repo, headSha: c.headSha ?? null }); progressed = true;'));
  });
  it('follow-up collection runs before the post-land steps read `merged`', () => {
    expect(src.indexOf('mergeStrategy.collectQueueMerged(')).toBeLessThan(src.indexOf('const landedLocal = !DRY_RUN && merged.some('));
  });
});
