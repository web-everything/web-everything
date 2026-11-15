/** PR2 executable contract. Phase 1 deliberately changes no production code.
 * New wrapper seams are asserted before invocation, so absent behaviour produces
 * assertion failures while the existing module graph still imports and collects.
 * All agent/process/write boundaries below are injected; only flow data is read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import * as wrapper from '../deliver-item-wrapper.mjs';
import { readTick, routeDispatchProvider } from '../dispatch-lane-io.mjs';
import { dispatchLaneOperation, DISPATCH_LANE_OP } from '../dispatch-lane.mjs';
import { createRegistry } from '../registry.mjs';
import { startRun, advanceWhileRunning } from '../engine.mjs';
import { deliveryFlowFor, resolveDeliveryFlowPolicy } from '../../lib/delivery-flow.mjs';
import { AI_ROUTING_ROLES, AI_ROUTING_STANDARD } from '../../lib/ai-routing.mjs';
import { runCheck } from '../../conveyor/flows/check.mjs';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal();
  const refuse = () => { throw new Error('unexpected process IO: inject the session runner'); };
  const guarded = { ...actual, execFileSync: refuse, execSync: refuse,
    execFile: refuse, exec: refuse, spawn: refuse, spawnSync: refuse };
  return { ...guarded, default: guarded };
});
vi.mock('../../lib/settings-files.mjs', async importOriginal => ({
  ...await importOriginal(),
  readSettings: () => ({ deliveryFlow: {} }),
  readDeclaredSettings: () => ({ settings: { deliveryFlow: {} }, errors: [] }),
}));
vi.mock('../../lib/policy-cascade.mjs', async importOriginal => ({
  ...await importOriginal(), platformPreference: () => undefined,
}));
vi.mock('../../lib/repo-profile.mjs', async importOriginal => ({
  ...await importOriginal(),
  briefTokensForRepo: () => ({ REPO: 'fixture/we', LANE_REPO: '.',
    GATE_COMMAND: 'fixture-gate', WE_ROOT: 'fixture/we', ATTRIBUTION: 'WE' }),
}));
// Brief-policy wording is a separate contract. Supply a fixed brief at this
// boundary so the historical dispatch snapshot contains only portable bytes.
vi.mock('../../lib/build-policy.mjs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, appendBuildRequirements: text => text,
    // Isolate unrelated build-policy provenance from the classifier's one-log contract.
    resolveBuildPolicy: options => actual.resolveBuildPolicy({ ...options, log: () => {} }),
  };
});

// Isolate the existing router's independent policy/scorecard inputs. The real
// readTick -> declaration -> durable effect path remains under test.
vi.mock('../../lib/dispatch-contracts.mjs', async importOriginal => ({
  ...await importOriginal(),
  decideDispatchRoute: vi.fn(() => ({
    outcome: 'routed', routed: 'claude', executed: 'claude', tier: 'sonnet',
    taskType: 'build-new-feature', supervision: 'full', auditTrail: [],
    probationWorker: null, policyRoute: null,
  })),
}));

afterEach(() => vi.unstubAllEnvs());
const NUM = '9001';
const CARD_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const ORDINARY = ['we:blocks/example.ts'];
const GUARDED = ['we:scripts/hooks/example.mjs'];
const NOTE = '# Approach\nRead the card first.\n\nFiles: blocks/example.ts\n'
  + '\nSafety properties\n1. No build after failed design. Test: design-failure.\n'
  + '\nNon-goals: changing routing policy.\n';
const NOTE_SHA = createHash('sha256').update(NOTE).digest('hex');
const DESIGN_NOTE = { text: NOTE, sha: NOTE_SHA, properties: ['1'] };
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'];
// PR1's ordinary dispatch contract, with the fixed router and brief IO above.
// Keep this literal: deriving it from the live output would hide added fields.
const LEGACY_ORDINARY_ROUTING = {
  outcome: 'routed', routed: 'claude', executed: 'claude', tier: 'sonnet',
  taskType: 'build-new-feature', supervision: 'full', auditTrail: [],
  probationWorker: null, policyRoute: null,
};
const LEGACY_ORDINARY = {
  verdict: {
    dispatching: true, num: '9001', launchKind: 'build', lane: 7,
    sessionSlug: 'conveyor-9001', reason: 'cleared for build on lane 7',
    unreadableRunRecords: 0, agedOutDispatches: [], dispatchLiveness: 'not-needed',
    guardsFrom: 'none', droppedBookkeeping: [], statusLine: 'fixture',
    occupancyFailOpen: false, occupancyWarning: null,
    routing: LEGACY_ORDINARY_ROUTING, taskType: 'build-new-feature',
  },
  payload: {
    num: '9001', groupMembers: [], launchKind: 'build', lane: 7,
    sessionSlug: 'conveyor-9001', itemSpecPath: 'backlog/9001-flow-check.md',
    scope: ['we:blocks/example.ts'], operatorPostBuild: false,
    prompt: 'Build 9001 in 7: we:blocks/example.ts backlog/9001-flow-check.md conveyor-9001  main fixture/we',
    expectedWithinMinutes: 90, pr: null, reason: null,
    occupancyFailOpen: false, occupancyWarning: null,
    routing: LEGACY_ORDINARY_ROUTING, taskType: 'build-new-feature', modelReason: null,
  },
  expectedWithinMinutes: 90,
};
const resolve = () => resolveDeliveryFlowPolicy({ tool: {}, platform: {}, env: {}, log: () => {} });
const flowFor = scope => deliveryFlowFor({ scope, kind: 'build' }, { resolve, log: () => {} });
const FLOW = flowFor(GUARDED);

function seam(name) {
  expect(wrapper[name], `PR2 wrapper must export ${name}`).toBeTypeOf('function');
  return wrapper[name];
}

function tick(scope, flowReader = vi.fn(input => deliveryFlowFor(input, { resolve, log: () => {} })), options = {}) {
  vi.stubEnv('WE_DELIVERY_FLOW', '{}');
  vi.stubEnv('WE_ROUTING_BUILDER', 'claude');
  vi.stubEnv('WE_BUILD_SELF_REVIEW_ENABLED', 'false');
  return readTick({
    num: NUM, root: 'fixture/we',
    runNode: () => JSON.stringify({
      decisions: { spawnBuilds: [{ num: NUM, lane: 7 }], statusLine: 'fixture', notes: [] },
      nextState: { tick: 1, buildGuards: [], prepareGuards: [], fixGuards: [], ciHealGuards: [] },
    }),
    exec: () => { throw new Error('unexpected process IO'); },
    readText: () => 'Build {{ITEM_NUM}} in {{LANE}}: {{SCOPE}} {{ITEM_SPEC_PATH}} {{SESSION_SLUG}} {{ATTEMPT_TAG}} {{DELIVERY_BASE}} {{WE_ROOT}}',
    loadItems: () => [{ num: NUM, slug: 'flow-check', specPath: 'backlog/9001-flow-check.md', scope, size: 3 }],
    listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
    listAgents: () => [], isPidAlive: () => false, recordLiveness: value => value,
    laneRefForPr: () => 'lane/9001',
    checkAlreadyDone: () => ({ done: false, pr: null, checked: true }),
    checkBuildDelivery: () => null,
    readScorecards: () => [], readSizePolicy: () => ({}), readPromotions: () => ({}),
    readDeliveryAgentOverride: () => null, dispatchModes: () => ({ build: 'mechanical' }),
    now: () => new Date('2026-11-14T12:00:00.000Z'),
    // New readTick dependency: bind the real PR1 resolver to empty policy layers.
    deliveryFlowFor: flowReader, ...options,
  });
}

function plan(raw, expectedWithinMinutes = 90) {
  const registry = createRegistry();
  registry.register(dispatchLaneOperation({ readTick: () => raw }));
  const run = advanceWhileRunning(startRun({
    op: DISPATCH_LANE_OP, id: 'delivery-flow-fixture',
    input: { num: NUM, expectedWithinMinutes }, registry,
  }), { registry });
  expect(run.verdict?.dispatching, JSON.stringify(run)).toBe(true);
  expect(run.effects).toHaveLength(1);
  return { verdict: run.verdict, payload: run.effects[0].payload,
    expectedWithinMinutes: run.findings.read.expectedWithinMinutes };
}

function routeHarness() {
  const agent = vi.fn(() => 'native-claude');
  const build = vi.fn(() => 'pid:123');
  return { agent, build, io: {
    agent, modes: { build: 'mechanical' }, scriptExists: () => true,
    providerAvailable: () => true,
    registry: { build: { kind: 'build', provider: build, runScript: 'fixture/deliver-item-run.mjs' } },
  } };
}
const request = () => ({ launchKind: 'build', num: NUM, deliveryFlow: FLOW,
  policyRoute: { provider: 'claude', model: 'sonnet', fallback: [] }, probationWorker: null });

// In-memory coordination store survives retries, but no host files are created.
// runSession is the sole design-session IO; its second argument owns the hard timeout.
function designHarness() {
  const files = new Map();
  const runSession = vi.fn(async () => ({ status: 'done', text: NOTE }));
  const io = {
    runSession, readText: path => {
      if (!files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files.get(path);
    },
    writeText: vi.fn((path, text) => files.set(path, text)), mkdir: vi.fn(),
    readBrief: vi.fn(() => 'Approach; files; numbered safety properties; a test per property; non-goals.'),
  };
  return { files, runSession, io };
}
const designInput = () => ({ item: NUM, cardSha: CARD_SHA, coordinationRoot: 'fixture/coordination',
  lanePath: 'fixture/lane', deliveryFlow: FLOW, stage: FLOW.stages[0] });
const briefInput = () => ({ item: NUM, lane: 7, sessionSlug: 'conveyor-9001', attemptTag: '' });
const briefIO = { loadItems: () => [{ num: NUM, slug: 'flow-check', specPath: 'backlog/9001-flow-check.md' }] };

describe('deliveryFlow first consumer (PR2)', () => {
  it('repair 1 design routing preserves critical-miss vetoes before selecting a wrapper', () => {
    const { io, build, agent } = routeHarness();
    const req = request();
    req.policyRoute = { provider: 'codex', model: 'vetoed', fallback: [{ provider: 'claude', model: 'opus' }],
      vetoes: [{ provider: 'codex', model: 'vetoed' }] };
    routeDispatchProvider(req, io);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude-restricted',
      policyRoute: expect.objectContaining({ provider: 'claude', model: 'opus' }) }));
    expect(agent).not.toHaveBeenCalled();
  });

  it('repair 1 design routing honours a reasoned Claude model pin over Codex', () => {
    const { io, build, agent } = routeHarness();
    routeDispatchProvider({ ...request(), modelReason: 'operator pin', extraArgs: ['--model', 'opus'],
      policyRoute: { provider: 'codex', model: 'codex', fallback: [{ provider: 'claude', model: 'opus' }] } }, io);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude-restricted',
      policyRoute: expect.objectContaining({ provider: 'claude' }) }));
    expect(agent).not.toHaveBeenCalled();
  });

  it('repair 1 design routing retains normal Codex selection and wrapper fallback after pre-launch refusal', () => {
    const { io, build, agent } = routeHarness();
    build.mockImplementationOnce(() => { throw Object.assign(new Error('pre-launch refusal'), { notApplied: true }); });
    routeDispatchProvider({ ...request(), policyRoute: { provider: 'codex', model: 'codex',
      fallback: [{ provider: 'claude', model: 'opus' }] } }, io);
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[0][0].policyRoute.provider).toBe('codex');
    expect(build.mock.calls[1][0].provider).toBe('claude-restricted');
    expect(agent).not.toHaveBeenCalled();
  });

  it('repair 2 grouped builds classify the union with the strictest member scope', () => {
    const reader = vi.fn(input => deliveryFlowFor(input, { resolve, log: () => {} }));
    const raw = tick(ORDINARY, reader, { groupMembers: ['9002'], loadItems: () => [
      { num: NUM, slug: 'flow-check', specPath: 'backlog/9001-flow-check.md', scope: ORDINARY },
      { num: '9002', slug: 'guard-member', specPath: 'backlog/9002-guard-member.md', scope: GUARDED },
    ] });
    expect(reader).toHaveBeenCalledWith({ scope: [...ORDINARY, ...GUARDED], kind: 'build' });
    expect(raw.deliveryFlow.class).toBe('guard');
    expect(plan(raw).payload.deliveryFlow.class).toBe('guard');
  });

  it.each(['audit', 'red-team'])('repair 3 unconsumed %s stage holds planning and wrapper before any build', async stage => {
    const flow = { class: 'ordinary', stages: [{ stage: 'build' }, { stage: 'review' }, { stage }] };
    const hold = `deliveryFlow: ordinary needs the stage runner (${stage})`;
    expect(tick(ORDINARY, () => flow).routing).toMatchObject({ outcome: 'refused', refusal: hold });
    const buildTurn = vi.fn();
    const design = vi.fn();
    const settleTerminal = vi.fn();
    const result = await wrapper.runDeliveryStages({ item: NUM, deliveryFlow: flow }, {
      buildTurn, runDesignStage: design, settleTerminal });
    expect(result).toMatchObject({ outcome: 'not-ready', reason: hold });
    expect(settleTerminal).toHaveBeenCalledWith('not-ready', expect.objectContaining({ hold, releaseClaim: true }));
    expect(buildTurn).not.toHaveBeenCalled();
    expect(design).not.toHaveBeenCalled();
  });

  it('repair 4 unknown mapped test names park for human even with a valid design ack', () => {
    const testExists = vi.fn(() => false);
    const report = { outcome: 'done', designAck: NOTE_SHA, propertyTests: { '1': 'invented safety test' } };
    const result = wrapper.decideParkMode({ report, deliveryFlow: FLOW, designNote: DESIGN_NOTE,
      lanePath: 'fixture/lane', filesTouched: [], convergeVerdict: { verdict: 'clear' } }, { testExists });
    expect(result).toMatchObject({ mode: 'park', label: 'review:human', reason: expect.stringMatching(/test.*(unknown|exist|found)/i) });
    expect(testExists).toHaveBeenCalledWith('invented safety test', expect.objectContaining({ lanePath: 'fixture/lane' }));
  });

  it('repair 4 default test lookup verifies title substrings in existing changed or repo test files', () => {
    const lookup = seam('deliveryTestExists');
    const run = vi.fn((_cmd, args) => args.includes('diff') ? 'new.test.mjs\0' : 'old.spec.ts\0');
    const readText = vi.fn(path => path.endsWith('new.test.mjs')
      ? "it('protects critical routing', () => {}); const body = 'invented safety test';"
      : "test('keeps ordinary bytes', () => {});");
    const io = { run, readText };
    expect(lookup('critical routing', { lanePath: 'fixture/lane' }, io)).toBe(true);
    expect(lookup('old.spec.ts: ordinary bytes', { lanePath: 'fixture/lane' }, io)).toBe(true);
    expect(lookup('invented safety test', { lanePath: 'fixture/lane' }, io)).toBe(false);
    expect(lookup('missing.test.mjs: critical routing', { lanePath: 'fixture/lane' }, io)).toBe(false);
    expect(lookup('critical routing', { lanePath: 'fixture/lane' }, { ...io,
      readText: () => { throw new Error('unreadable'); } })).toBe(false);
  });

  it.each([
    ['skipped test', "test.skip('guards property', () => {});"],
    ['skipped parameterized test', "it.skip.each([1])('guards property', () => {});"],
    ['skipped suite', "describe.skip('suite', () => { test('guards property', () => {}); });"],
    ['conditional skip', "test.skipIf(flag)('guards property', () => {});"],
    ['todo declaration', "test.todo('guards property');"],
    ['line comment', "// test('guards property', () => {});"],
    ['block comment', "/* test('guards property', () => {}); */"],
    ['string literal', 'const example = "test(\'guards property\', () => {});";'],
    ['template literal', "const example = `test('guards property', () => {});`;"],
    ['uninvoked function', "function example() { test('guards property', () => {}); }"],
    ['missing callback', "test('guards property');"],
    ['empty table', "test.each([])('guards property', () => {});"],
  ])('repair 4 executable evidence rejects %s and parks for human', (_kind, source) => {
    const io = { run: () => 'safety.test.mjs\0', readText: () => source };
    const testExists = (name, context) => wrapper.deliveryTestExists(name, context, io);
    const report = { outcome: 'done', designAck: NOTE_SHA, propertyTests: { '1': 'guards property' } };
    expect(testExists('guards property', { lanePath: 'fixture/lane' })).toBe(false);
    expect(wrapper.decideParkMode({ report, deliveryFlow: FLOW, designNote: DESIGN_NOTE,
      lanePath: 'fixture/lane', filesTouched: [], convergeVerdict: { verdict: 'clear' } }, { testExists }))
      .toMatchObject({ mode: 'park', label: 'review:human', reason: expect.stringMatching(/test.*not found/) });
  });

  it.each([
    "test.only('other', () => {}); test('guards property', () => {});",
    "test('guards property', () => {}); test.only('other', () => {});",
    "describe.only('focused suite', () => { test('other', () => {}); }); test('guards property', () => {});",
    "describe('suite', () => { test.only('other', () => {}); test('guards property', () => {}); });",
    "test.only.each([1])('other', () => {}); test('guards property', () => {});",
    "test['only']('other', () => {}); test('guards property', () => {});",
    "test.only('guards property', () => {});",
  ])('repair 4 rejects mapped evidence excluded by a focused test: %s', source => {
    const testExists = (name, context) => wrapper.deliveryTestExists(name, context, {
      run: () => 'safety.test.mjs\0', readText: () => source });
    const report = { outcome: 'done', designAck: NOTE_SHA, propertyTests: { '1': 'guards property' } };
    expect(testExists('guards property', { lanePath: 'fixture/lane' })).toBe(false);
    expect(wrapper.decideParkMode({ report, deliveryFlow: FLOW, designNote: DESIGN_NOTE,
      lanePath: 'fixture/lane', filesTouched: [], convergeVerdict: { verdict: 'clear' } }, { testExists }))
      .toMatchObject({ mode: 'park', label: 'review:human', reason: expect.stringMatching(/test.*not found/) });
  });

  it.each([
    "test('guards property', () => {});",
    "describe('suite', () => { it('guards property', function () {}); });",
    "it.concurrent('guards property', async () => {});",
    "test.each([1, 2])('guards property %s', () => {});",
    "/* test.skip('guards property', () => {}); */ test('guards property', () => {});",
    "// test.only('other', () => {});\ntest('guards property', () => {});",
    "const example = \"test.only('other', () => {});\"; test('guards property', () => {});",
  ])('repair 4 executable evidence accepts an active declaration: %s', source => {
    const testExists = (name, context) => wrapper.deliveryTestExists(name, context, {
      run: () => 'safety.test.mjs\0', readText: () => source });
    const report = { designAck: NOTE_SHA, propertyTests: { '1': 'guards property' } };
    expect(wrapper.designAckCheck({ report, designNote: DESIGN_NOTE, lanePath: 'fixture/lane' }, { testExists }))
      .toEqual({ ok: true });
  });

  it('1 readTick carries deliveryFlow into the plan verdict and dispatch payload and adds the design timeout', () => {
    const reader = vi.fn(input => deliveryFlowFor(input, { resolve, log: () => {} }));
    const raw = tick(GUARDED, reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith({ scope: GUARDED, kind: 'build' });
    expect(raw.deliveryFlow).toEqual(FLOW);
    const result = plan(raw);
    expect(result.verdict.deliveryFlow).toEqual(FLOW);
    expect(result.payload.deliveryFlow).toEqual(FLOW);
    expect(result.expectedWithinMinutes).toBe(110);
    expect(result.verdict.expectedWithinMinutes).toBe(110);
    expect(result.payload.expectedWithinMinutes).toBe(110);
    expect(plan(raw, 45).payload.expectedWithinMinutes).toBe(65);
  });

  it('1 classifier dependency throwing keeps the standard guard flow and logs exactly once', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const raw = tick(GUARDED, () => { throw new Error('private classifier detail'); });
      expect(raw.deliveryFlow).toMatchObject({ class: 'guard', stages: FLOW.stages });
      expect(log.mock.calls).toEqual([['delivery-flow-unreadable']]);
      expect(plan(raw).payload.deliveryFlow.class).toBe('guard');
    } finally { log.mockRestore(); }
  });

  it('3 agent mode exposes the stage-runner hold in the planning route before dispatch', () => {
    const raw = tick(GUARDED, undefined, { dispatchModes: () => ({ build: 'agent' }) });
    expect(raw.routing).toMatchObject({ outcome: 'refused', refusal: 'deliveryFlow: guard needs the stage runner' });
  });

  it('2 DEFAULT-UNCHANGED: empty shipped policy preserves ordinary plan/payload/deadline JSON byte for byte', () => {
    expect(JSON.parse(readFileSync(resolvePath('scripts/settings/delivery-flow.json'), 'utf8')).deliveryFlow).toEqual({});
    expect(flowFor(ORDINARY).stages).toEqual([{ stage: 'build' }, { stage: 'review' }]);
    expect(FLOW.stages).toEqual([
      { stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20 },
      { stage: 'build' }, { stage: 'review' },
    ]);
    const result = plan(tick(ORDINARY));
    expect(result.expectedWithinMinutes).toBe(90);
    expect(result.verdict).not.toHaveProperty('deliveryFlow');
    expect(result.payload).not.toHaveProperty('deliveryFlow');
    // Compare the full persisted JSON, including key presence and ordering.
    expect(JSON.stringify(result)).toBe(JSON.stringify(LEGACY_ORDINARY));
  });

  it('3 a design flow sends Claude through build/claude-restricted without launchAgent', () => {
    const { io, agent, build } = routeHarness();
    expect(routeDispatchProvider(request(), io)).toBe('pid:123');
    expect(agent).not.toHaveBeenCalled();
    expect(build).toHaveBeenCalledOnce();
    expect(build.mock.calls[0][0]).toMatchObject({ deliveryFlow: FLOW, provider: 'claude-restricted' });
  });

  it.each(['wrapper-missing', 'mode-agent', 'operator-post-build', 'provider-unavailable'])(
    '3 fail closed with a visible stage-runner hold: %s', fault => {
      const { io, agent, build } = routeHarness();
      const req = request();
      if (fault === 'wrapper-missing') io.scriptExists = () => false;
      if (fault === 'mode-agent') io.modes.build = 'agent';
      if (fault === 'operator-post-build') req.operatorPostBuild = true;
      if (fault === 'provider-unavailable') io.providerAvailable = () => false;
      let refusal;
      try { routeDispatchProvider(req, io); } catch (error) { refusal = error; }
      expect(refusal).toMatchObject({ notApplied: true,
        message: expect.stringMatching(/^deliveryFlow: guard needs the stage runner/) });
      expect(agent).not.toHaveBeenCalled();
      expect(build).not.toHaveBeenCalled();
    });

  it('4 runDesignStage passes exactly read-only tools, stage model/effort and a hard timeout to the session', async () => {
    const runDesignStage = seam('runDesignStage');
    const resolveDesignStageArgs = seam('resolveDesignStageArgs');
    const input = designInput();
    const args = resolveDesignStageArgs(input);
    const valueAfter = flag => args[args.indexOf(flag) + 1];
    expect(valueAfter('--model')).toBe('opus');
    expect(valueAfter('--effort')).toBe('high');
    expect(valueAfter('--tools').split(',')).toEqual(READ_ONLY_TOOLS);
    expect(valueAfter('--disallowedTools').split(',')).toEqual(['Bash']);
    expect(valueAfter('--allowedTools').split(',')).toEqual(READ_ONLY_TOOLS);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(valueAfter('--allowedTools')).not.toMatch(/Edit|Write|Bash/);
    const { io, runSession } = designHarness();
    const result = await runDesignStage(input, io);
    expect(runSession).toHaveBeenCalledOnce();
    expect(runSession.mock.calls[0][0]).toEqual(args);
    expect(runSession.mock.calls[0][1]).toMatchObject({ timeout: 20 * 60_000 });
    expect(io.readBrief).toHaveBeenCalledWith('skills-src/conveyor/delivery-design-brief.md');
    expect(result).toMatchObject({ text: NOTE, sha: NOTE_SHA });
  });

  it.each([
    ['output redirection option', 'git diff --output=blocks/example.ts'],
    ['output redirection token', 'git diff > blocks/example.ts'],
    ['subprocess execution option', 'rg --pre=hostile-program pattern'],
    ['subprocess execution via shell substitution', 'rg "$(hostile-program)"'],
  ])('4 rejects design Bash %s by removing and explicitly denying the shell capability', async (_name, command) => {
    const { io, runSession, files } = designHarness();
    const input = { ...designInput(), cardText: `Inspect this proposed command: ${command}` };
    await wrapper.runDesignStage(input, io);
    expect(runSession).toHaveBeenCalledTimes(1);
    const [args, options] = runSession.mock.calls[0];
    // Assert the real session boundary, not a second command-policy implementation.
    // --restricted excludes code-running tools; only the three reading tools are
    // restored. Bash is also explicitly denied, regardless of command options.
    expect(args).toContain('--restricted');
    expect(args[args.indexOf('--tools') + 1].split(',')).toEqual(['Read', 'Grep', 'Glob']);
    expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual(['Read', 'Grep', 'Glob']);
    expect(args[args.indexOf('--disallowedTools') + 1].split(',')).toEqual(['Bash']);
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args).not.toContain(command);
    expect(options.input).toContain(`<task>\n${input.cardText}\n</task>`);
    // The wrapper writes only the completed note to its coordination store.
    expect(io.writeText).toHaveBeenCalledTimes(1);
    expect(io.writeText).toHaveBeenCalledWith(wrapper.designNotePath(input), NOTE);
    expect([...files.keys()]).toEqual([wrapper.designNotePath(input)]);
  });

  it('4 designNotePath saves under coordination root, reuses the same card hash and reruns a changed card', async () => {
    const runDesignStage = seam('runDesignStage');
    const designNotePath = seam('designNotePath');
    const input = designInput();
    const path = join(input.coordinationRoot, 'delivery-designs', `${NUM}-${CARD_SHA.slice(0, 12)}.md`);
    expect(designNotePath(input)).toBe(path);
    const { io, files, runSession } = designHarness();
    const first = await runDesignStage(input, io);
    expect(files.get(path)).toBe(NOTE);
    expect(first.sha).toBe(NOTE_SHA);
    const retry = await runDesignStage(input, io);
    expect(retry.sha).toBe(first.sha);
    expect(runSession).toHaveBeenCalledTimes(1);
    await runDesignStage({ ...input, cardSha: OTHER_SHA }, io);
    expect(runSession).toHaveBeenCalledTimes(2);
    expect(files.get(join(input.coordinationRoot, 'delivery-designs', `${NUM}-${OTHER_SHA.slice(0, 12)}.md`))).toBe(NOTE);
  });

  it('5 fillMinimalBrief pastes DESIGN NOTE for design flows and preserves ordinary bytes', () => {
    const template = 'Build {{ITEM_SPEC_PATH_BASENAME}}.';
    const before = 'Build 9001-flow-check.md.\n\n[env: DELIVERY_SESSION=conveyor-9001 DELIVERY_ITEM=9001 LANE=7 ATTEMPT_TAG=]';
    expect(wrapper.fillMinimalBrief(template, briefInput(), briefIO)).toBe(before);
    expect(wrapper.fillMinimalBrief(template, { ...briefInput(), deliveryFlow: flowFor(ORDINARY) }, briefIO)).toBe(before);
    const designed = wrapper.fillMinimalBrief(template, { ...briefInput(), deliveryFlow: FLOW, designNote: DESIGN_NOTE }, briefIO);
    expect(designed).toContain(`DESIGN NOTE\n${NOTE}`);
    expect(designed).toContain(`designAck:${NOTE_SHA}`);
  });

  it('6 valid designAck and a complete property-to-test map clear designAckCheck', () => {
    const designAckCheck = seam('designAckCheck');
    const report = { outcome: 'done', summary: 'Built', filesTouched: ['blocks/example.ts'],
      designAck: NOTE_SHA, propertyTests: { '1': 'scripts/operations/__tests__/delivery-flow-stage.test.mjs: design-failure' } };
    expect(designAckCheck({ report, designNote: DESIGN_NOTE }, { testExists: () => true })).toEqual({ ok: true });
  });

  it('6 the PR body includes the design class, note hash and property-to-test map', () => {
    const report = { outcome: 'done', summary: 'Built', filesTouched: ['blocks/example.ts'],
      designAck: NOTE_SHA, propertyTests: { '1': 'scripts/operations/__tests__/delivery-flow-stage.test.mjs: design-failure' } };
    const body = wrapper.buildPrBody({ item: NUM, report, deliveryFlow: FLOW, designNote: DESIGN_NOTE });
    expect(body).toContain('## Design (deliveryFlow: guard)');
    expect(body).toContain(NOTE_SHA);
    expect(body).toContain(report.propertyTests['1']);
  });

  it.each([
    ['missing ack', { propertyTests: { '1': 'test' } }],
    ['wrong ack', { designAck: OTHER_SHA, propertyTests: { '1': 'test' } }],
    ['missing map', { designAck: NOTE_SHA }],
    ['unmapped property', { designAck: NOTE_SHA, propertyTests: {} }],
    ['empty test', { designAck: NOTE_SHA, propertyTests: { '1': '' } }],
  ])('6 wrapper parks a PR for human judgment on %s', (_name, evidence) => {
    const report = { outcome: 'done', summary: 'Built', filesTouched: ['blocks/example.ts'], ...evidence };
    const park = wrapper.decideParkMode({ report, convergeVerdict: { verdict: 'land' },
      filesTouched: report.filesTouched, deliveryFlow: FLOW, designNote: DESIGN_NOTE });
    expect(park).toMatchObject({ mode: 'park', label: 'review:human' });
    expect(park.reason).toMatch(/design/i);
    expect(seam('designAckCheck')({ report, designNote: DESIGN_NOTE }).ok).toBe(false);
  });

  // Wrapper orchestration seam: called after claim, before any build turn. The
  // injected callbacks are real boundaries, not a test reimplementation of order.
  it.each(['failed', 'timeout', 'empty'])(
    '7 design-failure (%s) settles design-failed and holds; the build turn is NEVER called', async fault => {
      const runDeliveryStages = seam('runDeliveryStages');
      const { io, runSession } = designHarness();
      if (fault === 'failed') runSession.mockRejectedValue(new Error('design failed'));
      if (fault === 'timeout') runSession.mockRejectedValue(Object.assign(new Error('deadline'), { code: 'ETIMEDOUT' }));
      if (fault === 'empty') runSession.mockResolvedValue({ status: 'done', text: ' \n ' });
      const buildTurn = vi.fn();
      const settleTerminal = vi.fn();
      const result = await runDeliveryStages(designInput(), { ...io,
        runDesignStage: input => seam('runDesignStage')(input, io), buildTurn, settleTerminal });
      expect(result).toMatchObject({ outcome: 'design-failed' });
      expect(runSession).toHaveBeenCalledOnce();
      expect(buildTurn).not.toHaveBeenCalled();
      expect(settleTerminal).toHaveBeenCalledTimes(1);
      expect(settleTerminal).toHaveBeenCalledWith('design-failed', expect.objectContaining({
        hold: expect.stringMatching(/design/i), releaseClaim: true,
      }));
    });

  it('7 successful design is passed to the build turn before any build can run', async () => {
    const runDeliveryStages = seam('runDeliveryStages');
    const { io } = designHarness();
    const buildTurn = vi.fn(async () => ({ outcome: 'done' }));
    const settleTerminal = vi.fn();
    await runDeliveryStages(designInput(), { ...io,
      runDesignStage: input => seam('runDesignStage')(input, io), buildTurn, settleTerminal });
    expect(buildTurn).toHaveBeenCalledTimes(1);
    expect(buildTurn).toHaveBeenCalledWith(expect.objectContaining({
      designNote: expect.objectContaining({ text: NOTE, sha: NOTE_SHA }),
    }));
    expect(settleTerminal).not.toHaveBeenCalled();
  });

  it.each([
    ['failed status', { status: 'failed', text: NOTE }],
    ['CLI error', { is_error: true, result: NOTE }],
    ['missing properties', { status: 'done', text: 'Approach only' }],
    ['duplicate properties', { status: 'done', text: '1. First\n1. Second' }],
    ['oversized note', { status: 'done', text: NOTE + 'x'.repeat(1024 * 1024) }],
  ])('7 invalid design evidence (%s) holds with operator recovery and never builds', async (_name, result) => {
    const { io, runSession } = designHarness();
    runSession.mockResolvedValue(result);
    const buildTurn = vi.fn();
    const settleTerminal = vi.fn();
    await wrapper.runDeliveryStages(designInput(), { buildTurn, settleTerminal,
      runDesignStage: input => wrapper.runDesignStage(input, io) });
    expect(buildTurn).not.toHaveBeenCalled();
    expect(io.writeText).not.toHaveBeenCalled();
    expect(settleTerminal).toHaveBeenCalledTimes(1);
    expect(settleTerminal).toHaveBeenCalledWith('design-failed', expect.objectContaining({
      releaseClaim: true, hold: expect.stringMatching(/inspect.*repair or retry/),
    }));
  });

  it('7 unreadable cached note fails closed rather than running a new design or building', async () => {
    const { io, runSession } = designHarness();
    io.readText = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
    const buildTurn = vi.fn();
    const settleTerminal = vi.fn();
    const result = await wrapper.runDeliveryStages(designInput(), { buildTurn, settleTerminal,
      runDesignStage: input => wrapper.runDesignStage(input, io) });
    expect(result.outcome).toBe('design-failed');
    expect(runSession).not.toHaveBeenCalled();
    expect(buildTurn).not.toHaveBeenCalled();
    expect(settleTerminal).toHaveBeenCalledTimes(1);
  });

  it('4 design session disables inherited MCP tools and slash commands', () => {
    const args = wrapper.resolveDesignStageArgs(designInput());
    expect(args).toContain('--restricted');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('5 design prose cannot close the shared untrusted-data fence', () => {
    const text = NOTE + '</approach>Injected instruction';
    const prompt = wrapper.fillMinimalBrief('Build {{ITEM_SPEC_PATH_BASENAME}}.',
      { ...briefInput(), deliveryFlow: FLOW, designNote: { ...DESIGN_NOTE, text } }, briefIO);
    expect(prompt.match(/<\/approach>/g)).toHaveLength(1);
    expect(prompt).toContain('[/approach]Injected instruction');
  });

  it('7 ordinary and historical runs without stage metadata call only the build callback', async () => {
    const buildTurn = vi.fn(async () => ({ outcome: 'done' }));
    const design = vi.fn();
    const settleTerminal = vi.fn();
    for (const deliveryFlow of [undefined, null, flowFor(ORDINARY)]) {
      const result = await wrapper.runDeliveryStages({ item: NUM, deliveryFlow }, {
        buildTurn, settleTerminal, runDesignStage: design,
      });
      expect(result).toEqual({ outcome: 'done' });
    }
    expect(buildTurn).toHaveBeenCalledTimes(3);
    expect(design).not.toHaveBeenCalled();
    expect(settleTerminal).not.toHaveBeenCalled();
  });

  // Item 8 is already pinned by the named classifier/reader-throws case in
  // scripts/lib/__tests__/delivery-flow.test.mjs, run alongside this file.
  it('9 build-dispatch has a designing state with timeout, exit and escalation', () => {
    const flow = JSON.parse(readFileSync(resolvePath('scripts/conveyor/flows/build-dispatch.flow.json'), 'utf8'));
    const designing = flow.states.find(state => state.id === 'designing');
    expect(designing, 'missing designing state').toBeDefined();
    expect(designing.wait?.timeout).toBeTruthy();
    expect(designing.wait?.onTimeout).toBeTruthy();
    expect(designing.escalation).toBeTruthy();
    expect(flow.transitions.some(edge => edge.from === 'designing' && edge.to !== 'designing')).toBe(true);
    expect(flow.transitions.some(edge => edge.to === 'designing' && edge.from !== 'designing')).toBe(true);
  });

  it('9 the real scripts/conveyor/flows/check.mjs checker has no unacknowledged findings', () => {
    // runCheck is the actual check.mjs CLI's exported implementation; no child
    // process or pretend checker, and no additional test command is launched.
    expect(runCheck().open).toEqual([]);
  });

  it('10 PR2 does not add an aiRouting design role', () => {
    expect(AI_ROUTING_ROLES).toEqual([
      'review', 'red-team', 'red-team-recheck', 'fix', 'build', 'prepare', 'ci-heal', 'worker', 'judge', 'helper',
    ]);
    expect(AI_ROUTING_STANDARD).not.toHaveProperty('design');
  });
});
