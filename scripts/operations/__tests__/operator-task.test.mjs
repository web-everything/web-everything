import { validateBacklogItem } from '../../check-standards-rules.mjs';
import { planScaffold } from '../scaffold.mjs';
import { composeOperatorTaskBrief, planOperatorPostBuild, renderOperatorEdgeStep, renderOperatorProofStep, resolveOperatorPostBuild } from '../operator-task-brief.mjs';
import { readFileSync } from 'node:fs';
import { readTick, routeDispatchProvider, createDispatchSinks } from '../dispatch-lane-io.mjs';
import { shapeDispatchRead, fillBrief, dispatchLaneOperation, DISPATCH_LANE_OP, DISPATCH_EFFECT } from '../dispatch-lane.mjs';
import { applyPendingEffects } from '../effect-executor.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { renderOperatorReport } from '../../worker-brief.mjs';
import { describe, it, expect, vi } from 'vitest';
import { planFileItem, fileItemOperation } from '../file-item.mjs';
import { createRegistry } from '../registry.mjs';
import { advanceWhileRunning, startRun } from '../engine.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { readField } from '../../backlog/frontmatter.mjs';
import { resolveOperatorTaskSettings, readOperatorTaskSettings } from '../../lib/operator-task-settings.mjs';
import { createFileItemReader } from '../file-item-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import * as operatorTaskModule from '../../backlog/operator-task.mjs';

const brief = 'A bounded task.\n\n' + ['Design', 'MVP', 'Done when', 'Edge cases', 'Test plan', 'Proof plan']
  .map(h => `## ${h}\nConcrete handling in we:scripts/example.mjs.\n`).join('\n');
const context = { existingIds: [], today: '2026-10-13', dir: '/repo/backlog',
  originMainSha: 'a'.repeat(40), operatorTask: { enabled: true }, sessionRole: 'orchestrator' };
const input = { title: 'Operator task', kind: 'story', size: '1', scope: 'we:scripts/example.mjs',
  digest: brief, operatorTask: true };
const OP = { operatorTask: true };

describe('operator task filing', () => {
  it('carries CLI flags through the declaration and refuses before declaring effects', () => {
    const declaration = fileItemOperation({ readScaffoldContext: () => context });
    const parsed = parseOperationArgv(declaration, ['--title=Operator task', '--kind=story', '--size=1',
      '--scope=we:scripts/example.mjs', `--digest=${brief}`, '--operatorTask']);
    expect(parsed.errors).toEqual([]);
    expect(parsed.input.operatorTask).toBe(true);
    const registry = createRegistry();
    registry.register(declaration);
    const start = input => startRun({ op: 'file-item', id: 'operator-task-test', input, registry });
    const run = advanceWhileRunning(start(parsed.input), { registry });
    expect(readField(run.verdict.content, 'preparedDate')).toBe(context.today);
    const incomplete = start({ ...parsed.input, digest: 'Incomplete.' });
    expect(() => advanceWhileRunning(incomplete, { registry })).toThrow(/missing or incomplete/);
    expect(incomplete.effects).toEqual([]);
  });
  it('stamps a complete brief with the origin/main tip', () => {
    const { content } = planFileItem(context, input);
    expect(readField(content, 'preparedDate')).toBe(context.today);
    expect(readField(content, 'preparedAgainstSha')).toBe(context.originMainSha);
    expect(readField(content, 'operatorTask')).toBe('true');
    expect(content).not.toContain('TODO');
  });
  it('refuses incomplete and placeholder briefs, naming missing sections', () => {
    expect(() => planFileItem(context, { ...input, digest: 'Incomplete.' })).toThrow(/Design.*MVP.*Test plan.*Proof plan.*Done when.*Edge cases/);
    expect(() => planFileItem(context, { ...input, digest: brief.replace('## MVP\nConcrete handling in we:scripts/example.mjs.', '## MVP\nTODO') })).toThrow(/MVP/);
    expect(() => planFileItem(context, { ...input, scope: 'scripts/example.mjs' })).toThrow(/we:.*scope/);
    expect(() => planFileItem({ ...context, originMainSha: '' }, input)).toThrow(/origin\/main/);
  });
  it('disabled filing retains the brief and marker but leaves it unprepared', () => {
    const { content } = planFileItem({ ...context, operatorTask: { enabled: false } }, input);
    expect(readField(content, 'operatorTask')).toBe('true');
    expect(readField(content, 'preparedDate')).toBeUndefined();
    expect(content).toContain('## Proof plan');
  });
  it('does not count section headings inside comments or fences', () => {
    for (const digest of [`<!--${brief}-->`, `\`\`\`md\n${brief}\`\`\``]) {
      expect(() => planFileItem(context, { ...input, digest })).toThrow(/Design/);
    }
  });
  it('refuses a dispatched worker or an unknown session role', () => {
    for (const sessionRole of ['worker', 'unknown', undefined]) {
      expect(() => planFileItem({ ...context, sessionRole }, input)).toThrow(/session role/);
    }
    expect(() => planScaffold({ existingIds: [], today: '2026-10-13', dir: '' }, input)).toThrow(/session role/);
    const worker = createFileItemReader({ allocate: () => ({ ok: false, reason: 'test disabled' }), log: () => {}, root: process.cwd(), listFiles: () => [], readPolicy: () => context.operatorTask, readTip: () => context.originMainSha, env: { WE_CONVEYOR_WORKER: '1' } })();
    expect(worker.sessionRole).toBe('worker');
    expect(() => planFileItem(worker, input)).toThrow(/session role "worker"/);
  });
});

