// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDrainMergeStrategy, resolveDrainMergePolicy, readEnqueueClearance, buildClearanceComment, hasClearanceFor, DRY_RUN_STRATEGY_ENV,
  staleRedTeamRequestEligibility, requestDrainRedTeam, readDrainRedTeamRequests, finishDrainRedTeamRequest, readQueueState, FOLLOW_UP_MAX_ATTEMPTS, readMergeDeliveryToolSettings, MERGE_DELIVERY_SETTINGS_FILE_ENV,
} from '../drain-merge-strategy.mjs';
import { readReserves, writeReserves } from '../priority-reserve.mjs';
import { resolveMergeDeliveryPolicy } from '../merge-delivery-policy.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { rulesetSuggestion } from '../merge-queue-enqueue.mjs';
import { saveProvenanceFixtures } from './fixtures/saved-red-team-provenance.mjs';
import { resolveScorecardStorePath } from '../../conveyor/run-scorecard-store.mjs';
import { readDrainRedTeamEvidence, recordRedTeamStatus } from '../drain-red-team-evidence.mjs';
import { withLandWriteLock } from '../../readiness/drain-lock.mjs';
import { publishAttention } from '../../operations/needs-you-feed.mjs';
import { isUnderTest } from '../under-test.mjs';

// The real operator feed is never written from this file: every test either injects a publisher or relies on the
// test-run guard, and the guard's own tests assert against this stand-in.
vi.mock('../../operations/needs-you-feed.mjs', async importOriginal => ({ ...(await importOriginal()), publishAttention: vi.fn() }));

const HEAD = 'b'.repeat(40);
const BASE_TIP = 'e'.repeat(40);
const LOCAL = 'web-everything/web-everything';
const policyOf = (strategy) => ({ policy: resolveMergeDeliveryPolicy({ tool: strategy ? { strategy } : undefined }), note: null });

const DRAIN = 'drain-bot';

