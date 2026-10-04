import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as c from '../dispatch-contracts.mjs';
import { PROVEN_TASK_ENVELOPES } from '../provider-routing.mjs';

const profile = (extra = {}) => c.buildDispatchProfile({ taskType: 'doc-fix', estimatedLoc: 30, filesTouched: ['docs/readme.md'], acceptanceTestable: true, dependsOn: [], ...extra }).profile;
const task = (id = 'a', dependsOn = [], paths = [`docs/${id}.md`]) => ({ agent: null, status: 'planned', id, title: `Task ${id}`, dependsOn, profile: profile({ dependsOn, filesTouched: paths }) });
const plan = (tasks = [task()]) => ({ storyRef: 'we#3383', round: 1, supervisor: { provider: 'claude', model: 'claude-opus-5', sessionId: null }, tasks });
const execution = (extra = {}) => ({ authorRef: 'author', supervisionLevel: 'full', supervisor: { provider: 'claude', model: 'claude-opus-5', sessionId: 'supervisor' }, sessionName: null, taskId: 'a', storyRef: 'we#3383', round: 1, attempt: 1, taskType: 'doc-fix', status: 'landed', provider: 'codex', model: 'gpt-5', executor: 'codex-direct-task', evidence: { sha: 'abcdef0', tests: { command: 'vitest', passed: 1, failed: 0 } }, findings: [], ...extra });
const verdict = (extra = {}) => ({ mode: 'acting', storyTaskType: 'doc-fix', supervisor: { provider: 'claude', model: 'claude-opus-5', sessionId: 'supervisor' }, taskId: 'a', storyRef: 'we#3383', round: 1, attempt: 1, verdict: 'accept', findings: [], verifiedBy: 'independent-claude', ...extra });

