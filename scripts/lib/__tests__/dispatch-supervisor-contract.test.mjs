import { describe, it, expect } from 'vitest';
import * as s from '../dispatch-supervisor-contract.mjs';
import * as c from '../dispatch-contracts.mjs';

const supervisor = { provider: 'claude', model: 'claude-opus-5', sessionId: null };
const raw = (extra = {}) => ({ estimatedLoc: 30, filesTouched: ['docs/a.md'], acceptanceTestable: true, risk: 'low', dependsOn: [], ...extra });
const task = (id = 'a', deps = [], extra = {}) => ({ id, title: `Task ${id}`, dependsOn: deps, profile: raw({ dependsOn: deps }), ...extra });
const output = (tasks = [task()]) => ({ storyRef: '3383', round: 1, tasks });
const identity = (extra = {}) => ({ taskId: 'a', storyRef: '3383', round: 1, attempt: 1, mode: 'acting', supervisor, verifiedBy: 'other', storyTaskType: 'doc-fix', ...extra });
const verdictOutput = (extra = {}) => ({ verdict: 'accept', findings: [], newTasks: null, complete: null, ...extra });
const result = () => ({ ...identity(), authorRef: 'author', taskType: 'doc-fix', status: 'landed', provider: 'codex', model: 'gpt-6-astra', executor: 'codex-direct-task', supervisionLevel: 'full', sessionName: null, evidence: { pr: 1, tests: { command: 'test', passed: 1, failed: 0 } }, findings: [] });
const packet = (extra = {}) => ({ version: 1, phase: 'plan', mode: 'acting', storyRef: '3383', round: 1, supervisor: { provider: 'claude', model: 'claude-opus-5' }, story: { taskType: 'doc-fix', risk: 'low', complexity: 'S', estimatedLoc: 30, filesTouched: ['docs/a.md'], brief: 'Implement the story', acceptance: ['Works as described'] }, ...extra });
function strict(schema) {
  expect(Object.isFrozen(schema)).toBe(true);
  if (schema.type === 'object') {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    for (const property of Object.values(schema.properties)) strict(property);
  }
  if (schema.items) strict(schema.items);
}

