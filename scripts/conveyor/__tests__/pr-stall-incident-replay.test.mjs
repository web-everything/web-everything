import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { claimedFixerLiveness, claimPidAlive } from '../fix-claim-store.mjs';
import { collectOwnerSignals, runPrSweep } from '../pr-sweep.mjs';
import { resolveWaitState, evaluateInvariant, resolveOwner } from '../pr-sweep-core.mjs';
import { detectStalls } from '../pr-stall-detector.mjs';
import { classifyStall } from '../pr-stall-classify.mjs';
import { SKIP_KINDS, DRAIN_SKIP_DEADLINES, buildSkipReasons } from '../../lib/drain-skip-reasons.mjs';
import { assessPrSweep } from '../../operations/pr-sweep-core.mjs';
import { createWhyReader } from '../../operations/operator-why-io.mjs';
import { evaluatePr } from '../../operations/operator-queue.mjs';
import { evaluateEligibility } from '../delegated-clear-human.mjs';
import { currentHeadHumanReviewGates } from '../../lib/human-review-gates.mjs';
import { gateReadyItems, itemsFromReport } from '../../operations/needs-you-feed.mjs';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { openBasePr } from '../../lib/open-pr-base.mjs';
import { explainWhy } from '../../operations/operator-why.mjs';

const repo = 'web-everything/web-everything', head = 'a'.repeat(40), oldHead = 'b'.repeat(40);
const now = Date.parse('2026-11-17T14:40:00Z'), minute = 60_000;
const iso = ago => new Date(now - ago * minute).toISOString();
const pr = (number = 6873, over = {}) => ({ repo, number, headRefOid: head, labels: ['review:pending'],
  comments: [], state: 'OPEN', updatedAt: iso(50), headRefName: `lane/${number}`, baseRefName: 'main',
  mergeable: 'MERGEABLE', ...over });
const claim = over => ({ live: false, pid: 99, heartbeatAt: iso(1),
  meta: { repo: 'we', kind: 'fix', pr: 6873, who: 'fix-6873', runnerPid: 42, claimedAt: '2026-11-17T14:32:00Z' }, ...over });
const refusal = over => ({ kind: 'refusal', head, at: iso(2), reason: 'reconcile-refused dispatch-failed', ...over });
const staleOwner = { state: 'none', owner: null, ownerLastSeenAt: null };

