import { it, expect } from 'vitest';
import { buildCodexDirectTaskArgv } from '../../codex-direct-task.mjs';
it('passes resolved effort to the actual Codex, Gemini and native Claude argv builders', async () => {
  const { DEFAULT_ROUTING_POLICY, resolveOperationRoute } = await import('../../lib/dispatch-routing-policy.mjs');
  const { buildWorkerArgv } = await import('../../lib/probation-launcher.mjs');
  const { buildAgyDirectTaskArgv } = await import('../../gemini-direct-task.mjs');
  const { buildAgentArgv } = await import('../dispatch-lane-io.mjs');
  const codex = resolveOperationRoute({ operation: 'build' });
  expect(buildCodexDirectTaskArgv({ cwd: '/tmp/lane', ...codex })).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol', 'model_reasoning_effort=medium']));
  const testFix = resolveOperationRoute({ operation: 'build', taskType: 'test-fix' });
  expect(testFix).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
  expect(buildWorkerArgv({ worker: { ...testFix, launcher: 'scripts/codex-direct-task.mjs' }, weRoot: '/we', dir: '/lane', taskFile: '/task' })).toEqual(expect.arrayContaining(['/we/scripts/codex-direct-task.mjs', '--model=gpt-6.1-sol', '--effort=low']));
  expect(buildCodexDirectTaskArgv({ cwd: '/tmp/lane', ...testFix })).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol', 'model_reasoning_effort=low']));
  // Exercise Gemini argv with an explicit policy fixture, independent of the live test-fix route.
  const geminiPolicy = structuredClone(DEFAULT_ROUTING_POLICY);
  geminiPolicy.operations['build:test-fix'] = { provider: 'agy-gemini', model: 'gemini-3.8-flash', effort: 'low', fallback: [] };
  const gemini = resolveOperationRoute({ operation: 'build', taskType: 'test-fix', policy: geminiPolicy });
  expect(buildWorkerArgv({ worker: { ...gemini, launcher: 'scripts/gemini-direct-task.mjs' }, weRoot: '/we', dir: '/lane', taskFile: '/task' })).toContain('--effort=low');
  expect(buildAgyDirectTaskArgv(gemini)).toEqual(expect.arrayContaining(['--model', 'gemini-3.8-flash', '--effort', 'low']));
  const native = resolveOperationRoute({ operation: 'build', gateClosed: true });
  // Codex builds use medium; the native Claude fallback retains its own high effort.
  expect(buildAgentArgv({ payload: { prompt: 'repair', launchKind: 'fix' }, table: native })).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'high']));
  expect(() => buildAgentArgv({ payload: { prompt: 'repair' }, extraArgs: ['--effort=typo'] })).toThrow(/unknown effort/);
});