describe('strict supervisor output schemas', () => {
  it('requires every property recursively and uses null for optional output', () => {
    strict(s.PLAN_OUTPUT_SCHEMA); strict(s.VERDICT_OUTPUT_SCHEMA);
    expect(s.PLAN_OUTPUT_SCHEMA.properties.tasks.items.properties.profile.properties).not.toHaveProperty('complexity');
    expect(s.VERDICT_OUTPUT_SCHEMA.properties.newTasks.type).toEqual(['array', 'null']);
    expect(s.VERDICT_OUTPUT_SCHEMA.properties.complete.type).toEqual(['boolean', 'null']);
    expect(JSON.stringify(s.PLAN_OUTPUT_SCHEMA)).not.toContain('taskType');
  });
  it('derives profiles, preserves a supervisor and initializes tasks', () => {
    const input = output([task('a', [], { profile: raw({ filesTouched: ['docs/agent/a.md'], estimatedLoc: 900, risk: 'low' }) })]);
    const before = JSON.stringify(input), out = s.planFromSupervisorOutput(input, { supervisor });
    expect(out.ok).toBe(true); expect(c.validatePlan(out.plan).ok).toBe(true);
    expect(out.plan.supervisor).toEqual(supervisor);
    expect(out.plan.tasks[0]).toMatchObject({ status: 'planned', agent: null, profile: { complexity: 'L', risk: 'high' } });
    expect(JSON.stringify(input)).toBe(before);
    const custom = s.planFromSupervisorOutput(output(), { supervisor, isStatutePath: path => path === 'docs/a.md' });
    expect(custom.plan.tasks[0].profile.risk).toBe('high');
  });
  it('rejects planner complexity, unknown fields, missing fields, cycles and bad profiles', () => {
    for (const input of [null, {}, { ...output(), extra: true }, { ...output(), round: 0 }, output([]), output([task('a', [], { complexity: 'S' })]), output([task('a', [], { profile: { ...raw(), complexity: 'S' } })]), output([task('a', [], { profile: raw({ estimatedLoc: 0 }) })]), output([task('a', ['b']), task('b', ['a'])]), output([task('a', ['missing'])])]) {
      expect(s.planFromSupervisorOutput(input, { supervisor })).toMatchObject({ ok: false, errors: expect.any(Array), plan: null });
    }
    expect(s.planFromSupervisorOutput(output()).ok).toBe(false);
    const missing = output(); delete missing.tasks[0].profile.risk;
    expect(s.planFromSupervisorOutput(missing, { supervisor }).ok).toBe(false);
  });
  it('builds verdict identity and new task profiles and drops nullable controls', () => {
    const out = s.verdictFromSupervisorOutput(verdictOutput({ newTasks: [task('new', [], { profile: raw({ estimatedLoc: 600 }) })] }), identity());
    expect(out.ok).toBe(true); expect(c.validateSupervisorVerdict(out.verdict).ok).toBe(true);
    expect(out.verdict.newTasks[0]).toMatchObject({ profile: { complexity: 'L', risk: 'medium' }, status: 'planned', agent: null });
    expect(s.verdictFromSupervisorOutput(verdictOutput(), identity()).verdict).not.toHaveProperty('complete');
    expect(s.verdictFromSupervisorOutput(verdictOutput({ complete: true }), identity()).verdict.complete).toBe(true);
    for (const input of [null, {}, { ...verdictOutput(), extra: true }, verdictOutput({ verdict: 'bad' }), verdictOutput({ newTasks: [task('a', [], { profile: { ...raw(), complexity: 'S' } })] })]) expect(s.verdictFromSupervisorOutput(input, identity()).ok).toBe(false);
  });
  it('rejects shadow actions while allowing null or inert output controls', () => {
    const id = identity({ mode: 'shadow' });
    for (const input of [verdictOutput({ newTasks: [task()] }), verdictOutput({ complete: true })]) expect(s.verdictFromSupervisorOutput(input, id).errors).toContain('shadow verdicts cannot act');
    for (const input of [verdictOutput(), verdictOutput({ newTasks: [], complete: false })]) {
      const out = s.verdictFromSupervisorOutput(input, id);
      expect(out.ok).toBe(true); expect(out.verdict).not.toHaveProperty('newTasks'); expect(out.verdict).not.toHaveProperty('complete');
    }
  });
});

