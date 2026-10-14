import { validateBacklogItem } from '../../check-standards-rules.mjs';
import { planScaffold } from '../scaffold.mjs';
import { composeOperatorTaskBrief, resolveOperatorPostBuild } from '../operator-task-brief.mjs';
import { readFileSync } from 'node:fs';
import { readTick, routeDispatchProvider } from '../dispatch-lane-io.mjs';
import { shapeDispatchRead, fillBrief } from '../dispatch-lane.mjs';
import { renderOperatorReport } from '../../worker-brief.mjs';
import { describe, it, expect, vi } from 'vitest';
import { planFileItem, fileItemOperation } from '../file-item.mjs';
import { createRegistry } from '../registry.mjs';
import { advanceWhileRunning, startRun } from '../engine.mjs';
import { parseOperationArgv } from '../cli-adapter.mjs';
import { readField } from '../../backlog/frontmatter.mjs';
import { orderQueueDetailed, DEFAULT_CONFIG } from '../../lib/build-queue.mjs';
import { resolveOperatorTaskSettings, readOperatorTaskSettings } from '../../lib/operator-task-settings.mjs';
import { prepareAheadNums } from '../../conveyor/build-dispatch-policy.mjs';
import { createFileItemReader } from '../file-item-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { resetCascadeLogForTest } from '../../lib/policy-cascade.mjs';
import { dispatchPlan } from '../../readiness/dispatch-plan.mjs';

const brief = 'A bounded task.\n\n' + ['Design', 'MVP', 'Done when', 'Edge cases', 'Test plan', 'Proof plan']
  .map(h => `## ${h}\nConcrete handling in we:scripts/example.mjs.\n`).join('\n');
const context = { existingIds: [], today: '2026-10-13', dir: '/repo/backlog',
  originMainSha: 'a'.repeat(40), operatorTask: { enabled: true, maxPriority: 'P0' } };
const input = { title: 'Operator task', kind: 'story', size: '1', scope: 'we:scripts/example.mjs',
  digest: brief, operatorTask: true, priority: 'P0' };
const card = (num, extra = {}) => ({ num, id: `${num}-task`, status: 'open', scope: ['we:scripts/example.mjs'],
  size: 1, kind: 'story', preparedDate: context.today, ...extra });