describe('closed contracts and pure boundary', () => {
  it('freezes every vocabulary and derives task types from router envelopes', () => {
    expect(c.TASK_TYPES).toEqual([...Object.keys(PROVEN_TASK_ENVELOPES), 'triage-research', 'architectural-decision']);
    for (const key of ['TASK_TYPES', 'RISKS', 'COMPLEXITIES', 'TASK_STATUSES', 'VERDICTS', 'VERIFIED_BY', 'GRADUATION_VERIFIERS', 'PROVIDERS', 'EXECUTORS', 'EXECUTOR_PROVIDERS', 'STORY_KINDS', 'ROUTE_STAGES', 'SIZE_TO_ESTIMATED_LOC', 'TASK_TYPE_BY_CARD_KIND', 'RUNG_KINDS', 'TASK_LIFECYCLE', 'VERDICT_MODES', 'CLAUDE_NATIVE_MODEL_BY_TIER', 'GROUND_TRUTH_KINDS']) expect(Object.isFrozen(c[key]), key).toBe(true);
    Object.values(c.EXECUTOR_PROVIDERS).forEach((v) => expect(Object.isFrozen(v)).toBe(true));
    expect(c.RISKS).toEqual(['low', 'medium', 'high']);
    expect(c.COMPLEXITIES).toEqual(['S', 'M', 'L']);
    expect(c.TASK_STATUSES).toEqual(['landed', 'blocked', 'failed']);
    expect(c.VERDICTS).toEqual(['accept', 'rework', 'reject']);
    expect(c.PROVIDERS).not.toContain('both');
    for (const type of c.TASK_TYPES) expect(c.isTaskType(type)).toBe(true);
    for (const value of [null, [], 'constructor', 1]) expect(c.isTaskType(value)).toBe(false);
  });
  it('has only allowed imports, annotated exports and no impure primitives', () => {
    const source = readFileSync('scripts/lib/dispatch-contracts.mjs', 'utf8');
    for (const forbidden of ['node:fs', 'Date.now', 'new Date', 'process.env', 'Math.random']) expect(source).not.toContain(forbidden);
    // #3717 added `./dispatch-task-type.mjs` — the `taskType` derivation `decideDispatchRoute` composes with
    // `routeDispatch`. It is import-free, so the allow-list's real property (this module reaches nothing
    // impure) is unchanged.
    // #4034 added `./critical-work.mjs` — the critical-work verdict and critical-miss vetoes `routeDispatch` hands
    // the provider cascade. It composes deriveRisk (here), NEVER_SPOT_CHECK_PATH_PREFIXES and gate-config's pure
    // path predicates, and is itself free of the forbidden primitives (its own test pins that).
    expect([...source.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['./provider-routing.mjs', './secret-scrub.mjs', './dispatch-thresholds.mjs', './codex-model-routing.mjs', './dispatch-task-type.mjs', './critical-work.mjs']);
    const lines = source.split('\n');
    // See the sibling assertion below for why three annotations are accepted since #3717 wired slice G2 and
    // #3887 added a second real runtime caller outside that wiring (review-dispatch.mjs).
    const G1 = '// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)';
    const G2 = '// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)';
    const G3 = '// @wired-by-3887: has a runtime caller — scripts/operations/review-dispatch.mjs#reviewSeatRoutes';
    for (let i = 0; i < lines.length; i++) if (lines[i].startsWith('export ')) expect([G1, G2, G3]).toContain(lines[i - 1]);
  });
  it('all validators fail closed on arbitrary and cyclic input', () => {
    const cyclic = {}; cyclic.self = cyclic;
    const hostile = new Proxy({}, { get() { throw Error('hostile'); } });
    for (const validate of [c.validateDispatchProfile, c.validateTaskShape, c.validatePlan, c.validateTaskResult, c.validateSupervisorVerdict]) {
      for (const input of [null, undefined, [], 'x', 7, cyclic, hostile]) {
        expect(() => validate(input)).not.toThrow();
        expect(validate(input)).toMatchObject({ ok: false, errors: expect.any(Array) });
      }
    }
    const cyclicTask = task(); cyclicTask.profile = cyclicTask;
    expect(c.validateTaskShape(cyclicTask).ok).toBe(false);
    expect(c.gradeGraduation(hostile, hostile).ok).toBe(false);
  });
});

describe('path helpers', () => {
  it.each(['a', 'scripts/lib/', 'docs/a.md'])('accepts path %s', (p) => expect(c.isRepoRelativePath(p)).toBe(true));
  it.each(['', ' ', '/a', './a', 'a/../b', '..', 'a\\b', 'a\0b', 'https:a', 'C:a', null, 4])('rejects path %s', (p) => expect(c.isRepoRelativePath(p)).toBe(false));
  it('uses directory segment boundaries', () => {
    for (const [a, b] of [['scripts/lib', 'scripts/lib/a'], ['scripts/lib/', 'scripts/lib/a'], ['a/', 'a'], ['a', 'a']]) {
      expect(c.pathsOverlap(a, b)).toBe(true); expect(c.pathsOverlap(b, a)).toBe(true);
    }
    expect(c.pathsOverlap('scripts/lib', 'scripts/library/a')).toBe(false);
    expect(c.pathsOverlap(null, 'a')).toBe(false);
  });

});

describe('plans and parallel eligibility', () => {
  it('accepts valid plans, standalone external dependencies, and reordered dependency sets', () => {
    expect(c.validatePlan(plan()).ok).toBe(true);
    expect(c.validateTaskShape(task('a', ['external'])).ok).toBe(true);
    const t = task('a', ['b', 'c']); t.profile.dependsOn.reverse();
    expect(c.validateTaskShape(t).ok).toBe(true);
  });
  it.each([
    ['storyRef', 'bad ref'], ['round', 0], ['round', 1.5], ['tasks', []], ['tasks', {}],
  ])('rejects plan field %s', (field, value) => expect(c.validatePlan({ ...plan(), [field]: value }).ok).toBe(false));
  it.each([
    ['id', 'bad/id'], ['title', ' '], ['title', 'x'.repeat(201)], ['dependsOn', ['a']], ['dependsOn', ['b', 'b']], ['dependsOn', [1]], ['profile', null], ['dependsOn', ['b']],
  ])('rejects task field %s', (field, value) => expect(c.validateTaskShape({ ...task(), [field]: value }).ok).toBe(false));
  it('reports duplicate ids, unknown dependencies and self-dependencies', () => {
    expect(c.validatePlan(plan([task(), task()])).errors.join()).toContain('duplicate task id: a');
    expect(c.validatePlan(plan([task('a', ['b'])])).errors.join()).toContain('unknown dependency: b');
    expect(c.validatePlan(plan([task('a', ['a'])])).errors.join()).toContain('self dependency');
  });
  it('reports two- and three-member cycles in plan order, excluding dependent tails', () => {
    expect(c.validatePlan(plan([task('a', ['b']), task('b', ['a'])])).errors).toContain('dependency cycle: a -> b -> a');
    expect(c.validatePlan(plan([task('a', ['c']), task('b', ['a']), task('c', ['b']), task('d', ['a'])])).errors).toContain('dependency cycle: a -> b -> c -> a');
  });
  it('validates a 500-task chain without recursion', () => {
    const tasks = Array.from({ length: 500 }, (_, i) => task(`t${i}`, i ? [`t${i - 1}`] : []));
    expect(c.validatePlan(plan(tasks))).toEqual({ ok: true, errors: [] });
    expect(c.computeParallelEligible(plan(tasks))).toEqual({ ok: true, pairs: [] });
  });
  it('pairs only independent disjoint scopes, excluding transitive paths', () => {
    const p = plan([task('a'), task('b', ['a']), task('c', ['b']), task('d')]);
    expect(c.computeParallelEligible(p)).toEqual({ ok: true, pairs: [['a', 'd'], ['b', 'd'], ['c', 'd']] });
    for (const path of ['scripts/lib', 'scripts/lib/', 'scripts/lib/a.mjs']) {
      expect(c.computeParallelEligible(plan([task('a', [], [path]), task('b', [], ['scripts/lib/a.mjs'])])).pairs).toEqual([]);
    }
    expect(c.computeParallelEligible(plan([task('a', [], ['scripts/lib']), task('b', [], ['scripts/library'])])).pairs).toEqual([['a', 'b']]);
    expect(c.computeParallelEligible(plan([task('a', ['unknown'])])).ok).toBe(false);
  });
});

describe('result evidence and supervisor verdicts', () => {
  it('accepts valid outcomes and executor/provider pairs', () => {
    for (const [executor, providers] of Object.entries(c.EXECUTOR_PROVIDERS)) for (const provider of providers) expect(c.validateTaskResult(execution({ executor, provider })).ok).toBe(true);
    for (const status of ['blocked', 'failed']) expect(c.validateTaskResult(execution({ status, evidence: {} })).ok).toBe(true);
    expect(c.validateTaskResult(execution({ evidence: { pr: 1, tests: { command: 'test', passed: 0, failed: 0 } } })).ok).toBe(true);
    for (const v of ['accept', 'reject']) expect(c.validateSupervisorVerdict(verdict({ verdict: v, findings: ['finding'], newTasks: [task('new', ['external'])] })).ok).toBe(true);
    expect(c.validateSupervisorVerdict(verdict({ complete: true })).ok).toBe(true);
    expect(c.validateSupervisorVerdict(verdict({ verdict: 'rework', findings: ['fix this'] })).ok).toBe(true);
  });
  it.each([
    ['taskId', 'bad/id'], ['storyRef', 'bad ref'], ['round', 0], ['attempt', undefined], ['attempt', 1.5], ['taskType', 'made-up'], ['status', 'done'], ['provider', 'both'], ['model', ' '], ['executor', 'other'], ['executor', 'claude-session'], ['findings', ['']], ['findings', ['x'.repeat(2001)]], ['findings', {}], ['evidence', null],
  ])('rejects result field %s', (key, value) => expect(c.validateTaskResult(execution({ [key]: value })).ok).toBe(false));
  it.each([
    {}, { sha: 'ABCDEF0' }, { sha: 'abcdef' }, { sha: 'a'.repeat(41) }, { pr: 0 }, { pr: 1.5 }, { tests: null },
    { pr: 1, tests: { command: '', passed: 1, failed: 0 } },
    { pr: 1, tests: { command: 'test', passed: -1, failed: 0 } },
    { pr: 1, tests: { command: 'test', passed: 1, failed: 0.5 } },
    { pr: 1, tests: { command: 'test', passed: 1, failed: 1 } },
  ])('rejects contradictory or malformed evidence %j', (evidence) => expect(c.validateTaskResult(execution({ evidence })).ok).toBe(false));
  it('validates optional evidence even for blocked/failed outcomes', () => {
    for (const status of ['blocked', 'failed']) {
      expect(c.validateTaskResult(execution({ status, evidence: { sha: 'oops' } })).ok).toBe(false);
      expect(c.validateTaskResult(execution({ status, evidence: { tests: { command: 'test', passed: 0, failed: 1 } } })).ok).toBe(true);
    }
  });
  it.each([
    ['taskId', ''], ['storyRef', 'bad ref'], ['round', -1], ['attempt', 0], ['verdict', 'done'], ['verifiedBy', 'self'], ['findings', [2]], ['findings', null], ['newTasks', {}], ['newTasks', [null]], ['complete', 'yes'],
  ])('rejects verdict field %s', (key, value) => expect(c.validateSupervisorVerdict(verdict({ [key]: value })).ok).toBe(false));
  it('enforces findings and newTasks/complete control combinations', () => {
    for (const v of ['rework', 'reject']) {
      expect(c.validateSupervisorVerdict(verdict({ verdict: v })).ok).toBe(false);
      expect(c.validateSupervisorVerdict(verdict({ verdict: v, findings: ['fix'], complete: true })).ok).toBe(false);
    }
    expect(c.validateSupervisorVerdict(verdict({ newTasks: [], complete: true })).ok).toBe(false);
    expect(c.validateSupervisorVerdict(verdict({ verdict: 'rework', findings: ['fix'], newTasks: [] })).ok).toBe(false);
    expect(c.validateSupervisorVerdict(verdict({ verdict: 'rework', findings: ['fix'], complete: false })).ok).toBe(false);
  });
});


describe('session names and new provenance fields', () => {
  it('round trips unambiguous session names', () => {
    for (const storyRef of ['3383', 'x4e6oux', 'we#3383', 'a.b_c']) for (const taskId of ['t1', 'build-tests.v2', 'a-b-c']) for (const round of [1, 2, 10]) {
      const key = { storyRef, taskId, round };
      expect(c.parseTaskSessionName(c.taskSessionName(key))).toEqual(key);
    }
    for (const name of ['', 't-', 't-3383-r0-a', 't-3383-r01-a', 't-a-b-r1-c', 1, null, '3383-r1-a', 't-x-r9007199254740992-a']) expect(c.parseTaskSessionName(name)).toBeNull();
    for (const key of [null, {}, { storyRef: 'a-b', round: 1, taskId: 'a' }, { storyRef: 'a/b', round: 1, taskId: 'a' }, { storyRef: 'a', round: 0, taskId: 'a' }, { storyRef: 'a', round: 1, taskId: '/' }]) expect(c.taskSessionName(key)).toBeNull();
  });
  it('checks result fields, null sessions and exact identity', () => {
    expect(c.validateTaskResult(execution({ sessionName: 't-we#3383-r1-a' })).ok).toBe(true);
    for (const [field, value] of [['authorRef', ''], ['supervisionLevel', 'none'], ['sessionName', undefined], ['sessionName', 't-we#3383-r2-a'], ['storyRef', 'a-b'], ['storyRef', 'a/b'], ['supervisor', null]]) expect(c.validateTaskResult(execution({ [field]: value })).ok).toBe(false);
    expect(c.validateTaskResult(execution({ supervisionLevel: 'spot-check', supervisor: { provider: 'codex', model: 'm', sessionId: null } })).ok).toBe(true);
    for (const supervisor of [{ provider: 'both', model: 'm', sessionId: null }, { provider: 'codex', model: '', sessionId: null }, { provider: 'codex', model: 'm' }, { provider: 'codex', model: 'm', sessionId: '' }]) {
      expect(c.validateTaskResult(execution({ supervisor })).ok).toBe(false);
      expect(c.validateSupervisorVerdict(verdict({ supervisor })).ok).toBe(false);
      expect(c.validatePlan({ ...plan(), supervisor }).ok).toBe(false);
    }
  });
  it('checks lifecycle and routed agents', () => {
    for (const status of c.TASK_LIFECYCLE) expect(c.validateTaskShape({ ...task(), status }).ok).toBe(true);
    const agent = { provider: 'codex', model: 'm', executor: 'codex-direct-task', supervisionLevel: 'full', sessionName: 't-we#3383-r1-a' };
    expect(c.validatePlan(plan([{ ...task(), agent }])).ok).toBe(true);
    expect(c.validatePlan(plan([{ ...task(), agent: { ...agent, provider: 'both', model: null, executor: null, sessionName: null } }])).ok).toBe(true);
    for (const [key, value] of [['provider', 'x'], ['model', null], ['executor', 'x'], ['supervisionLevel', 'x'], ['sessionName', 't-we#3383-r2-a']]) expect(c.validatePlan(plan([{ ...task(), agent: { ...agent, [key]: value } }])).ok).toBe(false);
    for (const extra of [{ status: 'x' }, { agent: undefined }, { complexity: 'S' }, { risk: 'low' }]) expect(c.validateTaskShape({ ...task(), ...extra }).ok).toBe(false);
  });
  it('makes shadow verdicts inert and validates the new fields', () => {
    const shadow = verdict({ mode: 'shadow' });
    expect(c.validateSupervisorVerdict(shadow).ok).toBe(true);
    for (const extra of [{ newTasks: [] }, { complete: false }, { newTasks: [task()], complete: true }]) {
      expect(c.validateSupervisorVerdict({ ...shadow, ...extra }).errors).toContain('shadow verdicts cannot act');
      expect(c.verdictEffects({ ...shadow, ...extra })).toEqual({ acted: false, newTasks: [], complete: false });
    }
    expect(c.verdictEffects(verdict({ newTasks: [task()] }))).toEqual({ acted: true, newTasks: [task()], complete: false });
    expect(c.verdictEffects(verdict({ complete: true }))).toEqual({ acted: true, newTasks: [], complete: true });
    for (const odd of [null, {}, [], { mode: 'acting' }]) expect(c.verdictEffects(odd)).toEqual({ acted: false, newTasks: [], complete: false });
    for (const extra of [{ mode: 'x' }, { storyTaskType: 'x' }, { supervisorRef: 'old' }]) expect(c.validateSupervisorVerdict(verdict(extra)).ok).toBe(false);
  });
  it('keeps every dispatch module pure with annotated exports', () => {
    for (const name of ['dispatch-contracts', 'dispatch-thresholds', 'dispatch-supervisor-contract', 'dispatch-supervision-tree']) {
      const source = readFileSync(`scripts/lib/${name}.mjs`, 'utf8');
      for (const forbidden of ['node:fs', 'Date.now', 'new Date', 'process.env', 'Math.random']) expect(source).not.toContain(forbidden);
      const lines = source.split('\n');
      // #3717 WIRED SLICE G2, so "no runtime caller" stopped being true for part of this module. #3887 added a
      // second real runtime caller outside that wiring. The rule the test is FOR is unchanged — every export
      // is annotated with why it exists — so it now accepts any of three annotations: the G1 one (still exact,
      // still the default), the G2 one (the G2 dispatcher wiring), or the G3 one (review-dispatch.mjs).
      const G1 = '// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)';
      const G2 = '// @wired-by-3717: has a runtime caller — the G2 dispatcher wiring (see `decideDispatchRoute`)';
      const G3 = '// @wired-by-3887: has a runtime caller — scripts/operations/review-dispatch.mjs#reviewSeatRoutes';
      lines.forEach((line, i) => { if (line.startsWith('export ')) expect([G1, G2, G3]).toContain(lines[i - 1]); });
    }
  });
});

it('#3996 preserves plan size provenance for a planned build', () => {
  const dispatch = { kind: 'build', cause: 'planned', scopePaths: ['scripts/a.mjs'], sizeSource: 'plan' };
  expect(c.decideDispatchRoute({ ...dispatch, estimatedLoc: 42 })).toMatchObject({ sizeSource: 'plan', sized: true, estimatedLoc: 42 });
  expect(c.decideDispatchRoute({ ...dispatch, size: 2 })).toMatchObject({ sizeSource: 'plan', sized: true, estimatedLoc: 80 });
  for (const extra of [{}, { size: 4 }, { estimatedLoc: 0 }, { estimatedLoc: -1 }, { estimatedLoc: '42' }]) {
    expect(c.decideDispatchRoute({ ...dispatch, ...extra }).outcome).toBe('refused');
  }
});

// The planner only ever emits planned `build` tasks (`dispatch-supervisor-contract.mjs#buildTasks`). A caller-supplied
// `sizeSource: 'plan'` on a repair kind would otherwise skip `resolveFixSize` and turn a repair that defaults to the
// largest band into a small, in-envelope one.
it.each([
  ['fix', 'planned'], ['ci-heal', 'planned'], ['fix', 'conflict'], ['ci-heal', 'ci-failure'], ['build', 'conflict'], ['build', 'review-finding'],
])('#3996 refuses a caller-supplied plan size for %s / %s', (kind, cause) => {
  const routed = c.decideDispatchRoute({ kind, cause, scopePaths: ['scripts/a.mjs'], sizeSource: 'plan', estimatedLoc: 1 });
  expect(routed).toMatchObject({ outcome: 'refused', sized: null, sizeSource: null });
  expect(routed.refusal).toMatch(/plan/);
});
