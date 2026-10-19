// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDrainMergeStrategy, resolveDrainMergePolicy, readEnqueueClearance, buildClearanceComment, hasClearanceFor, DRY_RUN_STRATEGY_ENV,
  requestDrainRedTeam, readDrainRedTeamRequests, finishDrainRedTeamRequest, readQueueState, FOLLOW_UP_MAX_ATTEMPTS, readMergeDeliveryToolSettings, MERGE_DELIVERY_SETTINGS_FILE_ENV,
} from '../drain-merge-strategy.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { rulesetSuggestion } from '../merge-queue-enqueue.mjs';
import { saveProvenanceFixtures } from './fixtures/saved-red-team-provenance.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../drain-red-team-evidence.mjs';

const HEAD = 'b'.repeat(40);
const BASE_TIP = 'e'.repeat(40);
const LOCAL = 'web-everything/web-everything';
const policyOf = (strategy) => ({ policy: resolveMergeDeliveryPolicy({ tool: strategy ? { strategy } : undefined }), note: null });

const DRAIN = 'drain-bot';

function harness({ strategy = null, dryRun = false, initial = null, ghView = {} , enqueueFails = false, onView = {}, viewThrows = [], selfLogin = DRAIN, withLock, mutation, inQueue, liveComments, postConflictFinding = () => {}, now, labels = ['ready-to-merge'], queued = false, queueFacts, env = { ...process.env, WE_RED_TEAM_TIMING: 'post-accept' }, evidence = { loopPayload: labels.includes('review:accepted') ? { verdict: { verdict: 'accept' } } : null, inFlight: false, recorded: false, scheduled: labels.includes('review:accepted') && !['off', 'false', '0'].includes(env.WE_REVIEW_RED_TEAM) && !['off', 'false', '0'].includes(env.WE_REVIEW_EXTRA_SEATS) }, requestRedTeam, readReviewAgents = () => [], baseTip = () => BASE_TIP } = {}) {
  const calls = [];
  const logs = [];
  let stored = initial;
  let mutated = false;
  let removed = false;
  const exec = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (args.includes('--slurp')) {
      // Exercise Node's real output-buffer limit for the oversized-thread regression.
      const out = JSON.stringify([liveComments ?? ghView[args[2]]?.comments ?? []]);
      if (Buffer.byteLength(out) > 1024 * 1024) return execFileSync(process.execPath,
        ['-e', 'process.stdin.pipe(process.stdout)'], { ...opts, input: out, stdio: ['pipe', 'pipe', 'pipe'] });
      return out;
    }
    if (args[0] === 'pr' && args[1] === 'merge') throw new Error('merge API must never be called');
    if (args[0] === 'pr' && ['comment', 'edit'].includes(args[1])) return '';
    if (args[0] === 'label' && args[1] === 'create') return '';
    if (args[0] === 'api' && args[1] === 'user') { if (selfLogin == null) throw new Error('gh: not logged in'); return `${selfLogin}\n`; }
    if (cmd === 'git' && args[0] === 'rev-parse') return `${baseTip()}\n`; // the base tip the pinned diff used
    if (cmd === 'git' && args[0] === 'ls-remote') return `${baseTip()}\t${args.at(-1)}\n`; // the live base tip
    if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : ''; // the pinned change list of the judged head
    if (args[0] === 'pr' && args[1] === 'view' && args.includes('id,headRefOid,baseRefName')) return JSON.stringify({ id: 'PR_NODE', headRefOid: ghView[args[2]]?.headRefOid ?? HEAD, baseRefName: 'main', labels: ['ready-to-merge'] });
    if (args[0] === 'pr' && args[1] === 'view' && viewThrows.includes(Number(args[2]))) throw new Error('gh: HTTP 502');
    if (args[0] === 'pr' && args[1] === 'view') { onView[args[2]]?.(); return JSON.stringify(ghView[args[2]] ?? { state: 'OPEN', headRefOid: HEAD, labels, id: 'PR_NODE' }); }
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (args.some(a => a.includes('mergeQueue(branch:'))) return JSON.stringify(queueFacts ?? { data: { repository: { mergeQueue: { entries: {
        nodes: !removed && queued ? [{ pullRequest: { id: 'PR_NODE', number: 5283 } }] : [], pageInfo: { hasNextPage: false },
      } } } } });
      if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: !removed && (queued || mutated) && (inQueue ?? true), headRefOid: Object.values(ghView)[0]?.headRefOid ?? HEAD } } } });
      if (args.some(a => a.includes('dequeuePullRequest'))) { removed = true; return JSON.stringify({ data: { dequeuePullRequest: { clientMutationId: null } } }); }
      const response = mutation ?? (enqueueFails
        ? { errors: [{ message: 'Pull request is not mergeable' }] }
        : { data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } });
      // A refused mutation must not make the recovery attempt observe a queued PR.
      if (!response.errors?.length && response.data?.enqueuePullRequest?.mergeQueueEntry?.id) mutated = true;
      return JSON.stringify(response);
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  const readFile = () => { if (stored == null) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return JSON.stringify(stored); };
  const writeState = (_p, s) => { stored = JSON.parse(JSON.stringify(s)); };
  const s = createDrainMergeStrategy({
    dryRun, env, readReviewAgents, readRedTeamEvidence: () => { if (evidence.readError) throw new Error('evidence unreadable'); return evidence; }, requestRedTeam, isLocalRepo: (r) => r == null || r === LOCAL, localSlug: LOCAL, exec, statePath: '/x/state.json',
    cancelObsoleteRuns: () => {}, batching: { gate: () => ({ admit: true }), observe: () => ({}) },
    postConflictFinding, ...(now ? { now } : {}), resolved: policyOf(strategy), log: { write: (l) => logs.push(l) }, readFile, writeState, ...(withLock ? { withLock } : {}),
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
    const gql = calls.find((c) => c.includes('id=PR_NODE'));
    expect(gql).toEqual(expect.arrayContaining(['id=PR_NODE', `sha=${HEAD}`]));
    expect(calls.findIndex((c) => c[2] === 'comment')).toBeGreaterThan(calls.findIndex((c) => c[1] === 'api' && c[2] === 'graphql'));
    expect(state().pending).toEqual([expect.objectContaining({ num: 42, repo: null, headSha: HEAD, item: 'x1' })]);
  });

  it('routes the exact #5169 refusal to conflict repair without a clearance', () => {
    const findings = [];
    const message = 'Pull request has merge conflicts and Pull request not in mergeable state';
    const h = harness({ strategy: 'github-merge-queue', mutation: { errors: [{ type: 'UNPROCESSABLE', message }], data: { enqueuePullRequest: null } }, postConflictFinding: x => findings.push(x) });
    expect(() => h.s.enqueue({ num: 5169 }, HEAD)).toThrow(message);
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(0);
    expect(findings).toEqual([expect.objectContaining({ pr: expect.objectContaining({ number: 5169 }), repo: LOCAL })]);
    expect(h.logs.join('')).toContain(message);
    expect(h.state().enqueueFailures['cwd#5169']).toMatchObject({ error: message, kind: 'conflict' });
  });

  it('does not stamp a success contradicted by live queue membership', () => {
    const h = harness({ strategy: 'github-merge-queue', inQueue: false });
    expect(() => h.s.enqueue({ num: 42 }, HEAD)).toThrow(/unconfirmed/);
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(0);
    expect(h.state().pending).toEqual([]);
  });

  it('dedupes clearance across passes even with stale or unread comments', () => {
    const h = harness({ strategy: 'github-merge-queue' });
    h.s.enqueue({ num: 42 }, HEAD, { comments: [] });
    const next = harness({ strategy: 'github-merge-queue', initial: h.state() });
    next.s.enqueue({ num: 42 }, HEAD, { comments: [] });
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(1);
    expect(next.calls.filter(c => c[2] === 'comment')).toHaveLength(0);
  });

  it('backs off across restarts, surfaces a health smell at the cascade threshold, and resets on a new head', () => {
    const mutation = { errors: [{ message: 'GitHub temporarily unavailable\nretry later' }] };
    const first = harness({ strategy: 'github-merge-queue', mutation, now: () => 0 });
    expect(() => first.s.enqueue({ num: 42 }, HEAD)).toThrow('GitHub temporarily unavailable');
    const wait = harness({ strategy: 'github-merge-queue', mutation, initial: first.state(), now: () => 1 });
    expect(wait.s.enqueue({ num: 42 }, HEAD)).toMatchObject({ enqueued: false, kind: 'enqueue-backoff' });
    expect(wait.calls).toEqual([]);
    const second = harness({ strategy: 'github-merge-queue', mutation, initial: wait.state(), now: () => 60_000 });
    expect(() => second.s.enqueue({ num: 42 }, HEAD)).toThrow();
    expect(second.state().enqueueFailures['cwd#42'].retryAt).toBe(180_000);
    const third = harness({ strategy: 'github-merge-queue', mutation, initial: second.state(), now: () => 180_000 });
    expect(() => third.s.enqueue({ num: 42 }, HEAD)).toThrow();
    expect(third.state().enqueueFailures['cwd#42']).toMatchObject({ count: 3, healthSmell: true, smellSource: 'standard', error: mutation.errors[0].message });
    expect(third.logs.join('')).toContain('enqueueFailureSmellAfter=3, standard');
    const changed = structuredClone(third.state());
    changed.enqueueFailures['cwd#42'].headSha = 'c'.repeat(40);
    const next = harness({ strategy: 'github-merge-queue', mutation, initial: changed, now: () => 180_001 });
    expect(() => next.s.enqueue({ num: 42 }, HEAD)).toThrow();
    expect(next.state().enqueueFailures['cwd#42'].count).toBe(1);
  });

  it('uses a live trusted clearance after a crash before the local stamp record', () => {
    const h = harness({ strategy: 'github-merge-queue', liveComments: stampedBy(DRAIN) });
    h.s.enqueue({ num: 42 }, HEAD, { comments: [] });
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(0);
  });

  it('does not re-stamp a clearance already on the PR for this head', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue', liveComments: stampedBy(DRAIN) });
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
    expect(state().pending).toEqual([]);
    expect(calls.filter(c => c[2] === 'comment')).toHaveLength(0);
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
      cancelObsoleteRuns: () => {}, batching: { gate: () => ({ admit: true }), observe: () => ({}) },
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
      if (args.includes('--slurp')) return JSON.stringify([[]]);
      if (args[0] === 'pr' && ['comment', 'edit'].includes(args[1])) return '';
    if (args[0] === 'label' && args[1] === 'create') return '';
      if (cmd === 'git') return args[0] === 'diff' ? 'scripts/x.mjs\0' : '';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_NODE', headRefOid: HEAD, baseRefName: 'main', labels: ['ready-to-merge'] });
      if (args[0] === 'api' && args[1] === 'graphql') {
      if (args.some(a => a.includes('isInMergeQueue'))) return JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: broken, headRefOid: HEAD } } } });
      broken = true; return JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: 'E', position: 1, state: 'QUEUED' } } } }); }
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
    const exec2 = (cmd, args) => (args.some(a => a.includes('isInMergeQueue')) ? JSON.stringify({ data: { repository: { pullRequest: { isInMergeQueue: true, headRefOid: HEAD } } } }) : exec(cmd, args));
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