describe('2026-11-17 claim and refusal replay', () => {
  it('the inventory reader probes once per claim and selects the running fixer over a stale saved live=true row', async () => {
    let reads = 0, probes = 0;
    const inventory = [claim({ live: true, meta: { ...claim().meta, runnerPid: 43 } }), claim()];
    const signals = await collectOwnerSignals({ prs: [pr(), pr(6940)], now, env: {}, errors: [], readAgents: () => [],
      readHealth: () => ({}), cloneRoots: () => [], readClaims: () => { reads++; return inventory; },
      isAlive: pid => { probes++; return pid === 42; } });
    expect(reads).toBe(1);
    expect(probes).toBe(2);
    expect(signals[`${repo}#6873`].fixClaim).toMatchObject({ live: true, meta: { runnerPid: 42 } });
    expect(signals[`${repo}#6940`].fixClaim).toBeUndefined();
  });
  it('#6873 probes the dispatched PID and fresh heartbeat despite persisted live=false and an empty agent listing', async () => {
    const c = claim();
    const signals = await collectOwnerSignals({ prs: [pr()], now, env: {}, errors: [], readAgents: () => [],
      readHealth: () => ({}), cloneRoots: () => [], readClaim: () => c, isAlive: pid => pid === 42 });
    const s = signals[`${repo}#6873`];
    expect(s.fixClaim).toMatchObject({ live: true, pidAlive: true });
    s.daemons = [refusal()];
    const waitState = resolveWaitState(pr(), s, { now });
    expect(waitState.kind).toBe('live-claim');
    expect(resolveOwner(pr(), { ...s, now }).state).toBe('active');
    expect(evaluateInvariant(pr(), staleOwner, { now, since: now - 200 * minute, waitState }).violation).toBeNull();
    expect(detectStalls({ prs: [pr()], now, signals,
      seen: { [`${repo}#6873@${head}|review:pending`]: now - 200 * minute } }).items).toEqual([]);
    const facts = createWhyReader({ now: () => now, isAlive: pid => pid === 42,
      run: () => JSON.stringify(pr()), listPrs: () => [], readComments: () => [], readRequiredChecks: () => [],
      readChecks: () => [], readClaims: () => [c], readBuildHolds: () => [], readBackoffs: () => [],
      readPrepareFailures: () => ({}), readAgents: () => [], listFiles: () => [], listPlists: () => [],
      tail: () => ({ text: '' }) })({ repo, pr: 6873 });
    expect(facts.claims[0].live).toBe(true);
    expect(explainWhy(facts).owner).toContain('fix-6873');
  });
  it.each([
    ['dead PID', claim({ live: true }), false],
    ['stale heartbeat', claim({ live: true, heartbeatAt: iso(11) }), true],
    ['missing heartbeat', claim({ heartbeatAt: null }), true],
    ['future heartbeat', claim({ heartbeatAt: iso(-10) }), true],
  ])('does not treat %s as live; a real stalled fixer still alerts', (_name, c, alive) => {
    const evidence = { ...c, ...claimedFixerLiveness(c, { nowMs: now, isAlive: () => alive }) };
    expect(evidence.live).toBe(false);
    const waitState = resolveWaitState(pr(), { fixClaim: evidence, daemons: [refusal()] }, { now });
    expect(waitState.kind).not.toBe('refused');
    expect(evaluateInvariant(pr(), staleOwner, { now, since: now - 200 * minute, waitState }).violation).toBe('deadline-passed');
    expect(detectStalls({ prs: [pr()], now, signals: { [`${repo}#6873`]: { fixClaim: evidence } },
      seen: { [`${repo}#6873@${head}|review:pending`]: now - 200 * minute } }).items).toHaveLength(1);
  });
  it('refusal requires an explicit current head; headless and previous-head records retain real-stall detection', () => {
    for (const h of [undefined, oldHead]) {
      expect(resolveWaitState(pr(), { daemons: [refusal({ head: h })] }, { now })).toBeNull();
      expect(evaluateInvariant(pr(), staleOwner, { now, since: now - 200 * minute }).violation).toBe('deadline-passed');
    }
    const waitState = resolveWaitState(pr(), { daemons: [refusal()] }, { now });
    expect(waitState.kind).toBe('refused');
    expect(evaluateInvariant(pr(), staleOwner, { now, since: now - 50 * minute, waitState }).violation).toBe('waiting-refused');
  });
  it.each([[6991, 'capacity'], [6995, 'merge-queue'], [7001, 'batching'], [7006, 'accepted-waiting-on-merge']])(
    '#%s has a bounded %s wait, then alerts if nothing moves', (number, kind) => {
      const p = pr(number, { labels: ['review:accepted'], isInMergeQueue: kind === 'merge-queue' });
      const daemons = kind === 'capacity' ? [refusal({ reason: 'reconcile-refused no-lane' })]
        : kind === 'batching' ? [refusal({ reason: 'drain-skip:batching-deferred' })] : [];
      const waitState = resolveWaitState(p, { daemons }, { now });
      expect(waitState).toMatchObject({ kind, owner: 'drain', deadlineMinutes: 120 });
      expect(evaluateInvariant(p, staleOwner, { now, since: now - 50 * minute, waitState }).violation).toBeNull();
      expect(evaluateInvariant(p, staleOwner, { now, since: now - 121 * minute, waitState }).violation).toBe('deadline-passed');
    });
});

it.each([['ESRCH', false], ['EPERM', true], ['EIO', null]])('claim PID probe %s yields %s without trusting saved liveness', (code, expected) => {
  const alive = claimPidAlive(42, () => { throw Object.assign(Error(code), { code }); });
  expect(alive).toBe(expected);
  expect(claimedFixerLiveness(claim({ live: true }), { nowMs: now, isAlive: () => alive }).live)
    .toBe(expected);
});

it('an unknown claim PID or unreadable heartbeat cannot establish a live owner', () => {
  expect(claimedFixerLiveness(claim({ pid: null, meta: {} }), { nowMs: now }).live).toBeNull();
  expect(claimedFixerLiveness(claim({ heartbeatAt: 'unreadable' }), { nowMs: now, isAlive: () => true }).live).toBe(false);
});

it.each(['oversized', 'malformed', 'unreadable'])('an %s open-base read retains an operator-visible undecided alert without approval', async kind => {
  const p = { ...readyPr(6949), baseRefName: 'lane/6945' }, report = { ready: [{ repo, number: p.number }] };
  const messages = [];
  const result = await gateReadyItems(itemsFromReport(report), report, { now, fixClaimLive: () => false, log: s => messages.push(s),
    gh: async (_cmd, args) => {
      if (args[0] === 'api') return JSON.stringify([[]]);
      if (args[1] !== 'list') return JSON.stringify(p);
      if (kind === 'unreadable') throw Error('base read unavailable');
      return JSON.stringify(kind === 'oversized' ? Array.from({ length: 100 }, (_, n) => ({ ...pr(n + 1), headRefName: p.baseRefName }))
        : [{ headRefName: p.baseRefName }]);
    } });
  expect(result.kept).toHaveLength(1);
  expect(result.kept[0]).toMatchObject({ kind: 'red-team-undecided' });
  expect(result.kept[0]).not.toHaveProperty('command');
  expect(messages.join(' ')).toMatch(/base.*(?:incomplete|unavailable)/);
});