// Operator send-back on PR 5242, 2026-10-15 item 2: the operator authority work (the operatorInstruction record,
// hasOperatorRecord gating, and the queue, dispatch-plan and probation changes) is card xqqmw6g, not this PR.
describe('operator authority is not part of this feature (card xqqmw6g)', () => {
  it('file-item declares no operator record or explicit priority flags', () => {
    const declaration = fileItemOperation({ readScaffoldContext: () => context });
    for (const flag of ['--operatorActor=chalbert', '--operatorChannel=console', '--operatorWords=go', '--priority=P0']) {
      expect(parseOperationArgv(declaration, ['--title=T', flag]).errors.join('\n')).toMatch(/unknown flag/);
    }
  });
  it('filing writes no operator record, filing marker or priority', () => {
    const { content } = planFileItem(context, input);
    expect(content).not.toMatch(/^(operatorInstruction|preparedBy|priority):/m);
  });
  it('the operator-task module exports no operator record helpers', () => {
    expect(Object.keys(operatorTaskModule)).not.toEqual(expect.arrayContaining(['hasOperatorRecord']));
    expect(Object.keys(operatorTaskModule)).not.toEqual(expect.arrayContaining(['validateOperatorInstruction']));
  });
  it('the report step needs only operatorTask: true and the enabled switch', () => {
    const settings = { operatorTask: { enabled: true } };
    expect(composeOperatorTaskBrief(template, { operatorTask: true, report: true }, { settings })).toContain('<!-- operator-task-report -->');
    expect(composeOperatorTaskBrief(template, { operatorTask: true, report: true }, { settings: { operatorTask: { enabled: false } } })).toBe(template);
  });
});

describe('operator task settings', () => {
  it('resolves admission and post-build leaves together, retaining defaults for invalid overrides', () => {
    expect(resolveOperatorTaskSettings({
      platform: { operatorTask: { enabled: false, postBuild: { edgeLoad: false, report: false } } },
      tool: { operatorTask: { enabled: true, postBuild: { edgeLoad: 'yes', liveProof: false, report: true } } },
    })).toMatchObject({
      value: { enabled: true, postBuild: { edgeLoad: false, liveProof: false, report: true } },
      sources: { enabled: 'tool', 'postBuild.edgeLoad': 'platform',
        'postBuild.liveProof': 'tool', 'postBuild.report': 'tool' },
      invalid: ['tool.postBuild.edgeLoad="yes"'],
    });
    expect(resolveOperatorTaskSettings().value).toEqual({ enabled: true,
      postBuild: { edgeLoad: false, liveProof: false, report: true } });
  });
  it('cascades valid leaves and logs their source', () => {
    expect(resolveOperatorTaskSettings({ platform: { operatorTask: { enabled: false } },
      tool: { operatorTask: { enabled: 'typo' } } })).toMatchObject({
      value: { enabled: false }, sources: { enabled: 'platform' } });
    expect(readOperatorTaskSettings({ env: {}, read: () => ({ build: { operatorTask: { enabled: false } } }) })).toMatchObject({ enabled: false });
  });
});


