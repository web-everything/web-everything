/**
 * agy-launcher-probation — the routing half: the opened doc-fix / ci-heal / bugfix / build-new-feature gate rows, the probation roster, the
 * `ci-heal` taskType, and the pick riding on the routing record while Claude stays the fallback.
 */
import { describe, expect, it } from 'vitest';
import {
  AGY_CLAUDE_MODEL_BY_TIER, AGY_GEMINI_SIMPLE_MODEL, AGY_MODEL_CATALOG_CHECK, CRITICAL_WORK_GATE, PROBATION_ROSTER,
  PROBATION_WORKERS, PROVEN_TASK_ENVELOPES, RECOMMENDATIONS, selectProbationWorker, selectProvider,
} from '../provider-routing.mjs';
import { decideDispatchRoute as currentRoute } from '../dispatch-contracts.mjs';
import { inheritedRoutingPolicy } from './inherited-routing-policy.mjs';
const decideDispatchRoute = (dispatch, options) => currentRoute(dispatch, { routingPolicy: inheritedRoutingPolicy, ...options });
import { readBuildArgonSettings } from '../build-argon-settings.mjs';
import { taskTypeFor } from '../dispatch-task-type.mjs';
import { CODEX_MODEL } from '../codex-model-routing.mjs';

const row = (o) => ({ subjectClass: 'work-agent', verifiedBy: 'independent-claude', outcome: 'landed', scoredAt: '2026-09-20T00:00:00Z', ...o });
const open = { criticalWork: { critical: false, reasons: [] }, criticalMisses: [] };

describe('the Antigravity Claude models were checked against the live catalog', () => {
  it('pins the two Claude backends `agy models` lists on agy 1.2.12, and records the check', () => {
    expect(AGY_CLAUDE_MODEL_BY_TIER).toEqual({ sonnet: 'claude-sonnet-4-6', opus: 'claude-opus-4-6-thinking' });
    expect(AGY_MODEL_CATALOG_CHECK).toEqual({ agyVersion: '1.2.12', checkedOn: '2026-09-27' });
    expect(AGY_GEMINI_SIMPLE_MODEL).toMatch(/^gemini-3\.8-flash-/);
  });
});

describe('ci-heal is its own taskType, with a bounded envelope', () => {
  it('a ci-heal dispatch derives ci-heal, and a fix still derives bugfix', () => {
    expect(taskTypeFor({ kind: 'ci-heal', cause: null, scopePaths: ['we:scripts/a.mjs'] }).taskType).toBe('ci-heal');
    expect(taskTypeFor({ kind: 'fix', cause: null, scopePaths: ['we:scripts/a.mjs'] }).taskType).toBe('bugfix');
  });
  it('the ci-heal envelope is smaller than bugfix', () => {
    expect(PROVEN_TASK_ENVELOPES['ci-heal']).toEqual({ maxLoc: 150, maxFiles: 3 });
  });
  it('the gate opens doc-fix, ci-heal and bugfix on probation, plus Codex features, but keeps conflict-resolution closed', () => {
    expect(CRITICAL_WORK_GATE.openForNonCritical).toMatchObject({ 'doc-fix': true, 'ci-heal': true, bugfix: true, 'build-new-feature': true, 'conflict-resolution': false });
  });
});

