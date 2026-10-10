// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDrainMergeStrategy, resolveDrainMergePolicy, readEnqueueClearance, buildClearanceComment, hasClearanceFor, DRY_RUN_STRATEGY_ENV,
  readQueueState, FOLLOW_UP_MAX_ATTEMPTS,
} from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';

const HEAD = 'b'.repeat(40);
const LOCAL = 'web-everything/web-everything';
const policyOf = (strategy) => ({ policy: resolveMergeDeliveryPolicy({ tool: strategy ? { strategy } : undefined }), note: null });

const DRAIN = 'drain-bot';

function harness({ strategy = null, dryRun = false, initial = null, ghView = {} , enqueueFails = false, onView = {}, viewThrows = [], selfLogin = DRAIN, withLock } = {}) {
  const calls = [];
  const logs = [];
  let stored = initial;
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'pr' && args[1] === 'merge') throw new Error('merge API must never be called');
    if (args[0] === 'pr' && args[1] === 'comment') return '';
    if (args[0] === 'api' && args[1] === 'user') { if (selfLogin == null) throw new Error('gh: not logged in'); return `${selfLogin}\n`; }
    if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : ''; // the pinned change list of the judged head
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('id,headRefOid,baseRefName')) return JSON.stringify({ id: 'PR_NODE', headRefOid: HEAD, baseRefName: 'main' });
    if (args[0] === 'pr' && args[1] === 'view' && viewThrows.includes(Number(args[2]))) throw new Error('gh: HTTP 502');
    if (args[0] === 'pr' && args[1] === 'view') { onView[args[2]]?.(); return JSON.stringify(ghView[args[2]] ?? { state: 'OPEN' }); }
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
    resolved: policyOf(strategy), log: { write: (l) => logs.push(l) }, readFile, writeState, ...(withLock ? { withLock } : {}),
  });
  // `peer` = a second drain process writing the same state file (its own enqueue) at any moment, as `onView` does mid-collect.
  const peerEnqueue = (entry) => { const cur = stored ? JSON.parse(JSON.stringify(stored)) : { pending: [], followedUp: [] }; cur.pending.push(entry); stored = cur; };
  return { s, calls, logs, state: () => stored, peerEnqueue, setState: (v) => { stored = v; } };
}