function harness({ gitExec, resolveRealFiles, priorityReserve, reservePath, strategy = null, dryRun = false, initial = null, ghView = {} , enqueueFails = false, onView = {}, viewThrows = [], selfLogin = DRAIN, withLock, mutation, inQueue, liveComments, postConflictFinding = () => {}, now, labels = ['ready-to-merge'], queued = false, queueFacts, env = { ...process.env, WE_RED_TEAM_TIMING: 'post-accept' }, evidence = { loopPayload: labels.includes('review:accepted') ? { verdict: { verdict: 'accept' } } : null, inFlight: false, recorded: false, scheduled: labels.includes('review:accepted') && !['off', 'false', '0'].includes(env.WE_REVIEW_RED_TEAM) && !['off', 'false', '0'].includes(env.WE_REVIEW_EXTRA_SEATS) }, requestRedTeam, readReviewAgents = () => [], baseTip = () => BASE_TIP, strategyExtra = {}, evidenceFor = null, publishNeedsYou, redTeamDeadline } = {}) {
  const calls = [];
  const logs = [];
  let stored = initial;
  let mutated = false;
  let removed = false;
  const exec = (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && gitExec) return gitExec(args, opts);
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
    ...strategyExtra,
    ...(resolveRealFiles ? { resolveRealFiles } : {}),
    ...(priorityReserve ? { priorityReserve } : {}), ...(reservePath ? { reservePath } : {}),
    dryRun, env, readReviewAgents, readRedTeamEvidence: (o) => { if (evidenceFor) return evidenceFor(o); if (evidence.readError) throw new Error('evidence unreadable'); return evidence; }, requestRedTeam, publishNeedsYou, redTeamDeadline, isLocalRepo: (r) => r == null || r === LOCAL, localSlug: LOCAL, exec, statePath: '/x/state.json',
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
  it('xym8nt4: a card-group source is deferred as card-grouped and never reaches the enqueue mutation', () => {
    const { s, calls } = harness({ strategy: 'github-merge-queue', strategyExtra: {
      cardGroupHold: c => (c.num === 42 ? { kind: 'card-grouped', reason: 'grouped into #9 (lands with it; drain.group)' } : null) } });
    const r = s.enqueue({ num: 42, repo: null }, HEAD, { comments: [] });
    expect(r).toMatchObject({ enqueued: false, deferred: true, kind: 'card-grouped' });
    expect(calls.some(c => c.join(' ').includes('enqueuePullRequest'))).toBe(false);
    expect(calls).toEqual([]);
  });

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

  it('live 2026-10-21 "merged 2 (#5798, #5798)": one PR pending as cwd#N AND <slug>#N is ONE landing', () => {
    // The real state left behind: followedUp held both 'cwd#5798' and 'web-everything/web-everything#5798'.
    const initial = { pending: [{ num: 5798, repo: null, headSha: HEAD }, { num: 5798, repo: LOCAL, headSha: HEAD }], followedUp: [] };
    const h = harness({ strategy: 'github-merge-queue', initial, ghView: { 5798: MERGED } });
    const merged = [];
    const done = h.s.collectQueueMerged({ merged, landedThisPass: new Set() });
    expect(merged.map((m) => m.num)).toEqual([5798]);
    h.s.confirmQueueFollowUps(done);
    expect(h.state().pending).toEqual([]);
    // a landing another path already recorded this pass (the cascade's already-merged probe) is not pushed again
    const h2 = harness({ strategy: 'github-merge-queue', initial: { pending: [{ num: 7, repo: LOCAL }], followedUp: [] }, ghView: { 7: MERGED } });
    const m2 = [{ num: 7, repo: null }];
    h2.s.collectQueueMerged({ merged: m2, landedThisPass: new Set() });
    expect(m2).toHaveLength(1);
    // a legacy `cwd#N` followedUp entry still retires its slug-keyed pending twin
    const h3 = harness({ strategy: 'github-merge-queue', initial: { pending: [{ num: 9, repo: LOCAL }], followedUp: ['cwd#9'] }, ghView: { 9: MERGED } });
    const m3 = [];
    expect(h3.s.collectQueueMerged({ merged: m3, landedThisPass: new Set() })).toEqual([]);
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


describe('recorded hold read-only admission', () => {
  const key = 'cwd#5283';
  const initial = () => ({ pending: [], followedUp: [], redTeamPending: {
    [key]: { headSha: HEAD, firstPendingAt: 0, retryAt: 0, reason: 'no recorded result on the live head' },
  } });
  function reader({ state, write, head = HEAD, evidence = {}, labels = ['review:accepted', 'ready-to-merge'], onView = () => {}, request = () => {}, redTeamDeadline }) {
    const mutations = [];
    const s = createDrainMergeStrategy({ localSlug: LOCAL, statePath: 'unused-hold-state',
      resolved: policyOf('github-merge-queue'), env: { WE_RED_TEAM_TIMING: 'post-accept' },
      queueSafety: { value: { waitForRedTeamBeforeEnqueue: true, dequeueOnSendBack: true } },
      now: () => 1000, log: { write: () => {} },
      readFile: () => JSON.stringify(state()), writeState: (_path, value) => write(structuredClone(value)),
      readRedTeamEvidence: () => evidence, requestRedTeam: request, ...(redTeamDeadline ? { redTeamDeadline } : {}),
      labelProvider: { ensureLabel: () => mutations.push('ensure-label'), setLabels: () => mutations.push('labels') },
      exec: (_cmd, args) => {
        if (args[0] === 'pr' && args[1] === 'view') {
          onView();
          return JSON.stringify({ headRefOid: typeof head === 'function' ? head() : head, labels });
        }
        if (args.includes('--slurp')) return '[[]]';
        mutations.push(args);
        return '{}';
      },
    });
    return { s, mutations };
  }

  it.each(['held', 'clear', 'request', 'sent-back'])('holdOnly performs zero shared-state writes: %s', mode => {
    let stored = initial();
    const writes = [];
    const requests = [];
    const h = reader({ state: () => stored, write: value => { writes.push(value); stored = value; },
      labels: mode === 'sent-back' ? ['review:changes'] : mode === 'clear' ? ['ready-to-merge'] : ['review:accepted', 'ready-to-merge'],
      evidence: mode === 'clear' ? { skipCardOnly: true, scheduled: false }
        : mode === 'request' ? { scheduled: false, loopPayload: { verdict: { verdict: 'accept' } } }
          : { scheduled: true, inFlight: true },
      request: value => { requests.push(value); return { requested: true }; },
    });
    const before = structuredClone(stored);
    const outcome = h.s.recordedHold({ num: 5283 }, HEAD);
    expect(outcome).toBeNull(); // every case needs the ordinary locked path to refresh/clear/dequeue
    expect(writes).toEqual([]);
    expect(stored).toEqual(before);
    expect(h.mutations).toEqual([]);
    expect(requests).toEqual([]);
  });

  describe('yieldTargetHold (overlap-yield target eligibility, read-only)', () => {
    const rec = (extra = {}) => ({ ...initial().redTeamPending[key], requestedAt: 500, ...extra });
    // A local target: enqueue may read either cwd# or owner/name#, so a settled answer needs both.
    const requested = (extra = {}) => ({ pending: [], followedUp: [], redTeamPending: { [key]: rec(extra), [`${LOCAL}#5283`]: rec(extra) } });
    // `state` is the stored OBJECT here; reader() wants a getter, so it must not be spread over the getter.
    const run = ({ state: initialState, ...opts }) => {
      let stored = initialState ?? requested();
      const writes = []; const requests = [];
      const h = reader({ ...opts, state: () => stored, write: value => { writes.push(value); stored = value; },
        request: value => { requests.push(value); return { requested: true }; } });
      return { h, writes, requests };
    };
    const inFlight = { scheduled: true, inFlight: true };
    it('a requested red-team wait on the live head with no result is a blocking hold — and nothing is written', () => {
      const r = run({ evidence: inFlight });
      expect(r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toMatchObject({ kind: 'red-team-pending' });
      expect(r.writes).toEqual([]); expect(r.requests).toEqual([]); expect(r.h.mutations).toEqual([]);
    });
    it.each([['cwd#5283', null], ['cwd#5283', LOCAL], [`${LOCAL}#5283`, null], [`${LOCAL}#5283`, LOCAL]])('a wait under only %s (repo %s) is unknown — it throws, waiters keep yielding', (k, repoArg) => {
      const r = run({ state: { pending: [], followedUp: [], redTeamPending: { [k]: rec() } }, evidence: inFlight });
      expect(() => r.h.s.yieldTargetHold({ num: 5283, repo: repoArg }, HEAD)).toThrow(/only some of the keys/);
    });
    it('both keys recorded on this head ⇒ blocked for either repo naming', () => {
      for (const repoArg of [null, LOCAL]) {
        const r = run({ evidence: inFlight });
        expect(r.h.s.yieldTargetHold({ num: 5283, repo: repoArg }, HEAD)).toMatchObject({ kind: 'red-team-pending' });
      }
    });
    it('reads red-team evidence with an explicit, migration-free runs dir', () => {
      const seen = [];
      vi.stubEnv('OPERATION_RUNS_DIR', '/tmp/we-yield-probe-runs');
      const s2 = createDrainMergeStrategy({ localSlug: LOCAL, statePath: 'x', resolved: policyOf('github-merge-queue'),
        env: { WE_RED_TEAM_TIMING: 'post-accept' }, queueSafety: { value: { waitForRedTeamBeforeEnqueue: true } }, log: { write: () => {} },
        readFile: () => JSON.stringify(requested()), readRedTeamEvidence: (a) => { seen.push(a); return inFlight; },
        exec: (_c, args) => (args[0] === 'pr' ? JSON.stringify({ headRefOid: HEAD, labels: ['review:accepted', 'ready-to-merge'] }) : args.includes('--slurp') ? '[[]]' : '{}') });
      s2.yieldTargetHold({ num: 5283 }, HEAD);
      expect(seen).toHaveLength(1);
      expect(seen[0].runsDir).toBe('/tmp/we-yield-probe-runs');
      vi.unstubAllEnvs();
    });
    it('Codex audit #3: a cold probe on a head with no red-team trace and no proof yet is unknown (throws — keep yielding), runs no git', () => {
      const calls = [];
      const s2 = createDrainMergeStrategy({ localSlug: LOCAL, statePath: 'x', resolved: policyOf('github-merge-queue'),
        env: { WE_RED_TEAM_TIMING: 'post-accept' }, queueSafety: { value: { waitForRedTeamBeforeEnqueue: true } }, log: { write: () => {} },
        readFile: () => JSON.stringify(requested()), readRedTeamEvidence: () => ({ scheduled: false, recorded: false, inFlight: false, loopPayload: null }),
        numberingRedTeamSetting: () => ({ value: true, source: 'test' }),
        exec: (c, args) => { calls.push(c); return args[0] === 'pr' ? JSON.stringify({ headRefOid: HEAD, labels: ['review:accepted', 'ready-to-merge'] }) : args.includes('--slurp') ? '[[]]' : '{}'; } });
      expect(() => s2.yieldTargetHold({ num: 5283 }, HEAD)).toThrow(/numbering alias not yet proven/);
      expect(calls).not.toContain('git');
    });
    it('aliases that disagree on the request state are unknown (throws — keep yielding)', () => {
      const st = requested();
      st.redTeamPending[`${LOCAL}#5283`] = rec({ requestedAt: undefined }); // no requestedAt
      const r = run({ state: st, evidence: { scheduled: false, loopPayload: { verdict: { verdict: 'accept' } } } });
      expect(() => r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toThrow();
    });
    it('with the never-scheduled escape retired, an unrequested held reason is blocked', () => {
      const r = run({ state: requested({ requestedAt: undefined }), evidence: inFlight });
      expect(r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toMatchObject({ kind: 'red-team-pending' });
    });
    it('only the named operator merge-without-result override can still enqueue it, so that is unknown (throws)', () => {
      const r = run({ state: requested({ requestedAt: undefined }), evidence: inFlight,
        redTeamDeadline: { value: { deadlineAction: 'merge-without-result' }, sources: { deadlineAction: 'env' }, operatorOverride: { by: 'operator' } } });
      expect(() => r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toThrow(/merge-without-result override/);
    });
    it('no recorded wait on THIS head ⇒ not blocked (waiters keep yielding)', () => {
      const r = run({ state: requested({ headSha: 'f'.repeat(40) }), evidence: inFlight });
      expect(r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toBeNull();
    });
    it('a live head that moved is unknown — it throws so the caller keeps the yield', () => {
      const r = run({ head: 'a'.repeat(40), evidence: inFlight });
      expect(() => r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toThrow(/live head/);
    });
    it('an unreadable follow-up state throws (fail closed)', () => {
      const s = createDrainMergeStrategy({ localSlug: LOCAL, statePath: 'x', resolved: policyOf('github-merge-queue'),
        queueSafety: { value: { waitForRedTeamBeforeEnqueue: true } }, log: { write: () => {} }, readFile: () => '{not json' });
      expect(() => s.yieldTargetHold({ num: 5283 }, HEAD)).toThrow(/unreadable/);
    });
    it('a sent-back target is blocked (sent-back)', () => {
      const r = run({ labels: ['review:changes'], evidence: inFlight });
      expect(r.h.s.yieldTargetHold({ num: 5283 }, HEAD)).toMatchObject({ kind: 'sent-back' });
    });
    it('strictly read-only: never runs git, never lists agents/jobs, and an unsettled card-only answer is unknown, not blocked', () => {
      const gitCalls = []; const agentReads = [];
      const s = createDrainMergeStrategy({ localSlug: LOCAL, statePath: 'x', resolved: policyOf('github-merge-queue'),
        env: { WE_RED_TEAM_TIMING: 'post-accept' }, queueSafety: { value: { waitForRedTeamBeforeEnqueue: true } }, log: { write: () => {} },
        readFile: () => JSON.stringify(requested()), writeState: () => { throw new Error('write'); },
        readReviewAgents: () => { agentReads.push(1); return []; },
        readRedTeamEvidence: () => ({ scheduled: false, loopPayload: { verdict: { verdict: 'accept' } } }),
        exec: (cmd, args) => {
          if (cmd === 'git') { gitCalls.push(args); throw new Error('git must not run'); }
          if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: HEAD, labels: ['review:accepted', 'ready-to-merge'] });
          if (args.includes('--slurp')) return '[[]]';
          return '{}';
        } });
      let out; let threw = null;
      try { out = s.yieldTargetHold({ num: 5283, headRef: 'lane/x' }, HEAD); } catch (e) { threw = e; }
      expect(gitCalls).toEqual([]);
      expect(agentReads).toEqual([]);
      // Either every variant agrees on a definite stop, or the probe says it cannot tell. Never a guessed "blocked".
      if (!threw) expect(out === null || out.kind === 'red-team-pending').toBe(true);
    });
  });

  it('keeps a cached hold and refreshes an expired hold only on ordinary locked enqueue', () => {
    const root = mkdtempSync(join(tmpdir(), 'hold-refresh-lock-'));
    try {
      let stored = initial();
      stored.redTeamPending[key].retryAt = 2000;
      const writes = [];
      let locked = false;
      const h = reader({ state: () => stored, write: value => { writes.push(locked); stored = value; },
        evidence: { scheduled: true, inFlight: true },
      });
      expect(h.s.recordedHold({ num: 5283 }, HEAD)).toMatchObject({ kind: 'red-team-pending' });
      expect(writes).toEqual([]);
      stored.redTeamPending[key].retryAt = 0;
      expect(h.s.recordedHold({ num: 5283 }, HEAD)).toBeNull();
      expect(writes).toEqual([]);
      // A peer's queue entry arrives after the pre-check and must survive the locked state re-read.
      stored.pending.push({ num: 77, headSha: HEAD });
      const result = withLandWriteLock(() => {
        locked = true;
        try { return h.s.enqueue({ num: 5283 }, HEAD); } finally { locked = false; }
      }, { lockRoot: root, runUnlockedOnContention: false });
      expect(result.result).toMatchObject({ kind: 'red-team-pending' });
      expect(writes).toEqual([true]);
      expect(stored.pending).toEqual([expect.objectContaining({ num: 77 })]);
      expect(stored.redTeamPending[key].retryAt).toBe(301000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['held', 'clear'])('overlapping drains preserve the newer-head hold and queue entries: %s old head', mode => {
    const root = mkdtempSync(join(tmpdir(), 'hold-merge-lock-'));
    try {
      let stored = initial();
      let locked = false;
      let liveHead = HEAD;
      const newerHead = 'c'.repeat(40);
      const writes = [];
      const write = value => { writes.push({ locked, value }); stored = value; };
      const lock = fn => withLandWriteLock(() => {
        locked = true;
        try { return fn(); } finally { locked = false; }
      }, { lockRoot: root, runUnlockedOnContention: false });
      const peer = reader({ state: () => stored, write, head: newerHead, evidence: { scheduled: true, inFlight: true } });
      let interleaved = false;
      const old = reader({ state: () => stored, write, head: () => liveHead,
        labels: mode === 'clear' ? ['ready-to-merge'] : ['review:accepted', 'ready-to-merge'],
        evidence: mode === 'clear' ? { skipCardOnly: true, scheduled: false } : { scheduled: true, inFlight: true },
        onView: () => {
          if (interleaved) return;
          interleaved = true;
          // The old drain has read its snapshot. A second drain now records a new head under the real mutex.
          expect(lock(() => {
            stored.pending.push({ num: 77, repo: null, headSha: newerHead });
            return peer.s.enqueue({ num: 5283 }, newerHead);
          }).result).toMatchObject({ kind: 'red-team-pending' });
        },
      });
      old.s.recordedHold({ num: 5283 }, HEAD);
      expect(stored.redTeamPending[key].headSha).toBe(newerHead);
      expect(stored.pending).toEqual([expect.objectContaining({ num: 77 })]);
      expect(writes.every(w => w.locked)).toBe(true);
      // Falling through the pre-check is not clearance: locked enqueue re-reads state and the live head.
      liveHead = newerHead;
      expect(lock(() => old.s.enqueue({ num: 5283 }, HEAD)).result).toMatchObject({ kind: 'live-state-unreadable' });
      expect(stored.redTeamPending[key].headSha).toBe(newerHead);
      expect(stored.pending).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
  it('a head with no red team ever scheduled gets one request attempt per head even if dispatch becomes available later', () => {
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
    expect(next.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requests).toHaveLength(1);
    expect(next.logs.join('')).toContain('redTeamRequestCooldownMin=2 (env)');
    clock += 200 * 60_000;
    const restarted = harness({ ...options, initial: next.state() });
    expect(restarted.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requests).toHaveLength(1);
    const newHead = 'c'.repeat(40);
    const moved = harness({ ...options, initial: restarted.state(), ghView: { 5485: { headRefOid: newHead, labels: options.labels } } });
    expect(moved.s.enqueue({ num: 5485 }, newHead)).toMatchObject({ enqueued: false, redTeamRequested: true });
    expect(requests).toHaveLength(2);
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
      // A retry record with no saved-result provenance on the same head is not a result.
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team',
        repo: LOCAL, pr: 5283, rev: HEAD, status: 'ok', recheckStatus: 'ok', findings: [], confirmedMissCount: 0 }] }));
      clock = next.state().redTeamPending['cwd#5283'].retryAt;
      // The retry record carries no saved-result provenance, so it is not a trusted result. Before the deadline hold
      // (lane/redteam-no-merge-without-result) the retired never-scheduled escape enqueued it anyway; now it stays held.
      expect(next.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
      expect(next.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
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
    thread.push({ user: { login: 'chalbert' }, body: buildVerdictComment({
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
  it('raises a named health smell and HOLDS a never-scheduled pass at the maximum, even during backoff (no merge without a result)', () => {
    let clock = 1_000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      env: { WE_DRAIN_RED_TEAM_PENDING_BACKOFF_SEC: '7200', WE_DRAIN_RED_TEAM_PENDING_MAX_MIN: '45' } });
    h.s.enqueue({ num: 5283 }, HEAD);
    clock += 45 * 60_000 - 1;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ healthSmell: false });
    clock += 1;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, deferred: true, kind: 'red-team-pending', healthSmell: true, deadlineHeld: true });
    expect(h.logs.join('')).toContain(`health smell: ${LOCAL}#5283 red-team-pending on ${HEAD}`);
    expect(h.logs.join('')).toContain('redTeamPendingMaxMin=45, env');
    // First read + the deadline recheck despite the 7200s backoff; no third (clearance-stamp) read, since nothing enqueues.
    expect(h.calls.filter(c => c.includes('--slurp'))).toHaveLength(2);
    expect(h.logs.join('')).toContain(`HOLD ${LOCAL}#5283 on ${HEAD}: held: no red-team result on this head after 45 min (no red-team request path)`);
    expect(h.logs.join('')).toContain('redTeam.deadlineAction=requeue-then-hold (standard)');
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
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
  it('requests an overdue missing pass ONCE through the supplied review dispatch path, then holds (never enqueues)', () => {
    let clock = 1000;
    const requests = [], notes = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      requestRedTeam: input => { requests.push(input); return { requested: true }; }, publishNeedsYou: item => notes.push(item) });
    h.s.enqueue({ num: 5283 }, HEAD);
    expect(requests).toHaveLength(0);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, healthSmell: true, redTeamRequested: true });
    expect(requests).toEqual([expect.objectContaining({ repo: LOCAL, pr: 5283, head: HEAD })]);
    expect(notes).toHaveLength(0); // the re-request gets its own full wait before the operator is asked
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false });
    expect(requests).toHaveLength(1);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, deferred: true, kind: 'red-team-pending', deadlineHeld: true });
    expect(requests).toHaveLength(1);
    expect(notes).toEqual([expect.objectContaining({ repo: LOCAL, pr: 5283, head: HEAD, kind: 'red-team-deadline-held',
      reason: expect.stringContaining('still none after one re-request') })]);
    clock += 10 * 60 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(requests).toHaveLength(1);
    expect(notes).toHaveLength(1);
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
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
  // held until a usable result exists; stale attempts can request recovery without admission.
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
    expect(requests).toHaveLength(run.status ? 1 : 0);
  });
  it('releases an errored card-only attempt without a seat row when the producer skips cards', () => {
    const { first, second, requests } = erroredRunAfterDeadline({
      status: { status: 'finished', result: { status: 'error' } },
      read: { netChangedFiles: ['backlog/123-card.md'] },
    });
    expect(first).toMatchObject({ enqueued: true });
    expect(second).toMatchObject({ enqueued: true });
    expect(requests).toHaveLength(0);
  });
  it('a retired enqueueWhenRedTeamNeverScheduled=true no longer releases the hold, and says so', () => {
    let clock = 1000;
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], now: () => clock,
      env: { WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'on' } });
    h.s.enqueue({ num: 5283 }, HEAD);
    clock += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD)).toMatchObject({ enqueued: false, healthSmell: true, deadlineHeld: true });
    expect(h.logs.join('')).toContain('WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED is retired and ignored');
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


describe('red-team wait deadline never merges without a result (redTeam.deadlineAction)', () => {
  const ACCEPTED = ['review:accepted', 'ready-to-merge'];
  const enqueuedAny = h => h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')));
  const clean = { user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->\n### Post-accept red team — no break found` };
  const pastDeadline = (opts = {}) => {
    const clock = { t: 1000 };
    const notes = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, publishNeedsYou: item => notes.push(item), ...opts });
    h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    clock.t += 45 * 60_000;
    return { h, clock, notes };
  };

  it('deadline passed + no result: held with a clear reason, one operator note for repo/PR/head, no enqueue', () => {
    const { h, clock, notes } = pastDeadline();
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deferred: true, deadlineHeld: true,
      reason: 'held: no red-team result on this head after 45 min (no red-team request path)' });
    expect(notes).toEqual([{ repo: LOCAL, pr: 5283, head: HEAD, kind: 'red-team-deadline-held',
      reason: 'held: no red-team result on this head after 45 min (no red-team request path)', pick: `https://github.com/${LOCAL}/pull/5283` }]);
    expect(h.state().redTeamPending['cwd#5283']).toMatchObject({ headSha: HEAD, firstPendingAt: 1000, deadlineHeldAt: clock.t, notifiedAt: clock.t });
    // Repeated passes and a drain restart keep the hold and publish nothing new.
    for (let i = 0; i < 3; i++) { clock.t += 10 * 60_000; expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true }); }
    const restarted = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, initial: h.state(), publishNeedsYou: item => notes.push(item) });
    clock.t += 10 * 60_000;
    expect(restarted.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(notes).toHaveLength(1);
    expect(enqueuedAny(h) || enqueuedAny(restarted)).toBe(false);
  });

  it('a failed note publication leaves the hold intact and retries at the next recheck', () => {
    let fail = true;
    const notes = [];
    const { h, clock } = pastDeadline({ publishNeedsYou: item => { if (fail) throw new Error('feed lock busy'); notes.push(item); } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(h.logs.join('')).toContain('red-team deadline note for #5283 not published (feed lock busy) — PR stays held');
    fail = false;
    clock.t += 300_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(notes).toHaveLength(1);
    expect(enqueuedAny(h)).toBe(false);
  });

  it.each(['inFlight', 'queued', 'recorded'])('a %s run past the deadline is held with the note and is not re-requested', field => {
    const requests = [];
    const { h, notes } = pastDeadline({ evidence: { loopPayload: { verdict: { verdict: 'accept' } }, [field]: true, scheduled: true },
      requestRedTeam: input => { requests.push(input); return { requested: true }; } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(requests).toHaveLength(0);
    expect(notes).toHaveLength(1);
  });

  it('result arrives after the deadline hold: merges (enqueues) on that exact head and clears the hold', () => {
    const { h, clock } = pastDeadline();
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ deadlineHeld: true });
    const after = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t + 60_000, initial: h.state(), liveComments: [clean] });
    expect(after.s.enqueue({ num: 5283 }, HEAD, { comments: [clean] })).toMatchObject({ enqueued: true });
    expect(after.state().redTeamPending['cwd#5283']).toBeUndefined();
  });

  it('a result for a DIFFERENT head never releases the hold', () => {
    const { h, clock } = pastDeadline();
    h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    const other = { user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5283 rev=${'d'.repeat(40)} -->\n### Post-accept red team — no break found` };
    const after = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t + 60_000, initial: h.state(), liveComments: [other] });
    expect(after.s.enqueue({ num: 5283 }, HEAD, { comments: [other] })).toMatchObject({ enqueued: false, deadlineHeld: true });
  });

  it('a proven-identical carry of a result arriving after the hold merges', () => {
    const { h, clock } = pastDeadline();
    h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    const prior = 'a'.repeat(40);
    const carried = { user: { login: 'web-everything[bot]' }, body: [
      `<!-- review-verdict-carried from=${prior} to=${HEAD} patch-id=${'c'.repeat(40)} -->`,
      'Review verdict carried across an identical contribution.',
      `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->`, '### Post-accept red team — no break found'].join('\n') };
    const after = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t + 60_000, initial: h.state(), liveComments: [carried] });
    expect(after.s.enqueue({ num: 5283 }, HEAD, { comments: [carried] })).toMatchObject({ enqueued: true });
  });

  it('a card-only diff (red team off for that class) is unaffected even with an old pending record past the deadline', () => {
    const initial = { pending: [], followedUp: [], redTeamPending: { 'cwd#5283': { headSha: HEAD, firstPendingAt: 0, retryAt: 0, commentCount: 0,
      reason: 'post-accept red team has no recorded result on the live head', deadlineHeldAt: 1, notifiedAt: 1 } } };
    const notes = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, initial, now: () => 10 * 60 * 60_000, publishNeedsYou: item => notes.push(item),
      evidence: { scheduled: true, inFlight: false, recorded: false, loopPayload: { findings: { read: { netChangedFiles: ['backlog/123-card.md'] } } } } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: true });
    expect(notes).toHaveLength(0);
  });

  it('deadlineAction=hold publishes the note without re-requesting', () => {
    const requests = [];
    const { h, notes } = pastDeadline({ env: { WE_RED_TEAM_DEADLINE_ACTION: 'hold' }, requestRedTeam: input => { requests.push(input); return { requested: true }; } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true, reason: expect.stringContaining('redTeam.deadlineAction=hold') });
    expect(requests).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(h.logs.join('')).toContain('redTeam.deadlineAction=hold (env)');
  });

  it.each([
    ['a settings-file value', { redTeamDeadline: undefined, env: {} }, { file: { redTeam: { deadlineAction: 'merge-without-result' } } }],
    ['a platform value', { env: {} }, { platform: { deadlineAction: 'merge-without-result' } }],
    ['env without a named operator', { env: { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result' } }, null],
  ])('%s can never restore merge-without-result', async (_name, opts, layer) => {
    const { resolveRedTeamDeadlineAction } = await import('../red-team-gate.mjs');
    const redTeamDeadline = layer ? resolveRedTeamDeadlineAction({ ...layer, env: opts.env }) : undefined;
    if (layer) expect(redTeamDeadline.invalid.join(' ')).toContain('merge-without-result');
    const { h, notes } = pastDeadline({ ...opts, ...(redTeamDeadline ? { redTeamDeadline } : {}) });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(notes).toHaveLength(1);
    expect(enqueuedAny(h)).toBe(false);
  });

  it('only the explicit operator env override enqueues without a result, logged with who and the source', () => {
    const { h, notes } = pastDeadline({ env: { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: 'chalbert' } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: true });
    expect(h.logs.join('')).toContain(`OPERATOR OVERRIDE: enqueuing ${LOCAL}#5283 on ${HEAD} with NO red-team result after 45 min (redTeam.deadlineAction=merge-without-result, env, by chalbert)`);
    expect(notes).toHaveLength(0);
  });

  it('the operator override never waives an in-flight run or a confirmed break', () => {
    const { h } = pastDeadline({ env: { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: 'chalbert' },
      evidence: { loopPayload: { verdict: { verdict: 'accept' } }, inFlight: true, scheduled: true } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(enqueuedAny(h)).toBe(false);
  });

  const OVERRIDE_ENV = { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: 'chalbert' };
  it.each(['inFlight', 'queued', 'recorded'])('the operator override never waives a %s run (held, never enqueued)', field => {
    const { h, clock } = pastDeadline({ env: OVERRIDE_ENV,
      evidence: { loopPayload: { verdict: { verdict: 'accept' } }, [field]: true, scheduled: true } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    clock.t += 10 * 60 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(enqueuedAny(h)).toBe(false);
    expect(h.logs.join('')).not.toContain('OPERATOR OVERRIDE');
  });

  it('the operator override never waives a confirmed break, even with no run evidence at all', async () => {
    const { renderRedTeamComment } = await import('../../operations/review-extra-seats.mjs');
    const thread = [{ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
      pr: 5283, rev: HEAD, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'unresolved security break', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }],
    }) }];
    // No in-flight, queued or recorded run: only the break's own send-back routing stands between it and the override.
    const { h, clock } = pastDeadline({ env: OVERRIDE_ENV, liveComments: thread,
      evidence: { loopPayload: { verdict: { verdict: 'accept' } }, scheduled: true, inFlight: false, queued: false, recorded: false } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: thread })).toMatchObject({ enqueued: false, kind: 'red-team-pending',
      reason: expect.stringContaining('requiring send-back') });
    clock.t += 10 * 60 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: thread })).toMatchObject({ enqueued: false });
    expect(enqueuedAny(h)).toBe(false);
    expect(h.logs.join('')).not.toContain('OPERATOR OVERRIDE');
  });

  it.each([
    ['returns requested:false', () => ({ requested: false })],
    ['throws', () => { throw new Error('dispatch unavailable'); }],
  ])('a re-request hook that %s is tried ONCE for the head, then the PR holds with one note (never re-called)', (_name, hook) => {
    let attempts = 0;
    const requestRedTeam = input => { attempts++; return hook(input); };
    const { h, clock, notes } = pastDeadline({ requestRedTeam });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true,
      reason: expect.stringContaining('the one re-request was not accepted') });
    expect(attempts).toBe(1);
    // Every backoff recheck (and a drain restart) keeps the hold without calling the hook again.
    for (let i = 0; i < 3; i++) { clock.t += 301_000; expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true }); }
    const restarted = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, initial: h.state(), requestRedTeam, publishNeedsYou: item => notes.push(item) });
    clock.t += 301_000;
    expect(restarted.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(attempts).toBe(1);
    expect(notes).toHaveLength(1);
    expect(enqueuedAny(h) || enqueuedAny(restarted)).toBe(false);
  });

  it('the re-request attempt is saved BEFORE the hook runs: a crash inside the hook never re-requests the head', () => {
    let attempts = 0, h, atHookTime;
    // The drain dies inside the hook: only what was on disk when the hook started survives.
    const crash = () => { attempts++; atHookTime ??= structuredClone(h.state()); throw new Error('drain process killed'); };
    const started = pastDeadline({ requestRedTeam: crash });
    h = started.h;
    const { clock, notes } = started;
    h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    expect(atHookTime.redTeamPending['cwd#5283']).toMatchObject({ headSha: HEAD, requestAttemptedAt: clock.t });
    const restarted = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t + 301_000, initial: atHookTime,
      requestRedTeam: crash, publishNeedsYou: item => notes.push(item) });
    expect(restarted.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(attempts).toBe(1);
  });

  it('a refused attempt is per head: a NEW live head gets its own one re-request', () => {
    const requests = [];
    const NEXT = 'f'.repeat(40);
    const { h, clock } = pastDeadline({ requestRedTeam: input => { requests.push(input.head); return { requested: false }; } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ deadlineHeld: true });
    const moved = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, initial: h.state(),
      ghView: { 5283: { state: 'OPEN', headRefOid: NEXT, labels: ACCEPTED, id: 'PR_NODE' } },
      requestRedTeam: input => { requests.push(input.head); return { requested: false }; }, publishNeedsYou: () => {} });
    expect(moved.s.enqueue({ num: 5283 }, NEXT, { comments: [] })).toMatchObject({ healthSmell: false });
    expect(moved.state().redTeamPending['cwd#5283'].requestAttemptedAt).toBeUndefined();
    clock.t += 45 * 60_000;
    expect(moved.s.enqueue({ num: 5283 }, NEXT, { comments: [] })).toMatchObject({ deadlineHeld: true,
      reason: expect.stringContaining('the one re-request was not accepted') });
    expect(requests).toEqual([HEAD, NEXT]);
  });

  it('suppresses the real needs-you feed when only process.env marks the test run', () => {
    expect(isUnderTest(process.env)).toBe(true);
    publishAttention.mockClear();
    // An injected env WITHOUT test markers and no injected publisher: process.env alone must keep the real feed unwritten.
    const { h } = pastDeadline({ env: {}, publishNeedsYou: undefined });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(publishAttention).not.toHaveBeenCalled();
  });

  it('outside a test run the default publisher IS the real needs-you feed (positive control for the guard above)', () => {
    vi.stubEnv('VITEST', '');
    vi.stubEnv('WE_UNDER_TEST', '');
    try {
      publishAttention.mockClear();
      const { h } = pastDeadline({ env: {}, publishNeedsYou: undefined });
      expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
      expect(publishAttention).toHaveBeenCalledTimes(1);
      expect(publishAttention).toHaveBeenCalledWith(expect.objectContaining({ pr: 5283, head: HEAD, kind: 'red-team-deadline-held' }));
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('redTeam.deadlineAction resolver: an invalid higher layer preserves the lower layer and its provenance', () => {
  it.each([
    ['file merge-without-result over platform hold', { platform: { deadlineAction: 'hold' }, file: { redTeam: { deadlineAction: 'merge-without-result' } } }, 'platform', 'tool.deadlineAction'],
    ['env merge-without-result (no operator) over file hold', { file: { redTeam: { deadlineAction: 'hold' } }, env: { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result' } }, 'tool', 'env.deadlineAction'],
    ['env typo over file hold', { file: { redTeam: { deadlineAction: 'hold' } }, env: { WE_RED_TEAM_DEADLINE_ACTION: 'hodl' } }, 'tool', 'env.deadlineAction'],
    ['platform merge-without-result over nothing keeps the standard', { platform: { deadlineAction: 'merge-without-result' } }, 'standard', 'platform.deadlineAction'],
    ['env merge-without-result with a blank operator over platform hold', { platform: { deadlineAction: 'hold' }, env: { WE_RED_TEAM_DEADLINE_ACTION: 'merge-without-result', WE_RED_TEAM_DEADLINE_OVERRIDE_BY: '  ' } }, 'platform', 'env.deadlineAction'],
  ])('%s', async (_name, layers, source, rejected) => {
    const { resolveRedTeamDeadlineAction } = await import('../red-team-gate.mjs');
    const r = resolveRedTeamDeadlineAction(layers);
    expect(r.value.deadlineAction).toBe(source === 'standard' ? 'requeue-then-hold' : 'hold');
    expect(r.sources.deadlineAction).toBe(source);
    expect(r.invalid.join(' ')).toContain(rejected);
    expect(r.operatorOverride).toBeNull();
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
  const stale = { ...evidence, recorded: true, attempted: true, untrustedSavedResult: true, noUsableResult: true };
  it.each(['panel-seat', 'post-accept'])('%s requests stale rows once and keeps the head held', timing => {
    const requestRedTeam = vi.fn(() => ({ requested: true }));
    const h = setup({ evidence: stale, requestRedTeam, env: { WE_RED_TEAM_TIMING: timing } });
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending', redTeamRequested: true });
    expect(requestRedTeam).toHaveBeenCalledWith({ repo: LOCAL, pr: 5485, head: HEAD, loopPayload: panel });
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    h.advance(60 * 60_000);
    const restarted = setup({ evidence: stale, requestRedTeam, initial: h.state(), now: () => 3_601_000,
      env: { WE_RED_TEAM_TIMING: timing } });
    expect(restarted.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    expect(restarted.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
  });
  it.each([
    { noUsableResult: false }, { inFlight: true }, { queued: true },
  ])('does not request stale-looking rows with usable or active evidence (%j)', extra => {
    const h = setup({ evidence: { ...stale, ...extra } });
    h.s.enqueue({ num: 5485 }, HEAD);
    h.advance(60 * 60_000);
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.requests).toHaveLength(0);
  });
  it('never retries a failed stale-row request on the same head or falls through to enqueue', () => {
    const h = setup({ evidence: stale });
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(1);
    h.advance(60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(1);
    h.advance(60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(1);
    h.advance(60 * 60_000);
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')))).toBe(false);
  });
  // Live gap #5549: the operator accepted a needs-human head, its panel seat errored, and no request was ever filed.
  const operatorAccepted = { ...stale, recorded: false, untrustedSavedResult: false, loopPayload: { ...panel,
    verdict: { verdict: 'needs-human', humanRequired: true, blockedReferrals: [{ seat: 'correctness' }] } } };
  it('recovers an operator-accepted needs-human head with an attempted, unusable pass', () => {
    expect(staleRedTeamRequestEligibility({ evidence: operatorAccepted, repo: LOCAL, pr: 5549, head: HEAD,
      labels: ['review:accepted', 'ready-to-merge'], enabled: true, panelSeat: true, reviewAgents: [] }))
      .toEqual({ eligible: true, reason: 'stale rows with no usable result' });
  });
  it('never recovers that head without a live review:accepted label', () => {
    expect(staleRedTeamRequestEligibility({ evidence: operatorAccepted, repo: LOCAL, pr: 5549, head: HEAD,
      labels: ['review:human', 'ready-to-merge'], enabled: true, panelSeat: true, reviewAgents: [] }))
      .toEqual({ eligible: false, reason: 'PR not accepted' });
  });
  it.each(['requiring send-back', 'saved red-team re-check incomplete'])('does not recover a recorded break: %s', reason => {
    expect(staleRedTeamRequestEligibility({ evidence: stale, repo: LOCAL, pr: 5485, head: HEAD,
      labels: ['review:accepted'], enabled: true, panelSeat: true, reviewAgents: [], reason }).eligible).toBe(false);
  });
  it('does not request stale rows in dry run', () => {
    const h = setup({ evidence: stale, dryRun: true });
    expect(() => h.s.enqueue({ num: 5485 }, HEAD)).toThrow('enqueue refused in dry run');
    expect(h.requests).toHaveLength(0);
  });
  it('requests an unseated accepted head promptly once and holds until a usable result', () => {
    const h = setup();
    expect(h.s.enqueue({ num: 5485 }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.requests).toHaveLength(1);
    h.advance(60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(1);
    h.advance(60_000);
    h.s.enqueue({ num: 5485 }, HEAD);
    expect(h.requests).toHaveLength(1);
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

describe('live queue file-overlap admission', () => {
  const card = 'backlog/123-card.md';
  const candidate = { num: 42, listedFiles: [card], listedFilesComplete: true };
  const facts = numbers => ({ data: { repository: { mergeQueue: { entries: {
    pageInfo: { hasNextPage: false }, nodes: numbers.map(number => ({ pullRequest: { number } })),
  } } } } });
  const setup = (over = {}) => harness({ strategy: 'github-merge-queue',
    queueFacts: facts([43]), ghView: { 43: { files: [{ path: card }] } }, ...over });
  it.each([
    ['disjoint net files', 'git', ['scripts/candidate.mjs'], ['scripts/queued.mjs'], false],
    ['shared net files', 'git', ['scripts/shared.mjs'], ['scripts/shared.mjs'], true],
    ['unverifiable git', 'github', [card], [card], true],
    ['unknown files', 'github', null, null, false],
  ])('uses resolved files in both queue admission paths: %s', (_name, source, candidateFiles, queuedFiles, held) => {
    const resolveRealFiles = vi.fn(({ pr, ghFiles }) => ({ source, disagreed: source === 'git',
      files: pr.headRefName === 'lane/candidate' ? candidateFiles : queuedFiles }));
    const h = setup({ resolveRealFiles, ghView: { 43: { files: [card], headRefName: 'lane/queued', baseRefName: 'main', headRefOid: HEAD } } });
    const c = { ...candidate, headRef: 'lane/candidate' };
    expect(h.s.queueOverlapHold(c, HEAD)?.kind ?? null).toBe(held ? 'queue-file-overlap' : null);
    const result = h.s.enqueue(c, HEAD);
    expect(result.kind ?? null).toBe(held ? 'queue-file-overlap' : null);
    expect(result.enqueued).toBe(!held);
    expect(resolveRealFiles).toHaveBeenCalledWith({ pr: expect.objectContaining({ headRefName: 'lane/candidate', baseRefName: 'main', headRefOid: HEAD }), repo: LOCAL, ghFiles: [card], cwd: process.cwd(), run: expect.any(Function) });
    if (candidateFiles !== null) expect(resolveRealFiles).toHaveBeenCalledWith({ pr: expect.objectContaining({ headRefName: 'lane/queued', headRefOid: HEAD }), repo: LOCAL, ghFiles: [card], cwd: process.cwd(), run: expect.any(Function) });
    const logs = h.logs.filter(line => line.includes('real files for #'));
    expect(logs).toHaveLength(source === 'git' ? 2 : 0); // one per pre-check/enqueue decision
  });
  it('falls back conservatively when the resolver throws', () => {
    const h = setup({ resolveRealFiles: () => { throw new Error('unavailable'); } });
    expect(h.s.queueOverlapHold(candidate, HEAD)?.kind).toBe('queue-file-overlap');
    expect(h.s.enqueue(candidate, HEAD).kind).toBe('queue-file-overlap');
  });
  it('pre-check shares the enqueue reason, caches only its own reads and expires after 30s', () => {
    let time = 1_000;
    const h = setup({ now: () => time });
    const hold = h.s.queueOverlapHold(candidate, HEAD);
    expect(hold).toEqual({ kind: 'queue-file-overlap', deferred: true, reason: `#43 share ${card}` });
    expect(h.s.queueOverlapHold({ ...candidate, num: 44 }, HEAD)).toEqual(hold);
    expect(h.calls).toHaveLength(2); // queue discovery + queued PR files, no writes
    const result = h.s.enqueue(candidate, HEAD, { comments: stampedBy(DRAIN) });
    expect(result).toEqual({ enqueued: false, ...hold });
    expect(h.calls.filter(c => c.includes('files,headRefName,baseRefName,headRefOid'))).toHaveLength(2); // enqueue read fresh
    time += 30_000;
    expect(h.s.queueOverlapHold(candidate, HEAD)).toEqual(hold);
    expect(h.calls.filter(c => c.includes('files,headRefName,baseRefName,headRefOid'))).toHaveLength(3);
  });
  it.each([
    ['missing', { num: 42 }],
    ['incomplete', { ...candidate, listedFilesComplete: false }],
    ['capped', { ...candidate, listedFiles: Array(100).fill(card) }],
    ['malformed', { ...candidate, listedFiles: [null] }],
    ['other repo', { ...candidate, repo: 'other/repo' }],
  ])('pre-check makes no reads when files or mode are unknown: %s', (_name, c) => {
    const h = setup();
    expect(h.s.queueOverlapHold(c, HEAD)).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.state()).toBeNull();
  });
  it('pre-check never caches queue read errors', () => {
    const failures = [43];
    const h = setup({ viewThrows: failures });
    expect(h.s.queueOverlapHold(candidate, HEAD)).toBeNull();
    expect(h.s.queueOverlapHold(candidate, HEAD)).toBeNull();
    expect(h.calls).toHaveLength(4);
    failures.pop();
    expect(h.s.queueOverlapHold(candidate, HEAD)?.kind).toBe('queue-file-overlap');
    expect(h.calls).toHaveLength(6);
  });
  it.each([
    ['self excluded', { queueFacts: facts([42]), ghView: { 42: { files: [card] } } }],
    ['cards disabled', { env: { WE_DRAIN_QUEUE_FILE_OVERLAP_INCLUDES_CARDS: 'off' } }],
    ['disjoint', { ghView: { 43: { files: ['other'] } } }],
    ['unknown queued files', { ghView: { 43: { files: null } } }],
    ['direct mode', { strategy: 'drain-direct' }],
  ])('pre-check fails open for %s', (_name, options) => {
    const h = setup(options);
    expect(h.s.queueOverlapHold(candidate, HEAD)).toBeNull();
  });
  it('pre-check also reads in dry run without any mutation', () => {
    const h = setup({ dryRun: true });
    expect(h.s.queueOverlapHold(candidate, HEAD)?.kind).toBe('queue-file-overlap');
    expect(h.calls).toHaveLength(2);
    expect(h.state()).toBeNull();
  });
  it('defers shared cards before any enqueue mutation and reports policy source', () => {
    const h = setup();
    expect(h.s.enqueue(candidate, HEAD, { comments: stampedBy(DRAIN) })).toEqual({
      enqueued: false, deferred: true, kind: 'queue-file-overlap', reason: `#43 share ${card}`,
    });
    expect(h.calls.some(call => call.some(arg => arg.includes('enqueuePullRequest')))).toBe(false);
    expect(h.logs.join('')).toContain(`defer #42 (shares ${card} with queued #43) — includeCards=true (standard)`);
    expect(h.calls.filter(call => call[0] === 'gh' && call.includes('files,headRefName,baseRefName,headRefOid'))).toEqual([
      ['gh', 'pr', 'view', '43', '--repo', LOCAL, '--json', 'files,headRefName,baseRefName,headRefOid'],
    ]);
    expect(h.calls.some(call => call[0] === 'git' && ['fetch', 'diff'].includes(call[1]))).toBe(false);
  });
  it.each([
    ['disjoint', { ghView: { 43: { files: [{ path: 'scripts/other.mjs' }] } } }],
    ['self excluded', { queueFacts: facts([42]) }],
    ['cards disabled', { env: { WE_DRAIN_QUEUE_FILE_OVERLAP_INCLUDES_CARDS: 'off' } }],
    ['queued list capped', { ghView: { 43: { files: Array(100).fill({ path: card }) } } }],
  ])('continues through existing admission when %s', (_label, over) => {
    const h = setup(over);
    expect(h.s.enqueue(candidate, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: true });
    expect(h.calls.some(call => call.some(arg => arg.includes('enqueuePullRequest')))).toBe(true);
  });
  describe('fails closed when the locked live queue read fails', () => {
    const labels = ['review:accepted', 'ready-to-merge', 'red-team:pending'];
    const pendingState = () => ({ pending: [], followedUp: [], redTeamPending: {
      'cwd#42': { headSha: HEAD, firstPendingAt: 0, retryAt: 0, commentCount: 0, checkedAt: 0, reason: 'red team pending' } } });
    const evidence = { scheduled: false, inFlight: false, recorded: false, attempted: false, loopPayload: { verdict: { verdict: 'accept' } } };
    const enqueueCalled = h => h.calls.some(call => call.some(arg => String(arg).includes('enqueuePullRequest')));
    const pendingRemoved = h => h.calls.some(call => call.includes('--remove-label') && call.includes('red-team:pending'));
    it.each([
      ['queue read errors', { viewThrows: [43] }, 'gh: HTTP 502'],
      ['queue response malformed', { queueFacts: { data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false } } } } } } }, 'unreadable merge queue'],
      ['queue read throws an empty message', { onView: { 43: () => { throw new Error(''); } } }, 'queue read error'],
    ])('%s: holds with queue-read-failed, keeps red-team:pending and its pending record', (_name, over, detail) => {
      const h = setup({ ...over, labels, evidence, initial: pendingState() });
      const result = h.s.enqueue(candidate, HEAD, { comments: stampedBy(DRAIN) });
      expect(result).toMatchObject({ enqueued: false, deferred: true, kind: 'queue-read-failed' });
      expect(result.reason).toContain(detail);
      expect(enqueueCalled(h)).toBe(false);
      expect(pendingRemoved(h)).toBe(false);
      expect(h.state().redTeamPending['cwd#42']).toMatchObject({ headSha: HEAD });
      expect(h.logs.join('')).toContain('holding #42 (queue-read-failed), retried next pass');
    });
    it('control: a successful read enqueues, then drops red-team:pending and the pending record', () => {
      const h = setup({ ghView: { 43: { files: [{ path: 'scripts/other.mjs' }] } }, labels, evidence, initial: pendingState() });
      expect(h.s.enqueue(candidate, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: true });
      expect(enqueueCalled(h)).toBe(true);
      expect(pendingRemoved(h)).toBe(true);
      const enqueueAt = h.calls.findIndex(call => call.some(arg => String(arg).includes('enqueuePullRequest')));
      expect(h.calls.findIndex(call => call.includes('--remove-label'))).toBeGreaterThan(enqueueAt);
      expect(h.state().redTeamPending?.['cwd#42']).toBeUndefined();
    });
  });
  it.each([
    ['missing', { num: 42 }],
    ['incomplete', { ...candidate, listedFilesComplete: false }],
    ['capped', { ...candidate, listedFiles: Array(100).fill(card) }],
    ['malformed', { ...candidate, listedFiles: [null] }],
  ])('fails open when candidate files are %s', (_label, c) => {
    const h = setup();
    expect(h.s.enqueue(c, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: true });
    expect(h.logs.join('')).toContain('candidate files unknown — continuing enqueue');
    expect(h.calls.some(call => call[0] === 'gh' && call.includes('files,headRefName,baseRefName,headRefOid'))).toBe(false);
  });
});


describe('card-overlap clean-merge relief (drain.cardOverlapCleanMerge)', () => {
  const card = 'backlog/123-card.md';
  const TIP = 'c'.repeat(40);
  const QH = HEAD; // the harness confirms queue entry by the first ghView head
  const candidate = { num: 42, listedFiles: [card], listedFilesComplete: true };
  const facts = numbers => ({ data: { repository: { mergeQueue: { entries: {
    pageInfo: { hasNextPage: false }, nodes: numbers.map(number => ({ pullRequest: { number } })),
  } } } } });
  const mergeRun = status => vi.fn((cmd, args) => args[0] === 'cat-file' ? { status: 0 }
    : args[0] === 'merge-tree' ? { status, stdout: status === 0 ? `${'d'.repeat(40)}\n` : `${'d'.repeat(40)}\n${card}\n` } : { status: 128 });
  const setup = ({ enabled = true, status = 0, tip = { sha: TIP, num: 43, entries: [{ num: 43, headSha: QH }] }, queuedFiles = [card], files = [card] } = {}) => {
    const readQueueTip = vi.fn(() => tip);
    const cardMergeRun = mergeRun(status);
    const h = harness({ strategy: 'github-merge-queue', queueFacts: facts([43]), ghView: { 43: { files: queuedFiles.map(path => ({ path })), headRefOid: QH } },
      strategyExtra: { cardOverlapCleanMerge: { enabled, source: 'tool' }, readQueueTip, cardMergeRun } });
    return { ...h, readQueueTip, cardMergeRun, c: { ...candidate, listedFiles: files } };
  };
  it('enqueues a card-only overlap that merges cleanly onto the queue tip', () => {
    const h = setup();
    expect(h.s.queueOverlapHold(h.c, HEAD)).toBeNull();
    expect(h.s.enqueue(h.c, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: true });
    expect(h.cardMergeRun).toHaveBeenCalledWith('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', TIP, HEAD], expect.anything());
    expect(h.logs.join('')).toContain('card-overlap clean-merge: #42 with #43 → enqueue');
    expect(h.logs.join('')).toContain('drain.cardOverlapCleanMerge=on (tool)');
  });
  it('keeps the deferral on a conflict', () => {
    const h = setup({ status: 1 });
    expect(h.s.queueOverlapHold(h.c, HEAD)?.kind).toBe('queue-file-overlap');
    expect(h.s.enqueue(h.c, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: false, kind: 'queue-file-overlap' });
    expect(h.logs.join('')).toContain(`card-overlap clean-merge: #42 with #43 → skip: conflict (${card})`);
  });
  it.each([
    ['merge-tree error', { status: 128 }],
    ['queue tip unknown', { tip: { error: 'a queue entry has no merge-group commit yet' } }],
    ['queue changed between reads', { tip: { sha: TIP, num: 44, entries: [{ num: 43, headSha: QH }, { num: 44, headSha: QH }] } }],
    ['queued PR re-queued at a new head', { tip: { sha: TIP, num: 43, entries: [{ num: 43, headSha: 'f'.repeat(40) }] } }],
  ])('keeps the deferral on %s', (_name, over) => {
    const h = setup(over);
    expect(h.s.enqueue(h.c, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: false, kind: 'queue-file-overlap' });
    expect(h.logs.join('')).toMatch(/card-overlap clean-merge: #42 with #43 → skip: /);
  });
  it('keeps the deferral, without a dry merge, when any shared path is not a card', () => {
    const h = setup({ files: [card, 'scripts/x.mjs'], queuedFiles: [card, 'scripts/x.mjs'] });
    expect(h.s.enqueue(h.c, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: false, kind: 'queue-file-overlap' });
    expect(h.readQueueTip).not.toHaveBeenCalled();
    expect(h.cardMergeRun).not.toHaveBeenCalled();
    expect(h.logs.join('')).toContain('→ skip: non-card overlap');
  });
  it('does nothing new when the setting is off', () => {
    const h = setup({ enabled: false });
    expect(h.s.enqueue(h.c, HEAD, { comments: stampedBy(DRAIN) })).toMatchObject({ enqueued: false, kind: 'queue-file-overlap' });
    expect(h.readQueueTip).not.toHaveBeenCalled();
    expect(h.logs.join('')).not.toContain('card-overlap clean-merge');
  });
});

describe('red-team requests while queue-file-overlap deferred', () => {
  const c = { num: 42, listedFiles: ['scripts/x.mjs'], listedFilesComplete: true };
  const panel = { verdict: { verdict: 'accept' }, findings: { read: {
    netBasis: { rev: HEAD }, netChangedFiles: ['scripts/x.mjs'],
  } } };
  const evidence = { scheduled: false, recorded: false, attempted: false, inFlight: false, loopPayload: panel };
  const key = 'cwd#42';
  function setup(extra = {}) {
    let clock = 1000;
    const requestRedTeam = vi.fn(() => ({ requested: true }));
    const h = harness({ strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'],
      env: { WE_RED_TEAM_TIMING: 'post-accept', WE_DRAIN_RED_TEAM_REQUEST_COOLDOWN_MIN: '2' }, evidence,
      requestRedTeam, now: () => clock,
      queueFacts: { data: { repository: { mergeQueue: { entries: {
        pageInfo: { hasNextPage: false }, nodes: [{ pullRequest: { number: 43 } }],
      } } } } }, ghView: { 43: { files: [{ path: 'scripts/x.mjs' }] } }, ...extra });
    return { ...h, requestRedTeam, advance: ms => { clock += ms; } };
  }
  const hasEnqueueMutation = h => h.calls.some(call => call.some(arg => String(arg).includes('enqueuePullRequest')));

  const sibling = { ...c, repo: 'plateauapp/plateau-app' };
  it('requests once for a non-local repo in enqueue mode without adding a hold', () => {
    const h = setup();
    expect(h.s.requestRedTeamWhileDeferred(sibling, HEAD)).toEqual({ requested: true });
    expect(h.requestRedTeam).toHaveBeenCalledWith({ repo: sibling.repo, pr: 42, head: HEAD, loopPayload: panel });
    expect(h.s.requestRedTeamWhileDeferred(sibling, HEAD)).toEqual({ requested: false });
    expect(h.requestRedTeam).toHaveBeenCalledTimes(1);
    expect(h.s.enqueues(sibling.repo)).toBe(false);
    expect(h.s.recordedHold(sibling, HEAD)).toBeNull();
    expect(h.s.queueOverlapHold(sibling, HEAD)).toBeNull();
    expect(h.state().redTeamPending[`${sibling.repo}#42`].requestedAt).toBe(1000);
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it.each([
    ['not accepted', { labels: ['ready-to-merge'] }],
    ['dry run', { dryRun: true }],
    ['head mismatch', { ghView: { 42: { headRefOid: 'a'.repeat(40), labels: ['review:accepted', 'ready-to-merge'] } } }],
    ['direct mode', { strategy: 'drain-direct' }],
  ])('does not request for a non-local repo when %s', (_label, extra) => {
    const h = setup(extra);
    expect(h.s.requestRedTeamWhileDeferred(sibling, HEAD)).toBeNull();
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it('never repeats a refused request for a non-local repo', () => {
    const requestRedTeam = vi.fn(() => ({ requested: false }));
    const h = setup({ requestRedTeam });
    expect(h.s.requestRedTeamWhileDeferred(sibling, HEAD)).toEqual({ requested: false });
    h.advance(60_000);
    expect(h.s.requestRedTeamWhileDeferred(sibling, HEAD)).toEqual({ requested: false });
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    expect(h.s.requestRedTeamWhileDeferred(sibling, HEAD)).toEqual({ requested: false });
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    expect(h.s.recordedHold(sibling, HEAD)).toBeNull();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it.each([
    { labels: ['review:accepted'] },
    { labels: ['review:accepted', 'ready-to-merge', 'review:changes'] },
    { labels: ['review:accepted', 'ready-to-merge', 'review:human'] },
    { labels: ['review:accepted', 'ready-to-merge', 'review:pending'] },
  ])('refuses send-back labels without writing state: $labels', ({ labels }) => {
    const h = setup({ labels });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    expect(h.calls.some(call => call.includes('--slurp'))).toBe(false);
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it.each([true, false])('does not request after a complete live-head result (confirmed break=%s)', confirmedBreak => {
    const h = setup({ liveComments: [{ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
      pr: 42, rev: HEAD, recheckStatus: 'ok',
      findings: confirmedBreak ? [{ summary: 'live break', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }] : [],
    }) }] });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
    expect(h.calls).toContainEqual(['gh', 'api', '--paginate', '--slurp', `repos/${LOCAL}/issues/42/comments`]);
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it('refuses an incomplete saved red-team recheck without writing state', () => {
    const root = mkdtempSync(join(tmpdir(), 'drain-deferred-incomplete-'));
    try {
      const env = { WE_RED_TEAM_TIMING: 'post-accept', CONVEYOR_STATE_ROOT: root,
        WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'on' };
      const path = resolveScorecardStorePath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team',
        repo: LOCAL, pr: 42, rev: HEAD, status: 'ok', recheckStatus: 'pending', confirmedMissCount: 1,
        findings: [{ confirmedByRecheck: true, impactIfUnfixed: 'degraded' }, { confirmedByRecheck: false }] }] }));
      saveProvenanceFixtures(env);
      const h = setup({ env, liveComments: [] });
      expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
      expect(h.requestRedTeam).not.toHaveBeenCalled();
      expect(h.state()).toBeNull();
      expect(hasEnqueueMutation(h)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns null for unreadable complete comments without writing state', () => {
    const h = setup({ liveComments: { unreadable: true } });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toBeNull();
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it('requests once during overlap, persists the request, and leaves admission held', () => {
    const h = setup();
    const hold = h.s.queueOverlapHold(c, HEAD);
    expect(hold).toMatchObject({ kind: 'queue-file-overlap' });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: true });
    expect(h.requestRedTeam).toHaveBeenCalledWith({ repo: LOCAL, pr: 42, head: HEAD, loopPayload: panel });
    expect(h.requestRedTeam).toHaveBeenCalledTimes(1);
    expect(h.state().redTeamPending[key]).toEqual({ headSha: HEAD, firstPendingAt: 1000, retryAt: 1000,
      checkedAt: 1000, commentCount: 0, requestAttemptedAt: 1000, requestedAt: 1000,
      reason: 'red team requested while queue-file-overlap deferred' });
    expect(hasEnqueueMutation(h)).toBe(false);
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
    h.advance(60 * 60_000);
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
    expect(h.s.enqueue(c, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.requestRedTeam).toHaveBeenCalledTimes(1);
    expect(h.s.queueOverlapHold(c, HEAD)).toEqual(hold);
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it('persists failed attempts before dispatch and never retries the same head', () => {
    let h;
    const requestRedTeam = vi.fn(() => {
      expect(h.state().redTeamPending[key].requestAttemptedAt).toBeDefined();
      throw new Error('dispatcher unavailable');
    });
    h = setup({ requestRedTeam });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
    h.advance(60_000);
    h.s.requestRedTeamWhileDeferred(c, HEAD);
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    h.advance(60_000);
    h.s.requestRedTeamWhileDeferred(c, HEAD);
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    expect(h.state().redTeamPending[key].requestedAt).toBeUndefined();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it.each(['recorded', 'attempted', 'inFlight', 'queued'])('refuses %s evidence without stale recovery eligibility', field => {
    const h = setup({ evidence: { ...evidence, [field]: true } });
    h.s.requestRedTeamWhileDeferred(c, HEAD);
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it.each([
    { labels: ['ready-to-merge'] },
    { ghView: { 42: { headRefOid: 'a'.repeat(40), labels: ['review:accepted'] } } },
    { dryRun: true },
    { env: { WE_DRAIN_WAIT_FOR_RED_TEAM_BEFORE_ENQUEUE: 'false' } },
    { strategy: 'drain-direct' },
    { requestRedTeam: null },
    { evidence: { ...evidence, readError: true } },
    { viewThrows: [42] },
  ])('does nothing when prerequisites fail (%j)', extra => {
    const h = setup(extra);
    expect(() => h.s.requestRedTeamWhileDeferred(c, HEAD)).not.toThrow();
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(h.state()).toBeNull();
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it('does nothing without a head', () => {
    const h = setup();
    expect(h.s.requestRedTeamWhileDeferred(c, null)).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.requestRedTeam).not.toHaveBeenCalled();
  });

  it('takes the land lock before reading state and respects lock refusal', () => {
    const withLock = vi.fn(fn => ({ ran: true, result: fn() }));
    const h = setup({ withLock });
    h.s.requestRedTeamWhileDeferred(c, HEAD);
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(h.requestRedTeam).toHaveBeenCalledTimes(1);
    const refused = setup({ withLock: () => ({ ran: false }) });
    expect(refused.s.requestRedTeamWhileDeferred(c, HEAD)).toBeNull();
    expect(refused.calls).toEqual([]);
    expect(refused.state()).toBeNull();
    expect(refused.requestRedTeam).not.toHaveBeenCalled();
  });

  it.each(['post-accept', 'panel-seat'])('shares stale recovery eligibility for %s', timing => {
    const h = setup({ env: { WE_RED_TEAM_TIMING: timing },
      evidence: { ...evidence, scheduled: true, recorded: true, attempted: true, noUsableResult: true } });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: true });
    expect(h.requestRedTeam).toHaveBeenCalledTimes(1);
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it('requests an orphaned accepted panel seat even when policy marks it scheduled', () => {
    const h = setup({ env: { WE_RED_TEAM_TIMING: 'panel-seat' }, evidence: { ...evidence, scheduled: true } });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: true });
    expect(h.requestRedTeam).toHaveBeenCalledTimes(1);
    expect(hasEnqueueMutation(h)).toBe(false);
  });

  it.each([
    () => [{ name: 'review-42', state: 'queued', repo: LOCAL, pr: 42 }],
    () => { throw new Error('unknown jobs'); },
  ])('does not request an orphaned panel seat without proving jobs inactive', readReviewAgents => {
    const h = setup({ env: { WE_RED_TEAM_TIMING: 'panel-seat' }, readReviewAgents,
      evidence: { ...evidence, scheduled: true } });
    expect(h.s.requestRedTeamWhileDeferred(c, HEAD)).toEqual({ requested: false });
    expect(h.requestRedTeam).not.toHaveBeenCalled();
    expect(hasEnqueueMutation(h)).toBe(false);
  });
});


describe('priority file reservations', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  const files = ['scripts/shared.mjs', 'scripts/second.mjs'];
  const priority = { num: 42, prLabels: ['priority:now'], listedFiles: files, listedFilesComplete: true };
  const candidate = { num: 44, listedFiles: [files[0]], listedFilesComplete: true };
  const facts = numbers => ({ data: { repository: { mergeQueue: { entries: {
    pageInfo: { hasNextPage: false }, nodes: numbers.map(number => ({ pullRequest: { number } })),
  } } } } });
  const setup = (over = {}) => {
    dir = mkdtempSync(join(tmpdir(), 'priority-reserve-'));
    const reservePath = join(dir, 'drain-priority-reserve.json');
    const h = harness({ strategy: 'github-merge-queue', reservePath,
      priorityReserve: () => ({ enabled: true, source: 'default' }), ...over });
    return { ...h, reservePath };
  };
  const stamp = (h, extra = {}) => writeReserves(h.reservePath, {
    'cwd#42': { num: 42, repo: null, headSha: HEAD, files, at: Date.now(), ...extra },
  });
  const accepted = ['priority:now', 'review:accepted', 'ready-to-merge'];
  const panel = { verdict: { verdict: 'accept' }, findings: { read: {
    netBasis: { rev: HEAD }, netChangedFiles: files,
  } } };
  const pendingEvidence = { scheduled: true, inFlight: true, recorded: false, loopPayload: panel };
  const rtSetup = (extra = {}) => setup({ labels: accepted, evidence: pendingEvidence,
    env: { WE_RED_TEAM_TIMING: 'post-accept' }, now: () => 1000, ...extra });
  it.each(['priority:now', 'priority:urgent'])('stamps %s before a recorded hold and retains its first timestamp', label => {
    let clock = 1000;
    const labels = accepted.map(l => l === 'priority:now' ? label : l);
    const h = rtSetup({ labels, now: () => clock });
    const c = { ...priority, prLabels: labels };
    h.s.priorityReserveStamp(c, HEAD);
    expect(h.calls.filter(call => call.includes('state,headRefOid,labels,reviews'))).toHaveLength(1);
    expect(readReserves(h.reservePath)['cwd#42']).toMatchObject({ headSha: HEAD, files, rt: true, rtSince: 1000, maxMs: 90 * 60_000 });
    expect(h.s.enqueue(c, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    clock += 60_000;
    h.s.priorityReserveStamp(c, HEAD);
    expect(h.s.recordedHold(c, HEAD)).toMatchObject({ kind: 'red-team-pending' });
    expect(readReserves(h.reservePath)['cwd#42'].rtSince).toBe(1000);
    expect(h.s.priorityReserveHold(candidate, HEAD)?.kind).toBe('priority-reserve');
    expect(h.logs.join('')).toContain('priorityReserveMaxMin=90 (standard)');
    expect(h.calls.some(call => call.some(arg => String(arg).includes('enqueuePullRequest')))).toBe(false);
  });
  it('stamps in ordinary enqueue without changing the red-team hold', () => {
    const h = rtSetup();
    expect(h.s.enqueue({ ...priority, prLabels: accepted }, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(readReserves(h.reservePath)['cwd#42']).toMatchObject({ rt: true, rtSince: 1000 });
  });
  it.each([
    ['not accepted', ['priority:now', 'ready-to-merge']],
    ['not ready', ['priority:now', 'review:accepted']],
    ['send-back', [...accepted, 'review:changes']],
  ])('does not stamp when %s and drops an existing rt stamp in either path', (_name, labels) => {
    const live = { state: 'OPEN', headRefOid: HEAD, labels };
    const h = rtSetup({ ghView: { 42: live } });
    h.s.priorityReserveStamp(priority, HEAD);
    expect(readReserves(h.reservePath)).toEqual({});
    stamp(h, { at: 1000, rt: true, rtSince: 1000, maxMs: 90 * 60_000 });
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(readReserves(h.reservePath)).toEqual({});
    stamp(h, { at: 1000, rt: true, rtSince: 1000, maxMs: 90 * 60_000 });
    h.s.priorityReserveStamp(priority, HEAD);
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it.each(['hold', 'stamp'])('expires at maxMin in the %s path without extending rtSince', path => {
    let clock = 1000;
    const h = rtSetup({ now: () => clock, priorityReserve: () => ({ enabled: true, source: 'default', maxMin: 40, maxMinSource: 'tool' }) });
    h.s.priorityReserveStamp(priority, HEAD);
    clock += 31 * 60_000;
    h.s.priorityReserveStamp(priority, HEAD);
    expect(readReserves(h.reservePath)['cwd#42'].rtSince).toBe(1000);
    expect(h.s.priorityReserveHold(candidate, HEAD)?.kind).toBe('priority-reserve');
    expect(h.logs.join('')).toContain('priorityReserveMaxMin=40 (tool)');
    clock = 1000 + 40 * 60_000;
    if (path === 'hold') expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    else h.s.priorityReserveStamp(priority, HEAD);
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it.each([
    ['head changed', { state: 'OPEN', headRefOid: 'a'.repeat(40), labels: accepted }],
    ['closed', { state: 'CLOSED', headRefOid: HEAD, labels: accepted }],
  ])('expires rt stamps when %s', (_name, live) => {
    const h = rtSetup({ ghView: { 42: live } });
    stamp(h, { at: 1000, rt: true, rtSince: 1000, maxMs: 90 * 60_000 });
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it('requests the current head locally without overlap, keeps cooldown and preserves the hold', () => {
    const requestRedTeam = vi.fn(() => ({ requested: true }));
    const h = rtSetup({ requestRedTeam, evidence: { ...pendingEvidence, scheduled: false, inFlight: false } });
    h.s.priorityReserveStamp(priority, HEAD);
    expect(h.s.requestRedTeamWhileDeferred(priority, HEAD)).toEqual({ requested: true });
    expect(requestRedTeam).toHaveBeenCalledWith({ repo: LOCAL, pr: 42, head: HEAD, loopPayload: panel });
    expect(h.s.requestRedTeamWhileDeferred(priority, HEAD)).toEqual({ requested: false });
    expect(requestRedTeam).toHaveBeenCalledTimes(1);
    expect(h.s.enqueue(priority, HEAD)).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    expect(h.s.recordedHold(priority, HEAD)).toMatchObject({ kind: 'red-team-pending' });
    expect(readReserves(h.reservePath)['cwd#42'].rt).toBe(true);
  });
  it.each(['break', 'incomplete'])('drops rt reservations for a red-team %s before send-back labels arrive', kind => {
    const thread = [];
    const h = rtSetup({ liveComments: thread });
    h.s.priorityReserveStamp(priority, HEAD);
    thread.push({ user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({
      pr: 42, rev: HEAD, provider: 'codex', model: 'm',
      recheckStatus: kind === 'incomplete' ? 'pending' : 'ok', foldedVerdict: 'changes',
      findings: [{ summary: 'unresolved security break', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }],
    }) });
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(readReserves(h.reservePath)).toEqual({});
    stamp(h, { at: 1000, rt: true, rtSince: 1000, maxMs: 90 * 60_000 });
    h.s.priorityReserveStamp(priority, HEAD);
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it.each([
    ['default card-only exemption', {}, {}, false],
    ['card-only skipping disabled', {}, { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, true],
    ['producer exemption overrides disabled skipping', { skipCardOnly: true }, { WE_RED_TEAM_SKIP_CARD_ONLY: 'false' }, false],
    ['producer requires a pass', { skipCardOnly: false }, {}, true],
    ['in-flight pass', { inFlight: true }, {}, true],
    ['recorded pass', { recorded: true }, {}, true],
    ['attempt-only exemption', { attempted: true }, {}, false],
  ])('matches the enqueue reason for a card-only PR: %s', (_name, evidence, env, held) => {
    const h = rtSetup({ env: { WE_RED_TEAM_TIMING: 'post-accept', ...env }, evidence: {
      ...pendingEvidence, inFlight: false, ...evidence, loopPayload: {
        verdict: { verdict: 'accept' }, findings: { read: {
          netBasis: { rev: HEAD }, netChangedFiles: ['backlog/123-card.md'],
        } },
      },
    } });
    h.s.priorityReserveStamp(priority, HEAD);
    if (held) expect(readReserves(h.reservePath)['cwd#42']).toMatchObject({ rt: true });
    else expect(readReserves(h.reservePath)).toEqual({});
    const result = h.s.enqueue(priority, HEAD);
    if (held) expect(result).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
    else expect(result.enqueued).toBe(true);
  });
  it.each([0])('disables rt stamping with maxMin=%s', maxMin => {
    const h = rtSetup({ priorityReserve: () => ({ enabled: true, source: 'tool', maxMin }) });
    h.s.priorityReserveStamp(priority, HEAD);
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it.each([
    ['disjoint net files', 'git', ['scripts/other.mjs'], false],
    ['shared net files', 'git', [files[0]], true],
    ['GitHub fallback', 'github', [files[0]], true],
    ['unknown files', 'github', null, false],
  ])('uses resolved candidate files against reserves: %s', (_name, source, realFiles, blocked) => {
    const h = setup({ resolveRealFiles: () => ({ files: realFiles, source, disagreed: source === 'git' }),
      ghView: { 42: { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now'] } } });
    stamp(h);
    expect(h.s.priorityReserveHold(candidate, HEAD)?.kind ?? null).toBe(blocked ? 'priority-reserve' : null);
    const result = h.s.enqueue(candidate, HEAD);
    expect(result.kind ?? null).toBe(blocked ? 'priority-reserve' : null);
    expect(result.enqueued).toBe(!blocked);
  });
  it('stamps only real files in both overlap paths, and uses those stamps for later candidates', () => {
    const net = [files[1]];
    const resolveRealFiles = ({ pr }) => ({ source: 'git', disagreed: true,
      files: pr.headRefName === 'lane/later' ? [files[0]] : net });
    const queueFacts = facts([43]);
    const h = setup({ resolveRealFiles, queueFacts,
      ghView: { 43: { files: [files[0]] }, 42: { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now'] } } });
    expect(h.s.queueOverlapHold(priority, HEAD)?.kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)['cwd#42'].files).toEqual(net);
    writeReserves(h.reservePath, {});
    expect(h.s.enqueue(priority, HEAD).kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)['cwd#42'].files).toEqual(net);
    queueFacts.data.repository.mergeQueue.entries.nodes = [];
    expect(h.s.priorityReserveHold({ ...candidate, headRef: 'lane/later' }, HEAD)).toBeNull();
  });
  it.each(['priority:now', 'priority:urgent'])('persists %s overlap defers in both paths', label => {
    const h = setup({ queueFacts: facts([43]), ghView: { 43: { files: [files[0]] } } });
    const c = { ...priority, prLabels: [{ name: label }] };
    expect(h.s.queueOverlapHold(c, HEAD)?.kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)['cwd#42']).toMatchObject({ num: 42, headSha: HEAD, files });
    writeReserves(h.reservePath, {});
    expect(h.s.enqueue(c, HEAD).kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)['cwd#42'].files).toEqual(files);
  });
  it.each([
    ['expired', 'hint'],
    ['expired', 'enqueue'],
    ['head-mismatched', 'hint'],
    ['head-mismatched', 'enqueue'],
  ])('replaces an %s rt stamp with an ordinary overlap reservation in the %s path', (reason, path) => {
    const clock = 1000 + 90 * 60_000;
    const h = setup({ now: () => clock, queueFacts: facts([43]), ghView: { 43: { files: [files[0]] } } });
    stamp(h, { headSha: reason === 'head-mismatched' ? 'a'.repeat(40) : HEAD,
      files: ['old.mjs'], at: 1000, rt: true,
      rtSince: reason === 'expired' ? 1000 : clock - 1000, maxMs: 90 * 60_000 });
    const result = path === 'hint' ? h.s.queueOverlapHold(priority, HEAD) : h.s.enqueue(priority, HEAD);
    expect(result?.kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)['cwd#42']).toEqual({ num: 42, repo: null, headSha: HEAD, files, at: clock });
  });
  it('reserves across passes, permits disjoint work and lets priority enqueue and clear its stamp', () => {
    const queued = facts([43]);
    const ghView = {
      43: { files: [files[0]] },
      42: { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now'] },
    };
    let h = setup({ queueFacts: queued, ghView });
    expect(h.s.enqueue(priority, HEAD).kind).toBe('queue-file-overlap');
    queued.data.repository.mergeQueue.entries.nodes = [];
    h = { ...h, ...harness({ strategy: 'github-merge-queue', reservePath: h.reservePath,
      priorityReserve: () => ({ enabled: true, source: 'default' }), queueFacts: queued, ghView }) };
    expect(h.s.enqueue(candidate, HEAD)).toEqual({ enqueued: false, deferred: true, kind: 'priority-reserve', reason: `priority #42 reserves ${files[0]}` });
    expect(h.logs.join('')).toContain('reserved files for priority #42: blocks #44');
    expect(h.s.enqueue({ ...candidate, num: 45, listedFiles: ['other.mjs'] }, HEAD).enqueued).toBe(true);
    expect(h.s.enqueue(priority, HEAD).enqueued).toBe(true);
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it.each([
    ['not ready', { state: 'OPEN', headRefOid: HEAD, labels: ['priority:now'] }],
    ['head moved', { state: 'OPEN', headRefOid: 'a'.repeat(40), labels: ['ready-to-merge', 'priority:now'] }],
    ['closed', { state: 'CLOSED', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now'] }],
    ['priority removed', { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge'] }],
    ['sent back', { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now', 'review:changes'] }],
    ['queued', { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now'], files: ['other.mjs'] }, [42]],
  ])('drops a stamp when %s', (_name, live, queued = []) => {
    const h = setup({ ghView: { 42: live }, queueFacts: facts(queued) });
    stamp(h);
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(readReserves(h.reservePath)).toEqual({});
    // The harness uses the first view head for queue confirmation too.
    live.headRefOid = HEAD;
    expect(h.s.enqueue(candidate, HEAD).enqueued).toBe(true);
  });
  it('keeps unreadable live stamps without blocking, and retries reads', () => {
    const failures = [42];
    const h = setup({ viewThrows: failures, ghView: { 42: { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:urgent'] } } });
    stamp(h);
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(readReserves(h.reservePath)['cwd#42']).toBeDefined();
    failures.pop();
    expect(h.s.priorityReserveHold(candidate, HEAD)?.kind).toBe('priority-reserve');
  });
  it('refreshes successful live and queue reads after 30 seconds', () => {
    let time = 1_000;
    const live = { state: 'OPEN', headRefOid: HEAD, labels: ['ready-to-merge', 'priority:now'] };
    const h = setup({ now: () => time, ghView: { 42: live } });
    stamp(h, { at: time });
    expect(h.s.priorityReserveHold(candidate, HEAD)?.kind).toBe('priority-reserve');
    const count = h.calls.length;
    expect(h.s.priorityReserveHold(candidate, HEAD)?.kind).toBe('priority-reserve');
    expect(h.calls).toHaveLength(count);
    live.labels = [];
    time += 30_000;
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it('disabled setting prevents stamping and holding', () => {
    const h = setup({ priorityReserve: () => ({ enabled: false, source: 'env' }), queueFacts: facts([43]), ghView: { 43: { files } } });
    expect(h.s.queueOverlapHold(priority, HEAD)?.kind).toBe('queue-file-overlap');
    expect(h.s.enqueue(priority, HEAD).kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)).toEqual({});
    stamp(h);
    const count = h.calls.length;
    expect(h.s.priorityReserveHold(candidate, HEAD)).toBeNull();
    expect(h.calls).toHaveLength(count);
  });
  it.each([() => ({ ran: false }), () => { throw new Error('lock unavailable'); }])('hint tolerates a refused or throwing lock', withLock => {
    const h = setup({ withLock, queueFacts: facts([43]), ghView: { 43: { files } } });
    expect(h.s.queueOverlapHold(priority, HEAD)?.kind).toBe('queue-file-overlap');
    expect(readReserves(h.reservePath)).toEqual({});
  });
  it.each([
    ['dry run', { dryRun: true }, candidate],
    ['other repo', {}, { ...candidate, repo: 'other/repo' }],
    ['priority', {}, { ...candidate, prLabels: ['priority:urgent'] }],
    ['unknown files', {}, { ...candidate, listedFilesComplete: false }],
  ])('does no reserve reads for %s', (_name, options, c) => {
    const h = setup(options);
    stamp(h);
    expect(h.s.priorityReserveHold(c, HEAD)).toBeNull();
    expect(h.calls).toEqual([]);
  });
});


describe('card-only restamped head with no review run', () => {
  const candidate = { num: 42, repo: null, headRef: 'lane/restamped', baseRefName: 'main' };
  const evidence = { loopPayload: null, scheduled: true, recorded: false, attempted: false, inFlight: false, queued: false };
  const setup = (files, failure, over = {}) => harness({
    strategy: 'github-merge-queue', labels: ['review:accepted', 'ready-to-merge'], evidence,
    env: { WE_RED_TEAM_TIMING: 'post-accept', WE_DRAIN_ENQUEUE_WHEN_RED_TEAM_NEVER_SCHEDULED: 'false' },
    now: () => 1000,
    initial: { pending: [], followedUp: [], redTeamPending: { 'cwd#42': {
      headSha: HEAD, firstPendingAt: 0, retryAt: 0, requestedAt: 0,
      reason: 'post-accept red team has no recorded result on the live head',
    } } },
    gitExec: args => {
      if (args[0] === 'remote') return 'https://github.com/web-everything/web-everything.git\n';
      if (args[0] === 'fetch') {
        if (failure === 'exit' && args.includes('--no-tags')) throw Object.assign(new Error('fetch failed'), { status: 1 });
        return '';
      }
      if (args[0] === 'rev-parse') return `${args[1] === 'FETCH_HEAD' ? (failure === 'head' ? 'c'.repeat(40) : HEAD) : BASE_TIP}\n`;
      if (args[0] === 'ls-remote') return `${BASE_TIP}\t${args.at(-1)}\n`;
      if (args[0] === 'diff') return files.map(f => `${f}\0`).join('');
      if (args[0] === 'cat-file') return '';
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    ...over,
  });
  it.each(['enqueue', 'prestage'])('%s exempts only verified non-empty card diffs', method => {
    for (const [files, failure, exempt] of [
      [['backlog/123-card.md'], null, true],
      [['backlog/123-card.md', 'scripts/x.mjs'], null, false],
      [['backlog/123-card.md'], 'exit', false],
      [['backlog/123-card.md'], 'head', false],
      [[], null, false],
    ]) {
      const h = setup(files, failure);
      const result = h.s[method](candidate, HEAD);
      if (method === 'prestage') {
        expect(result.allowed).toBe(exempt);
        if (!exempt) expect(result.reason).toBe('post-accept red team has no recorded result on the live head');
      } else if (exempt) expect(result).toMatchObject({ enqueued: true });
      else expect(result).toMatchObject({ enqueued: false, kind: 'red-team-pending',
        reason: 'post-accept red team has no recorded result on the live head' });
    }
  });
  it.each([
    { recorded: true }, { attempted: true }, { inFlight: true }, { queued: true },
    { loopPayload: { findings: { read: { netBasis: { rev: HEAD.toUpperCase() } } } } },
  ])('does not fetch real files when existing evidence rules out the exemption: %j', over => {
    const h = setup(['backlog/123-card.md'], null, { evidence: { ...evidence, ...over } });
    expect(h.s.enqueue(candidate, HEAD)).toMatchObject({ kind: 'red-team-pending' });
    expect(h.calls.some(call => call[0] === 'git')).toBe(false);
  });
});

describe('#5742: a head moved only by the drain numbering commit reads red-team evidence from the accepted head', () => {
  const setup = () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rt-alias-strategy-'));
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '-q'); git('config', 'commit.gpgsign', 'false'); git('config', 'user.name', 'Drain'); git('config', 'user.email', 'd@x');
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'backlog/010-old.md'), '---\nstatus: resolved\n---\n');
    git('add', '.'); git('commit', '-qm', 'base'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(cwd, 'backlog/xabc123-foo.md'), '---\nstatus: open\n---\n\n# Foo\n');
    git('add', '.'); git('commit', '-qm', 'card');
    const accepted = git('rev-parse', 'HEAD');
    git('mv', 'backlog/xabc123-foo.md', 'backlog/011-foo.md');
    writeFileSync(join(cwd, 'backlog/011-foo.md'), '---\nbornAs: xabc123\nstatus: open\n---\n\n# Foo\n');
    git('add', '.'); git('commit', '-qm', 'drain: JIT-number xabc123→#011 at land (#2288)');
    const real = new Set(['cat-file', 'rev-list', 'log', 'diff-tree', 'ls-tree', 'grep']);
    const gitExec = (args, opts) => {
      if (real.has(args[0]) || (args[0] === 'rev-parse' && args.some((a) => a.endsWith('^{commit}'))))
        return execFileSync('git', args, { ...opts, cwd });
      if (args[0] === 'rev-parse') return `${BASE_TIP}\n`;
      if (args[0] === 'ls-remote') return `${BASE_TIP}\t${args.at(-1)}\n`;
      return args[0] === 'diff' ? 'scripts/x.mjs\0' : '';
    };
    return { cwd, git, accepted, head: git('rev-parse', 'HEAD'), gitExec };
  };
  const pendingOn = (sha) => ({ head }) => (head === sha
    ? { scheduled: true, recorded: false, inFlight: true, loopPayload: { verdict: { verdict: 'accept' } } }
    : { scheduled: false, recorded: false, inFlight: false, loopPayload: null });
  const run = ({ head, gitExec, evidenceFor, setting }) => {
    const requests = [];
    const labels = ['review:accepted', 'ready-to-merge'];
    const h = harness({ strategy: 'github-merge-queue', labels, gitExec, evidenceFor, ...(setting ? { strategyExtra: { numberingRedTeamSetting: () => setting } } : {}), ghView: { 5742: { headRefOid: head, labels, isDraft: false } },
      liveComments: [], requestRedTeam: (input) => { requests.push(input); return { requested: true }; } });
    return { outcome: h.s.enqueue({ num: 5742 }, head), requests, logs: h.logs.join('') };
  };
  it('no red-team request for the numbered head: the accepted head\'s evidence decides', () => {
    const t = setup();
    try {
      const r = run({ ...t, evidenceFor: pendingOn(t.accepted) });
      expect(r.requests).toEqual([]);
      expect(r.outcome).toMatchObject({ enqueued: false, kind: 'red-team-pending' });
      expect(r.outcome.reason).toContain('post-accept red team pending on the numbering ancestor');
      expect(r.outcome.redTeamRequested).toBeFalsy();
      expect(r.logs).toContain('moved only by drain numbering');
      expect(r.logs).toContain('xabc123→#011');
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('the accepted head\'s saved clean red team admits the numbered head: enqueued, no new red team', () => {
    const t = setup();
    const root = mkdtempSync(join(tmpdir(), 'drain-alias-saved-'));
    try {
      const env = { WE_RED_TEAM_TIMING: 'post-accept', CONVEYOR_STATE_ROOT: root, WE_SHARED_RUNS_DIR: join(root, 'runs'), WE_RED_TEAM_DRAIN_READS_SAVED_RESULT: 'on' };
      const path = resolveScorecardStorePath(env);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ version: 1, records: [{ dispatchKind: 'review-seat', seat: 'red-team',
        repo: LOCAL, pr: 5742, rev: t.accepted, status: 'ok', seatVerdict: 'accept', recheckStatus: 'ok', confirmedMissCount: 0, findings: [] }] }));
      saveProvenanceFixtures(env);
      const requests = [];
      const labels = ['review:accepted', 'ready-to-merge'];
      const evidenceFor = ({ head }) => (head === t.accepted
        ? { scheduled: true, recorded: true, inFlight: false, loopPayload: { verdict: { verdict: 'accept' } } }
        : { scheduled: false, recorded: false, inFlight: false, loopPayload: null });
      const mk = () => harness({ strategy: 'github-merge-queue', env, labels, gitExec: t.gitExec, evidenceFor, liveComments: [],
        ghView: { 5742: { headRefOid: t.head, labels, isDraft: false } }, requestRedTeam: (i) => { requests.push(i); return { requested: true }; } });
      const h = mk();
      expect(h.s.enqueue({ num: 5742, repo: LOCAL }, t.head, { comments: [] })).toMatchObject({ enqueued: true });
      expect(requests).toEqual([]);
    } finally { rmSync(t.cwd, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); }
  });
  it('NOT WEAKENED: a smuggled edit in the numbering commit requests a red team for the exact head, as today', () => {
    const t = setup();
    try {
      writeFileSync(join(t.cwd, 'backlog/011-foo.md'), '---\nbornAs: xabc123\nstatus: open\n---\n\n# Foo, edited\n');
      t.git('add', '.'); t.git('commit', '-q', '--amend', '--no-edit');
      const head = t.git('rev-parse', 'HEAD');
      const r = run({ ...t, head, evidenceFor: pendingOn(t.accepted) });
      expect(r.requests).toEqual([expect.objectContaining({ pr: 5742, head })]);
      expect(r.logs).not.toContain('moved only by drain numbering');
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('kill switch review.carryRedTeamAcrossNumbering=false requests a red team for the exact head (today\'s behavior), logged', () => {
    const t = setup();
    try {
      const r = run({ ...t, evidenceFor: pendingOn(t.accepted), setting: { value: false, source: 'env' } });
      expect(r.requests).toEqual([expect.objectContaining({ pr: 5742, head: t.head })]);
      expect(r.logs).toContain('review.carryRedTeamAcrossNumbering=false (env)');
      expect(r.logs).not.toContain('moved only by drain numbering');
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('Codex audit #1: a confirmed break recorded on the numbered head itself is never replaced by the ancestor', () => {
    const t = setup();
    try {
      const requests = [];
      const labels = ['review:accepted', 'ready-to-merge'];
      const comment = { user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({ pr: 5742, rev: t.head,
        findings: [{ summary: 'break on the numbered head', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }], recheckStatus: 'ok' }) };
      const h = harness({ strategy: 'github-merge-queue', labels, gitExec: t.gitExec, evidenceFor: pendingOn(t.accepted), liveComments: [comment],
        ghView: { 5742: { headRefOid: t.head, labels, isDraft: false } }, requestRedTeam: (i) => { requests.push(i); return { requested: true }; } });
      const outcome = h.s.enqueue({ num: 5742 }, t.head);
      expect(outcome.enqueued).toBeFalsy();
      expect(h.logs.join('')).not.toContain('moved only by drain numbering');
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('Codex re-audit #1: an exact-head break spelled with an UPPERCASE sha still decides (never the ancestor)', () => {
    const t = setup();
    try {
      const labels = ['review:accepted', 'ready-to-merge'];
      const comment = { user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({ pr: 5742, rev: t.head.toUpperCase(),
        findings: [{ summary: 'break', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }], recheckStatus: 'ok' }) };
      const clean = { scheduled: true, recorded: true, inFlight: false, loopPayload: { verdict: { verdict: 'accept' } } };
      const h = harness({ strategy: 'github-merge-queue', labels, gitExec: t.gitExec, liveComments: [comment],
        evidenceFor: ({ head }) => (head === t.accepted ? clean : { scheduled: false, recorded: false, inFlight: false, loopPayload: null }),
        ghView: { 5742: { headRefOid: t.head, labels, isDraft: false } }, requestRedTeam: () => ({ requested: true }) });
      expect(h.s.enqueue({ num: 5742 }, t.head).enqueued).toBeFalsy();
      expect(h.logs.join('')).not.toContain('moved only by drain numbering');
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('Codex re-audit #2: once the ancestor\'s red team ends without a usable result, the exact head is requested (recovery not blocked)', () => {
    const t = setup();
    try {
      let clock = 1000;
      let ancestor = { scheduled: true, recorded: false, inFlight: true, loopPayload: { verdict: { verdict: 'accept' } } };
      const requests = [];
      const labels = ['review:accepted', 'ready-to-merge'];
      const opts = { strategy: 'github-merge-queue', labels, gitExec: t.gitExec, liveComments: [], now: () => clock,
        evidenceFor: ({ head }) => (head === t.accepted ? ancestor : { scheduled: false, recorded: false, inFlight: false, loopPayload: null }),
        ghView: { 5742: { headRefOid: t.head, labels, isDraft: false } }, requestRedTeam: (i) => { requests.push(i); return { requested: true }; } };
      const first = harness(opts);
      expect(first.s.enqueue({ num: 5742 }, t.head).reason).toContain('pending on the numbering ancestor');
      expect(requests).toEqual([]);
      ancestor = { scheduled: true, recorded: true, inFlight: false, attempted: true, loopPayload: { verdict: { verdict: 'accept' } } };
      clock += 60 * 60_000;
      const later = harness({ ...opts, initial: first.state() });
      later.s.enqueue({ num: 5742 }, t.head);
      expect(requests).toEqual([expect.objectContaining({ pr: 5742, head: t.head })]);
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('Codex re-audit 2 #2: a confirmed break recorded on the ancestor is the numbered head\'s disposition too (send-back, no new review)', () => {
    const t = setup();
    try {
      const labels = ['review:accepted', 'ready-to-merge'];
      const comment = { user: { login: 'web-everything[bot]' }, body: renderRedTeamComment({ pr: 5742, rev: t.accepted,
        findings: [{ summary: 'break on the accepted head', category: 'security', impactIfUnfixed: 'broken', confirmedByRecheck: true }], recheckStatus: 'ok' }) };
      const done = { scheduled: true, recorded: true, inFlight: false, attempted: true, loopPayload: { verdict: { verdict: 'accept' } } };
      const requests = [];
      const h = harness({ strategy: 'github-merge-queue', labels, gitExec: t.gitExec, liveComments: [comment],
        evidenceFor: ({ head }) => (head === t.accepted ? done : { scheduled: false, recorded: false, inFlight: false, loopPayload: null }),
        ghView: { 5742: { headRefOid: t.head, labels, isDraft: false } }, requestRedTeam: (i) => { requests.push(i); return { requested: true }; } });
      const outcome = h.s.enqueue({ num: 5742 }, t.head);
      expect(outcome.enqueued).toBeFalsy();
      expect(outcome.reason).toContain('requiring send-back');
      expect(requests).toEqual([]);
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('Codex audit #2: evidence that arrives on the numbered head later in the pass wins over a cached alias', () => {
    const t = setup();
    try {
      let headEvidence = { scheduled: false, recorded: false, inFlight: false, loopPayload: null };
      const reads = [];
      const evidenceFor = ({ head }) => { reads.push(head); return head === t.accepted ? pendingOn(t.accepted)({ head }) : headEvidence; };
      const labels = ['review:accepted', 'ready-to-merge'];
      const h = harness({ strategy: 'github-merge-queue', labels, gitExec: t.gitExec, evidenceFor, liveComments: [],
        ghView: { 5742: { headRefOid: t.head, labels, isDraft: false } }, requestRedTeam: () => ({ requested: true }) });
      h.s.enqueue({ num: 5742 }, t.head);
      expect(reads).toContain(t.accepted);
      headEvidence = { scheduled: true, recorded: false, inFlight: true, loopPayload: { verdict: { verdict: 'accept' } } };
      reads.length = 0;
      const before = h.logs.length;
      h.s.enqueue({ num: 5742 }, t.head);
      expect(reads).not.toContain(t.accepted);
      expect(h.logs.slice(before).join('')).not.toContain('moved only by drain numbering');
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('Codex audit #4: a finished-but-unusable ancestor result does not block recovery — the exact head is requested as today', () => {
    const t = setup();
    try {
      const done = { scheduled: true, recorded: true, inFlight: false, attempted: true, loopPayload: { verdict: { verdict: 'accept' } } };
      const r = run({ ...t, evidenceFor: ({ head }) => (head === t.accepted ? done : { scheduled: false, recorded: false, inFlight: false, loopPayload: null }) });
      expect(r.requests).toEqual([expect.objectContaining({ pr: 5742, head: t.head })]);
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
  it('the head\'s own evidence always wins over an ancestor', () => {
    const t = setup();
    try {
      const reads = [];
      const r = run({ ...t, evidenceFor: (o) => { reads.push(o.head); return pendingOn(t.head)(o); } });
      expect(r.requests).toEqual([]);
      expect(new Set(reads)).toEqual(new Set([t.head]));
    } finally { rmSync(t.cwd, { recursive: true, force: true }); }
  });
});

describe('the wired red-team re-request (card 6267): a request is never a result', () => {
  const ACCEPTED = ['review:accepted', 'ready-to-merge'];
  const enqueuedAny = h => h.calls.some(c => c.some(a => String(a).includes('enqueuePullRequest')));
  const payload = { verdict: { verdict: 'accept' }, findings: { read: { netBasis: { rev: HEAD } } } };
  const clean = { user: { login: 'web-everything[bot]' }, body: `<!-- we:red-team-advisory pr=5283 rev=${HEAD} -->\n### Post-accept red team — no break found` };
  const setup = async ({ spawnJob }) => {
    const { requestRedTeamRerun, listRedTeamRequests } = await import('../red-team-rerequest.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'rt-rereq-'));
    const policy = { value: { enabled: true, maxRequestsPerHead: 1 }, sources: {} };
    const requestRedTeam = input => requestRedTeamRerun(input, { env: {}, policy, dir, spawnJob, log: () => {} });
    return { dir, requestRedTeam, list: () => listRedTeamRequests({ repo: LOCAL, pr: 5283, head: HEAD, dir }) };
  };

  it('hold → one request posted → result arrives → merges on that exact head', async () => {
    const spawned = [];
    const { dir, requestRedTeam, list } = await setup({ spawnJob: o => { spawned.push(o); return 4242; } });
    const clock = { t: 1000 };
    const notes = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, requestRedTeam, publishNeedsYou: n => notes.push(n),
      evidence: { loopPayload: payload, inFlight: false, recorded: false, scheduled: true } });
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false });
    clock.t += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deferred: true, redTeamRequested: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].argv).toEqual(expect.arrayContaining(['red-team', '--pr=5283', `--repo=${LOCAL}`, `--head=${HEAD}`]));
    expect(list()).toHaveLength(1);
    const req = JSON.parse(readFileSync(list()[0].path, 'utf8'));
    expect(req).toMatchObject({ repo: LOCAL, pr: 5283, head: HEAD, requestedBy: 'drain', attempt: 1 });
    // Later passes while the re-run is queued: still held, quiet, and never a second request.
    clock.t += 10 * 60_000;
    const queued = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, initial: h.state(), requestRedTeam, publishNeedsYou: n => notes.push(n),
      evidence: { loopPayload: payload, queued: true, inFlight: false, recorded: false, scheduled: true } });
    expect(queued.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deferred: true });
    expect(spawned).toHaveLength(1);
    expect(notes).toHaveLength(0);
    expect(enqueuedAny(h) || enqueuedAny(queued)).toBe(false);
    // The real result arrives for this head: the drain enqueues.
    const after = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t + 60_000, initial: queued.state(), liveComments: [clean], requestRedTeam,
      evidence: { loopPayload: payload, inFlight: false, recorded: true, scheduled: true } });
    expect(after.s.enqueue({ num: 5283 }, HEAD, { comments: [clean] })).toMatchObject({ enqueued: true });
    expect(spawned).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it('request write/start fails → still held, operator alerted with the reason, never retried on the same head', async () => {
    let fail = true;
    const spawned = [];
    const { dir, requestRedTeam, list } = await setup({ spawnJob: o => { if (fail) throw new Error('EACCES spawn'); spawned.push(o); return 99; } });
    const clock = { t: 1000 };
    const notes = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, requestRedTeam, publishNeedsYou: n => notes.push(n),
      evidence: { loopPayload: payload, inFlight: false, recorded: false, scheduled: true } });
    h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    clock.t += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deferred: true, deadlineHeld: true,
      reason: expect.stringContaining('red-team re-request not posted') });
    expect(notes).toEqual([expect.objectContaining({ kind: 'red-team-deadline-held', reason: expect.stringContaining('EACCES spawn') })]);
    expect(list()).toHaveLength(0); // the failed reservation was released
    expect(h.state().redTeamPending['cwd#5283'].requestedAt).toBeUndefined();
    fail = false;
    clock.t += 300_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true,
      reason: expect.stringContaining('EACCES spawn') });
    expect(spawned).toHaveLength(0);
    expect(list()).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(enqueuedAny(h)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a throwing requestRedTeam is caught: held with the note, never enqueued', () => {
    const clock = { t: 1000 };
    const notes = [];
    const h = harness({ strategy: 'github-merge-queue', labels: ACCEPTED, now: () => clock.t, publishNeedsYou: n => notes.push(n),
      requestRedTeam: () => { throw new Error('disk full'); } });
    h.s.enqueue({ num: 5283 }, HEAD, { comments: [] });
    clock.t += 45 * 60_000;
    expect(h.s.enqueue({ num: 5283 }, HEAD, { comments: [] })).toMatchObject({ enqueued: false, deadlineHeld: true });
    expect(h.logs.join('')).toContain('red-team request failed #5283: disk full');
    expect(notes).toHaveLength(1);
    expect(enqueuedAny(h)).toBe(false);
  });
});
