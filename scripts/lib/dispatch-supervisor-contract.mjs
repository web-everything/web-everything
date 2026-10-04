/** Supervisor invocation contracts as data only; nothing here launches a process. */
import { RISKS, VERDICTS, PROVIDERS, VERDICT_MODES, buildDispatchProfile,
  validateDispatchProfile, validateTaskShape, validateTaskResult, validatePlan,
  validateSupervisorVerdict, taskSessionName } from './dispatch-contracts.mjs';

import { taskTypeFor } from './dispatch-task-type.mjs';

const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.trim().length > 0;
const stringArray = x => Array.isArray(x) && Array.from(x).every(v => typeof v === 'string');
function freeze(x) { if (object(x) || Array.isArray(x)) { Object.values(x).forEach(freeze); Object.freeze(x); } return x; }
const schemaObject = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string' }, arr = { type: 'array', items: str };
const taskSchema = schemaObject({ id: str, title: str, dependsOn: arr, profile: schemaObject({
  estimatedLoc: { type: 'integer', minimum: 1 }, filesTouched: arr,
  acceptanceTestable: { type: 'boolean' }, risk: { type: 'string', enum: [...RISKS] }, dependsOn: arr,
}) });
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const SUPERVISOR_CONTEXT_PACKET_VERSION = 1;
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const PLAN_OUTPUT_SCHEMA = freeze(schemaObject({ storyRef: str, round: { type: 'integer', minimum: 1 }, tasks: { type: 'array', minItems: 1, items: taskSchema } }));
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const VERDICT_OUTPUT_SCHEMA = freeze(schemaObject({ verdict: { type: 'string', enum: [...VERDICTS] }, findings: arr,
  newTasks: { type: ['array', 'null'], items: taskSchema }, complete: { type: ['boolean', 'null'] } }));

