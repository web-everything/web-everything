import { expect, it, vi } from 'vitest';
import * as routing from '../../lib/ai-routing.mjs';
import { finishAiRouting } from '../ai-routing.mjs';
import { OPERATIONS } from '../run.mjs';

it('ai-routing prints settings, each role input, sources and invalid diagnostics', () => {
  const verdict = { settings: { fix: { executors: ['claude'] } },
    inputs: { fix: { executors: ['claude'] } }, sources: { 'fix.executors': 'platform' }, invalid: ['tool.fix: invalid'] };
  expect(finishAiRouting({ run: { verdict }, code: 0, lines: ['original'], json: false })).toEqual({ code: 0, lines: [
    'settings: {"fix":{"executors":["claude"]}}',
    'fix: {"executors":["claude"]}',
    'sources: {"fix.executors":"platform"}',
    'invalid: ["tool.fix: invalid"]',
  ] });
  expect(finishAiRouting({ run: { verdict }, code: 1, lines: ['json payload'], json: true }))
    .toEqual({ code: 1, lines: ['json payload'] });
  expect(finishAiRouting({ run: {}, code: 1, lines: ['failure'], json: false }))
    .toEqual({ code: 1, lines: ['failure'] });
});

it('registered ai-routing collector returns all ten roles, settings, sources and invalid', () => {
  const resolved = routing.resolveAiRouting({ env: {}, platform: {}, log: false, accountMap: { accounts: {} },
    tool: { fix: { executors: ['claude'] }, build: { coordinator: { provider: 'invalid' } } } });
  const read = vi.spyOn(routing, 'resolveAiRouting').mockReturnValue(resolved);
  try {
    const operation = OPERATIONS['ai-routing']();
    expect(operation.finish).toBe(finishAiRouting);
    expect(operation.sinks).toEqual({});
    const payload = operation.declaration.steps.find(({ name }) => name === 'read').step.fn();
    expect(read).toHaveBeenCalledOnce();
    expect(payload).toEqual({ settings: resolved.value, sources: resolved.sources, invalid: resolved.invalid,
      inputs: Object.fromEntries(['review', 'red-team', 'red-team-recheck', 'fix', 'build', 'prepare', 'ci-heal', 'worker', 'judge', 'helper']
        .map(role => [role, role === 'fix' ? { coordinator: undefined, executors: ['claude'] }
          : { coordinator: undefined, executors: undefined }])) });
    expect(payload.invalid.length).toBeGreaterThan(0);
    expect(operation.finish({ run: { verdict: payload }, code: 0, json: false }).lines).toHaveLength(13);
  } finally {
    read.mockRestore();
  }
});