describe('context packets and invocation evidence', () => {
  it('accepts plan and verdict packets with bounded free text', () => {
    expect(s.SUPERVISOR_CONTEXT_PACKET_VERSION).toBe(1);
    expect(s.validateContextPacket(packet())).toEqual({ ok: true, errors: [] });
    expect(s.validateContextPacket(packet({ tasks: s.planFromSupervisorOutput(output(), { supervisor }).plan.tasks })).ok).toBe(true);
    expect(s.validateContextPacket(packet({ phase: 'verdict', mode: 'shadow', results: [result()] })).ok).toBe(true);
    expect(s.validateContextPacket(packet({ story: { ...packet().story, brief: 'x'.repeat(20000) } })).ok).toBe(true);
  });
  it('rejects wrong phases, provenance, identities, story profiles and free text', () => {
    for (const extra of [{ version: 2 }, { phase: 'bad' }, { mode: 'bad' }, { storyRef: 'a-b' }, { round: 0 }, { supervisor: null }, { supervisor: { provider: 'both', model: 'm' } }, { supervisor: { provider: 'codex', model: '' } }, { story: null }, { results: [] }, { phase: 'verdict' }, { phase: 'verdict', results: [] }, { phase: 'verdict', results: [null] }, { phase: 'verdict', results: [{ ...result(), storyRef: '42' }] }, { tasks: {} }, { tasks: [null] }]) expect(s.validateContextPacket(packet(extra)).ok).toBe(false);
    for (const extra of [{ brief: 'x'.repeat(20001) }, { brief: null }, { acceptance: 'yes' }, { acceptance: [1] }, { complexity: 'L' }, { risk: 'bad' }, { taskType: 'bad' }, { estimatedLoc: 0 }, { filesTouched: [] }]) expect(s.validateContextPacket(packet({ story: { ...packet().story, ...extra } })).ok).toBe(false);
  });
  it('records three backends and distinguishes unverified execution claims', () => {
    expect(Object.keys(s.SUPERVISOR_INVOCATIONS).sort()).toEqual(['agy', 'claude-native', 'codex']);
    for (const [backend, invocation] of Object.entries(s.SUPERVISOR_INVOCATIONS)) {
      expect(s.supervisorBackendFor(backend)).toBe(invocation);
      expect(invocation).toMatchObject({ inputPacket: 'context-packet', output: 'schema-constrained-json' });
      expect(Object.isFrozen(invocation)).toBe(true); expect(Object.isFrozen(invocation.verification)).toBe(true);
      for (const [key, status] of Object.entries(invocation.verification)) if (key !== 'note') expect(['verified-in-repo', 'verified-by-help-output', 'UNVERIFIED']).toContain(status);
    }
    expect(s.SUPERVISOR_INVOCATIONS.agy.verification).toMatchObject({ schemaFlag: 'verified-by-help-output', modeFlag: 'verified-by-help-output', planPreventsWriteToolError: 'UNVERIFIED', schemaMakesToolFree: 'UNVERIFIED' });
    expect(s.SUPERVISOR_INVOCATIONS.agy.verification.note).toContain('write_to_file');
    expect(s.SUPERVISOR_INVOCATIONS.agy.verification.note).toContain('PR 2223');
    expect(s.SUPERVISOR_INVOCATIONS['claude-native'].verification.toolFreeSupervisorRound).toBe('UNVERIFIED');
    expect(s.SUPERVISOR_INVOCATIONS.codex.extraFlags).toEqual(['exec', '--json', '-s read-only']);
    expect(s.SUPERVISOR_INVOCATIONS.codex.toolPosture).toBe('read-only shell (not tool-free)');
    for (const backend of [null, {}, 'constructor', 'missing']) expect(s.supervisorBackendFor(backend)).toBeNull();
  });
  it('never throws on hostile, malformed or cyclic inputs', () => {
    const cyclic = {}; cyclic.tasks = [cyclic];
    const hostile = new Proxy({}, { get() { throw Error('hostile'); } });
    for (const input of [null, [], 3, cyclic, hostile]) {
      expect(s.validateContextPacket(input)).toMatchObject({ ok: false, errors: expect.any(Array) });
      expect(s.planFromSupervisorOutput(input, { supervisor })).toMatchObject({ ok: false, plan: null });
      expect(s.verdictFromSupervisorOutput(input, identity())).toMatchObject({ ok: false, verdict: null });
    }
    expect(s.planFromSupervisorOutput(output(), null).ok).toBe(false);
    expect(s.verdictFromSupervisorOutput(verdictOutput(), null).ok).toBe(false);
  });
});

it('#3996 validates and routes planner JSON without a declared task type', () => {
  for (const [file, taskType] of [['docs/a.md', 'doc-fix'], ['scripts/a.mjs', 'build-new-feature'], ['scripts/a.test.mjs', 'test-fix']]) {
    const input = output([task('a', [], { profile: raw({ filesTouched: [file], risk: 'high' }) })]);
    const parsed = s.planFromSupervisorOutput(input, { supervisor });
    expect(parsed.ok).toBe(true);
    const profile = parsed.plan.tasks[0].profile;
    expect(profile).toMatchObject({ taskType, risk: 'high' });
    const routed = c.decideDispatchRoute({ kind: 'build', cause: 'planned', scopePaths: profile.filesTouched,
      estimatedLoc: profile.estimatedLoc, sizeSource: 'plan', risk: profile.risk });
    expect(routed).toMatchObject({ taskType, sizeSource: 'plan', sized: true });
    expect(s.planFromSupervisorOutput(output([task('a', [], { profile: raw({ taskType }) })]), { supervisor }).ok).toBe(false);
  }
});