it('a merged, cross-repository or incomplete base record cannot suppress a genuine stall', () => {
  const p = pr(6949, { baseRefName: 'lane/6945' }), base = pr(6945);
  for (const candidate of [{ ...base, repo: 'other/repo' }, { ...base, state: 'MERGED' }, { ...base, number: undefined }]) {
    expect(openBasePr(p, [candidate])).toBeNull();
    expect(evaluateInvariant(p, staleOwner, { now, since: now - 300 * minute,
      waitState: resolveWaitState(p, {}, { now, openPrs: [candidate] }) }).violation).toBe('deadline-passed');
  }
});

it('an explicit operator hold on a stacked PR stays visible', () => {
  const base = pr(6945), p = pr(6949, { baseRefName: base.headRefName, labels: ['status:needs-you'], updatedAt: iso(300) });
  expect(assessPrSweep({ prs: [base, p], now }).prs.find(row => row.number === p.number))
    .toMatchObject({ actor: 'operator', stalled: true, waitingOn: 'needs-you' });
  expect(resolveWaitState(p, {}, { now, openPrs: [base] })).toBeNull();
});

describe('every emitted drain skip is a known bounded drain wait', () => {
  it('enumerates literal enqueue emitters as well as the accounting registry', () => {
    for (const file of ['scripts/merge-ai-prs.mjs', 'scripts/lib/drain-merge-strategy.mjs']) {
      const source = readFileSync(file, 'utf8');
      const kinds = [...source.matchAll(/(?:outcome: 'not-enqueued'|enqueued: false)[^\n}]*?kind: '([^']+)'/g)].map(m => m[1]);
      expect(kinds.length).toBeGreaterThan(0);
      for (const kind of kinds) expect(SKIP_KINDS).toContain(kind);
    }
    expect(SKIP_KINDS).toEqual(expect.arrayContaining(['batching-deferred', 'bornas-collision', 'bornas-unreadable']));
  });
  it.each(SKIP_KINDS)('%s is drain-owned, has a deadline, waits before it and retains a real-stall action after it', kind => {
    const p = pr(7001, { labels: ['ready-to-merge'], updatedAt: iso(1) });
    const skips = buildSkipReasons({ verdicts: [{ num: p.number, repo, decision: 'merge' }],
      enqueueOutcomes: [{ num: p.number, repo, outcome: 'not-enqueued', kind, reason: kind }] });
    const fresh = assessPrSweep({ prs: [p], now, drainSkips: skips }).prs[0];
    expect(fresh).toMatchObject({ waitingOn: `drain-skip:${kind}`, actor: 'drain', stalled: false });
    expect(Date.parse(fresh.deadline)).toBeGreaterThan(now);
    expect(classifyStall({ row: fresh, head })).toBeNull();
    const old = assessPrSweep({ prs: [{ ...p, updatedAt: iso(DRAIN_SKIP_DEADLINES[kind] + 1) }], now, drainSkips: skips }).prs[0];
    expect(old.stalled).toBe(true);
    expect(classifyStall({ row: old, head })).toMatchObject({ lane: 'system', action: 'tooling-card' });
  });
  it('unknown skip evidence fails closed with an operator-visible explanation', () => {
    const row = assessPrSweep({ prs: [pr(6940, { labels: ['review:accepted'], updatedAt: iso(500) })], now,
      drainSkips: [{ num: 6940, repo, kind: 'future-kind', reason: 'unknown' }] }).prs[0];
    expect(classifyStall({ row, head })).toMatchObject({ lane: 'operator', reason: expect.stringContaining('unknown waiting state') });
  });
});

const readyPr = number => pr(number, {
  labels: ['review:human', 'advisory:accepted', 'red-team:clear'].map(name => ({ name })),
  statusCheckRollup: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  comments: [{ author: { login: 'web-everything' }, createdAt: iso(5),
    body: `**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${oldHead}..${head}\`` },
  { author: { login: 'web-everything' }, createdAt: iso(4), body: renderRedTeamComment({ pr: number, rev: head,
    provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'accepted', findings: [] }) }],
});
const projectedView = (p, args) => Object.fromEntries(args[args.indexOf('--json') + 1].split(',')
  .filter(field => Object.hasOwn(p, field)).map(field => [field, p[field]]));
const feed = async (p, observeView = () => {}) => {
  const report = { ready: [{ repo, number: p.number }] };
  return gateReadyItems(itemsFromReport(report), report, { now, fixClaimLive: () => false, log: () => {},
    gh: async (_cmd, args) => {
      if (args[0] === 'api') return JSON.stringify([p.comments.map(c => ({ ...c, user: c.author, created_at: c.createdAt }))]);
      const view = projectedView(p, args);
      observeView(view);
      return JSON.stringify(view);
    } });
};