describe('tool-layer settings read (hermetic in a test run)', () => {
  it('reads no live settings inside a test run, so the repo strategy cannot leak into a spawned drain', () => {
    expect(readMergeDeliveryToolSettings({ VITEST: 'true' })).toEqual({});
    expect(readMergeDeliveryToolSettings({ WE_UNDER_TEST: '1' })).toEqual({});
  });
  it('an override file replaces the declared files, in or out of a test run; an unreadable one reads as not set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdts-'));
    try {
      const file = join(dir, 's.json');
      writeFileSync(file, JSON.stringify({ mergeDelivery: { strategy: 'github-merge-queue' } }));
      expect(readMergeDeliveryToolSettings({ [MERGE_DELIVERY_SETTINGS_FILE_ENV]: file })).toEqual({ mergeDelivery: { strategy: 'github-merge-queue' } });
      expect(readMergeDeliveryToolSettings({ VITEST: 'true', [MERGE_DELIVERY_SETTINGS_FILE_ENV]: file }).mergeDelivery.strategy).toBe('github-merge-queue');
      const warned = [];
      expect(readMergeDeliveryToolSettings({ [MERGE_DELIVERY_SETTINGS_FILE_ENV]: join(dir, 'missing.json') }, (m) => warned.push(m))).toEqual({});
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/unreadable/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('outside a test run with no override, the declared settings files are read (the live path stays wired)', () => {
    expect(readMergeDeliveryToolSettings({})).toHaveProperty('mergeQueue');
  });
  it('feeds resolveDrainMergePolicy: the default load honours the override file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdts-'));
    try {
      const file = join(dir, 's.json');
      writeFileSync(file, JSON.stringify({ mergeDelivery: { strategy: 'github-merge-queue' } }));
      expect(resolveDrainMergePolicy({ env: { [MERGE_DELIVERY_SETTINGS_FILE_ENV]: file } }).policy.strategy).toBe('github-merge-queue');
      expect(resolveDrainMergePolicy({ env: { VITEST: 'true' } }).policy.strategy).toBe('drain-direct');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('the merge-queue ruleset body matches rulesetSuggestion (docs/agent/merge-queue-switch.md)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const body = JSON.parse(readFileSync(join(root, 'scripts', 'rulesets', 'main-required-checks.merge-queue.json'), 'utf8'));
  const settings = JSON.parse(readFileSync(join(root, 'scripts', 'settings', 'merge-queue.json'), 'utf8'));
  const want = rulesetSuggestion(settings.mergeDelivery);
  const rule = (type) => body.rules.filter((r) => r.type === type);
  // web-everything/web-everything (`gh api repos/web-everything/web-everything --jq .id`).
  const REPO_ID = 1142650361;

  it('pins every workflow that defines a required check to refs/heads/main (the merge_group YAML comes from the group commit otherwise)', () => {
    expect(rule('workflows')).toHaveLength(1);
    const { parameters } = rule('workflows')[0];
    expect(parameters.do_not_enforce_on_create).toBe(false);
    const pinned = parameters.workflows.map(({ path, ref }) => ({ path, ref }));
    expect(pinned).toEqual(want.requiredWorkflows);
    for (const w of parameters.workflows) {
      expect(w.repository_id).toBe(REPO_ID);
      expect(w).not.toHaveProperty('sha');
    }
  });
  it('requires exactly the suggested checks, each restricted to the GitHub Actions app', () => {
    expect(rule('required_status_checks')).toHaveLength(1);
    const checks = rule('required_status_checks')[0].parameters.required_status_checks;
    expect(checks.map((c) => c.context)).toEqual(want.requiredStatusChecks);
    for (const c of checks) expect(c.integration_id).toBe(want.requiredStatusCheckIntegrationId);
  });
  it('carries the suggested merge_queue parameters', () => {
    expect(rule('merge_queue')).toHaveLength(1);
    const q = want.mergeQueue;
    expect(rule('merge_queue')[0].parameters).toEqual({
      merge_method: q.mergeMethod, max_entries_to_build: q.maxEntriesToBuild, min_entries_to_merge: q.minEntriesToMerge,
      max_entries_to_merge: q.maxEntriesToMerge, min_entries_to_merge_wait_minutes: q.minEntriesToMergeWaitMinutes,
      grouping_strategy: q.groupingStrategy, check_response_timeout_minutes: q.checkResponseTimeoutMinutes,
    });
  });
  it('targets the default branch and has no rule type the suggestion does not account for', () => {
    expect(body.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    expect(body.rules.map((r) => r.type).sort()).toEqual(['merge_queue', 'required_status_checks', 'workflows']);
  });

  // The body is "the current ruleset plus additions": everything outside the added rules must equal the saved GET,
  // or the operator's PUT silently drops it (the admin bypass the hand-merges and the rollback rely on, above all).
  const rollback = JSON.parse(readFileSync(join(root, 'scripts', 'rulesets', 'main-required-checks.rollback.json'), 'utf8'));
  const rollbackRule = (type) => rollback.rules.filter((r) => r.type === type);
  it('keeps the current ruleset fields outside the added rules: name, target, enforcement, conditions, admin bypass', () => {
    for (const key of ['name', 'target', 'enforcement', 'conditions', 'bypass_actors']) expect(body[key], key).toEqual(rollback[key]);
    expect(body.bypass_actors).toContainEqual({ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' });
  });
  it('keeps every current required check and its parameters, and adds only merge-gate', () => {
    expect(rollbackRule('required_status_checks')).toHaveLength(1);
    const { required_status_checks: was, ...wasParams } = rollbackRule('required_status_checks')[0].parameters;
    const { required_status_checks: now, ...nowParams } = rule('required_status_checks')[0].parameters;
    expect(nowParams).toEqual(wasParams);
    for (const c of was) expect(now).toContainEqual(c);
    expect(now.filter((c) => !was.some((w) => w.context === c.context)).map((c) => c.context)).toEqual(['merge-gate']);
    expect(rollback.rules.map((r) => r.type)).toEqual(['required_status_checks']);
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


describe('post-accept red-team enqueue barrier (#5283)', () => {
  it('an owed panel seat never uses the overdue request or never-scheduled escape', () => {
    let clock = 1000;
    const requests = [];
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      now: () => clock, env: { WE_RED_TEAM_TIMING: 'panel-seat', WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'true' },
      evidence: { scheduled: true, recorded: false, attempted: false, inFlight: false,
        loopPayload: { verdict: { verdict: 'needs-human' }, findings: { read: { netBasis: { rev: HEAD } } } } },
      requestRedTeam: input => { requests.push(input); return { requested: false }; } };
    const first = harness(options);
    expect(first.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    clock += 120 * 60_000;
    const overdue = harness({ ...options, initial: first.state() });
    expect(overdue.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requests).toEqual([]);
  });
  it('a head with no red team ever scheduled gets one request, once, with a cooldown', () => {
    let clock = 1000;
    const requests = [];
    let available = false;
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      env: { WE_DRAIN_RED_TEAM_REQUEST_COOLDOWN_MIN: '2', WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC: '7200' },
      evidence: { scheduled: false, recorded: false, attempted: false, inFlight: false, loopPayload: null },
      requestRedTeam: input => { requests.push(input); return { requested: available }; } };
    const first = harness(options);
    expect(first.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requests).toHaveLength(1);
    const next = harness({ ...options, initial: first.state() });
    clock += 120_000 - 1;
    expect(next.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false });
    expect(requests).toHaveLength(1);
    available = true;
    clock += 1;
    expect(next.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, redTeamRequested: true });
    expect(requests).toHaveLength(2);
    expect(next.logs.join('')).toContain('redTeamRequestCooldownMin=2 (env)');
    clock += 200 * 60_000;
    const restarted = harness({ ...options, initial: next.state() });
    expect(restarted.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requests).toHaveLength(2);
    const newHead = 'c'.repeat(40);
    const moved = harness({ ...options, initial: restarted.state(), ghView: { 5485: { headRefOid: newHead, labels: options.labels } } });
    expect(moved.s.enqueue({ num: 5485 }, newHead)).toMatchObject({ enqueued: false, redTeamRequested: true });
    expect(requests.at(-1).head).toBe(newHead);
  });
  it('replays #5461: old-head break, live head with no scheduled work requests and stays pending', () => {
    const liveHead = 'ff45ed96c40644e5537370df84b6b30328b1a73e';
    const oldHead = '4752c275333c66228ea55c4b6d65f4038c760d38';
    const requests = [];
    const comment = { user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({ pr: 5461, rev: oldHead,
      findings: [{ summary: 'old break', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }], recheckStatus: 'ok' }) };
    const labels = ['review:accepted', 'ready-to-merge', 'status:ready-to-merge', 'review-round:11', 'red-team:pending'];
    const h = harness({ strategy: 'github-merge-queue', labels, ghView: { 5461: { headRefOid: liveHead, labels, isDraft: false } },
      liveComments: [comment], evidence: { scheduled: false, attempted: false, recorded: false, inFlight: false },
      requestRedTeam: input => { requests.push(input); return { requested: true }; } });
    const outcome = h.s.enqueue({ num: 5461 }, liveHead);
    expect(outcome).toMatchObject({ enqueued: false, kind: 'red-team-pending', redTeamRequested: true });
    expect(outcome.reason).toContain('no recorded result on the live head');
    expect(outcome.reason).not.toContain('requiring send-back');
    expect(requests).toEqual([expect.objectContaining({ pr: 5461, head: liveHead })]);
  });

  it.each([null, LOCAL])('enqueues a saved clean live-head result without comments (repo=%s)', repo => {
    const root = mkdtempSync(join(tmpdir(), 'drain-saved-wiring-'));
    try {
      const env = { WE_RED_TEAM_TIMING: 'post-accept', CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'on' };
      const path = resolveScorecardStorePath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team',
        repo: LOCAL, pr: 5283, rev: HEAD, status: 'ok', seatVerdict: 'accept',
        recheckStatus: 'ok', confirmedMissCount: 0, findings: [] }] }));
      saveProvenanceFixtures(env);
      const h = harness({ strategy: 'github-merge-queue', env, labels: ['review:accepted', 'ready-to-merge'], liveComments: [] });
      expect(h.s.enqueue({ num: 5283, repo }, HEAD, { comments: [] })).toMatchObject({ enqueued: true });
      expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(true);
      expect(h.state().redTeamPending?.[`${repo ?? 'cwd'}#5283`]).toBeUndefined();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(['pending', 'error', undefined])('persists incomplete saved rechecks and never waives them as unscheduled: %s', recheckStatus => {
    const root = mkdtempSync(join(tmpdir(), 'drain-incomplete-wiring-'));
    try {
      const env = { WE_RED_TEAM_TIMING: 'post-accept', CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'on' };
      const path = resolveScorecardStorePath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team',
        repo: LOCAL, pr: 5283, rev: HEAD, status: 'ok', recheckStatus, confirmedMissCount: 1,
        findings: [{ confirmedByRecheck: true, impactIfUnfixed: 'degraded' }, { confirmedByRecheck: false }] }] }));
      saveProvenanceFixtures(env);
      let clock = 0;
      const h = harness({ strategy: 'github-merge-queue', env, now: () => clock,
        labels: ['review:accepted', 'ready-to-merge'], liveComments: [] });
      expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ kind: 'red-team-pending', healthSmell: false });
      expect(h.state().redTeamPending['cwd#5283'].reason).toContain('saved red-team re-check incomplete');
      clock = 46 * 60_000;
      const next = harness({ strategy: 'github-merge-queue', env, now: () => clock, initial: h.state(),
        labels: ['review:accepted', 'ready-to-merge'], liveComments: [] });
      expect(next.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ kind: 'red-team-pending', healthSmell: true });
      expect(next.logs.join('')).toContain('health smell:');
      expect(next.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')) || c[2] === 'comment')).toBe(false);
      // A completed retry on the same head releases the persisted hold at the next allowed probe.
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team',
        repo: LOCAL, pr: 5283, rev: HEAD, status: 'ok', recheckStatus: 'ok', findings: [], confirmedMissCount: 0 }] }));
      clock = next.state().redTeamPending['cwd#5283'].retryAt;
      expect(next.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: true });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([['card-only', { scheduled: true, inFlight: false, recorded: false,
    loopPayload: { findings: { read: { netChangedFiles: ['backlog/123-card.md'] } } } }],
    ['not scheduled', { scheduled: false, inFlight: false, recorded: false, loopPayload: { verdict: { verdict: 'accept' } } }]])('%s enqueues without an owed pass', (_name, evidence) => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: true });
  });
  it('a scheduled in-flight pass holds admission and writes pending through the label provider', () => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      evidence: { scheduled: true, inFlight: true } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ kind: 'red-team-pending' });
    expect(h.calls.some(c => c.includes('--add-label') && c.includes('red-team:pending'))).toBe(true);
  });

  it.each(['speculative running', 'required but not started'])('does not enqueue or stamp while %s', () => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'] });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deferred: true, kind: 'red-team-pending' });
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
    expect(h.calls.some(c => c[2] === 'comment')).toBe(false);
  });
  it.each([{ author: { login: 'web-everything' } }, { user: { login: 'web-everything[bot]' } }])('enqueues after a trusted clean result for the live head (%j)', identity => {
    const result = { ...identity, body: `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->\n### Post-accept red team — no break found` };
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], liveComments: [result] });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [result] })).toMatchObject({ enqueued: true });
    expect(h.calls.some(c => c.includes('--add-label') && c.includes('red-team:clear'))).toBe(true);
  });
  it.each([false, true])('holds a confirmed break before the gate acts (scheduled=%s)', async scheduled => {
    const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
    const thread = [{ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
      pr: 5283, rev: HEAD, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'unresolved security break', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }],
    }) }];
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      liveComments: thread, evidence: { scheduled, inFlight: false, recorded: true, loopPayload: null } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: thread })).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')) || c[2] === 'comment')).toBe(false);
    expect(h.calls.some(c => c.includes('--add-label') && c.includes('red-team:blocked'))).toBe(true);
    expect(h.calls.some(c => c.includes('--add-label') && c.includes('red-team:clear'))).toBe(false);
  });
  it('reads a complete comment thread larger than 1 MiB', () => {
    const result = { user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->\n### Post-accept red team — no break found` };
    const bulk = Array.from({ length: 24 }, () => ({ user: { login: 'someone' }, body: 'x'.repeat(50_000) }));
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], liveComments: [result, ...bulk] });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [result] })).toMatchObject({ enqueued: true });
    // The clearance dedupe read is the same complete-thread read: it must not defer the stamp either.
    expect(h.logs.join('')).not.toContain('clearance dedupe read failed');
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(1);
  });
  it('enqueues on a REST-shaped carried clean result (carryAcrossRebase)', () => {
    const prior = 'a'.repeat(40);
    const carried = { user: { login: 'web-everything[bot]' }, body: [
      `<!-- review-verdict-carried from=${prior} to=${HEAD} patch-id=${'c'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.',
      `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->`, '### Post-accept red team — no break found'].join('\n') };
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], liveComments: [carried] });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [carried] })).toMatchObject({ enqueued: true });
  });
  it('a real round-cap record followed by the clear-human renderer releases admission before retry backoff', async () => {
    const { applyRedTeamGate } = await import('../../operations/red-team-gate-apply.mjs');
    const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
    const { buildVerdictComment } = await import('../../review-set-label.mjs');
    const { CONFIRMED_BREAKS_DEFAULTS } = await import('../red-team-gate.mjs');
    const thread = [{ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
      pr: 5283, rev: HEAD, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'known risk', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }],
    }) }];
    const labels = ['review:accepted', 'ready-to-merge'];
    const gate = await applyRedTeamGate({ repo: LOCAL, pr: 5283 }, {
      readPr: () => ({ headRefOid: HEAD, labels: ['review:human'], comments: thread }),
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => 5,
      postComment: ({ body }) => thread.push({ user: { login: 'web-everything[bot]' }, body }),
    });
    expect(gate.outcome).toBe('round-cap');
    const h = harness({ strategy: 'github-merge-queue', labels, liveComments: thread, now: () => 1000 });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: thread })).toMatchObject({ kind: 'red-team-pending' });
    thread.push({ user: { login: 'web-everything[bot]' }, body: buildVerdictComment({
      to: 'clear-human', actor: 'operator', headSha: HEAD, reason: 'accept the documented known risk',
    }) });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: thread })).toMatchObject({ enqueued: true });
  });
  it.each([
    ['carded #5441', ['degraded'], 1, true],
    ['held #5453', ['broken', 'broken'], 5, false],
    ['sent back', ['broken'], 1, false],
    ['mixed #5460', ['degraded', 'broken'], 5, false],
  ])('follows the real gate disposition: %s', async (_name, impacts, round, enqueued) => {
    const { applyRedTeamGate } = await import('../../operations/red-team-gate-apply.mjs');
    const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
    const { CONFIRMED_BREAKS_DEFAULTS } = await import('../red-team-gate.mjs');
    const thread = [{ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
      pr: 5283, rev: HEAD, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: impacts.map((impact, i) => ({ summary: `break ${i}`, category: 'edge-case', impactIfUnfixed: impact, confirmedByRecheck: true })),
    }) }];
    const applied = await applyRedTeamGate({ repo: LOCAL, pr: 5283 }, {
      readPr: () => ({ headRefOid: HEAD, labels: ['review:human'], comments: thread }),
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => round,
      readHead: () => HEAD, appendSendBackEvent: () => {},
      sendBack: () => ({ ok: true }), dequeueSentBack: () => {}, fileCard: () => ({ ok: true }),
      postComment: ({ body }) => thread.push({ user: { login: 'web-everything[bot]' }, body }),
    });
    expect(applied.status).toBe('applied');
    if (round === 5) {
      const { redTeamRulingRow } = await import('../../operations/operator-queue.mjs');
      const row = redTeamRulingRow(LOCAL, { number: 5283, headRefOid: HEAD, labels: ['review:accepted'], comments: thread });
      expect(row.findings.map(f => f.summary)).toEqual(impacts.flatMap((impact, i) => impact === 'broken' ? [`break ${i}`] : []));
    }
    let clock = 1000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      liveComments: thread, evidence: { loopPayload: null }, now: () => clock });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: thread }).enqueued).toBe(enqueued);
    if (!enqueued) {
      const reads = h.calls.filter(c => c.includes('--slurp')).length;
      clock += 60_000;
      h.s.enqueue({ num: 5283 }, HEAD, { comments: thread });
      expect(h.calls.filter(c => c.includes('--slurp'))).toHaveLength(reads);
      expect(h.logs.join('')).toContain('red-team-pending backoff');
      clock += 240_000;
      h.s.enqueue({ num: 5283 }, HEAD, { comments: thread });
      expect(h.calls.filter(c => c.includes('--slurp'))).toHaveLength(reads + 1);
    }
  });
  it('keeps an untrusted REST clean marker pending without enqueue or clearance', () => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      liveComments: [{ user: { login: 'mallory[bot]' }, body: `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->\n### Post-accept red team — no break found` }] });
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ kind: 'red-team-pending' });
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')) || c[2] === 'comment')).toBe(false);
  });
  it('backs off complete comment reads across restarts, then retries at 300 seconds', () => {
    let clock = 1_000;
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock };
    const first = harness(options);
    first.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    const next = harness({ ...options, initial: first.state() });
    clock += 180_000;
    expect(next.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ kind: 'red-team-pending', healthSmell: false });
    expect(next.calls.filter(c => c.includes('--slurp'))).toHaveLength(0);
    clock += 120_000;
    next.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    expect(next.calls.filter(c => c.includes('--slurp'))).toHaveLength(1);
    expect(next.state().redTeamPending['cwd#5283'].firstPendingAt).toBe(1_000);
    expect(next.logs.join('')).toContain('redTeamPendingBackoffSec=300 (standard)');
  });
  it('a new observed comment wakes the held head before backoff and clears pending on success', () => {
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => 1_000 };
    const first = harness(options);
    first.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    const result = { user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->\n### Post-accept red team — no break found` };
    const next = harness({ ...options, initial: first.state(), liveComments: [result] });
    expect(next.s.enqueue({ num: 5283 }, HEAD, { comments: [result] })).toMatchObject({ enqueued: true });
    expect(next.state().redTeamPending['cwd#5283']).toBeUndefined();
  });
  it('wakes a missing-result backoff when scheduling evidence says no pass is owed', () => {
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => 1000 };
    const first = harness(options);
    first.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    const next = harness({ ...options, initial: first.state(),
      evidence: { scheduled: false, inFlight: false, recorded: false } });
    expect(next.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: true });
  });
  it('wakes on a new review or edited operator/gate comment within backoff', () => {
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => 1000 };
    const comments = [{ id: 1, body: 'original' }];
    const first = harness(options);
    first.s.enqueue({ num: 5283 }, HEAD, { comments });
    const review = harness({ ...options, initial: first.state(), ghView: { 5283: {
      headRefOid: HEAD, labels: options.labels, reviews: [{ id: 2, submittedAt: '2026-10-17T00:00:00Z' }],
    } } });
    review.s.enqueue({ num: 5283 }, HEAD, { comments });
    expect(review.calls.filter(c => c.includes('--slurp'))).toHaveLength(1);
    const edited = harness({ ...options, initial: first.state() });
    edited.s.enqueue({ num: 5283 }, HEAD, { comments: [{ id: 1, body: 'operator ruling' }] });
    expect(edited.calls.filter(c => c.includes('--slurp'))).toHaveLength(1);
  });
  it('raises a named health smell and enqueues a never-scheduled pass at the maximum, even during backoff', () => {
    let clock = 1_000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      env: { WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC: '7200', WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: '45' } });
    h.s.enqueue({ num: 5283 }, HEAD);
    clock += 45 * 60_000 - 1;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ healthSmell: false });
    clock += 1;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: true });
    expect(h.logs.join('')).toContain(`health smell: ${LOCAL}#5283 red-team-pending on ${HEAD}`);
    expect(h.logs.join('')).toContain('redTeamPendingMaxMin=45, env');
    expect(h.calls.filter(c => c.includes('--slurp'))).toHaveLength(3);
    expect(h.logs.join('')).toContain('red team never scheduled');
    expect(h.logs.join('')).toContain('enqueueWhenRedTeamNeverScheduled=true (standard)');
  });
  it.each([5439, 5443])('enqueues accepted #%s when the review scheduler owes no pass', num => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      evidence: { loopPayload: null, inFlight: false, recorded: false } });
    expect(h.s.enqueue({ num }, HEAD)).toMatchObject({ enqueued: true });
  });
  it.each(['inFlight', 'recorded', 'queued'])('continues waiting past the deadline with %s evidence', field => {
    let clock = 1000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      evidence: { loopPayload: { verdict: { verdict: 'accept' } }, [field]: true, scheduled: true } });
    h.s.enqueue({ num: 5283 }, HEAD);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, healthSmell: true });
    expect(h.logs.join('')).not.toContain('red team never scheduled');
  });
  it('requests an overdue missing pass through the supplied review dispatch path', () => {
    let clock = 1000;
    const requests = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      requestRedTeam: input => { requests.push(input); return { requested: true }; } });
    h.s.enqueue({ num: 5283 }, HEAD);
    expect(requests).toHaveLength(0);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, healthSmell: true, redTeamRequested: true });
    expect(requests).toEqual([expect.objectContaining({ repo: LOCAL, pr: 5283, head: HEAD })]);
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false });
    expect(requests).toHaveLength(1);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requests).toHaveLength(1);
  });
  it('replays #5485: unparseable attempt holds without another request across restart and deadline, then accepts a usable result', () => {
    let clock = 1000;
    const requests = [];
    const thread = [];
    const options = { strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      env: { WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: '2' }, liveComments: thread,
      evidence: { scheduled: true, recorded: true, attempted: true, loopPayload: { verdict: { verdict: 'accept' } } },
      requestRedTeam: input => { requests.push(input); return { requested: true }; } };
    const first = harness(options);
    expect(first.s.enqueue({ num: 5485 }, HEAD, { comments: thread })).toMatchObject({ enqueued: false });
    clock += 2 * 60_000;
    expect(first.s.enqueue({ num: 5485 }, HEAD, { comments: thread })).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    const restarted = harness({ ...options, initial: first.state() });
    clock += 60 * 60_000;
    expect(restarted.s.enqueue({ num: 5485 }, HEAD, { comments: thread })).toMatchObject({ enqueued: false });
    expect(requests).toHaveLength(0);
    expect(restarted.logs.join('')).not.toContain('red team never scheduled');
    expect(first.logs.join('')).toContain('redTeamPendingMaxMin=2, env');
    thread.push({ user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5485 rev=${HEAD} -->\n### Post-accept red team — no break found` });
    expect(restarted.s.enqueue({ num: 5485 }, HEAD, { comments: thread })).toMatchObject({ enqueued: true });
  });
  // Operator ruling (PR #5551): a run that ran but left no usable result is not "never scheduled". The head stays
  // held until a usable result exists; the re-run path is a separate card.
  function erroredRunAfterDeadline({ status, row, writer = LOCAL, rev = HEAD, read = {} }) {
    const root = mkdtempSync(join(tmpdir(), 'drain-errored-red-team-'));
    try {
      const env = { WE_RED_TEAM_TIMING: 'post-accept', CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs') };
      const rows = row ? [{ dispatchKind: 'review-seat', seat: 'red-team', repo: LOCAL, pr: 5283, rev: HEAD, status: row, seatVerdict: null }] : [];
      const path = resolveScorecardStorePath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: rows }));
      if (status) recordRedTeamStatus({ repo: writer, pr: 5283, ...status,
        loopPayload: { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev }, ...read } } } }, { env });
      // The job that wrote the status is gone: a dead pid is not a live pass.
      const evidence = readDrainRedTeamEvidence({ repo: LOCAL, pr: 5283, head: HEAD, env, readScorecards: () => rows, isAlive: () => false });
      expect(evidence).toMatchObject({ inFlight: false });
      let clock = 1000;
      const requests = [];
      const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock, env,
        evidence: { ...evidence, loopPayload: evidence.loopPayload ?? { verdict: { verdict: 'accept' } } },
        requestRedTeam: input => { requests.push(input); return { requested: true }; } });
      const first = h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
      clock += 45 * 60_000;
      return { first, second: h.s.enqueue({ num: 5283 }, HEAD, { comments: [] }), h, requests };
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  it.each([
    ['errored', { status: { status: 'finished', result: { status: 'error' } }, row: 'error' }],
    ['errored with no seat row', { status: { status: 'finished', result: { status: 'error' } } }],
    ['unparseable', { status: { status: 'finished', result: { status: 'ran', comment: 'posted-failed' } }, row: 'unparseable' }],
    ['not-posted', { status: { status: 'finished', result: { status: 'ran', comment: 'not-posted' } }, row: 'not-posted' }],
    ['errored, no job status', { row: 'error' }],
    ['crashed while running', { status: { status: 'running' } }],
    ['errored, status written under another repo and head case',
      { status: { status: 'finished', result: { status: 'error' } }, writer: 'Web-Everything/Web-Everything', rev: HEAD.toUpperCase() }],
  ])('an %s red-team run plus 45 min elapsed is still held', (_name, run) => {
    const { first, second, h, requests } = erroredRunAfterDeadline(run);
    expect(first).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(second).toMatchObject({ enqueued: false, kind: 'red-team-pending', healthSmell: true });
    expect(h.logs.join('')).not.toContain('red team never scheduled');
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
    expect(requests).toHaveLength(0);
  });
  it('keeps an errored card-only run held even without a seat row', () => {
    const { first, second, requests } = erroredRunAfterDeadline({
      status: { status: 'finished', result: { status: 'error' } },
      read: { netChangedFiles: ['backlog/123-card.md'] },
    });
    expect(first).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(second).toMatchObject({ enqueued: false, kind: 'red-team-pending', healthSmell: true });
    expect(requests).toHaveLength(0);
  });
  it('honors the fallback switch and logs its source', () => {
    let clock = 1000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      env: { WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'off' } });
    h.s.enqueue({ num: 5283 }, HEAD);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, healthSmell: true });
    expect(h.logs.join('')).toContain('enqueueWhenRedTeamNeverScheduled=false (env)');
  });
  it('a new live head resets the pending age and backoff', () => {
    const initial = { pending: [], followedUp: [], redTeamPending: { 'cwd#5283': {
      headSha: 'a'.repeat(40), firstPendingAt: 0, retryAt: 99_000_000, commentCount: 0, reason: 'pending' } } };
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], initial, now: () => 5_000_000 });
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ healthSmell: false });
    expect(h.calls.filter(c => c.includes('--slurp'))).toHaveLength(1);
    expect(h.state().redTeamPending['cwd#5283']).toMatchObject({ headSha: HEAD, firstPendingAt: 5_000_000 });
    h.s.confirmQueueFollowUps([{ num: 999, repo: null }]);
    expect(h.state().followedUp).toContain('cwd#999');
    expect(h.state().redTeamPending['cwd#5283'].firstPendingAt).toBe(5_000_000);
  });
  it('keeps enqueue unchanged when no accepted panel owes a red team', () => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['ready-to-merge'], evidence: { loopPayload: null } });
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: true });
  });
  it.each([[[]], [['review:changes']], [['review:human']], [['review:pending']]])('the follow-up backstop dequeues a queued sent-back PR (%j) once', labels => {
    const h = harness({ strategy: 'github-merge-queue', queued: true, labels, initial: { pending: [{ num: 5283, headSha: HEAD }], followedUp: [] } });
    h.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    h.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    expect(h.calls.filter(c => c.some(a => String(a).includes('dequeuePullRequest')))).toHaveLength(1);
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(1);
  });
});