describe('operator task filing', () => {
  it('carries CLI flags through the declaration and refuses before declaring effects', () => {
    const declaration = fileItemOperation({ readScaffoldContext: () => context });
    const parsed = parseOperationArgv(declaration, ['--title=Operator task', '--kind=story', '--size=1',
      '--scope=we:scripts/example.mjs', `--digest=${brief}`, '--operatorTask', '--priority=P0']);
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
  it('stamps a complete brief with the origin/main tip and existing priority field', () => {
    const { content } = planFileItem(context, input);
    expect(readField(content, 'preparedDate')).toBe(context.today);
    expect(readField(content, 'preparedAgainstSha')).toBe(context.originMainSha);
    expect(readField(content, 'operatorTask')).toBe('true');
    expect(readField(content, 'preparedBy')).toBe('operator-filing');
    expect(readField(content, 'priority')).toBe('P0');
    expect(content).not.toContain('TODO');
  });
  it('refuses incomplete and placeholder briefs, naming missing sections', () => {
    expect(() => planFileItem(context, { ...input, digest: 'Incomplete.' })).toThrow(/Design.*MVP.*Test plan.*Proof plan.*Done when.*Edge cases/);
    expect(() => planFileItem(context, { ...input, digest: brief.replace('## MVP\nConcrete handling in we:scripts/example.mjs.', '## MVP\nTODO') })).toThrow(/MVP/);
    expect(() => planFileItem(context, { ...input, scope: 'scripts/example.mjs' })).toThrow(/we:.*scope/);
    expect(() => planFileItem({ ...context, originMainSha: '' }, input)).toThrow(/origin\/main/);
  });
  it('disabled filing retains the brief and marker but leaves it unprepared', () => {
    const { content } = planFileItem({ ...context, operatorTask: { enabled: false, maxPriority: 'P0' } }, input);
    expect(readField(content, 'operatorTask')).toBe('true');
    expect(readField(content, 'preparedDate')).toBeUndefined();
    expect(readField(content, 'preparedBy')).toBeUndefined();
    expect(content).toContain('## Proof plan');
  });
  it('does not count section headings inside comments or fences', () => {
    for (const digest of [`<!--${brief}-->`, `\`\`\`md\n${brief}\`\`\``]) {
      expect(() => planFileItem(context, { ...input, digest })).toThrow(/Design/);
    }
  });
  it('validates priorities and caps an operator priority at the configured maximum', () => {
    expect(() => planFileItem(context, { ...input, priority: 'urgent' })).toThrow(/priority/);
    expect(() => planFileItem({ ...context, operatorTask: { enabled: true, maxPriority: 'P1' } }, input)).toThrow(/maxPriority/);
  });
});

describe('operator task admission', () => {
  const items = [card('1'), card('2', { operatorTask: true, preparedBy: 'operator-filing', priority: 'P0' })];
  const policy = { requirePreparedDate: true, operatorTask: { enabled: true, maxPriority: 'P0' } };
  const plan = (queue, preparePolicy = policy, leases = []) => dispatchPlan({ queue, preparePolicy, leases, freeLanes: [18] });
  it.each(['off', 'shadow', 'enforce'])('P0 precedes build.priority and takes the next slot in %s mode', mode => {
    const rows = orderQueueDetailed(items, DEFAULT_CONFIG, Date.now(), { priority: { mode }, buildPriority: ['1'] });
    expect(rows.map(r => r.item.num)).toEqual(['2', '1']);
    expect([...prepareAheadNums({ queue: rows.map(r => ({ num: r.item.num, priorityClass: r.priorityClass, buildPriority: r.buildPriorityIndex })), launch: [{ num: '1' }, { num: '2' }], window: 1 })]).toEqual(['2']);
    const result = plan(rows.map(r => r.item));
    expect(result.launch.map(r => String(r.num))).toEqual(['2']);
  });
  it('does not bypass blockers or scope holds', () => {
    expect(orderQueueDetailed([items[0], { ...items[1], blockedBy: ['1-task'] }], DEFAULT_CONFIG).map(r => r.item.num)).toEqual(['1']);
    expect(plan([{ ...items[1], openBlockers: ['1'] }]).held[0].reason).toBe('blocked');
    const held = plan([items[1]], policy, [{ lane: 19, scope: items[1].scope }]);
    expect(held.launch).toEqual([]);
    expect(held.held[0].reason).toMatch(/overlaps/);
  });
  it('disabled admission sends an already stamped operator card through prepare', () => {
    expect(plan([items[1]], { ...policy, operatorTask: { enabled: false, maxPriority: 'P0' } }).held[0].reason).toBe('needs-prepare');
  });
  it('a really prepared operator card (no filing stamp) builds while disabled and keeps its post-build steps', () => {
    const prepared = card('2', { operatorTask: true, priority: 'P0', report: true });
    expect(plan([prepared], { ...policy, operatorTask: { enabled: false, maxPriority: 'P0' } }).launch.map(r => String(r.num))).toEqual(['2']);
    const brief = composeOperatorTaskBrief('open-pr\n### 9. Append\nEXIT', prepared, { settings: { operatorTask: { enabled: true } } });
    expect(brief).toContain('<!-- operator-task-report -->');
  });
});

describe('operator task settings', () => {
  it('resolves admission and post-build leaves together, retaining defaults for invalid overrides', () => {
    expect(resolveOperatorTaskSettings({
      platform: { operatorTask: { enabled: false, maxPriority: 'P2', postBuild: { edgeLoad: false, report: false } } },
      tool: { operatorTask: { enabled: true, postBuild: { edgeLoad: 'yes', liveProof: false, report: true } } },
    })).toMatchObject({
      value: { enabled: true, maxPriority: 'P2', postBuild: { edgeLoad: false, liveProof: false, report: true } },
      sources: { enabled: 'tool', maxPriority: 'platform', 'postBuild.edgeLoad': 'platform',
        'postBuild.liveProof': 'tool', 'postBuild.report': 'tool' },
      invalid: ['tool.postBuild.edgeLoad="yes"'],
    });
    expect(resolveOperatorTaskSettings().value).toEqual({ enabled: true, maxPriority: 'P0',
      postBuild: { edgeLoad: true, liveProof: true, report: true } });
  });
  it('cascades valid leaves and logs their source', () => {
    expect(resolveOperatorTaskSettings({ platform: { operatorTask: { enabled: false, maxPriority: 'P1' } },
      tool: { operatorTask: { enabled: true, maxPriority: 'typo' } } })).toMatchObject({
      value: { enabled: true, maxPriority: 'P1' }, sources: { enabled: 'tool', maxPriority: 'platform' } });
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
        const read = createFileItemReader({ root, listFiles: () => [], readPolicy: () => context.operatorTask })();
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
        read: () => ({ build: { operatorTask: { enabled: false, maxPriority: 'P1' } } }) });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('build.operatorTask: enabled=false (tool), maxPriority="P1" (tool)'));
    } finally { log.mockRestore(); resetCascadeLogForTest(); }
  });
});