describe('selectProbationWorker', () => {
  it('rosters: doc-fix → agy-Claude + Codex; ci-heal → agy-Claude + Codex + agy-Gemini (simple only, Codex-checked); bugfix → Codex + agy Claude + simple Gemini', () => {
    expect(PROBATION_ROSTER['doc-fix']).toEqual(['antigravity-claude', 'codex']);
    expect(PROBATION_ROSTER['ci-heal']).toEqual(['antigravity-claude', 'codex', 'antigravity-gemini']);
    expect(PROBATION_WORKERS['antigravity-gemini']).toMatchObject({ simpleOnly: true, checker: 'codex', model: AGY_GEMINI_SIMPLE_MODEL });
    expect(PROBATION_ROSTER.bugfix).toEqual(['codex', 'antigravity-claude', 'antigravity-gemini']);
    expect(PROBATION_ROSTER['build-new-feature']).toEqual(['codex', 'antigravity-argon']);
    expect(PROBATION_ROSTER['conflict-resolution']).toBeUndefined();
  });

  it('with no history, picks the first roster worker, at the tier\'s agy Claude model, fully supervised', () => {
    const { worker } = selectProbationWorker({ taskType: 'ci-heal', filesTouched: ['scripts/a.mjs'] });
    expect(worker).toMatchObject({ id: 'antigravity-claude', provider: 'antigravity', model: 'claude-sonnet-4-6', executor: 'antigravity', supervision: 'full', review: 'full', runRating: 'required' });
    expect(selectProbationWorker({ taskType: 'ci-heal', tier: 'opus', filesTouched: ['scripts/a.mjs'] }).worker.model).toBe('claude-opus-4-6-thinking');
  });

  it('rotates to the worker with fewer trials — a launch row with no outcome counts as a trial, not a failure', () => {
    const scorecards = [row({ provider: 'antigravity', model: 'claude-sonnet-4-6', taskType: 'ci-heal', outcome: null, verifiedBy: null, dispatchKind: 'probation-launch' })];
    const { worker } = selectProbationWorker({ taskType: 'ci-heal', filesTouched: ['scripts/a.mjs'], scorecards });
    expect(worker.id).toBe('codex');
  });

  it('ranks a worker whose last judged trial was not clean after one whose was', () => {
    const scorecards = [
      row({ provider: 'antigravity', model: 'claude-sonnet-4-6', taskType: 'ci-heal', outcome: 'reworked', scoredAt: '2026-09-21T00:00:00Z' }),
      row({ provider: 'codex', model: CODEX_MODEL, taskType: 'ci-heal' }),
      row({ provider: 'codex', model: CODEX_MODEL, taskType: 'ci-heal', scoredAt: '2026-09-22T00:00:00Z' }),
    ];
    expect(selectProbationWorker({ taskType: 'ci-heal', filesTouched: ['scripts/a.mjs'], scorecards }).worker.id).toBe('codex');
  });

  it('offers agy-Gemini only for a simple task', () => {
    const both = [
      row({ provider: 'antigravity', model: 'claude-sonnet-4-6', taskType: 'ci-heal' }),
      row({ provider: 'codex', model: CODEX_MODEL, taskType: 'ci-heal' }),
    ];
    expect(selectProbationWorker({ taskType: 'ci-heal', filesTouched: ['a.mjs'], scorecards: both }).worker.id).not.toBe('antigravity-gemini');
    const simple = selectProbationWorker({ taskType: 'ci-heal', filesTouched: ['a.mjs'], scorecards: both, simple: true });
    expect(simple.worker).toMatchObject({ id: 'antigravity-gemini', checker: 'codex' });
  });

  it('a critical miss on the exact triple vetoes that worker', () => {
    const vetoes = [{ provider: 'antigravity', model: 'claude-sonnet-4-6', taskType: 'ci-heal' }];
    expect(selectProbationWorker({ taskType: 'ci-heal', filesTouched: ['a.mjs'], vetoes }).worker.id).toBe('codex');
  });

  it('refuses statute paths, a roster-less taskType, and a doc-fix outside its envelope', () => {
    expect(selectProbationWorker({ taskType: 'doc-fix', filesTouched: ['docs/agent/platform-decisions.md'] }).worker).toBeNull();
    expect(selectProbationWorker({ taskType: 'conflict-resolution', filesTouched: ['a.mjs'] }).worker).toBeNull();
    expect(selectProbationWorker({ taskType: 'doc-fix', filesTouched: ['a.md'], estimatedSize: 500 }).worker).toBeNull();
  });
});

