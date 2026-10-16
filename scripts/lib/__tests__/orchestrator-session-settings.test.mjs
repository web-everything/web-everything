import { describe, it, expect } from 'vitest';
import { loadOrchestratorSessionSettings, ORCHESTRATOR_DELEGATE_COMMANDS } from '../orchestrator-session-settings.mjs';

const load = options => loadOrchestratorSessionSettings({ env: {}, tool: {}, platform: {}, ...options });
describe('orchestrator session settings cascade', () => {
  it('defaults off and logs the effective source', () => {
    const lines = [];
    const result = load({ log: line => lines.push(line) });
    expect(result.value.orchestratorMode).toBe(false);
    expect(result.value.orchestratorDelegateCommands).toEqual(ORCHESTRATOR_DELEGATE_COMMANDS);
    expect(lines.join('\n')).toContain('orchestratorMode=false (standard)');
  });
  it('resolves platform, tool and env in order with source attribution', () => {
    expect(load({ platform: { orchestratorMode: true } }).sources.orchestratorMode).toBe('platform');
    expect(load({ platform: { orchestratorMode: false }, tool: { orchestratorMode: true } }).value.orchestratorMode).toBe(true);
    const result = load({ tool: { orchestratorMode: false }, env: { WE_ORCHESTRATOR_SESSION: '1' } });
    expect(result.value.orchestratorMode).toBe(true);
    expect(result.sources.orchestratorMode).toBe('env');
    expect(load({ tool: { orchestratorMode: true }, env: { WE_ORCHESTRATOR_SESSION: '0' } }).value.orchestratorMode).toBe(false);
  });
  it('always excludes subagents and daemon workers despite inherited opt-in', () => {
    for (const options of [
      { agentSession: true }, { env: { WE_ORCHESTRATOR_SESSION: '1', WE_CONVEYOR_WORKER: '1' } },
      { env: { WE_ORCHESTRATOR_SESSION: '1', WE_DISPATCH_KIND: 'build' } },
    ]) {
      const result = load({ tool: { orchestratorMode: true }, ...options });
      expect(result.value.orchestratorMode).toBe(false);
      expect(result.sources.orchestratorMode).toBe('worker/subagent');
    }
  });
  it('replaces the list and rejects invalid settings without losing lower layers', () => {
    expect(load({ tool: { orchestratorDelegateCommands: [] } }).value.orchestratorDelegateCommands).toEqual([]);
    expect(load({ tool: { orchestratorDelegateCommands: ['node scripts/custom.mjs'] } }).sources.orchestratorDelegateCommands).toBe('tool');
    const invalid = load({ platform: { orchestratorMode: true },
      tool: { orchestratorMode: 'invalid', orchestratorDelegateCommands: [''] } });
    expect(invalid.value.orchestratorMode).toBe(true);
    expect(invalid.value.orchestratorDelegateCommands).toEqual(ORCHESTRATOR_DELEGATE_COMMANDS);
    expect(invalid.invalid).toHaveLength(2);
  });
});
