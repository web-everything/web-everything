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
  const items = [card('1'), card('2', { operatorTask: true, priority: 'P0' })];
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
});

describe('operator task settings', () => {
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