describe('queue safeguard overrides and untracked queue entries', () => {
  it.each(['WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE', 'WE_REVIEW_RED_TEAM', 'WE_REVIEW_EXTRA_SEATS'])('%s off preserves enqueue without a red-team result', key => {
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], env: { ...process.env, [key]: '0' } });
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: true });
  });
  it('dequeueOnSendBack off leaves queued send-backs untouched', () => {
    const h = harness({ strategy: 'github-merge-queue', queued: true, labels: [], initial: { pending: [{ num: 5283, headSha: HEAD }], followedUp: [] }, env: { ...process.env, WE_DRAIN_DEQUEUE_ON_SEND_BACK: 'false' } });
    h.s.collectQueueMerged({ merged: [], landedThisPass: new Set() });
    h.s.dequeueSendBacks([{ number: 5283, labels: [] }]);
    expect(h.calls.some(c => c.some(a => String(a).includes('dequeuePullRequest')))).toBe(false);
  });
  it.each([[[]], [['review:changes']], [['review:human']], [['review:pending']]])('bounds API calls for 150 non-queued open rows with labels %j', labels => {
    const h = harness({ strategy: 'github-merge-queue', labels: [] });
    h.s.dequeueSendBacks(Array.from({ length: 150 }, (_, i) => ({ number: i + 1, labels })));
    expect(h.calls.length).toBeLessThanOrEqual(1);
    expect(h.calls.some(c => c[1] === 'pr')).toBe(false);
  });
  it.each([
    { errors: [{ message: 'rate limited' }] },
    { data: { repository: { mergeQueue: null } } },
    { data: { repository: { mergeQueue: { entries: { nodes: [{ pullRequest: { id: 'PR_NODE', number: 5283 } }], pageInfo: { hasNextPage: true } } } } } },
  ])('does not fall back to per-row reads when queue discovery is incomplete', queueFacts => {
    const h = harness({ strategy: 'github-merge-queue', labels: [], queued: true, queueFacts });
    h.s.dequeueSendBacks([{ number: 5283, labels: [] }]);
    expect(h.calls).toHaveLength(1);
    expect(h.logs.join('')).toMatch(/queue.*failed/i);
  });
  it('revalidates only queued rows even in a large listing', () => {
    const h = harness({ strategy: 'github-merge-queue', labels: [], queued: true });
    h.s.dequeueSendBacks([...Array.from({ length: 150 }, (_, i) => ({ number: i + 1, labels: [] })), { number: 5283, labels: [] }]);
    expect(h.calls.filter(c => c[1] === 'pr' && c[2] === 'view' && c.includes('headRefOid,labels,reviews'))).toHaveLength(1);
    expect(h.calls.filter(c => c.some(a => String(a).includes('dequeuePullRequest')))).toHaveLength(1);
  });
  it.each([[[]], [['ready-to-merge', 'review:changes']], [['ready-to-merge', 'review:human']], [['ready-to-merge', 'review:pending']]])('sweeps a manually queued PR without a follow-up record and with labels %j once', labels => {
    const h = harness({ strategy: 'github-merge-queue', queued: true, labels });
    h.s.dequeueSendBacks([{ number: 5283, labels }]);
    h.s.dequeueSendBacks([{ number: 5283, labels }]);
    expect(h.calls.filter(c => c.some(a => String(a).includes('dequeuePullRequest')))).toHaveLength(1);
    expect(h.calls.filter(c => c[2] === 'comment')).toHaveLength(1);
  });
  it('revalidates labels so an old listing cannot dequeue a newly ready PR', () => {
    const h = harness({ strategy: 'github-merge-queue', queued: true });
    h.s.dequeueSendBacks([{ number: 5283, labels: [] }]);
    expect(h.calls.some(c => c.some(a => String(a).includes('dequeuePullRequest')))).toBe(false);
  });
});