describe('shared readiness evidence (#6933 and #6911)', () => {
  it('a proven-ready live read containing only requested JSON fields retains its approval action without a returned number', async () => {
    const p = readyPr(6933);
    const views = [];
    const result = await feed(p, view => views.push(view));
    expect(views).toHaveLength(1);
    expect(views[0]).not.toHaveProperty('number');
    expect(views[0]).not.toHaveProperty('comments');
    expect(result.held).toEqual([]);
    expect(result.kept).toHaveLength(1);
    const [expected] = itemsFromReport({ ready: [{ repo, number: p.number }] });
    expect(expected.command).toBeTruthy();
    expect(result.kept[0]).toMatchObject({ ...expected, head, kind: 'needs-you' });
  });
  it.each(['proven-ready', 'CI red', 'CI unreadable', 'no red-team proof', 'previous-head proof', 'pending label', 'malformed red-team proof'])('%s cannot disagree across delegate, queue and feed', async state => {
    const p = readyPr(state === 'CI red' ? 6911 : 6933);
    if (state === 'CI red') p.statusCheckRollup[0].conclusion = 'FAILURE';
    if (state === 'CI unreadable') delete p.statusCheckRollup;
    if (state === 'no red-team proof') p.comments.pop();
    if (state === 'malformed red-team proof') p.comments[1].body = p.comments[1].body.replace('no break found', '1 possible break(s), 1 confirmed');
    if (state === 'previous-head proof') p.headRefOid = oldHead;
    if (state === 'pending label') p.labels = p.labels.filter(l => l.name !== 'red-team:clear').concat({ name: 'red-team:pending' });
    const shared = currentHeadHumanReviewGates(p);
    expect(shared.eligible).toBe(state === 'proven-ready');
    expect(evaluateEligibility(p, { scoreNet: () => ({ scored: true, humanRequired: false }) }).eligible).toBe(shared.eligible);
    expect(evaluatePr(p).ready).toBe(shared.eligible);
    const result = await feed(p);
    expect(result.kept.some(i => i.kind === 'needs-you')).toBe(shared.eligible);
  });
  it('unreadable red-team evidence fails closed, including an accidentally asynchronous reader', () => {
    for (const reader of [() => { throw Error('unreadable'); }, () => Promise.resolve(true)]) {
      expect(currentHeadHumanReviewGates(readyPr(6933), { redTeamClearAtHead: reader }).failed)
        .toContain('red-team:clear not proven on the current head');
    }
  });
});

it('#6949 waits on open base #6945; removing that base restores the unowned-stall alert', async () => {
  const base = pr(6945), stacked = pr(6949, { baseRefName: base.headRefName, updatedAt: iso(300) });
  const read = prs => assessPrSweep({ prs, now });
  expect(read([base, stacked]).prs.find(p => p.number === 6949)).toMatchObject({ waitingOn: 'waiting-on-base', stalled: false });
  expect(evaluatePr({ ...readyPr(6949), baseRefName: base.headRefName }, { openPrs: [base] }).ready).toBe(false);
  const waitState = resolveWaitState(stacked, {}, { now, openPrs: [base] });
  expect(evaluateInvariant(stacked, staleOwner, { now, since: now - 300 * minute, waitState }).violation).toBeNull();
  expect(read([stacked]).prs[0].stalled).toBe(true);
  expect(evaluateInvariant(stacked, staleOwner, { now, since: now - 300 * minute }).violation).toBe('deadline-passed');
  const report = { ready: [{ repo, number: 6949 }] }, p = { ...readyPr(6949), baseRefName: base.headRefName };
  const result = await gateReadyItems(itemsFromReport(report), report, { now, fixClaimLive: () => false, log: () => {},
    gh: async (_cmd, args) => JSON.stringify(args[0] === 'api' ? [[]] : args[1] === 'list' ? [base] : p) });
  expect([...result.kept]).toEqual([]);
  expect(result.held[0].reasons).toContain('waiting on open base PR #6945');
  const run = await runPrSweep({ now, config: {}, settings: { value: { repos: [repo], idleMinutes: 45, stuckAfterMinutes: 90, stuckAlertMinutes: 90 }, sources: {} },
    readPrs: () => [base, stacked], readQueue: () => ({ ready: [], rulingNeeded: [] }), readSignals: () => ({}), readPrevious: () => null,
    notify: () => ({ ok: true }), persist: () => {}, append: () => {}, flush: () => {}, stallSweep: () => ({ mode: 'off' }), detector: () => ({ enabled: false, items: [], errors: [] }) });
  expect(run.decisions.find(p => p.number === 6949).violation).toBeNull();
});