describe('operator filing IO', () => {
  it('reads origin/main independently of the lane HEAD and stamps the ET day', async () => {
    await withRealRepo(async ({ root, git, head, commit }) => {
      const tip = head();
      git(['update-ref', 'refs/remotes/origin/main', tip]);
      commit({ 'README.md': '# lane change\n' });
      expect(head()).not.toBe(tip);
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-14T02:00:00Z'));
      try {
        const read = createFileItemReader({ allocate: () => ({ ok: false, reason: 'test disabled' }), log: () => {}, root, listFiles: () => [], readPolicy: () => context.operatorTask, env: {} })();
        expect(read.today).toBe('2026-10-13');
        expect(read.originMainSha).toBe(tip);
        expect(readField(planFileItem(read, input).content, 'preparedAgainstSha')).toBe(tip);
      } finally { vi.useRealTimers(); }
    });
  });
  it('logs the effective value and source of each policy leaf', () => {
    resetCascadeLogForTest();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      readOperatorTaskSettings({ env: { WE_POLICY_CASCADE_LOG: '1' },
        read: () => ({ build: { operatorTask: { enabled: false } } }) });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('build.operatorTask: enabled=false (tool)'));
    } finally { log.mockRestore(); resetCascadeLogForTest(); }
  });
});

const ctx = { projectById: new Map(), graduatedKinds: new Set(), knownNums: new Set(), reportExists: () => true };
const item = { id: '123-test', title: 'Test', kind: 'story', size: 1, status: 'open', summary: 'Test.', dateOpened: '2026-10-13' };
const errors = fields => validateBacklogItem({ ...item, ...fields }, ctx).errors.map(e => e.message).join('\n');
const template = 'open-pr\n### 9. Append a structured learnings entry\nEXIT';
const tickFor = (items, { num = '123', groupMembers } = {}) => readTick({
  root: process.cwd(), num, ...(groupMembers ? { groupMembers } : {}),
  runNode: () => JSON.stringify({ decisions: { spawnBuilds: [{ num, lane: 16 }] }, nextState: { tick: 1 } }),
  readText: path => readFileSync(path, 'utf8'),
  loadItems: () => items,
  listAgents: () => [], checkAlreadyDone: () => ({ done: false, checked: true }), checkBuildDelivery: () => null,
  readDeliveryAgentOverride: () => null,
});
describe('operator task post-build', () => {
  // Operator send-back 2026-10-15: edge-load and live-proof steps are off for every card until their authority is
  // verified (card xqqmw6g); only the report step can still be composed.
  it('never emits an edge-load or live-proof step, even for an operator card with every leaf on', () => {
    const settings = { operatorTask: { enabled: true, edgeClones: { review: 'daemon/review' }, postBuild: { edgeLoad: true, liveProof: true, report: true } } };
    const requestedAll = { ...OP, edgeClone: 'review', liveProof: { command: 'printf ready', expect: 'ready' } };
    expect(planOperatorPostBuild(requestedAll, { settings, enabled: true, policy: { edgeLoad: true, liveProof: true, report: true } })).toEqual([]);
    expect(composeOperatorTaskBrief(template, requestedAll, { settings })).toBe(template);
    const withReport = composeOperatorTaskBrief(template, { ...requestedAll, report: true }, { settings });
    expect(withReport).toContain('<!-- operator-task-report -->');
    expect(withReport).not.toMatch(/\*\*(Edge|Proof)\.\*\*|printf ready|daemon-load-overlay/);
  });
  const header = '### 8a. Operator post-build (generated by we:scripts/worker-brief.mjs)\n\nUse the exact ref and PR returned by open-pr above. Complete these steps before exiting, including on a parked PR.\n\n';
  it.each(['$$', "$'", '$&', '$`', '$1', '$<x>'])('inserts %s in a post-build step literally', token => {
    const step = `**Proof.** before ${token} after`;
    expect(composeOperatorTaskBrief(template, {}, { steps: [step] })).toBe(`open-pr\n${header}${step}\n### 9. Append a structured learnings entry\nEXIT`);
  });
  // The live-proof renderer is kept (off in planOperatorPostBuild), so its text is fed to compose as steps.
  it.each(['$$', "$'", '$&', '$`'].flatMap(token =>
    ['command', 'expect'].map(field => ({ token, field }))))('preserves $token literally in liveProof.$field', ({ token, field }) => {
    const liveProof = { command: 'printf ready', expect: 'ready', [field]: `before ${token} after` };
    const output = composeOperatorTaskBrief(template, {}, { steps: [renderOperatorProofStep(liveProof)] });
    expect(output).toContain(`~~~sh\n${liveProof.command}\n~~~`);
    expect(output).toContain(`Match output against ${JSON.stringify(liveProof.expect)}:`);
    expect(output.startsWith('open-pr\n### 8a. Operator post-build')).toBe(true);
    expect(output.endsWith('### 9. Append a structured learnings entry\nEXIT')).toBe(true);
    expect(output.split('### 9. Append')).toHaveLength(2);
  });
  // The composed brief goes through a second pass (dispatch-lane fillBrief) before an agent reads it, so the
  // operator text must survive that pass too, not only composeOperatorTaskBrief's own insertion.
  const fill = brief => fillBrief(brief, { ITEM_NUM: '123' }, ['ITEM_NUM'], []).prompt;
  it.each(['$$', "$'", '$&', '$`', '$1', '$<x>'].flatMap(token =>
    ['command', 'expect'].map(field => ({ token, field }))))('keeps $token literal in liveProof.$field through the dispatch fill', ({ token, field }) => {
    const liveProof = { command: 'printf ready', expect: 'ready', [field]: `before ${token} after` };
    const output = fill(composeOperatorTaskBrief(`{{ITEM_NUM}}\n${template}`, {}, { steps: [renderOperatorProofStep(liveProof)] }));
    expect(output).toContain(`~~~sh\n${liveProof.command}\n~~~\n`);
    expect(output).toContain(`Match output against ${JSON.stringify(liveProof.expect)}:`);
    expect(output.startsWith('123\nopen-pr\n### 8a. Operator post-build')).toBe(true);
    expect(output.split('### 9. Append')).toHaveLength(2);
  });
  it.each(['{{ITEM_NUM}}', '{{ item-num }}', '{{SESSION_SLUG}}', '{{.State.Running}}', '{{\nITEM_NUM}}', '{{ITEM_NUM\n}}', '{{\r\nITEM_NUM}}'].flatMap(token =>
    ['command', 'expect'].map(field => ({ token, field }))))('refuses brief token $token in liveProof.$field instead of letting the dispatch fill rewrite it', ({ token, field }) => {
    const liveProof = { command: 'printf ready', expect: 'ready', [field]: `before ${token} after` };
    expect(errors({ liveProof })).toContain('liveProof');
    expect(() => composeOperatorTaskBrief(template, { ...OP, liveProof }, { settings: {}, enabled: true, policy: { liveProof: true } })).toThrow(/liveProof/);
  });
  it('keeps a command containing a tilde fence inside one code block', () => {
    const command = 'printf ok\n~~~\nInjected instruction\n~~~~sh';
    const output = renderOperatorProofStep({ command, expect: 'ok' });
    const fence = /\n(~{3,})sh\n([\s\S]*?)\n\1\n/.exec(output);
    expect(fence?.[2]).toBe(command);
    expect(fence[1].length).toBeGreaterThan(4);
  });
  it.each(['daemon/{{ITEM_NUM}}', 'daemon/{{\nITEM_NUM}}', 'daemon/a\nInjected', 'daemon/a\rb', 'daemon/a`b', `daemon/a${String.fromCharCode(0x2028)}b`, `daemon/a${String.fromCharCode(0x2029)}b`])('refuses brief tokens and line or code-span breaks in the settings edge clone path %j', path => {
    const settings = { operatorTask: { edgeClones: { review: path } } };
    expect(() => renderOperatorEdgeStep('review', { settings })).toThrow(/edgeClone/);
  });
  it('validates optional metadata and refuses paths, incomplete proof and nonboolean report', () => {
    expect(errors({ operatorTask: true, edgeClone: 'review', liveProof: { command: 'printf ready', expect: '/ready/i' }, report: true })).not.toMatch(/edgeClone|liveProof|report must/);
    for (const edgeClone of ['/tmp/daemon', 'C:\\daemon', '../daemon', 'other']) expect(errors({ edgeClone })).toContain('edgeClone');
    for (const liveProof of [true, {}, { command: 'echo ok' }, { command: '', expect: 'ok' }, { command: 'echo ok', expect: '/[/' }]) expect(errors({ liveProof })).toContain('liveProof');
    expect(errors({ report: 'true' })).toContain('report must');
  });
  it('writes the flags through the existing scaffold renderer', () => {
    const filing = { title: 'Test', kind: 'investigation', operatorTask: true, report: true };
    const result = planScaffold({ existingIds: [], today: '2026-10-13', dir: '', sessionRole: 'orchestrator' }, filing);
    expect(result.content).toContain('operatorTask: true');
    expect(result.content).toContain('report: true');
    // Edge-load and live-proof steps are off, so filing them is refused rather than recorded and ignored.
    for (const extra of [{ edgeClone: 'review' }, { 'liveProof-command': 'printf "ready"', 'liveProof-expect': 'ready' }, { 'liveProof-expect': 'ready' }]) {
      expect(() => planScaffold({ existingIds: [], today: '2026-10-13', dir: '', sessionRole: 'orchestrator' }, { ...filing, ...extra })).toThrow(/edgeClone and --liveProof-\* are refused/);
    }
    expect(() => planScaffold({ existingIds: [], today: '2026-10-13' }, { title: 'Test', kind: 'investigation', edgeClone: '/tmp/daemon' })).toThrow(/edgeClone/);
    expect(() => planScaffold({ existingIds: [], today: '2026-10-13' }, { title: 'Test', kind: 'investigation', report: true })).toThrow(/require operatorTask: true/);
  });
  it('adds only the requested report step after open-pr and before exit', () => {
    const settings = { operatorTask: { enabled: true, edgeClones: { review: 'daemon/review' }, postBuild: { edgeLoad: true, liveProof: true, report: true } } };
    const op = fields => ({ ...OP, ...fields });
    expect(composeOperatorTaskBrief(template, op({}), { settings })).toBe(template);
    const brief = composeOperatorTaskBrief(template, op({ edgeClone: 'review', liveProof: { command: 'printf ready', expect: 'ready' }, report: true }), { settings });
    expect(brief.indexOf('<!-- operator-task-report -->')).toBeGreaterThan(brief.indexOf('open-pr'));
    expect(brief.indexOf('<!-- operator-task-report -->')).toBeLessThan(brief.indexOf('### 9. Append'));
    expect(brief).not.toMatch(/\*\*(Edge|Proof)\.\*\*|printf ready|daemon-load-overlay/);
    // Edge-load or live-proof alone composes nothing.
    expect(composeOperatorTaskBrief(template, op({ edgeClone: 'review' }), { settings })).toBe(template);
    expect(composeOperatorTaskBrief(template, op({ liveProof: { command: 'printf ready', expect: 'ready' } }), { settings })).toBe(template);
    // The kept renderers still produce the steps, for the card that re-enables them.
    expect(renderOperatorEdgeStep('review', { settings })).toContain('daemon-load-overlay.mjs');
    expect(renderOperatorProofStep({ command: 'printf ready', expect: 'ready' })).toContain('after adoption');
    expect(composeOperatorTaskBrief(template, op({ report: false }), { settings })).toBe(template);
    expect(composeOperatorTaskBrief(template, op({ report: true }), { settings, policy: { edgeLoad: false, liveProof: false, report: false } })).toBe(template);
    // A non-build kind (the prepare that repairs a card) never composes steps.
    expect(composeOperatorTaskBrief(template, op({ report: true }), { settings, kind: 'prepare' })).toBe(template);
  });
  // Card frontmatter alone never adds a post-build step: the card must be an operator task and operator tasks
  // must be enabled (build.operatorTask.enabled), in addition to the per-step policy leaf.
  const requested = { edgeClone: 'review', liveProof: { command: 'printf ready', expect: 'ready' }, report: true };
  const allSteps = { edgeLoad: true, liveProof: true, report: true };
  it.each([['a card without operatorTask', {}], ['operatorTask: false', { operatorTask: false }]])('refuses requested post-build steps on %s instead of composing them', (_label, flag) => {
    const settings = { operatorTask: { enabled: true, edgeClones: { review: 'daemon/review' } } };
    for (const fields of [{ ...requested, ...flag }, { report: true, ...flag }, { edgeClone: 'review', ...flag }, { liveProof: requested.liveProof, ...flag }]) {
      expect(errors(fields)).toContain('require operatorTask: true');
      expect(() => composeOperatorTaskBrief(template, fields, { settings, policy: allSteps })).toThrow(/require operatorTask: true/);
    }
    expect(composeOperatorTaskBrief(template, { report: false, ...flag }, { settings, policy: allSteps })).toBe(template);
  });
  it('adds no edge-load, live-proof or report step while build.operatorTask.enabled=false', () => {
    const settings = { operatorTask: { enabled: false, edgeClones: { review: 'daemon/review' } } };
    expect(composeOperatorTaskBrief(template, { operatorTask: true, ...requested }, { settings })).toBe(template);
    expect(composeOperatorTaskBrief(template, { operatorTask: true, ...requested }, { settings, policy: allSteps })).toBe(template);
  });
  it('resolves each policy leaf through the cascade and logs sources', () => {
    const lines = [];
    const p = resolveOperatorPostBuild({ operatorTask: { postBuild: { report: false } } }, { platform: { operatorTask: { postBuild: { edgeLoad: true } } }, env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => lines.push(line) });
    expect(p).toEqual({ edgeLoad: true, liveProof: false, report: false });
    expect(lines.join('\n')).toContain('postBuild.report=false (tool)');
  });
  it('carries real filing inputs and loaded metadata through dispatch and provider selection', () => {
    const declaration = fileItemOperation({ readScaffoldContext: () => context });
    const registry = createRegistry();
    registry.register(declaration);
    const parsed = parseOperationArgv(declaration, ['--title=we: operator report', '--kind=investigation',
      '--operatorTask', '--scope=we:scripts/example.mjs', `--digest=${brief}`, '--report']);
    expect(parsed.errors).toEqual([]);
    const run = advanceWhileRunning(startRun({ op: 'file-item', id: 'operator-file', registry, input: parsed.input }), { registry });
    expect(readField(run.verdict.content, 'preparedDate')).toBe(context.today);
    expect(readField(run.verdict.content, 'preparedAgainstSha')).toBe(context.originMainSha);
    expect(run.verdict.content).toContain('operatorTask: true');
    expect(run.verdict.content).toContain('report: true');
    expect(run.verdict.content).not.toMatch(/edgeClone|liveProof/);
    // A card requesting a post-build step without operatorTask: true is refused, never silently composed.
    expect(() => tickFor([{ num: '123', slug: 'test', report: true, scope: ['we:scripts/worker-brief.mjs'] }])).toThrow(/require operatorTask: true/);
    const operatorRaw = tickFor([{ num: '123', slug: 'test', ...OP, report: true, scope: ['we:scripts/worker-brief.mjs'] }]);
    expect(operatorRaw.item.report).toBe(true);
    const shaped = shapeDispatchRead(operatorRaw, { num: '123' });
    expect(shaped.prompt).toContain('<!-- operator-task-report -->');
    expect(shaped.operatorPostBuild).toBe(true);
    let seen;
    expect(routeDispatchProvider({ launchKind: 'build', operatorPostBuild: shaped.operatorPostBuild, prompt: shaped.prompt }, {
      modes: { build: 'mechanical' }, registry: { build: { provider: () => { throw new Error('wrapper loses post-build brief'); } } },
      agent: request => { seen = request; return 'agent-handle'; },
    })).toBe('agent-handle');
    expect(seen.prompt).toBe(shaped.prompt);
  });
  // The route flag crosses three hops with no shared type: readTick's verdict -> shapeDispatchRead -> the
  // dispatch-lane effect payload -> createDispatchSinks' provider request. Run the real chain (default sink router,
  // stub spawner) on two non-agent routes: build forced mechanical, and the routing policy's own codex route for a
  // docs-only card under default modes (the path production takes). A hop that drops the flag, or an operator check
  // moved below the policy branch, sends the card to the wrapper, which cannot post the report. The ordinary card is
  // the control: it must reach the wrapper.
  async function dispatchOperatorCard(extra, { scope = ['we:scripts/worker-brief.mjs'], modes = { build: 'mechanical' } } = {}) {
    const num = '9101';
    const registry = createRegistry();
    registry.register(dispatchLaneOperation({
      readTick: asked => readTick({
        ...asked,
        runNode: () => JSON.stringify({
          decisions: { spawnBuilds: [{ num, lane: 4 }], spawnPrepareScope: [], spawnPrepareDecision: [], spawnInvestigations: [],
            spawnFixes: [], spawnCiHeals: [], suppressedBuilds: [], statusLine: '', notes: [] },
          nextState: { tick: 1, buildGuards: [{ num, lane: 4, spawnedTick: 0 }] },
        }),
        readText: path => readFileSync(path, 'utf8'),
        loadItems: () => [{ num, slug: 'operator-route', scope, size: 3, ...extra }],
        listInFlightDispatches: () => ({ runs: [], unreadable: 0 }),
        listAgents: () => [],
        checkAlreadyDone: () => ({ done: false, pr: null, checked: false }),
        checkBuildDelivery: () => null,
        readScorecards: () => [],
        readDeliveryAgentOverride: () => null,
        dispatchModes: () => ({}),
      }),
    }));
    const spawned = [];
    const wrapped = [];
    const run = advanceWhileRunning(startRun({ op: DISPATCH_LANE_OP, id: `run-${num}`, input: { num }, registry }), { registry });
    const outcome = await applyPendingEffects(run, {
      sinks: createDispatchSinks({
        root: '/primary/webeverything',
        modes,
        registry: { build: { runScript: 'scripts/operations/fake-wrapper.mjs', provider: request => { wrapped.push(request); return { handle: 'wrapper' }; } } },
        scriptExists: () => true,
        providerAvailable: () => true,
        probationLaunch: 'off',
        reserveLane: () => ({ reserved: false }),
        // The file-writing seams, stubbed as the sibling sink tests do, so nothing is created on disk.
        sessionCwdFor: () => '/primary/.operations/dispatch/sess-9101',
        ensureSessionCwd: dir => dir,
        grantLanePermission: () => {},
        ensureWorktreeIsolation: () => {},
        resolveSettingsEnv: () => null,
        spawnAgent: (argv, opts) => { spawned.push({ argv, opts }); return 'backgrounded · 1ae0905c · x\n'; },
        mintSessionId: () => 'sess-9101',
        now: () => new Date('2026-10-15T10:00:00.000Z'),
      }),
      store: createMemoryRunStore(),
    });
    const effect = outcome.run.effects.find(e => e.type === DISPATCH_EFFECT);
    return { read: run.findings.read, effect, spawned, wrapped };
  }
  it('carries operatorPostBuild from the read verdict through the effect payload to the agent route', async () => {
    const operator = await dispatchOperatorCard({ ...OP, report: true });
    expect(operator.read.operatorPostBuild).toBe(true);
    expect(operator.effect.payload.operatorPostBuild).toBe(true);
    // The read-to-payload hop copies each route-relevant key by hand; a dropped line changes where the card runs.
    for (const key of ['num', 'launchKind', 'lane', 'sessionSlug', 'scope', 'groupMembers', 'prompt', 'routing', 'taskType']) {
      expect(operator.read[key], `read.${key}`).not.toBeUndefined();
      expect(operator.effect.payload[key], `payload.${key}`).toEqual(operator.read[key] ?? null);
    }
    expect(operator.wrapped).toEqual([]);
    expect(operator.spawned).toHaveLength(1);
    expect(operator.spawned[0].argv.join('\n')).toContain('<!-- operator-task-report -->');
    // Control: the same card without the report step takes the mechanical wrapper, with the flag false on every hop.
    const ordinary = await dispatchOperatorCard({ ...OP, report: false });
    expect(ordinary.read.operatorPostBuild).toBe(false);
    expect(ordinary.effect.payload.operatorPostBuild).toBe(false);
    expect(ordinary.spawned).toEqual([]);
    expect(ordinary.wrapped).toHaveLength(1);
    expect(ordinary.wrapped[0].operatorPostBuild).toBe(false);
  });
  it('sends an operator report card to the agent even when the routing policy picks a non-Claude worker', async () => {
    // A doc-fix card outside docs/agent/ (which the policy keeps on Claude) routes to codex in the shipped policy.
    const policy = { scope: ['we:docs/operator-route-note.md'], modes: {} };
    const ordinary = await dispatchOperatorCard({ ...OP, report: false }, policy);
    // Control: under default modes the policy's own route takes the docs-only card to the wrapper.
    expect(ordinary.effect.payload.routing?.policyRoute?.provider).toBe('codex');
    expect(ordinary.spawned).toEqual([]);
    expect(ordinary.wrapped).toHaveLength(1);
    const operator = await dispatchOperatorCard({ ...OP, report: true }, policy);
    expect(operator.effect.payload.routing?.policyRoute?.provider).toBe('codex');
    expect(operator.effect.payload.operatorPostBuild).toBe(true);
    expect(operator.wrapped).toEqual([]);
    expect(operator.spawned).toHaveLength(1);
    expect(operator.spawned[0].argv.join('\n')).toContain('<!-- operator-task-report -->');
  });
  // The sink hop on its own: a build effect payload goes straight into createDispatchSinks, and the provider request
  // the sink builds is recorded before the real router sees it. Pins the line that copies payload.operatorPostBuild
  // onto the request (dispatch-lane-io.mjs) and its strict `=== true`: only a boolean true is a route flag.
  async function sinkRequestFor(payloadExtra, { modes = { build: 'mechanical' }, routing } = {}) {
    const requests = [];
    const agentLaunches = [];
    const wrapped = [];
    const registry = { build: { runScript: 'scripts/operations/fake-wrapper.mjs', provider: request => { wrapped.push(request); return { handle: 'wrapper' }; } } };
    const sinks = createDispatchSinks({
      root: '/primary/webeverything',
      provider: request => {
        requests.push(request);
        return routeDispatchProvider(request, { modes, registry, scriptExists: () => true, providerAvailable: () => true,
          agent: r => { agentLaunches.push(r); return 'agent-handle'; } });
      },
      reserveLane: () => ({ reserved: false }),
      sessionCwdFor: () => '/primary/.operations/dispatch/sess-9102',
      ensureSessionCwd: dir => dir,
      resolveLaneGrant: () => ({}),
      grantLanePermission: () => {},
      ensureWorktreeIsolation: () => {},
      resolveSettingsEnv: () => null,
      mintSessionId: () => 'sess-9102',
      now: () => new Date('2026-10-15T10:00:00.000Z'),
    });
    await sinks[DISPATCH_EFFECT]({ num: '9102', launchKind: 'build', lane: 4, sessionSlug: 'conveyor-9102',
      scope: ['we:scripts/worker-brief.mjs'], prompt: 'brief', routing, ...payloadExtra }, { runId: 'run-9102', key: 'dispatch' });
    expect(requests).toHaveLength(1);
    return { request: requests[0], agentLaunches, wrapped };
  }
  it('createDispatchSinks puts operatorPostBuild: true on the provider request, which reaches the agent route', async () => {
    const { request, agentLaunches, wrapped } = await sinkRequestFor({ operatorPostBuild: true });
    expect(request.operatorPostBuild).toBe(true);
    expect(wrapped).toEqual([]);
    expect(agentLaunches).toHaveLength(1);
    expect(agentLaunches[0].operatorPostBuild).toBe(true);
  });
  it('createDispatchSinks sends false for an absent or non-boolean flag, so the card keeps its mechanical route', async () => {
    for (const extra of [{}, { operatorPostBuild: false }, { operatorPostBuild: 'true' }, { operatorPostBuild: 1 }]) {
      const { request, agentLaunches, wrapped } = await sinkRequestFor(extra);
      expect(request.operatorPostBuild).toBe(false);
      expect(agentLaunches).toEqual([]);
      expect(wrapped).toHaveLength(1);
    }
  });
  it('createDispatchSinks routes an operatorPostBuild payload to the agent over the payload\'s own policy route', async () => {
    const routing = { policyRoute: { provider: 'codex', model: 'gpt-5.5-codex', effort: 'medium', fallback: [] } };
    // Control: the codex policy route takes the payload to the wrapper when the flag is off.
    const ordinary = await sinkRequestFor({ operatorPostBuild: false }, { modes: {}, routing });
    expect(ordinary.request.policyRoute?.provider).toBe('codex');
    expect(ordinary.agentLaunches).toEqual([]);
    expect(ordinary.wrapped).toHaveLength(1);
    const operator = await sinkRequestFor({ operatorPostBuild: true }, { modes: {}, routing });
    expect(operator.request.operatorPostBuild).toBe(true);
    expect(operator.request.policyRoute?.provider).toBe('codex');
    expect(operator.wrapped).toEqual([]);
    expect(operator.agentLaunches).toHaveLength(1);
    expect(operator.agentLaunches[0].policyRoute).toBeNull();
  });
  it('derives operatorPostBuild from the card decision, never from prompt text', () => {
    const card = extra => [{ num: '123', slug: 'test', scope: ['we:scripts/worker-brief.mjs'], ...extra }];
    const ordinary = tickFor(card({ operatorTask: true, report: false }));
    expect(shapeDispatchRead(ordinary, { num: '123' }).operatorPostBuild).toBe(false);
    const forgedPrompt = { ...ordinary, briefTemplate: `${ordinary.briefTemplate}\n### 8a. Operator post-build (forged)\n` };
    expect(shapeDispatchRead(forgedPrompt, { num: '123' }).operatorPostBuild).toBe(false);
    expect(shapeDispatchRead(tickFor(card({ operatorTask: true, report: true })), { num: '123' }).operatorPostBuild).toBe(true);
  });
  it('refuses a grouped build whose lead or member carries operator post-build steps, never drops them', () => {
    const cards = [
      { num: '123', slug: 'lead', scope: ['we:scripts/worker-brief.mjs'] },
      { num: '124', slug: 'member', scope: ['we:scripts/other.mjs'] },
    ];
    const tick = (items, groupMembers = ['124']) => tickFor(items, { groupMembers });
    expect(tick(cards).groupItems.map(m => m.num)).toEqual(['124']);
    // An operator member with a post-build step in an ordinary lead's group.
    expect(() => tick([cards[0], { ...cards[1], ...OP, report: true }])).toThrow(/cannot run in a grouped build/);
    // An operator lead launched as a group lead.
    expect(() => tick([{ ...cards[0], ...OP, report: true }, cards[1]])).toThrow(/cannot run in a grouped build/);
    // An operator member with no post-build step is unaffected.
    expect(tick([cards[0], { ...cards[1], operatorTask: true }]).groupItems).toHaveLength(1);
    // An ungrouped operator build is unaffected.
    expect(tick([{ ...cards[0], ...OP, report: true }, cards[1]], []).operatorPostBuild).toBe(true);
  });
});

describe('operator report', () => {
  it('formats a stable report in at most eight lines without marker injection', () => {
    const report = renderOperatorReport({ pr: 42, adoptionSha: 'abc', proof: 'PASS\nextra' });
    expect(report.split('\n')[0]).toBe('<!-- operator-task-report -->');
    expect(report.split('\n').length).toBeLessThanOrEqual(8);
    expect(report).toContain('PR: 42');
    expect(report).toContain('Adoption SHA: abc');
    expect(report).toContain('Proof: PASS extra');
  });
});