describe('durable drain red-team requests', () => {
  it('records once per normalized repo/PR/head, preserves consumption, and dry-run writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'drain-request-'));
    const env = { WE_COORDINATION_ROOT: root };
    const input = { repo: LOCAL, pr: 5485, head: HEAD };
    try {
      expect(requestDrainRedTeam(input, { env, dryRun: true })).toEqual({ requested: false });
      expect(readDrainRedTeamRequests({ env })).toEqual([]);
      expect(requestDrainRedTeam(input, { env })).toEqual({ requested: true });
      const [request] = readDrainRedTeamRequests({ env });
      expect(request).toMatchObject(input);
      finishDrainRedTeamRequest(request, { env });
      expect(requestDrainRedTeam({ ...input, repo: LOCAL.toUpperCase(), head: HEAD.toUpperCase() }, { env })).toEqual({ requested: true });
      expect(readDrainRedTeamRequests({ env })).toEqual([]);
      expect(requestDrainRedTeam({ ...input, head: 'c'.repeat(40) }, { env })).toEqual({ requested: true });
      expect(readDrainRedTeamRequests({ env })).toHaveLength(1);
      expect(requestDrainRedTeam(input, { env, write: () => { throw new Error('disk full'); } })).toEqual({ requested: true });
      expect(requestDrainRedTeam({ ...input, head: 'd'.repeat(40) }, { env, write: () => { throw new Error('disk full'); } })).toEqual({ requested: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('wires the live drain construction and suppresses the writer for dry-run', () => {
    const source = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    expect(/requestRedTeam:.*DRY_RUN.*requestDrainRedTeam/.test(source)).toBe(true);
  });
});


describe('drain pre-stage queue admission', () => {
  it('changed safety policy falls back before mutation or failure backoff', () => {
    const { s, calls, state } = harness({ strategy:'github-merge-queue', enqueueFails:true });
    const c = { num:42, repo:null };
    const prepared = s.prestage(c, HEAD);
    expect(prepared.allowed).toBe(true);
    prepared.safety = { ...prepared.safety, redTeamPendingMaxMin:999 };
    calls.length = 0;
    expect(s.enqueue(c, HEAD, { prepared })).toEqual({ fallback:true });
    expect(calls).toEqual([]);
    expect(state()).toBeNull();
  });
  it('a throwing prepared enqueue leaves the ordinary recovery attempt unthrottled', () => {
    const { s, calls, state } = harness({ strategy:'github-merge-queue', enqueueFails:true });
    const c = { num:42, repo:null };
    const prepared = s.prestage(c, HEAD);
    expect(prepared.allowed).toBe(true);
    expect(() => s.enqueue(c, HEAD, { prepared })).toThrow('prepared enqueue FAILED');
    expect(state()).toBeNull();
    expect(() => s.enqueue(c, HEAD)).toThrow('enqueue FAILED');
    expect(calls.filter(call => call.some(arg => String(arg).includes('enqueuePullRequest')))).toHaveLength(2);
    expect(state().enqueueFailures['cwd#42']).toMatchObject({ headSha: HEAD, count: 1 });
    expect(state().pending).toEqual([]);
  });
  it('prepares without writes and rechecks red-team disposition at enqueue', () => {
    const { s, calls, state } = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence: { loopPayload: null } });
    const c = { num: 42, repo: null, headRef: 'lane/a' };
    const prepared = s.prestage(c, HEAD);
    expect(prepared.allowed).toBe(true);
    expect(state()).toBeNull();
    expect(calls.some(call => call.some(arg => String(arg).includes('enqueuePullRequest')))).toBe(false);
    calls.length = 0;
    expect(s.enqueue(c, HEAD, { prepared, comments: prepared.comments })).toMatchObject({ enqueued: true });
    // Both admission and the post-enqueue clearance dedupe read the live thread.
    expect(calls.filter(call => call.includes('--slurp'))).toHaveLength(2);
    expect(calls.some(call => call[0] === 'git' && ['fetch', 'diff'].includes(call[1]))).toBe(false);
  });
  // PR #5480 red-team finding: the prepared file list is bound to the base branch and tip it was read against,
  // so a PR retargeted (or whose base moved) between pre-stage and enqueue is re-read against the live base.
  const diffAgainst = (calls, base) => calls.some(call => call[0] === 'git' && call[1] === 'rev-parse' && call.includes(`refs/remotes/origin/${base}^{commit}`))
    && calls.some(call => call[0] === 'git' && call[1] === 'diff' && call.some(a => String(a).endsWith(`...${HEAD}`)));
  it('binds the prepared file list to its base and re-reads the diff when the live base differs', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence: { loopPayload: null } });
    const c = { num: 42, repo: null, headRef: 'lane/a', baseRefName: 'release' };
    const prepared = s.prestage(c, HEAD);
    expect(prepared).toMatchObject({ allowed: true, preparedSurface: { headSha: HEAD, base: 'release', baseSha: BASE_TIP, files: ['scripts/x.mjs'] } });
    calls.length = 0;
    expect(s.enqueue(c, HEAD, { prepared, comments: prepared.comments })).toMatchObject({ enqueued: true });
    expect(diffAgainst(calls, 'main')).toBe(true);
  });
  it('re-reads the diff when the base branch moved under the same name between pre-stage and enqueue', () => {
    let tip = BASE_TIP;
    const { s, calls } = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence: { loopPayload: null }, baseTip: () => tip });
    const c = { num: 42, repo: null, headRef: 'lane/a' };
    const prepared = s.prestage(c, HEAD);
    expect(prepared.preparedSurface).toMatchObject({ base: 'main', baseSha: BASE_TIP });
    tip = 'f'.repeat(40);
    calls.length = 0;
    expect(s.enqueue(c, HEAD, { prepared, comments: prepared.comments })).toMatchObject({ enqueued: true });
    expect(diffAgainst(calls, 'main')).toBe(true);
  });
  it('keeps held red-team dispositions ineligible', () => {
    const { s } = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      evidence: { loopPayload: { verdict: { verdict: 'accept' } }, inFlight: true } });
    expect(s.prestage({ num: 42, repo: null }, HEAD).allowed).toBe(false);
  });
  it.each([{ labels:['review:accepted'] }, { labels:['review:accepted', 'checking'] }])('requires explicit ready-to-merge authorization: $labels', ({ labels }) => {
    const { s, calls } = harness({ strategy: 'github-merge-queue', labels, evidence: { loopPayload: null } });
    const c = { num: 42, repo: null };
    expect(s.prestage(c, HEAD)).toMatchObject({ allowed: false, reason: 'ready-to-merge was removed' });
    const authorized = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence: { loopPayload: null } }).s.prestage(c, HEAD);
    expect(authorized.allowed).toBe(true);
    expect(s.enqueue(c, HEAD, { prepared: { ...authorized, labels: JSON.stringify([...labels].sort()) } })).toMatchObject({ enqueued: false, kind: 'sent-back' });
    expect(calls.some(call => call.some(arg => String(arg).includes('enqueuePullRequest')))).toBe(false);
  });
  it.each(['break', 'in-flight', 'unreadable'])('revalidates %s evidence that arrives after preparation', async variant => {
    const evidence = { loopPayload: null, inFlight: false, recorded: false };
    const comments = [];
    const { s, calls } = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence, liveComments: comments });
    const c = { num: 5283, repo: null };
    const prepared = s.prestage(c, HEAD);
    expect(prepared.allowed).toBe(true);
    if (variant === 'break') {
      const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
      comments.push({ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
        pr: 5283, rev: HEAD, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
        findings: [{ summary: 'new break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }],
      }) });
    } else if (variant === 'in-flight') {
      evidence.loopPayload = { verdict: { verdict: 'accept' } };
      evidence.inFlight = true;
    } else evidence.readError = true;
    if (variant === 'unreadable') expect(() => s.enqueue(c, HEAD, { prepared, comments: prepared.comments })).toThrow('evidence unreadable');
    else expect(s.enqueue(c, HEAD, { prepared, comments: prepared.comments })).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(calls.some(call => call.some(arg => String(arg).includes('enqueuePullRequest')))).toBe(false);
  });
});


