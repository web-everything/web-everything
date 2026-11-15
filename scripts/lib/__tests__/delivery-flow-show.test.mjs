import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { deliveryFlowOperation, finishDeliveryFlow } from '../../operations/delivery-flow.mjs';
import { createDeliveryFlowReader } from '../../operations/delivery-flow-io.mjs';
import { resolveOperation } from '../../operations/run.mjs';
import { importGraph } from '../../operations/__tests__/import-graph.mjs';
import { isReadOnlyOperation } from '../../operations/registry.mjs';
import { makeGitOverlay } from '../hermetic-git-overlay.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const assess = (readFlow, input) => deliveryFlowOperation({ readFlow }).steps[0].step.fn({ input });

describe('delivery-flow show operation', () => {
  it('registers a compute-only operation with a pure declaration and no sinks', () => {
    const result = resolveOperation('delivery-flow');
    expect(result.declaration.name).toBe('delivery-flow');
    expect(isReadOnlyOperation(result.declaration)).toBe(true);
    expect(result.sinks).toEqual({});
    expect(importGraph(join(root, 'scripts/operations/delivery-flow.mjs')).external).toEqual([]);
  });

  it('reads the exact explicit scope through the build choke point', () => {
    const flowFor = vi.fn(() => ({ class: 'ordinary' }));
    const loadItems = vi.fn();
    const readFlow = createDeliveryFlowReader({ flowFor, loadItems });
    expect(assess(readFlow, { scope: 'we:src/a,we:src/b', num: '' })).toEqual({ class: 'ordinary' });
    expect(flowFor).toHaveBeenCalledWith({ scope: 'we:src/a,we:src/b', kind: 'build' });
    expect(loadItems).not.toHaveBeenCalled();
  });

  it('loads card scope with the canonical lookup, including bornAs', () => {
    const flowFor = vi.fn();
    const reader = createDeliveryFlowReader({ flowFor,
      loadItems: () => [{ num: '123', bornAs: 'xabc123', slug: 'fixture', scope: ['we:scripts/hooks/**'] }],
    });
    reader({ num: 'xabc123' });
    expect(flowFor).toHaveBeenCalledWith({ scope: ['we:scripts/hooks/**'], kind: 'build' });
  });

  it('unknown/unreadable card scope reaches the guard fallback', () => {
    for (const loadItems of [() => [], () => { throw new Error('unreadable'); }]) {
      expect(createDeliveryFlowReader({ loadItems })({ num: 'missing' })).toMatchObject({ class: 'guard' });
    }
  });

  it('rejects ambiguous flags and requires an injected reader', () => {
    expect(() => assess(() => {}, { num: '1', scope: 'we:src/a' })).toThrow(/not both/);
    expect(() => deliveryFlowOperation()).toThrow(/readFlow/);
  });

  it('prints stages and provenance while preserving the JSON envelope', () => {
    const run = { verdict: { class: 'guard', stages: [{ stage: 'design' }, { stage: 'build' }, { stage: 'review' }], reason: 'strictest', sources: { flows: 'standard' } } };
    const args = { run, code: 0, lines: ['json'] };
    expect(finishDeliveryFlow(args).lines.join('\n')).toMatch(/guard: design -> build -> review.*\nsources:.*standard/);
    expect(finishDeliveryFlow({ ...args, json: true })).toEqual({ code: 0, lines: ['json'] });
  });

  it('real run.mjs --scope computes the flow without touching run/call stores', () => {
    const overlay = makeGitOverlay(root);
    try {
      const result = spawnSync(process.execPath, ['scripts/operations/run.mjs', 'delivery-flow', '--scope=we:scripts/guard-bash.mjs,we:src/main.ts', '--json'], {
        cwd: root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ...overlay.env, WE_PLATFORM_PREFERENCES_FILE: 'scripts/settings/absent-delivery-flow-platform.json',
          WE_DELIVERY_FLOW: '{}', WE_POLICY_CASCADE_LOG: '0',
          OPERATION_RUNS_DIR: '/dev/null/delivery-flow-runs', OPERATION_CALLS_DIR: '/dev/null/delivery-flow-calls' },
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(JSON.parse(result.stdout).verdict).toMatchObject({ class: 'guard', stages: [
        { stage: 'design', model: 'opus', effort: 'high', timeoutMin: 20 }, { stage: 'build' }, { stage: 'review' },
      ] });
    } finally { overlay.cleanup(); }
  });
});
