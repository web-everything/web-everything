import { describe, it, expect, vi } from 'vitest';
import {
  prOwnershipOperation, ownerFor, phaseSinceFrom, assessPrOwnership, PR_OWNERSHIP_THRESHOLDS,
} from '../pr-ownership.mjs';
import { createPrOwnershipReader, buildPrToCardMap, cardForPr } from '../pr-ownership-io.mjs';
import { createRegistry, isReadOnlyOperation } from '../registry.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';
import { runReconcilePass } from '../../conveyor/reconcile-pass.mjs';
import { bindAgents } from '../../conveyor/reconcile-core.mjs';

const NOW = Date.parse('2026-09-24T20:00:00.000Z');
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const GREEN = [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pr = (number, labels, extra = {}) => ({
  number, headRefName: `lane/${number}-thing`, headRefOid: `sha${number}`, baseRefName: 'main',
  labels: labels.map((name) => ({ name })), mergeStateStatus: 'CLEAN', statusCheckRollup: GREEN, comments: [],
  isDraft: false, ...extra,
});

// One PR per live shape the card names.
const PRS = [
  pr(1101, ['review:pending']), // owned and healthy: a live, fresh review session is on it
  pr(1102, ['review:pending']), // stale binding: its bound session is `blocked` with a 3-hour-old transcript (#3951)
  pr(1103, ['review:accepted'], { baseRefName: 'lane/3681-ratify' }), // orphan: stacked, queued (#4030 shape)
  pr(1104, ['review:changes']), // owner daemon down: fix-dispatch has no lease
  pr(1105, ['review:pending']), // owed-not-dispatched: 30 minutes owed, nothing bound
];
const AGENTS = [
  { name: 'review-1101', sessionId: 's1101', cwd: '/primary', state: 'working', pid: 1, pidAlive: true },
  { name: 'review-1102', sessionId: 's1102', cwd: '/primary', state: 'blocked', status: 'waiting', pid: 2 },
];
const TRANSCRIPT_AGE_MS = { s1101: 2 * 60_000, s1102: 3 * 60 * 60_000 };
const PHASE_ENTERED_MIN = { 1101: 10, 1102: 200, 1103: 60, 1104: 4, 1105: 30 };

function reader({ fixDispatchPresent = false } = {}) {
  const readTimeline = vi.fn(({ number }) => [
    { event: 'commented', createdAt: ago(1) }, // a comment is not a phase change
    { event: 'labeled', createdAt: ago(PHASE_ENTERED_MIN[number]) },
    { event: 'committed', createdAt: ago(PHASE_ENTERED_MIN[number] + 5) },
  ]);
  const heartbeat = new Date(NOW).toISOString();
  const readActivity = () => ({
    observedAt: heartbeat, staleAfterMs: 10 * 60_000, lastTick: { at: heartbeat, stalled: [] },
    inFlightDispatches: [], completedDispatches: [],
    runners: [
      { name: 'dispatcher', present: true, alive: true, heartbeatAt: heartbeat },
      { name: 'review', present: true, alive: true, heartbeatAt: heartbeat },
      { name: 'fix-dispatch', present: fixDispatchPresent, alive: fixDispatchPresent, heartbeatAt: fixDispatchPresent ? heartbeat : null },
    ],
  });
  const run = vi.fn((bin, argv) => {
    expect(argv.slice(1, 3)).toEqual(['status', '--json']);
    return JSON.stringify({ lanes: [
      { lane: 7, path: '/pool/lane-7', branch: 'lane/1101-thing', lease: { holder: 'h7', workerSession: 'review-1101', acquiredAt: ago(9) } },
    ] });
  });
  // The REAL reconcile pass, with only its network/git readers swapped for fixtures.
  const reconcile = vi.fn((o) => runReconcilePass({
    ...o,
    readPrs: () => PRS,
    enrichMainRed: (prs) => ({ prs, mainRedWindows: [], mainLatestCheckRuns: null }),
    enrichAlreadyLanded: (prs) => prs, enrichBaseRef: (prs) => prs, enrichSystemFix: (prs) => prs,
    resolveMainSha: () => null,
  }));
  const readAgents = vi.fn(() => AGENTS);
  return {
    reconcile, readAgents, readTimeline, run,
    read: createPrOwnershipReader({
      root: '/fixture', repoKeys: ['we'], now: () => NOW,
      reconcile, readAgents, enrich: (agents) => agents,
      enrichFixClaims: (prs) => prs,
      readRequiredChecks: () => ({ checks: ['test'], source: 'fallback' }),
      hungInfoFor: (agent) => ({ ageMs: TRANSCRIPT_AGE_MS[agent.sessionId] ?? null }),
      readTimeline, readActivity, run, pathExists: () => true,
    }),
  };
}

async function invoke(read) {
  const declaration = prOwnershipOperation({ readOwnership: read });
  const registry = createRegistry();
  registry.register(declaration);
  const result = await runOperationCli({ declaration, registry, argv: ['--json'],
    store: createMemoryRunStore(), sinks: {}, newRunId: () => 'test-pr-ownership' });
  expect(result.code).toBe(0);
  return JSON.parse(result.lines.join('\n')).verdict;
}
const flagsOf = (row) => row.flags.map((f) => f.flag);

describe('pr-ownership — one fixture per live shape, through the real reconcile pass and bindAgents', () => {
  it('is a read-only, compute-only declaration', () => {
    const declaration = prOwnershipOperation({ readOwnership: () => ({}) });
    expect(isReadOnlyOperation(declaration)).toBe(true);
    expect(declaration.steps.map(({ step }) => step.kind)).toEqual(['compute', 'compute']);
  });

  it('lists every PR the reconcile dry-run lists, each with an owner or a flag', async () => {
    const verdict = await invoke(reader().read);
    expect(verdict.prs.map((p) => p.number)).toEqual(PRS.map((p) => p.number));
    for (const row of verdict.prs) expect(row.owner !== 'none' || row.flags.length > 0).toBe(true);
    expect(verdict.prToCard).toEqual(Object.fromEntries(PRS.map((p) => [`we:${p.number}`, String(p.number)])));
  });

  it('reads the agents listing once and asks the reconcile pass for the real repo slug', async () => {
    const r = reader();
    await invoke(r.read);
    expect(r.reconcile).toHaveBeenCalledTimes(1);
    expect(r.reconcile.mock.calls[0][0]).toMatchObject({ repo: 'web-everything/web-everything', now: NOW });
    expect(r.readAgents).toHaveBeenCalledTimes(1);
    expect(r.run.mock.calls[0][1]).toContain('--repo=/fixture');
  });

  it('owned and healthy: review daemon alive, fresh bound session, its lane and card, no flag', async () => {
    const row = (await invoke(reader().read)).prs.find((p) => p.number === 1101);
    expect(row).toMatchObject({
      phase: 'needs-review', owner: 'review', nextMove: 'review', ownerDaemonState: 'alive-and-idle',
      card: '1101', healthy: true, flags: [], timeInPhaseMs: 10 * 60_000, ticksInPhase: 5,
      lane: { path: '/pool/lane-7', holder: 'h7', workerSession: 'review-1101' },
      boundSessions: [{ name: 'review-1101', state: 'working', transcriptAgeMs: 2 * 60_000 }],
    });
    // The reconcile pass itself refused: a live session already holds it.
    expect(row.reconcile).toMatchObject({ verdict: 'refusal', kind: 'live-process' });
  });

  it('stale binding: a blocked session whose transcript is 3 hours old freezes an owed PR (#3951)', async () => {
    const row = (await invoke(reader().read)).prs.find((p) => p.number === 1102);
    expect(row.owner).toBe('review');
    expect(flagsOf(row)).toEqual(['stale-binding']);
    expect(row.flags[0].why).toMatch(/review-1102 \(blocked\).*180 min/);
  });

  it('orphan: a stacked PR (base not main) that is queued has no owner — the drain never lands it', async () => {
    const row = (await invoke(reader().read)).prs.find((p) => p.number === 1103);
    expect(row).toMatchObject({ phase: 'queued', stacked: true, baseRefName: 'lane/3681-ratify', owner: 'none', ownerDaemonState: null });
    expect(flagsOf(row)).toEqual(['orphan']);
  });

  it('owner daemon down: a bounced PR whose fix-dispatch daemon has no lease is an orphan', async () => {
    const down = (await invoke(reader().read)).prs.find((p) => p.number === 1104);
    expect(down).toMatchObject({ phase: 'bounced', owner: 'fix-dispatch', nextMove: 'fix', ownerDaemonState: 'down' });
    expect(flagsOf(down)).toEqual(['orphan']);
    const up = (await invoke(reader({ fixDispatchPresent: true }).read)).prs.find((p) => p.number === 1104);
    expect(up.ownerDaemonState).toBe('alive-and-idle');
    expect(up.flags).toEqual([]);
  });

  it('owed-not-dispatched: owed a review for 15 ticks with no bound session or fix claim', async () => {
    const verdict = await invoke(reader().read);
    const row = verdict.prs.find((p) => p.number === 1105);
    expect(row).toMatchObject({ owner: 'review', boundSessions: [], ticksInPhase: 15 });
    expect(row.reconcile).toMatchObject({ verdict: 'dispatch', kind: 'review' });
    expect(flagsOf(row)).toEqual(['owed-not-dispatched']);
    expect(verdict.summary).toMatchObject({ prs: 5, flagged: 4, 'stale-binding': 1, orphan: 2, 'owed-not-dispatched': 1 });
  });

  it('a failed reconcile dry-run is a gap, never an empty "all healthy" list', async () => {
    const read = createPrOwnershipReader({
      repoKeys: ['we'], now: () => NOW, reconcile: () => { throw new Error('gh down'); },
      readActivity: () => { throw new Error('no child'); }, run: () => '{"lanes":[]}', pathExists: () => true,
    });
    const verdict = await invoke(read);
    expect(verdict.prs).toEqual([]);
    expect(verdict.gaps.join('\n')).toMatch(/we: reconcile dry-run failed.*gh down/);
    expect(verdict.gaps.join('\n')).toMatch(/runner-activity unreadable/);
  });
});

describe('pr-ownership — edge cases of the pure pieces', () => {
  it('owner table: each phase, stacked conflict → stacked-rebase, draft → promote-draft', () => {
    expect(ownerFor({ phase: 'ci-red' })).toMatchObject({ owner: 'fix-dispatch', nextMove: 'ci-heal' });
    expect(ownerFor({ phase: 'conflicted' })).toMatchObject({ owner: 'fix-dispatch', nextMove: 'conflict-fix' });
    expect(ownerFor({ phase: 'conflicted', stacked: true })).toMatchObject({ owner: 'fix-dispatch', nextMove: 'stacked-rebase' });
    expect(ownerFor({ phase: 'queued' })).toMatchObject({ owner: 'drain', nextMove: 'merge' });
    expect(ownerFor({ phase: 'needs-human' })).toMatchObject({ owner: 'human' });
    expect(ownerFor({ phase: 'open', isDraft: true })).toMatchObject({ owner: 'fix-dispatch', nextMove: 'promote-draft' });
    expect(ownerFor({ phase: 'needs-review', isDraft: true })).toMatchObject({ owner: 'fix-dispatch', nextMove: 'promote-draft' });
    expect(ownerFor({ phase: 'ci-red', isDraft: true })).toMatchObject({ owner: 'fix-dispatch', nextMove: 'ci-heal' });
    expect(ownerFor({ phase: 'open' }).owner).toBe('none');
    expect(ownerFor({ phase: 'something-new' }).owner).toBe('none');
  });

  it('drain liveness is unknown, not down — a queued PR is not an orphan for want of a runner-activity row', () => {
    const row = assessPrOwnership({ repo: 'we', number: 1, phase: 'queued', bound: [] },
      { observedAt: new Date(NOW).toISOString(), daemons: [] });
    expect(row).toMatchObject({ owner: 'drain', ownerDaemonState: 'unknown', flags: [] });
  });

  it('never guesses: no phase-entry time means no owed-not-dispatched; an unknown transcript age means no stale-binding', () => {
    const row = assessPrOwnership({
      repo: 'we', number: 2, phase: 'needs-review', phaseSince: null,
      bound: [{ name: 'review-2', state: 'blocked', transcriptAgeMs: null }],
    }, { observedAt: new Date(NOW).toISOString(), daemons: [{ name: 'review', state: 'alive-and-idle' }] });
    expect(row).toMatchObject({ ticksInPhase: null, flags: [] });
  });

  it('a finished or self-reported-done bound session is not a stale binding; a fix claim counts as dispatched', () => {
    const base = { repo: 'we', number: 3, phase: 'bounced', phaseSince: ago(60) };
    const ctx = { observedAt: new Date(NOW).toISOString(), daemons: [{ name: 'fix-dispatch', state: 'alive-and-idle' }] };
    const old = PR_OWNERSHIP_THRESHOLDS.staleBindingMs * 10;
    expect(assessPrOwnership({ ...base, bound: [{ name: 'fix-3', state: 'done', transcriptAgeMs: old }] }, ctx).flags).toEqual([]);
    expect(assessPrOwnership({ ...base, bound: [{ name: 'fix-3', state: 'working', selfReportedDone: true, transcriptAgeMs: old }] }, ctx).flags).toEqual([]);
    expect(assessPrOwnership({ ...base, bound: [], fixClaim: { who: 'x' } }, ctx).flags).toEqual([]);
    expect(assessPrOwnership({ ...base, bound: [] }, ctx).flags.map((f) => f.flag)).toEqual(['owed-not-dispatched']);
  });

  it('phase entry is the latest label or commit event; comments and junk timestamps are ignored', () => {
    expect(phaseSinceFrom([
      { event: 'labeled', createdAt: ago(30) }, { event: 'committed', createdAt: ago(20) },
      { event: 'commented', createdAt: ago(1) }, { event: 'labeled', createdAt: 'not-a-date' },
    ])).toBe(ago(20));
    expect(phaseSinceFrom([{ event: 'commented', createdAt: ago(1) }])).toBeNull();
    expect(phaseSinceFrom(null)).toBeNull();
  });

  it('the shared PR→card map is keyed `${repo}:${pr}` and skips PRs that name no card', () => {
    expect(cardForPr({ headRefName: 'lane/4056-pr-ownership' })).toBe('4056');
    expect(cardForPr({ headRefName: 'lane/xee72b2-pr-ownership' })).toBe('xee72b2');
    expect(cardForPr({ headRefName: 'feature/misc' })).toBeNull();
    expect(buildPrToCardMap([
      { repo: 'we', prs: [{ number: 10, headRefName: 'lane/4056-x' }, { number: 11, headRefName: 'misc' }] },
      { repo: 'frontierui', prs: [{ number: 10, headRefName: 'lane/xabc123-y' }] },
    ])).toEqual({ 'we:10': '4056', 'frontierui:10': 'xabc123' });
  });

  it('bindAgents carries transcriptAgeMs as evidence without changing what binds', () => {
    const agents = [
      { name: 'review-7', cwd: '/a', transcriptAgeMs: 5000 },
      { name: 'other', cwd: '/b', laneHeadOid: 'deadbeef' },
      { name: 'unrelated', cwd: '/c', transcriptAgeMs: 1 },
    ];
    const bound = bindAgents({ number: 7, headRefOid: 'deadbeef' }, agents);
    expect(bound.map((b) => [b.agent.name, b.transcriptAgeMs])).toEqual([['other', null], ['review-7', 5000]]);
  });
});