const ctx = { projectById: new Map(), graduatedKinds: new Set(), knownNums: new Set(), reportExists: () => true };
const item = { id: '123-test', title: 'Test', kind: 'story', size: 1, status: 'open', summary: 'Test.', dateOpened: '2026-10-13' };
const errors = fields => validateBacklogItem({ ...item, ...fields }, ctx).errors.map(e => e.message).join('\n');
const template = 'open-pr\n### 9. Append a structured learnings entry\nEXIT';
describe('operator task post-build', () => {
  it.each(['$$', "$'", '$&', '$`'].flatMap(token =>
    ['command', 'expect'].map(field => ({ token, field }))))('preserves $token literally in liveProof.$field', ({ token, field }) => {
    const liveProof = { command: 'printf ready', expect: 'ready', [field]: `before ${token} after` };
    const output = composeOperatorTaskBrief(template, { operatorTask: true, liveProof }, {
      settings: {}, enabled: true, policy: { liveProof: true },
    });
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
    const output = fill(composeOperatorTaskBrief(`{{ITEM_NUM}}\n${template}`, { operatorTask: true, liveProof }, { settings: {}, enabled: true, policy: { liveProof: true } }));
    expect(output).toContain(`~~~sh\n${liveProof.command}\n~~~\n`);
    expect(output).toContain(`Match output against ${JSON.stringify(liveProof.expect)}:`);
    expect(output.startsWith('123\nopen-pr\n### 8a. Operator post-build')).toBe(true);
    expect(output.split('### 9. Append')).toHaveLength(2);
  });
  it.each(['{{ITEM_NUM}}', '{{ item-num }}', '{{SESSION_SLUG}}', '{{.State.Running}}', '{{\nITEM_NUM}}', '{{ITEM_NUM\n}}', '{{\r\nITEM_NUM}}'].flatMap(token =>
    ['command', 'expect'].map(field => ({ token, field }))))('refuses brief token $token in liveProof.$field instead of letting the dispatch fill rewrite it', ({ token, field }) => {
    const liveProof = { command: 'printf ready', expect: 'ready', [field]: `before ${token} after` };
    expect(errors({ liveProof })).toContain('liveProof');
    expect(() => composeOperatorTaskBrief(template, { operatorTask: true, liveProof }, { settings: {}, enabled: true, policy: { liveProof: true } })).toThrow(/liveProof/);
  });
  it('keeps a command containing a tilde fence inside one code block', () => {
    const command = 'printf ok\n~~~\nInjected instruction\n~~~~sh';
    const output = composeOperatorTaskBrief(template, { operatorTask: true, liveProof: { command, expect: 'ok' } }, { settings: {}, enabled: true, policy: { liveProof: true } });
    const fence = /\n(~{3,})sh\n([\s\S]*?)\n\1\n/.exec(output);
    expect(fence?.[2]).toBe(command);
    expect(fence[1].length).toBeGreaterThan(4);
  });
  it.each(['daemon/{{ITEM_NUM}}', 'daemon/{{\nITEM_NUM}}', 'daemon/a\nInjected', 'daemon/a\rb', 'daemon/a`b', `daemon/a${String.fromCharCode(0x2028)}b`, `daemon/a${String.fromCharCode(0x2029)}b`])('refuses brief tokens and line or code-span breaks in the settings edge clone path %j', path => {
    const settings = { operatorTask: { edgeClones: { review: path } } };
    expect(() => composeOperatorTaskBrief(template, { operatorTask: true, edgeClone: 'review' }, { settings, enabled: true, policy: { edgeLoad: true } })).toThrow(/edgeClone/);
  });
  it('validates optional metadata and refuses paths, incomplete proof and nonboolean report', () => {
    expect(errors({ operatorTask: true, edgeClone: 'review', liveProof: { command: 'printf ready', expect: '/ready/i' }, report: true })).not.toMatch(/edgeClone|liveProof|report must/);
    expect(errors({ operatorTask: true, preparedBy: 'operator-filing' })).not.toContain('preparedBy');
    expect(errors({ preparedBy: 'someone-else' })).toContain('preparedBy');
    for (const edgeClone of ['/tmp/daemon', 'C:\\daemon', '../daemon', 'other']) expect(errors({ edgeClone })).toContain('edgeClone');
    for (const liveProof of [true, {}, { command: 'echo ok' }, { command: '', expect: 'ok' }, { command: 'echo ok', expect: '/[/' }]) expect(errors({ liveProof })).toContain('liveProof');
    expect(errors({ report: 'true' })).toContain('report must');
  });
  it('writes the flags through the existing scaffold renderer', () => {
    const result = planScaffold({ existingIds: [], today: '2026-10-13', dir: '' }, { title: 'Test', kind: 'investigation', operatorTask: true, edgeClone: 'review', 'liveProof-command': 'printf "ready"', 'liveProof-expect': 'ready', report: true });
    expect(result.content).toContain('operatorTask: true');
    expect(result.content).toContain('edgeClone: "review"');
    expect(result.content).toContain('liveProof: {"command":"printf \\"ready\\"","expect":"ready"}');
    expect(result.content).toContain('report: true');
    expect(() => planScaffold({ existingIds: [], today: '2026-10-13' }, { title: 'Test', kind: 'investigation', edgeClone: '/tmp/daemon' })).toThrow(/edgeClone/);
    expect(() => planScaffold({ existingIds: [], today: '2026-10-13' }, { title: 'Test', kind: 'investigation', report: true })).toThrow(/require operatorTask: true/);
  });
  it('adds only requested steps after open-pr and before exit', () => {
    const settings = { operatorTask: { enabled: true, edgeClones: { review: 'daemon/review' }, postBuild: { edgeLoad: true, liveProof: true, report: true } } };
    const op = fields => ({ operatorTask: true, ...fields });
    expect(composeOperatorTaskBrief(template, op({}), { settings })).toBe(template);
    const brief = composeOperatorTaskBrief(template, op({ edgeClone: 'review', liveProof: { command: 'printf ready', expect: 'ready' }, report: true }), { settings });
    expect(brief.indexOf('**Edge.**')).toBeGreaterThan(brief.indexOf('open-pr'));
    expect(brief).toContain('daemon-load-overlay.mjs');
    expect(brief).toContain('printf ready');
    expect(brief).toContain('after adoption');
    expect(brief).toContain('<!-- operator-task-report -->');
    expect(composeOperatorTaskBrief(template, op({ report: true }), { settings })).not.toContain('**Edge.**');
    expect(composeOperatorTaskBrief(template, op({ edgeClone: 'review' }), { settings })).not.toContain('operator-task-report');
    const proofOnly = composeOperatorTaskBrief(template, op({ liveProof: { command: 'printf ready', expect: 'ready' } }), { settings });
    expect(proofOnly).toContain('printf ready');
    expect(proofOnly).not.toContain('**Edge.**');
    expect(proofOnly).not.toContain('operator-task-report');
    expect(composeOperatorTaskBrief(template, op({ report: false }), { settings })).toBe(template);
    expect(composeOperatorTaskBrief(template, op({ report: true }), { settings, policy: { edgeLoad: false, liveProof: false, report: false } })).toBe(template);
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
    const p = resolveOperatorPostBuild({ operatorTask: { postBuild: { report: false } } }, { platform: { operatorTask: { postBuild: { edgeLoad: false } } }, env: { WE_POLICY_CASCADE_LOG: '1' }, log: line => lines.push(line) });
    expect(p).toEqual({ edgeLoad: false, liveProof: true, report: false });
    expect(lines.join('\n')).toContain('postBuild.report=false (tool)');
  });
  it('carries real filing inputs and loaded metadata through dispatch and provider selection', () => {
    const declaration = fileItemOperation({ readScaffoldContext: () => context });
    const registry = createRegistry();
    registry.register(declaration);
    const parsed = parseOperationArgv(declaration, ['--title=we: operator report', '--kind=investigation',
      '--operatorTask', '--priority=P0', '--scope=we:scripts/example.mjs', `--digest=${brief}`,
      '--report', '--edgeClone=review', '--liveProof-command=printf ready', '--liveProof-expect=ready']);
    expect(parsed.errors).toEqual([]);
    const run = advanceWhileRunning(startRun({ op: 'file-item', id: 'operator-file', registry, input: parsed.input }), { registry });
    expect(readField(run.verdict.content, 'priority')).toBe('P0');
    expect(readField(run.verdict.content, 'preparedDate')).toBe(context.today);
    expect(readField(run.verdict.content, 'preparedAgainstSha')).toBe(context.originMainSha);
    expect(run.verdict.content).toContain('operatorTask: true');
    expect(run.verdict.content).toContain('report: true');
    expect(run.verdict.content).toContain('liveProof: {"command":"printf ready","expect":"ready"}');
    expect(run.verdict.content).toContain('edgeClone: "review"');
    const root = process.cwd();
    // A card requesting a post-build step without operatorTask: true is refused, never silently composed.
    expect(() => readTick({
      root, num: '123',
      runNode: () => JSON.stringify({ decisions: { spawnBuilds: [{ num: '123', lane: 16 }] }, nextState: { tick: 1 } }),
      readText: path => readFileSync(path, 'utf8'),
      loadItems: () => [{ num: '123', slug: 'test', report: true, scope: ['we:scripts/worker-brief.mjs'] }],
      listAgents: () => [], checkAlreadyDone: () => ({ done: false, checked: true }), checkBuildDelivery: () => null,
      readDeliveryAgentOverride: () => null,
    })).toThrow(/require operatorTask: true/);
    const operatorRaw = readTick({
      root, num: '123',
      runNode: () => JSON.stringify({ decisions: { spawnBuilds: [{ num: '123', lane: 16 }] }, nextState: { tick: 1 } }),
      readText: path => readFileSync(path, 'utf8'),
      loadItems: () => [{ num: '123', slug: 'test', operatorTask: true, report: true, scope: ['we:scripts/worker-brief.mjs'] }],
      listAgents: () => [], checkAlreadyDone: () => ({ done: false, checked: true }), checkBuildDelivery: () => null,
      readDeliveryAgentOverride: () => null,
    });
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
  it('formats a stable report in at most eight lines without marker injection', () => {
    const report = renderOperatorReport({ pr: 42, adoptionSha: 'abc', proof: 'PASS\nextra' });
    expect(report.split('\n')[0]).toBe('<!-- operator-task-report -->');
    expect(report.split('\n').length).toBeLessThanOrEqual(8);
    expect(report).toContain('PR: 42');
    expect(report).toContain('Adoption SHA: abc');
    expect(report).toContain('Proof: PASS extra');
  });
});