describe('selectProvider — an opened roster taskType keeps Claude as the recommendation and adds the pick', () => {
  it('ci-heal, not critical: recommendation claude/sonnet, probationWorker agy-Claude', () => {
    const res = selectProvider({ taskType: 'ci-heal' }, { kind: 'ci-heal', filesTouched: ['scripts/a.mjs'], ...open });
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.claudeTier).toBe('sonnet');
    expect(res.probationWorker.id).toBe('antigravity-claude');
    expect(res.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('open-non-critical');
  });

  it('an EARNED Codex doc-fix record does not switch the recommendation — the pick still rides beside Claude', () => {
    const scorecards = [row({ provider: 'codex', model: CODEX_MODEL, taskType: 'doc-fix', verifiedBy: 'claude-subagent' })];
    const res = selectProvider({ taskType: 'doc-fix' }, { kind: 'build', filesTouched: ['docs/x.md'], estimatedSize: 40, scorecards, ...open });
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.auditTrail.find((a) => a.criterion === 'codex-fitness').result).toBe('fit');
    expect(res.probationWorker.id).toBe('antigravity-claude');
  });

  it('critical work, or no verdict at all, gets no probation worker', () => {
    const critical = selectProvider({ taskType: 'ci-heal' }, { kind: 'ci-heal', filesTouched: ['a.mjs'], criticalWork: { critical: true, reasons: [] }, criticalMisses: [] });
    expect(critical.probationWorker).toBeNull();
    const unknown = selectProvider({ taskType: 'ci-heal' }, { kind: 'ci-heal', filesTouched: ['a.mjs'] });
    expect(unknown.probationWorker).toBeNull();
  });

  it('default gate: non-critical bugfix starts with Codex on full-review probation; critical bugfix gets no pick', () => {
    const context = { kind: 'fix', filesTouched: ['a.mjs'], ...open };
    const res = selectProvider({ taskType: 'bugfix' }, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.probationWorker).toMatchObject({ id: 'codex', supervision: 'full', review: 'full', runRating: 'required' });
    expect(res.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('open-non-critical');

    const critical = selectProvider({ taskType: 'bugfix' }, { ...context, criticalWork: { critical: true, reasons: [] } });
    expect(critical.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(critical.probationWorker).toBeNull();
    expect(critical.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('claude-only');
  });

  it('default gate: non-critical build-new-feature starts with Codex on full-review probation; critical build-new-feature gets no pick', () => {
    const context = { kind: 'build', filesTouched: ['a.mjs'], ...open };
    const res = selectProvider({ taskType: 'build-new-feature' }, context);
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.probationWorker).toMatchObject({ id: 'codex', supervision: 'full', review: 'full', runRating: 'required' });
    expect(res.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('open-non-critical');

    const critical = selectProvider({ taskType: 'build-new-feature' }, { ...context, criticalWork: { critical: true, reasons: [] } });
    expect(critical.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(critical.probationWorker).toBeNull();
    expect(critical.auditTrail.find((a) => a.criterion === 'critical-work-gate').result).toBe('claude-only');
  });

  it('conflict-resolution stays closed — no pick', () => {
    const res = selectProvider({ taskType: 'conflict-resolution' }, { kind: 'fix', filesTouched: ['a.mjs'], ...open });
    expect(res.recommendation).toBe(RECOMMENDATIONS.CLAUDE);
    expect(res.probationWorker).toBeNull();
  });
});

describe('decideDispatchRoute carries the pick on the record', () => {
  it('a non-critical ci-heal: routed claude, probationWorker set; a `behind` heal may go to agy-Gemini once the others have trials', () => {
    const scope = ['we:scripts/operations/operator-queue.mjs'];
    const plain = decideDispatchRoute({ kind: 'ci-heal', scopePaths: scope });
    expect(plain).toMatchObject({ outcome: 'routed', taskType: 'ci-heal', routed: 'claude', tier: 'sonnet' });
    expect(plain.probationWorker.id).toBe('antigravity-claude');
    const scorecards = [
      row({ provider: 'antigravity', model: 'claude-sonnet-4-6', taskType: 'ci-heal' }),
      row({ provider: 'codex', model: CODEX_MODEL, taskType: 'ci-heal' }),
    ];
    expect(decideDispatchRoute({ kind: 'ci-heal', scopePaths: scope, reason: 'behind' }, { scorecards }).probationWorker.id).toBe('antigravity-gemini');
    expect(decideDispatchRoute({ kind: 'ci-heal', scopePaths: scope, reason: 'red-ci' }, { scorecards }).probationWorker.id).not.toBe('antigravity-gemini');
  });

  it('a critical ci-heal scope gets no pick', () => {
    const out = decideDispatchRoute({ kind: 'ci-heal', scopePaths: ['we:scripts/merge-ai-prs.mjs', 'we:scripts/lane-drain.mjs'] });
    expect(out.probationWorker).toBeNull();
  });

  it('an all-docs build (doc-fix) records a pick too', () => {
    const out = decideDispatchRoute({ kind: 'build', scopePaths: ['we:docs/guide.md'], size: 2 });
    expect(out.taskType).toBe('doc-fix');
    expect(out.probationWorker?.id).toBe('antigravity-claude');
  });
});


describe('test-fix probation (#4551)', () => {
  it('routes an all-test build or fix to Flash with the Codex checker without a simple flag', () => {
    for (const kind of ['build', 'fix']) {
      const filesTouched = ['scripts/__tests__/repair.test.mjs'];
      const { taskType } = taskTypeFor({ kind, scopePaths: filesTouched });
      expect(taskType).toBe('test-fix');
      const route = selectProvider({ taskType }, { kind, filesTouched, estimatedSize: 20, ...open });
      expect(route.probationWorker).toMatchObject({ id: 'antigravity-gemini', model: 'gemini-3.8-flash-high', checker: 'codex' });
      expect(decideDispatchRoute({ kind, scopePaths: filesTouched, size: 1 }).probationWorker).toMatchObject({
        id: 'antigravity-gemini', model: 'gemini-3.8-flash-high', checker: 'codex', taskType: 'test-fix',
      });
    }
  });
  it('refuses a mixed scope and retains the normal Claude route', () => {
    const filesTouched = ['scripts/a.test.mjs', 'scripts/a.mjs'];
    const route = selectProvider({ taskType: 'test-fix' }, { kind: 'build', filesTouched, ...open });
    expect(route.probationWorker).toBeNull();
    expect(route.recommendation).toBe('claude');
    expect(taskTypeFor({ kind: 'fix', scopePaths: filesTouched }).taskType).toBe('bugfix');
  });
});

// Operator decision 2026-09-30: exercise the real profile → verdict → probation pipeline.
describe('gate/approval-only critical scope', () => {
  it.each([
    'we:skills-src/conveyor/build-dispatch-daemon.mjs',
    'we:scripts/conveyor/tick-core.mjs',
    'we:scripts/operations/dispatch-lane-io.mjs',
    'we:scripts/conveyor/health-watch.mjs',
  ])('ordinary machinery %s gets Codex with full review', (path) => {
    const route = decideDispatchRoute({ kind: 'build', size: 2, scopePaths: [path] });
    expect(route.outcome).toBe('routed');
    expect(route.probationWorker).toMatchObject({ id: 'codex', review: 'full', supervision: 'full' });
  });

  it.each([
    'we:scripts/review-set-label.mjs', 'we:scripts/lib/review-core.mjs',
    'we:scripts/operations/review-pr.mjs', 'we:scripts/lib/advisory-labels.mjs',
    'we:scripts/merge-ai-prs.mjs', 'we:scripts/pr-land.mjs',
    'we:docs/agent/platform-decisions.md', 'we:AGENTS.md',
    'we:scripts/lib/critical-work.mjs', 'we:scripts/lib/provider-routing.mjs',
    'we:.github/branch-protection.json', 'we:.github/workflows/review-gate.yml',
    'we:scripts/lib/credentials.mjs',
    // PR #3124 review: the gate's own wiring/inputs, review-clearance code, harness config, and the drain.
    'we:scripts/lib/dispatch-contracts.mjs', 'we:scripts/lib/dispatch-thresholds.mjs',
    'we:scripts/conveyor/run-scorecard.mjs',
    'we:scripts/review-runner.mjs', 'we:scripts/lib/review-runner-core.mjs',
    'we:scripts/converge-daemon-pass.mjs', 'we:scripts/converge-daemon-install.mjs',
    'we:scripts/lib/review-label-provider.mjs', 'we:scripts/lib/review-loop-policy.mjs',
    'we:scripts/lib/review-skill-guard.mjs',
    'we:.claude/settings.json', 'we:.claude/skills/review/SKILL.md',
    'we:scripts/lib/__tests__/gate-invariants.test.mjs',
    'we:scripts/lib/__tests__/review-policy.conformance.test.mjs',
    'we:scripts/lib/__tests__/check-standards.conformance.test.mjs',
    'we:scripts/lane-drain.mjs',
    'plateau-app:tools/drain-daemon/cli.mjs', 'plateau-app:tools/drain-daemon/lib.mjs',
    'plateau-app:tools/drain-daemon/daemon.mjs',
  ])('protected surface %s stays Claude-only', (path) => {
    const route = decideDispatchRoute({ kind: 'build', size: 2, scopePaths: [path] });
    expect(route.outcome).toBe('routed');
    expect(route.routed).toBe('claude');
    expect(route.probationWorker).toBeNull();
  });

  it('ordinary bugfix plus tests is eligible despite derived correctness risk', () => {
    const route = decideDispatchRoute({ kind: 'fix', size: 2, scopePaths: ['we:scripts/conveyor/health-watch.mjs', 'we:scripts/conveyor/__tests__/health-watch.test.mjs'] });
    expect(route.probationWorker).toMatchObject({ id: 'codex', review: 'full' });
  });

  it.each([{ risk: 'high' }, { tags: ['security'] }])('preserves high-risk/security veto %j', (extra) => {
    const route = decideDispatchRoute({ kind: 'build', size: 2, scopePaths: ['we:skills-src/conveyor/build-dispatch-daemon.mjs'], ...extra });
    expect(route.outcome).toBe('routed');
    expect(route.probationWorker).toBeNull();
  });
});


describe('Argon probation builds', () => {
  const task = { taskType: 'build-new-feature' };
  const context = (extra = {}) => ({
    kind: 'build', filesTouched: ['a.mjs'], estimatedSize: 40, ...open,
    scorecards: [row({ provider: 'codex', model: CODEX_MODEL, taskType: task.taskType })],
    ...extra,
  });

  it('rotates an opened non-simple build to Argon with a Codex checker and full review', () => {
    expect(PROBATION_WORKERS['antigravity-argon']).toMatchObject({ simpleOnly: false });
    expect(selectProvider(task, context())).toMatchObject({
      recommendation: 'claude', probationWorker: {
        id: 'antigravity-argon', provider: 'antigravity', model: 'gemini-4-argon-high',
        executor: 'antigravity', launcher: 'scripts/gemini-direct-task.mjs', checker: 'codex',
        supervision: 'full', review: 'full', runRating: 'required',
      },
    });
  });

  it.each(['antigravity-argon', 'antigravity', 'codex'])('skips Argon when %s is held', (id) => {
    const res = selectProvider(task, context({ availability: { [id]: 'held' } }));
    expect(res.probationWorker?.id).not.toBe('antigravity-argon');
    expect(res.auditTrail).toContainEqual(expect.objectContaining({ criterion: 'probation-candidate:antigravity-argon', result: 'quota-held' }));
  });

  it('skips Argon when build.argon.enabled is off and records its source', () => {
    const res = selectProvider(task, context({ argonSettings: { value: { enabled: false, model: 'gemini-4-argon-high' }, sources: { enabled: 'tool', model: 'standard' } } }));
    expect(res.probationWorker?.id).toBe('codex');
    expect(res.auditTrail).toContainEqual(expect.objectContaining({ criterion: 'probation-candidate:antigravity-argon', result: 'disabled', dataConsulted: expect.stringContaining('tool') }));
  });

  it.each([
    { criticalWork: { critical: true, reasons: [] } },
    { criticalWork: undefined },
    { criticalMisses: undefined },
    { filesTouched: ['docs/agent/platform-decisions.md'] },
    { criticalMisses: [{ provider: 'antigravity', model: 'gemini-4-argon-high', taskType: task.taskType }] },
  ])('retains the critical, statute and exact-triple vetoes: %j', (extra) => {
    expect(selectProvider(task, context(extra)).probationWorker?.id).not.toBe('antigravity-argon');
  });
});


describe('build.argon settings cascade', () => {
  it('defaults enabled and logs standard sources', () => {
    const messages = [];
    const result = readBuildArgonSettings({ read: () => ({}), platform: {}, env: { WE_POLICY_CASCADE_LOG: '1' }, log: message => messages.push(message) });
    expect(result).toEqual({ value: { enabled: true, model: 'gemini-4-argon-high' }, sources: { enabled: 'standard', model: 'standard' } });
    expect(messages.join(' ')).toContain('argon.enabled=true (standard)');
  });

  it('resolves platform and tool independently per leaf, including the model used for routing', () => {
    const result = readBuildArgonSettings({
      read: () => ({ build: { argon: { model: 'gemini-4-argon-custom' } } }),
      platform: { argon: { enabled: false, model: 'gemini-4-argon-high' } }, env: {},
    });
    expect(result).toEqual({ value: { enabled: false, model: 'gemini-4-argon-custom' }, sources: { enabled: 'platform', model: 'tool' } });
    const enabled = { ...result, value: { ...result.value, enabled: true } };
    expect(selectProbationWorker({ taskType: 'build-new-feature', argonSettings: enabled,
      scorecards: [row({ provider: 'codex', model: CODEX_MODEL, taskType: 'build-new-feature' })],
    }).worker.model).toBe('gemini-4-argon-custom');
  });

  it('ignores invalid tool leaves and tolerates unreadable tool settings', () => {
    const platform = { argon: { enabled: false, model: 'gemini-4-argon-high' } };
    for (const read of [() => ({ build: { argon: { enabled: 'true', model: false } } }), () => { throw new Error('unreadable'); }]) {
      expect(readBuildArgonSettings({ read, platform, env: {} }).sources).toEqual({ enabled: 'platform', model: 'platform' });
    }
  });
});