const MERGED = { state: 'MERGED', mergedAt: '2026-10-09T22:00:00Z', mergeCommit: { oid: 'c'.repeat(40) } };
const stampedBy = (login) => [{ author: { login }, body: buildClearanceComment(HEAD) }];

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
    const gql = calls.find((c) => c[1] === 'api' && c[2] === 'graphql');
    expect(gql).toEqual(expect.arrayContaining(['id=PR_NODE', `sha=${HEAD}`]));
    expect(calls.findIndex((c) => c[2] === 'comment')).toBeLessThan(calls.findIndex((c) => c[1] === 'api' && c[2] === 'graphql'));
    expect(state().pending).toEqual([expect.objectContaining({ num: 42, repo: null, headSha: HEAD, item: 'x1' })]);
  });

  it('does not re-stamp a clearance already on the PR for this head', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue' });
    s.enqueue({ num: 42, repo: null }, HEAD, { comments: stampedBy(DRAIN) });
    expect(calls.some((c) => c[2] === 'comment')).toBe(false);
  });

  it('an untrusted author planting the marker first does NOT suppress the drain stamp (review F3)', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue' });
    s.enqueue({ num: 42, repo: null }, HEAD, { comments: stampedBy('some-pr-author') });
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'comment')).toBe(true);
  });

  it('a marker with no author at all, or when the drain identity cannot be read, still gets stamped (fail toward stamping)', () => {
    const noAuthor = harness({ strategy: 'github-merge-queue' });
    noAuthor.s.enqueue({ num: 42, repo: null }, HEAD, { comments: [{ body: buildClearanceComment(HEAD) }] });
    expect(noAuthor.calls.some((c) => c[1] === 'pr' && c[2] === 'comment')).toBe(true);
    const noSelf = harness({ strategy: 'github-merge-queue', selfLogin: null });
    noSelf.s.enqueue({ num: 42, repo: null }, HEAD, { comments: stampedBy(DRAIN) });
    expect(noSelf.calls.some((c) => c[1] === 'pr' && c[2] === 'comment')).toBe(true);
  });

  it('an unread comment list (comments: null) stamps the clearance (review F2)', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue' });
    s.enqueue({ num: 42, repo: null }, HEAD, { comments: null });
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'comment')).toHaveLength(1);
  });

  it('looks up the drain identity at most once per pass, and only when a marker for this head exists', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue' });
    s.enqueue({ num: 42, repo: null }, HEAD, { comments: [] });
    expect(calls.some((c) => c[1] === 'api' && c[2] === 'user')).toBe(false);
    s.enqueue({ num: 43, repo: null }, HEAD, { comments: stampedBy(DRAIN) });
    s.enqueue({ num: 44, repo: null }, HEAD, { comments: stampedBy(DRAIN) });
    expect(calls.filter((c) => c[1] === 'api' && c[2] === 'user')).toHaveLength(1);
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
    const ghView = { 1: MERGED, 2: { state: 'OPEN' }, 3: { state: 'CLOSED' } };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView });
    const merged = [];
    const landed = new Set();
    const done = h.s.collectQueueMerged({ merged, landedThisPass: landed, landedIdsFor: (p) => (p.item ? [p.item] : []) });
    expect(merged).toEqual([expect.objectContaining({ num: 1, mergedBy: 'github-merge-queue' })]);
    expect([...landed]).toEqual(['x1']);
    // the merged PR stays pending until the post-land work is CONFIRMED; the closed one is dropped now
    expect(h.state().pending.map((p) => p.num)).toEqual([1, 2]);
    expect(h.state().followedUp).toEqual([]);
    h.s.confirmQueueFollowUps(done);
    expect(h.state().pending.map((p) => p.num)).toEqual([2]);
    expect(h.state().followedUp).toEqual(['cwd#1']);
    // next pass: nothing new merged → no second follow-up
    const merged2 = [];
    h.s.collectQueueMerged({ merged: merged2, landedThisPass: new Set() });
    expect(merged2).toEqual([]);
  });

  it('retries queue follow-ups interrupted before post-land completion (review F4)', () => {
    const initial = { pending: [{ num: 1, repo: null, headSha: HEAD, item: 'x1' }], followedUp: [] };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView: { 1: MERGED } });
    // pass 1 collects, then the process dies / a post-land step fails → confirm never runs (or runs incomplete)
    const m1 = [];
    const done1 = h.s.collectQueueMerged({ merged: m1, landedThisPass: new Set(), landedIdsFor: (p) => [p.item] });
    expect(m1).toHaveLength(1);
    expect(h.s.confirmQueueFollowUps(done1, { complete: false })).toEqual({ confirmed: 0 });
    expect(h.state().pending.map((p) => p.num)).toEqual([1]);
    expect(h.state().followedUp).toEqual([]);
    // pass 2 (a fresh strategy, as after a restart) runs the follow-up AGAIN, then confirms it
    const h2 = harness({ strategy: 'github-merge-queue', initial: h.state(), ghView: { 1: MERGED } });
    const m2 = [];
    const landed2 = new Set();
    const done2 = h2.s.collectQueueMerged({ merged: m2, landedThisPass: landed2, landedIdsFor: (p) => [p.item] });
    expect(m2).toEqual([expect.objectContaining({ num: 1 })]);
    expect([...landed2]).toEqual(['x1']);
    expect(h2.s.confirmQueueFollowUps(done2, { complete: true })).toEqual({ confirmed: 1 });
    expect(h2.state()).toEqual({ pending: [], followedUp: ['cwd#1'] });
    // pass 3: complete → never run again
    const m3 = [];
    expect(h2.s.collectQueueMerged({ merged: m3, landedThisPass: new Set() })).toEqual([]);
    expect(m3).toEqual([]);
  });

  it('a failed follow-up `gh pr view` keeps the PR pending, retried next pass (review F2)', () => {
    const initial = { pending: [{ num: 1, repo: null }, { num: 2, repo: null }], followedUp: [] };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView: { 2: MERGED }, viewThrows: [1] });
    const merged = [];
    const done = h.s.collectQueueMerged({ merged, landedThisPass: new Set() });
    expect(merged.map((m) => m.num)).toEqual([2]);
    expect(h.state().pending.map((p) => p.num)).toEqual([1, 2]);
    h.s.confirmQueueFollowUps(done);
    expect(h.state().pending.map((p) => p.num)).toEqual([1]);
    expect(h.logs.join('')).toMatch(/cwd#1 queue follow-up read failed .*retried next pass/);
  });

  it('a concurrent enqueue between collect\'s read and write is NOT lost (review F1)', () => {
    const initial = { pending: [{ num: 1, repo: null }], followedUp: [] };
    // another drain process enqueues PR 9 while this pass is mid-way through its `gh pr view` calls
    const h = harness({
      strategy: 'github-merge-queue', initial, ghView: { 1: { state: 'CLOSED' } },
      onView: { 1: () => h.peerEnqueue({ num: 9, repo: null, headSha: HEAD }) },
    });
    h.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    expect(h.state().pending.map((p) => p.num)).toEqual([9]);
  });

  it('confirm also re-reads the state, so a concurrent enqueue survives it too (review F1)', () => {
    const initial = { pending: [{ num: 1, repo: null }], followedUp: [] };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView: { 1: MERGED } });
    const done = h.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    h.peerEnqueue({ num: 9, repo: null, headSha: HEAD }); // lands during the post-land work
    h.s.confirmQueueFollowUps(done);
    expect(h.state().pending.map((p) => p.num)).toEqual([9]);
    expect(h.state().followedUp).toEqual(['cwd#1']);
  });

  it('an UNREADABLE state file is never overwritten: collect/confirm write nothing and enqueue refuses (review: truncated read)', () => {
    let writes = 0;
    const bad = harness({ strategy: 'github-merge-queue', ghView: { 1: MERGED } });
    // a transient read error / half-written file: readFile throws something that is not ENOENT
    const s = createDrainMergeStrategy({
      isLocalRepo: () => true, localSlug: LOCAL, statePath: '/x/state.json', resolved: policyOf('github-merge-queue'),
      log: { write: (l) => bad.logs.push(l) }, exec: (c, a) => { bad.calls.push([c, ...a]); throw new Error('no gh call expected'); },
      readFile: () => '{"pending": [', writeState: () => { writes++; },
    });
    expect(s.collectQueueMerged({ merged: [], landedThisPass: new Set() })).toEqual([]);
    expect(s.confirmQueueFollowUps([{ num: 1, repo: null }])).toEqual({ confirmed: 0 });
    expect(() => s.enqueue({ num: 1, repo: null }, HEAD, { comments: [] })).toThrow(/unreadable .*refusing to enqueue .*NOT merging directly/);
    expect(writes).toBe(0);
    expect(bad.calls).toEqual([]); // not even the comment stamp or the enqueue went out
    expect(bad.logs.join('')).toMatch(/unreadable/);
  });

  it('a state file that turns UNREADABLE after the enqueue is never overwritten; the PR is recorded on the next pass (review: unreadable second read)', () => {
    const existing = { pending: [{ num: 9, repo: null, headSha: HEAD }], followedUp: [] };
    let stored = existing;
    let broken = false;
    let writes = 0;
    const exec = (cmd, args) => {
      if (args[0] === 'pr' && args[1] === 'comment') return '';
      if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : '';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_NODE', headRefOid: HEAD, baseRefName: 'main' });
      if (args[0] === 'api' && args[1] === 'graphql') { broken = true; return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } }); }
      throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    };
    const logs = [];
    const s = createDrainMergeStrategy({
      isLocalRepo: () => true, localSlug: LOCAL, statePath: '/x/state.json', resolved: policyOf('github-merge-queue'), exec,
      log: { write: (l) => logs.push(l) },
      readFile: () => { if (broken) return '{"pending": ['; return JSON.stringify(stored); },
      writeState: (_p, st) => { writes++; stored = JSON.parse(JSON.stringify(st)); },
    });
    expect(() => s.enqueue({ num: 1, repo: null }, HEAD, { comments: stampedBy(DRAIN) })).toThrow(/unreadable .*not recorded .*retried next pass/);
    expect(writes).toBe(0);
    expect(stored).toEqual(existing); // the unrelated pending follow-up (#9) survives

    // the file is fixed; the next pass finds the PR already queued and records it, keeping #9
    broken = false;
    const exec2 = (cmd, args) => (args[0] === 'api' && args[1] === 'graphql' ? JSON.stringify({ errors: [{ message: 'Pull request is already in the merge queue' }] }) : exec(cmd, args));
    const s2 = createDrainMergeStrategy({
      isLocalRepo: () => true, localSlug: LOCAL, statePath: '/x/state.json', resolved: policyOf('github-merge-queue'), exec: exec2,
      log: { write: (l) => logs.push(l) }, readFile: () => JSON.stringify(stored),
      writeState: (_p, st) => { writes++; stored = JSON.parse(JSON.stringify(st)); },
    });
    expect(s2.enqueue({ num: 1, repo: null }, HEAD, { comments: stampedBy(DRAIN) })).toEqual({ enqueued: true, already: true });
    expect(stored.pending.map((p) => p.num).sort()).toEqual([1, 9]);
  });

  it('a missing file (ENOENT) is a normal empty state; malformed entries are ignored, not fatal', () => {
    expect(readQueueState('/x', () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; })).toEqual({ pending: [], followedUp: [], exists: false, unreadable: false });
    const s = readQueueState('/x', () => JSON.stringify({ pending: [null, 7, { num: 3 }], followedUp: ['cwd#1', 4, null] }));
    expect(s.pending).toEqual([{ num: 3 }]);
    expect(s.followedUp).toEqual(['cwd#1']);
    expect(readQueueState('/x', () => 'not json').unreadable).toBe(true);
  });

  it('a follow-up that keeps failing is retried a bounded number of passes, then STOPPED loudly but kept (review: unbounded retries)', () => {
    const h = harness({ strategy: 'github-merge-queue', initial: { pending: [{ num: 1, repo: null }], followedUp: [] }, ghView: { 1: MERGED } });
    for (let pass = 1; pass <= FOLLOW_UP_MAX_ATTEMPTS; pass++) {
      const merged = [];
      const done = h.s.collectQueueMerged({ merged, landedThisPass: new Set() });
      expect(merged).toHaveLength(1);
      h.s.confirmQueueFollowUps(done, { complete: false });
      expect(h.state().pending[0].followUpAttempts).toBe(pass);
    }
    const merged = [];
    expect(h.s.collectQueueMerged({ merged, landedThisPass: new Set() })).toEqual([]);
    expect(merged).toEqual([]);
    expect(h.state().pending.map((p) => p.num)).toEqual([1]); // not dropped
    expect(h.logs.join('')).toMatch(/failed 5 passes in a row — STOPPED retrying/);
  });

  it('runs the state read-modify-write under the injected lock, and skips (does not write) when the lock is refused', () => {
    const initial = { pending: [{ num: 1, repo: null }], followedUp: [] };
    let locked = 0;
    const ran = harness({ strategy: 'github-merge-queue', initial, ghView: { 1: { state: 'CLOSED' } }, withLock: (fn) => { locked++; return { ran: true, result: fn() }; } });
    ran.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    expect(locked).toBe(1);
    expect(ran.state().pending).toEqual([]);
    const refused = harness({ strategy: 'github-merge-queue', initial, ghView: { 1: { state: 'CLOSED' } }, withLock: () => ({ ran: false }) });
    refused.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    expect(refused.state()).toEqual(initial); // untouched → retried next pass
    expect(refused.logs.join('')).toMatch(/state lock not acquired/);
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
  it('dedupe check shares the reader\'s trust rule: only a trusted author\'s marker counts (review F3)', () => {
    const plain = [{ body: buildClearanceComment(HEAD) }];
    expect(hasClearanceFor(comments, HEAD, ['drain-bot'])).toBe(true);
    expect(hasClearanceFor(comments, HEAD, ['someone-else'])).toBe(false);
    expect(hasClearanceFor(comments, HEAD)).toBe(false); // no trust list → covers nothing
    expect(hasClearanceFor(plain, HEAD, ['drain-bot'])).toBe(false); // no author → untrusted
    expect(hasClearanceFor([], HEAD, ['drain-bot'])).toBe(false);
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
    expect(src.indexOf('mergeStrategy.collectQueueMerged(')).toBeLessThan(src.indexOf('const landedLocalAny = !DRY_RUN && merged.some('));
  });
  it('follow-ups are confirmed only AFTER numbering, resolve-on-land and derived regen, and only when none of them failed (review F4)', () => {
    const at = src.indexOf('mergeStrategy.confirmQueueFollowUps(');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(src.indexOf('regenDerivedOnLand({ exec: execFileSync'));
    expect(at).toBeGreaterThan(src.indexOf('const numLock = withNumberingLock('));
    const line = src.slice(src.lastIndexOf('\n', at), src.indexOf('\n', at));
    const gate = src.slice(src.lastIndexOf('const queueFollowUpsClean', at), at);
    for (const needle of ['localSynced', 'numbered', 'resolveOnLandReport.failed', 'derived.warning', 'derived.failed']) expect(gate).toContain(needle);
    expect(line).toContain('complete: queueFollowUpsClean');
  });
  it('the strategy\'s state read-modify-write rides the SAME land lock the enqueue holds, and REFUSES (never runs unlocked) on contention', () => {
    // withLandWriteLock defaults to running the section UNLOCKED after the wait budget; the opt-out is what makes `ran:false` reachable.
    expect(src).toMatch(/createDrainMergeStrategy\(\{[^}]*withLock: \(fn\) => withLandWriteLock\(fn, \{ runUnlockedOnContention: false \}\)/);
  });
  it('the enqueue\'s own land lock also refuses on contention, and a refused enqueue is skipped, not merged', () => {
    const at = src.indexOf('const landLock = withLandWriteLock(');
    const block = src.slice(at, src.indexOf('if (landLock.contended', at));
    expect(block).toContain('mergeStrategy.enqueues(c.repo) ? { runUnlockedOnContention: false } : {}');
    expect(block).toContain('if (landLock.ran === false)');
    expect(src.slice(src.indexOf('if (landLock.ran === false)'), src.indexOf('if (landLock.contended', at))).toMatch(/decision = 'skip'; continue;/);
  });
});