// A small validator for the closed schema subset above also enforces the boundary
// when a caller supplies JSON without using a schema-constrained transport.
function schemaErrors(value, schema, path = 'output') {
  const errors = [], types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = type => type === 'null' ? value === null : type === 'object' ? object(value)
    : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isInteger(value) : typeof value === type;
  if (!types.some(matches)) return [`${path}: invalid type`];
  if (value === null) return errors;
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: invalid enum value`);
  if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum`);
  if (object(value)) {
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) errors.push(`${path}.${key}: unexpected property`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, child] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], child, `${path}.${key}`));
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push(`${path}: too few items`);
    for (const [i, item] of value.entries()) errors.push(...schemaErrors(item, schema.items, `${path}[${i}]`));
  }
  return errors;
}
function buildTasks(tasks, options, errors) {
  return tasks.map((task, i) => {
    const derived = taskTypeFor({ kind: 'build', cause: 'planned', scopePaths: task.profile.filesTouched });
    const built = buildDispatchProfile({ ...task.profile, taskType: derived.taskType }, options);
    errors.push(...built.errors.map(e => `tasks[${i}]: ${e}`));
    return { id: task.id, title: task.title, dependsOn: [...task.dependsOn], profile: built.profile, agent: null, status: 'planned' };
  });
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function planFromSupervisorOutput(output, options = {}) {
  try {
    const errors = schemaErrors(output, PLAN_OUTPUT_SCHEMA);
    if (errors.length) return { ok: false, errors, plan: null };
    const tasks = buildTasks(output.tasks, options, errors);
    const plan = { storyRef: output.storyRef, round: output.round, supervisor: object(options.supervisor) ? { ...options.supervisor } : options.supervisor, tasks };
    errors.push(...validatePlan(plan, options).errors);
    return { ok: !errors.length, errors, plan: errors.length ? null : plan };
  } catch { return { ok: false, errors: ['unreadable supervisor output'], plan: null }; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function verdictFromSupervisorOutput(output, identity) {
  try {
    const errors = schemaErrors(output, VERDICT_OUTPUT_SCHEMA);
    if (errors.length) return { ok: false, errors, verdict: null };
    if (identity?.mode === 'shadow' && (output.newTasks?.length || output.complete === true)) errors.push('shadow verdicts cannot act');
    const verdict = { taskId: identity.taskId, storyRef: identity.storyRef, round: identity.round, attempt: identity.attempt,
      mode: identity.mode, supervisor: object(identity.supervisor) ? { ...identity.supervisor } : identity.supervisor,
      verifiedBy: identity.verifiedBy, storyTaskType: identity.storyTaskType, verdict: output.verdict, findings: [...output.findings] };
    if (identity.mode !== 'shadow') {
      if (output.newTasks !== null) verdict.newTasks = buildTasks(output.newTasks, {}, errors);
      if (output.complete !== null) verdict.complete = output.complete;
    }
    errors.push(...validateSupervisorVerdict(verdict).errors);
    return { ok: !errors.length, errors, verdict: errors.length ? null : verdict };
  } catch { return { ok: false, errors: ['unreadable supervisor output'], verdict: null }; }
}
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function validateContextPacket(packet, opts = {}) {
  try {
    if (!object(packet)) return { ok: false, errors: ['packet must be an object'] };
    const errors = [], check = (ok, message) => { if (!ok) errors.push(message); };
    check(packet.version === SUPERVISOR_CONTEXT_PACKET_VERSION, 'version is invalid');
    check(['plan', 'verdict'].includes(packet.phase), 'phase is invalid');
    check(VERDICT_MODES.includes(packet.mode), 'mode is invalid');
    check(taskSessionName({ storyRef: packet.storyRef, round: packet.round, taskId: 'packet' }) !== null, 'story identity is invalid');
    check(object(packet.supervisor) && PROVIDERS.includes(packet.supervisor.provider) && text(packet.supervisor.model), 'supervisor is invalid');
    if (!object(packet.story)) errors.push('story is invalid');
    else {
      const story = packet.story;
      // Packet text is supervisor context only. It is never supplied to the router.
      check(typeof story.brief === 'string' && story.brief.length <= 20000, 'brief is invalid');
      check(stringArray(story.acceptance), 'acceptance is invalid');
      const built = buildDispatchProfile({ taskType: story.taskType, estimatedLoc: story.estimatedLoc, filesTouched: story.filesTouched,
        risk: story.risk, acceptanceTestable: true, dependsOn: [] }, opts);
      errors.push(...built.errors.map(e => `story: ${e}`));
      if (built.ok) errors.push(...validateDispatchProfile({ ...built.profile, complexity: story.complexity, risk: story.risk }, opts).errors.map(e => `story: ${e}`));
    }
    if (Object.hasOwn(packet, 'tasks')) {
      check(Array.isArray(packet.tasks), 'tasks must be an array');
      if (Array.isArray(packet.tasks)) for (const t of packet.tasks) errors.push(...validateTaskShape(t, { ...opts, storyRef: packet.storyRef, round: packet.round }).errors);
    }
    if (packet.phase === 'plan') check(!Object.hasOwn(packet, 'results'), 'plan phase forbids results');
    if (packet.phase === 'verdict') check(Array.isArray(packet.results) && packet.results.length > 0, 'verdict phase requires results');
    if (Object.hasOwn(packet, 'results')) {
      check(Array.isArray(packet.results), 'results must be an array');
      if (Array.isArray(packet.results)) for (const r of packet.results) {
        errors.push(...validateTaskResult(r).errors);
        check(r?.storyRef === packet.storyRef && r?.round === packet.round, 'result story identity mismatch');
      }
    }
    return { ok: !errors.length, errors };
  } catch { return { ok: false, errors: ['unreadable context packet'] }; }
}

// These are evidence labels supplied by the operator, not live execution claims.
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export const SUPERVISOR_INVOCATIONS = freeze({
  codex: { transport: 'codex CLI', inputPacket: 'context-packet', output: 'schema-constrained-json', schemaFlag: '--output-schema <FILE>',
    extraFlags: ['exec', '--json', '-s read-only'], toolPosture: 'read-only shell (not tool-free)',
    verification: { argv: 'verified-in-repo', schemaFlag: 'verified-by-help-output', toolPosture: 'verified-in-repo',
      note: 'we:scripts/lib/codex-judge-spawn.mjs#buildCodexJudgeArgv; codex exec --help lists --output-schema.' } },
  agy: { transport: 'agy CLI', inputPacket: 'context-packet', output: 'schema-constrained-json', schemaFlag: '--json-schema <string|file>',
    extraFlags: ['--mode plan', '-p', '--output-format json'], toolPosture: 'plan mode; tool-free execution UNVERIFIED',
    verification: { schemaFlag: 'verified-by-help-output', modeFlag: 'verified-by-help-output', planPreventsWriteToolError: 'UNVERIFIED', schemaMakesToolFree: 'UNVERIFIED',
      note: 'agy --help, 2026-09-20: --json-schema and --mode (accept-edits, plan). Whether --mode plan prevents the write_to_file error from the rejected agy Claude trial (PR 2223), and whether --json-schema makes execution tool-free, are UNVERIFIED.' } },
  'claude-native': { transport: 'claude CLI', inputPacket: 'context-packet', output: 'schema-constrained-json', schemaFlag: '--json-schema <inline JSON>',
    extraFlags: ['-p', '--output-format json', '--tools ""'], toolPosture: 'tools disabled; supervisor round UNVERIFIED',
    verification: { schemaFlag: 'verified-by-help-output', toolsFlag: 'verified-by-help-output', toolFreeSupervisorRound: 'UNVERIFIED',
      note: 'claude --help lists --json-schema and --tools; whether a supervisor round works tool-free is UNVERIFIED.' } },
});
// @test-only-export-ok: contract for the G2 dispatcher wiring (no runtime caller in slice G1)
export function supervisorBackendFor(candidateBackend) {
  return typeof candidateBackend === 'string' && Object.hasOwn(SUPERVISOR_INVOCATIONS, candidateBackend) ? SUPERVISOR_INVOCATIONS[candidateBackend] : null;
}
