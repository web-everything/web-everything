import { describe, expect, it } from 'vitest';
import { resolveClaudeHelperRoute } from '../claude-helper-route.mjs';
import { buildJudgeArgv, DEFAULT_MODEL } from '../judge-spawn.mjs';

describe('Claude helper model cascade', () => {
  it('defaults to Sonnet 5.5 and reaches the helper launch argv', () => {
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5-5');
    expect(resolveClaudeHelperRoute({ tool: {}, platform: {}, env: {}, log: false })).toMatchObject({ model: DEFAULT_MODEL, sources: { model: 'standard' } });
    const argv = buildJudgeArgv({ mandate: 'review', shape: { type: 'object', properties: {} }, sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    expect(argv[argv.indexOf('--model') + 1]).toBe(DEFAULT_MODEL);
  });
  it('resolves and logs each layer, ignoring invalid overrides', () => {
    const logs = [];
    const route = resolveClaudeHelperRoute({ platform: { model: 'claude-haiku-5-5' }, tool: { model: 'claude-sonnet-5-5' }, env: { WE_CLAUDE_HELPER_MODEL: 'claude-opus-5-5', WE_POLICY_CASCADE_LOG: '1' }, log: l => logs.push(l) });
    expect(route).toMatchObject({ model: 'claude-opus-5-5', sources: { model: 'env' } });
    expect(logs.join(' ')).toMatch(/model=.*env/);
    expect(resolveClaudeHelperRoute({ platform: { model: 'claude-haiku-5-5' }, tool: { model: '--bad' }, env: {}, log: false })).toMatchObject({ model: 'claude-haiku-5-5', sources: { model: 'platform' } });
  });
});

it('uses the helper setting for default Sonnet workers while preserving explicit design tiers', async () => {
  const { vi } = await import('vitest');
  const { workerModelTable, buildAgentArgv } = await import('../../operations/dispatch-lane-io.mjs');
  vi.stubEnv('WE_CLAUDE_HELPER_MODEL', 'claude-haiku-5-5');
  try {
    expect(workerModelTable({ outcome: 'role', tier: 'sonnet' }).model).toBe('haiku');
    expect(workerModelTable({ outcome: 'role', tier: 'opus' }).model).toBe('opus');
    const argv = buildAgentArgv({ sessionId: 's', payload: { launchKind: 'inspect', num: 1, prompt: 'work' } });
    expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
  } finally { vi.unstubAllEnvs(); }
});
