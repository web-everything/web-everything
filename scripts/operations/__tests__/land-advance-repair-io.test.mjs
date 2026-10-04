import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { createLandAdvanceReader, createLandAdvanceApplier, writeFollowUp } from '../land-advance-io.mjs';
import { planLandAdvance } from '../land-advance.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { allowedToolsArg, ALLOWED_TOOLS_BY_KIND } from '../land-advance-tools.mjs';
import { dispatchCiHeal } from '../ci-heal-pr-dispatch.mjs';
import { DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { CI_HEAL_COMMENT_MARKER } from '../../conveyor/ci-heal-mark.mjs';
import { STAND_DOWN_MARKER } from '../../conveyor/stand-down.mjs';
import { CONFLICT_LABEL } from '../../conveyor/parked-pr-conflict-watch.mjs';
const now = Date.parse('2026-09-20T20:00:00Z');
const emptyFs = { ...fs, readdirSync: () => [], readFileSync: (p) => { if (String(p).endsWith('swept-repos.json')) return '["web-everything/web-everything","frontier-ui/frontierui","plateauapp/plateau-app"]'; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } };
const live = { name: 'x', createdAt: '2026-09-20T13:00:00Z', updatedAt: '2026-09-20T15:00:00Z', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
// Tonight's shapes as `gh pr list` returns them (labels are objects there).
const gh = [{ ...live, number: 2349, headRefName: 'lane/ci-red-thing', labels: [{ name: 'ci:failed' }], mergeStateStatus: 'UNSTABLE' },
  { ...live, number: 2344, headRefName: 'lane/graduate-3443-fix-dispatch-pr-diff-scope', labels: [{ name: 'review:changes' }, { name: 'review-status:fixing' }], mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }];
// Hermetic: never read this machine's real drain history / jobs / trials (its PR numbers can collide with the fixtures').
// #3856 graduation note: both fixtures below are itemless PRs (`lane/ci-red-thing`, `lane/graduate-3443-...` —
// neither head ref matches `lane/<num>-...`), so `planFixesFromReconcile`'s itemless branch resolves them
// through the shared `resolvePrWorkUnit` (`we:scripts/conveyor/pr-work-unit.mjs`) via the injected
// `fetchItemlessDiffPaths` (UN-prefixed — the resolver adds the repo prefix), not `resolveFallbackScope`
// (still item-carrying-only on main, unlike this module's own branch snapshot).
const ports = (over = {}) => ({ fs: emptyFs, now: () => now, home: '/nonexistent/home', drainDir: '/nonexistent/drain', jobsDir: '/nonexistent/jobs', trialLog: '/nonexistent/trials.jsonl', readSessions: () => [], store: createMemoryRunStore(), machineLoad: () => 0, findItemFn: () => null, loadItems: () => [],
  fetchItemlessDiffPaths: vi.fn((pr) => [`scripts/x-${pr}.mjs`]), readPrComments: () => [],
  run: (cmd, args) => cmd === 'gh' ? (args.includes('web-everything/web-everything') ? JSON.stringify(gh) : '[]') : cmd === 'git' ? '0 0' : '/lanes/lane-1\n/lanes/lane-2', ...over });
const label = (labels) => labels.map((l) => l.name ?? l);

describe('reader: repair evidence', () => {
  it('plans #2349 and #2344 through the same item-number-free planner, marking the conflict', () => {
    const p = ports(), inputs = createLandAdvanceReader(p)();
    expect(inputs.errors).toEqual([]);
    expect(inputs.fixPlans['we#2349'].planned).toMatchObject({ pr: 2349, itemNum: null, scope: ['we:scripts/x-2349.mjs'], scopeSource: 'pr-diff', isConflict: false });
    expect(inputs.fixPlans['we#2344'].planned).toMatchObject({ pr: 2344, itemNum: null, scopeSource: 'pr-diff', isConflict: true });
    expect(p.fetchItemlessDiffPaths).toHaveBeenCalledWith(2349);
    const plan = planLandAdvance(inputs);
    expect(plan.rows.map((r) => [r.pr, r.owedAction, r.dispatchable]).sort()).toEqual([[2344, 'dispatch-conflict-fix', true], [2349, 'dispatch-ci-heal', true]]);
    expect(label(gh[1].labels)).not.toContain(CONFLICT_LABEL); // the reader never edits the PR: the marker is only on the planned entry
  });
  // #3856 graduation note: `countCiHealComments`/`countStandDownComments` (`ci-heal-mark.mjs`/`stand-down.mjs`,
  // main) now gate every marker on `isTrustedMarkerAuthor` (`we:scripts/lib/marker-authorship.mjs`, #3383 —
  // landed after this module's own branch snapshot: a forged marker from an untrusted login must not inflate a
  // round cap or force a stand-down). Fixture comments need `viewerDidAuthor: true` to read as trusted.
  it('reads the PR\'s own CI-heal and stand-down comments, and only for PRs that owe a repair', () => {
    const readPrComments = vi.fn((pr) => pr.number === 2349 ? [{ body: `${CI_HEAL_COMMENT_MARKER}\n\nx`, viewerDidAuthor: true }, { body: `${CI_HEAL_COMMENT_MARKER}\n\nx`, viewerDidAuthor: true }, { body: 'quoting: ' + CI_HEAL_COMMENT_MARKER, viewerDidAuthor: true }] : [{ body: `${STAND_DOWN_MARKER}\n\nx`, viewerDidAuthor: true }]);
    const inputs = createLandAdvanceReader(ports({ readPrComments }))();
    expect(inputs.repairEvidence).toEqual({ 'we#2349': { ciHealComments: 2, standDownComments: 0 }, 'we#2344': { ciHealComments: 0, standDownComments: 1 } });
    expect(planLandAdvance(inputs).rows.find((r) => r.pr === 2344)).toMatchObject({ owedAction: 'escalate', kind: 'conflict-fix-exhausted' });
    const none = vi.fn(); createLandAdvanceReader(ports({ readPrComments: none, run: (cmd) => cmd === 'gh' ? '[]' : cmd === 'git' ? '0 0' : '/lane-1' }))(); expect(none).not.toHaveBeenCalled();
  });
  it('a comment-read failure is a source error, so apply refuses', () => {
    const inputs = createLandAdvanceReader(ports({ readPrComments: () => { throw new Error('gh down'); } }))();
    expect(inputs.errors.map((e) => e.source)).toEqual(['repair-evidence:we#2349', 'repair-evidence:we#2344']);
  });
  it('a live detached ci-heal wrapper (pid handle) is a live worker; a dead one is not, and counts toward the cap', () => {
    const store = createMemoryRunStore(), entry = { session: 'pid:4242', kind: 'ci-heal', target: 'we#2349', launchedAt: '2026-09-20T19:00:00Z', deadline: '2026-09-20T21:00:00Z', expectedResultPath: '/completion/ci-heal-2349.json', permissionsGranted: [] };
    writeFollowUp(entry, { store });
    const alive = createLandAdvanceReader(ports({ store, isPidAlive: (pid) => pid === 4242 }))();
    expect(alive.detached).toEqual(['we#2349']); expect(alive.followUps[0].evidence.liveness).toBe('live-active');
    expect(planLandAdvance(alive).rows.find((r) => r.pr === 2349).owedAction).toBe('none');
    const dead = createLandAdvanceReader(ports({ store, isPidAlive: () => false }))();
    expect(dead.detached).toEqual([]); expect(dead.followUps[0].evidence.liveness).toBe('dead-record');
    expect(planLandAdvance(dead).rows.find((r) => r.pr === 2349).owedAction).toBe('dispatch-ci-heal'); // one dead attempt is under the cap
  });
  it('a repair follow-up is finished once the PR is no longer red / conflicting', () => {
    const store = createMemoryRunStore(), t = (kind, target) => ({ session: 's', kind, target, launchedAt: '2026-09-20T19:00:00Z', deadline: '2026-09-20T21:00:00Z', expectedResultPath: `/r/${kind}.md`, permissionsGranted: [] });
    writeFollowUp(t('ci-heal', 'we#2349'), { store }); writeFollowUp(t('conflict-fix', 'we#2344'), { store });
    const fixed = gh.map((p) => ({ ...p, labels: [], mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE' }));
    const inputs = createLandAdvanceReader(ports({ store, run: (cmd, args) => cmd === 'gh' ? (args.includes('web-everything/web-everything') ? JSON.stringify(fixed) : '[]') : cmd === 'git' ? '0 0' : '/lane-1', readSessions: () => [{ id: 's', liveness: 'live-idle' }] }))();
    expect(inputs.followUps.map((f) => f.evidence.targetMovedOn)).toEqual([true, true]);
  });
});

describe('apply: the repair dispatches', () => {
  const setup = (planInputs, over = {}) => {
    const p = { now: () => now, readCapacity: vi.fn(() => ({ freeLanes: 3, sessions: [], load: 0 })), writeLedger: vi.fn(), writePacket: vi.fn(), reap: vi.fn(), pickFixLane: () => 7,
      dispatchReview: vi.fn(), dispatchFix: vi.fn(async () => ({ agentId: 'fix-agent', sessionSlug: 'fix-2344' })), dispatchCiHeal: vi.fn(async () => ({ agentId: 'pid:99', sessionSlug: 'ci-heal-2349' })), run: vi.fn(), ...over };
    return { p, plan: planLandAdvance({ now, freeLanes: 3, cap: 5, ...planInputs }) };
  };
  const prs = gh.map((x) => ({ ...x, repo: 'we', slug: 'web-everything/web-everything', labels: label(x.labels) }));
  const fixPlans = { 'we#2349': { planned: { itemNum: null, attributionKind: 'PR', attributionNum: '2349', pr: 2349, laneRef: 'lane/ci-red-thing', scope: ['we:scripts/a.mjs'] } },
    'we#2344': { planned: { itemNum: null, attributionKind: 'PR', attributionNum: '2344', pr: 2344, laneRef: 'lane/g', scope: ['we:scripts/b.mjs'], isConflict: true } } };
  it('routes ci-heal to the ci-heal dispatch and a conflict to the reconcile fix, each with its own tool grant and ledger kind', async () => {
    const { p, plan } = setup({ prs, fixPlans }), result = await createLandAdvanceApplier(p)(plan);
    expect(result.errors).toEqual([]); expect(result.dispatched).toHaveLength(2);
    expect(p.dispatchCiHeal).toHaveBeenCalledWith(expect.objectContaining({ pr: 2349, reason: 'red-ci', lane: 7, attributionKind: 'PR' }), expect.objectContaining({ extraArgs: [allowedToolsArg('ci-heal')], repo: 'we' }));
    expect(p.dispatchFix).toHaveBeenCalledWith(expect.objectContaining({ pr: 2344, lane: 7, attributionKind: 'PR', attributionNum: '2344' }), expect.objectContaining({ extraArgs: [allowedToolsArg('conflict-fix')] }));
    expect(p.dispatchReview).not.toHaveBeenCalled();
    const ledger = Object.fromEntries(p.writeLedger.mock.calls.map(([e]) => [e.kind, e]));
    expect(ledger['ci-heal']).toMatchObject({ target: 'we#2349', session: 'pid:99', permissionsGranted: ALLOWED_TOOLS_BY_KIND['ci-heal'], expectedResultPath: expect.stringContaining('ci-heal-2349') });
    expect(ledger['conflict-fix']).toMatchObject({ target: 'we#2344', session: 'fix-agent', permissionsGranted: ALLOWED_TOOLS_BY_KIND['conflict-fix'] });
    expect(p.run).not.toHaveBeenCalled(); // apply itself never shells gh: no label edit is possible from here
  });
  it('a held dispatch is deferred, and a spent cap writes an escalation packet with no dispatch', async () => {
    const held = setup({ prs: [prs[0]], fixPlans }, { dispatchCiHeal: vi.fn(async () => ({ held: true, reason: 'held:pr' })) });
    const r = await createLandAdvanceApplier(held.p)(held.plan); expect(r.deferred).toEqual([{ target: 'we#2349', reason: 'held-by-action-record' }]); expect(held.p.writeLedger).not.toHaveBeenCalled();
    const spent = setup({ prs, fixPlans, repairEvidence: { 'we#2349': { ciHealComments: 3 }, 'we#2344': { standDownComments: 1 } } });
    await createLandAdvanceApplier(spent.p)(spent.plan);
    expect(spent.p.dispatchCiHeal).not.toHaveBeenCalled(); expect(spent.p.dispatchFix).not.toHaveBeenCalled();
    expect(spent.p.writePacket.mock.calls.map(([k]) => k.kind).sort()).toEqual(['ci-heal-exhausted', 'conflict-fix-exhausted']);
    expect(spent.p.writePacket.mock.calls.every(([k]) => k.status === 'open' && k.ladder.next === 'L2 ai-triage')).toBe(true);
  });
  it('plan mode dispatches nothing: only the applier acts', () => {
    const { p, plan } = setup({ prs, fixPlans }); expect(plan.proposed).toHaveLength(2); expect(p.dispatchCiHeal).not.toHaveBeenCalled(); expect(p.dispatchFix).not.toHaveBeenCalled();
  });
});

describe('dispatchCiHeal (the tick sink, entered for a PR by number)', () => {
  const planned = { itemNum: null, attributionKind: 'PR', attributionNum: '2349', pr: 2349, laneRef: 'lane/ci-red-thing', scope: ['we:scripts/a.mjs', 'we:docs/b.md'], lane: 7 };
  // #3856 graduation note: `repo` here is the internal key (`sessionSlugFor` → `repoSlugTag` accepts only a
  // known key on main, not a gh slug — see `land-advance-io.mjs`'s applier comment at its own dispatch calls).
  it('fills the real ci-heal brief and hands one ci-heal payload to the sink', async () => {
    const sink = vi.fn(async () => ({ handle: 'pid:4242', expectedBy: '2026-09-20T21:00:00.000Z' })), sinks = { [DISPATCH_EFFECT]: sink };
    const out = await dispatchCiHeal(planned, { sinks, repo: 'we' });
    expect(out).toMatchObject({ agentId: 'pid:4242', sessionSlug: 'ci-heal-2349', pr: 2349, itemNum: null, lane: 7 });
    const [payload] = sink.mock.calls[0];
    expect(payload).toMatchObject({ launchKind: 'ci-heal', sessionSlug: 'ci-heal-2349', pr: 2349, reason: 'red-ci', lane: 7, scope: planned.scope, repo: 'we' });
    expect(payload.num).toBeUndefined(); expect(payload.prompt).toContain('2349'); expect(payload.prompt).toContain('lane/ci-red-thing'); expect(payload.prompt).toContain('we:scripts/a.mjs,we:docs/b.md');
  });
  it('passes an item number through when the PR names one, and returns a held result untouched', async () => {
    const sink = vi.fn(async () => ({ held: true, reason: 'held:pr' }));
    const out = await dispatchCiHeal({ ...planned, itemNum: '3140' }, { sinks: { [DISPATCH_EFFECT]: sink }, repo: 'we' });
    expect(out).toEqual({ held: true, reason: 'held:pr' }); expect(sink.mock.calls[0][0].num).toBe('3140');
  });
});
