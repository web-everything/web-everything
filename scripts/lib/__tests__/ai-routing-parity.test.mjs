import { describe, expect, it } from 'vitest';
import { AI_ROUTING_ROLES, resolveAiRouting, aiRoutingInputs } from '../ai-routing.mjs';
import { DEFAULT_ROUTING_POLICY, applyRoutingOverrides, resolveOperationRoute } from '../dispatch-routing-policy.mjs';
import { resolveCodexTaskRoute } from '../codex-task-route.mjs';
import { resolveFixExecutorChain, pickChainRung } from '../fix-executor-chain.mjs';
import { chooseFixExecutor } from '../fix-slot-borrow.mjs';
import { workerTierFor } from '../provider-routing.mjs';
import { criticalWorkVerdict } from '../critical-work.mjs';

const roles = ['review', 'red-team', 'red-team-recheck', 'fix', 'build', 'prepare', 'ci-heal', 'worker', 'judge', 'helper'];
const operationFor = role => ({ review: 'review-seat', 'red-team': 'review-seat',
  'red-team-recheck': 'review-recheck', prepare: 'prepare-item', helper: 'precedent-draft' }[role] ?? role);
const kindFor = role => ['review', 'red-team', 'red-team-recheck', 'judge'].includes(role)
  ? 'review' : role === 'helper' ? 'worker' : role;
const outcome = run => {
  try { return { returned: run() }; }
  catch (error) { return { threw: { name: error.name, message: error.message } }; }
};

// Full Cartesian product, including both operation-wide and task-specific operator keys.
const dimensions = {
  gateClosed: [false, true], codexHeld: [false, true], vetoed: [false, true],
  operator: ['none', 'op', 'op:task'], builderClaude: [false, true], critical: [false, true],
  takeover: [false, true], daemonLabel: [false, true], smallPrepare: [false, true],
};
const matrix = Object.entries(dimensions).reduce((rows, [key, values]) =>
  rows.flatMap(row => values.map(value => ({ ...row, [key]: value }))), [{}]);

describe('aiRouting inheritance parity', () => {
  it('pins all ten roles and the complete design matrix', () => {
    expect(AI_ROUTING_ROLES).toEqual(roles);
    expect(matrix).toHaveLength(768);
  });

  it.each(roles)('%s: empty settings preserve resolver outputs across the full matrix', role => {
    const resolved = resolveAiRouting({ tool: {}, platform: {}, env: {}, log: false, accountMap: { accounts: {} } });
    const inputs = aiRoutingInputs(role, resolved);
    expect(inputs.coordinator).toBeUndefined();
    expect(inputs.executors).toBeUndefined();

    for (const row of matrix) {
      const context = `${role}: ${JSON.stringify(row)}`;
      const operation = operationFor(role);
      const taskType = role === 'red-team' ? 'red-team' : 'doc-fix';
      const key = row.operator === 'op:task' ? `${operation}:${taskType}` : operation;
      // Add a valid scoped entry to exercise the same lookup shapes for every role.
      const base = structuredClone(DEFAULT_ROUTING_POLICY);
      base.operations[operation] ??= { inherit: true };
      base.operations[`${operation}:${taskType}`] ??= { inherit: true };
      const operatorKeys = row.operator === 'none' ? [] : [key];
      const policy = applyRoutingOverrides(base, row.operator === 'none' ? {} : {
        [key]: { provider: operation === 'review-seat' ? 'agy-claude' : 'claude', model: 'sonnet', effort: 'high', fallback: [] },
      });
      const vetoes = row.vetoed ? [{ provider: 'codex', model: 'gpt-6.1-sol' },
        { provider: 'codex', model: 'gpt-6-astra' }] : [];
      const operationOptions = {
        operation, taskType, policy, operatorKeys, gateClosed: row.gateClosed,
        availability: row.codexHeld ? { codex: 'quota held' } : {}, vetoes,
        ...(row.smallPrepare ? { size: 1, designQuestion: false, wellScoped: true }
          : { size: 8, designQuestion: true, wellScoped: false }),
      };
      expect(outcome(() => resolveOperationRoute({ ...operationOptions, aiRouting: inputs.coordinator })), context)
        .toEqual(outcome(() => resolveOperationRoute(operationOptions)));

      const codexOptions = { kind: row.takeover ? 'takeover' : kindFor(role),
        size: row.smallPrepare ? 1 : 8, vetoes, tool: {}, platform: {}, env: {}, log: false };
      expect(outcome(() => resolveCodexTaskRoute({ ...codexOptions, aiRouting: inputs.coordinator })), context)
        .toEqual(outcome(() => resolveCodexTaskRoute(codexOptions)));

      const chainOptions = { env: {}, platform: {}, repo: { routing: { builder: row.builderClaude ? 'claude' : 'codex' } } };
      const absent = resolveFixExecutorChain(chainOptions);
      const inherited = resolveFixExecutorChain({ ...chainOptions, aiRouting: inputs.executors });
      expect(inherited, context).toEqual(absent);
      const pickOptions = { critical: row.critical, trigger: row.takeover ? 'takeover' : null,
        launcherAvailable: provider => provider !== 'codex' || !row.codexHeld,
        criticalClaudeFromRung: absent.criticalClaudeFromRung, criticalSource: absent.criticalClaudeFromRungSource };
      expect(pickChainRung({ ...pickOptions, chain: inherited.value }), context)
        .toEqual(pickChainRung({ ...pickOptions, chain: absent.value }));
      const chooseOptions = { critical: row.critical, takeover: row.takeover,
        launcherAvailable: pickOptions.launcherAvailable };
      expect(chooseFixExecutor({ ...chooseOptions, chain: inherited }), context)
        .toEqual(chooseFixExecutor({ ...chooseOptions, chain: absent }));

      // The daemon label is a real tier/critical-work input, never a reason to promote a role.
      const work = { kind: role, taskType, filesTouched: ['blocks/example.ts'],
        scopePaths: ['blocks/example.ts'], tags: row.daemonLabel ? ['daemon'] : [], risk: row.critical ? 'high' : 'low' };
      expect(workerTierFor(work), context).toEqual(workerTierFor({ ...work, tags: [] }));
      expect(criticalWorkVerdict(work), context).toEqual(criticalWorkVerdict({ ...work, tags: [] }));
    }
  });
});