describe('orphaned accepted panel-seat recovery', () => {
  const panel = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: HEAD }, netChangedFiles: ['scripts/x.mjs'] } } };
  const evidence = { scheduled: true, recorded: false, attempted: false, inFlight: false, loopPayload: panel };
  function setup(extra = {}) {
    const requests = [];
    let clock = 1000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      env: { WE_RED_TEAM_TIMING: 'panel-seat', WE_DRAIN_RED_TEAM_REQUEST_COOLDOWN_MIN: '2' }, evidence,
      requestRedTeam: input => { requests.push(input); return { requested: false }; }, now: () => clock, ...extra });
    return { ...h, requests, advance: ms => { clock += ms; } };
  }
  it('requests an unseated accepted head promptly, retries on cooldown, and holds until a usable result', () => {
    const h = setup();
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.requests).toHaveLength(1);
    h.advance(60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(1);
    h.advance(60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(2);
    expect(h.logs.join('')).toContain('requesting red team for #5485');
    expect(h.logs.join('')).not.toContain('red team never scheduled');
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
  });
  it.each([
    { evidence: { ...evidence, inFlight: true } }, { evidence: { ...evidence, queued: true } },
    { evidence: { ...evidence, attempted: true } }, { evidence: { ...evidence, recorded: true } },
    { readReviewAgents: () => [{ name: 'review-pr-5485-we', state: 'working', repo: LOCAL, pr: 5485, kind: 'review-job' }] },
    { readReviewAgents: () => { throw Error('unreadable jobs'); } },
    { labels: ['ready-to-merge'] },
    { evidence: { ...evidence, loopPayload: { ...panel, verdict: { verdict: 'needs-human' } } } },
    { readReviewAgents: () => [{ name: 'review-5485', state: 'queued' }] },
    { evidence: { ...evidence, scheduled: false }, readReviewAgents: () => [{ name: 'review-5485', state: 'queued' }] },
    { evidence: { ...evidence, loopPayload: { ...panel, findings: { read: { netBasis: { rev: 'c'.repeat(40) } } } } } },
    { readReviewAgents: () => Object.defineProperty([], 'incomplete', { value: [{ session: 'review-5485' }] }) },
    { requestRedTeam: undefined },
    { evidence: { ...evidence, loopPayload: { ...panel, findings: { read: { netBasis: { rev: HEAD }, netChangedFiles: ['backlog/123-card.md'] } } } } },
    { env: { WE_RED_TEAM_TIMING: 'panel-seat', WE_REVIEW_RED_TEAM: 'off' } },
    { env: { WE_RED_TEAM_TIMING: 'panel-seat', WE_REVIEW_EXTRA_SEATS: 'off' } },
  ])('does not request when work, exemption, or refusal prevents recovery (%j)', extra => {
    const h = setup(extra);
    h.s.enqueue({ num: 5485 }, HEAD);
    h.advance(60 * 60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(0);
  });
  it.each([
    ['panel-seat', 'recorded'], ['panel-seat', 'attempted'],
    ['post-accept', 'recorded'], ['post-accept', 'attempted'],
  ])('%s holds %s evidence without requesting again, until a usable result exists', (timing, field) => {
    const thread = [];
    const requestRedTeam = vi.fn(() => ({ requested: true }));
    const h = setup({ liveComments: thread, requestRedTeam,
      env: { WE_RED_TEAM_TIMING: timing }, evidence: { ...evidence, [field]: true } });
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    h.advance(60 * 60_000);
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending', healthSmell: true });
    expect(requestRedTeam).not.toHaveBeenCalled();
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
    thread.push({ user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5485 rev=${HEAD} -->\n### Post-accept red team — no break found` });
    expect(h.s.enqueue({ num: 5485 }, HEAD, { comments: thread })).toMatchObject({ enqueued: true });
    expect(requestRedTeam).not.toHaveBeenCalled();
  });
  it('records a successful request once, keeps holding, then admits a usable head result', () => {
    const requests = [];
    const thread = [];
    const h = setup({ liveComments: thread, requestRedTeam: input => { requests.push(input); return { requested: true }; } });
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, redTeamRequested: true });
    h.advance(60 * 60_000);
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false });
    expect(requests).toHaveLength(1);
    expect(h.logs.join('')).toContain('requested red team for #5485');
    thread.push({ user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5485 rev=${HEAD} -->\n### Post-accept red team — no break found` });
    expect(h.s.enqueue({ num: 5485 }, HEAD, { comments: thread })).toMatchObject({ enqueued: true });
  });
});
