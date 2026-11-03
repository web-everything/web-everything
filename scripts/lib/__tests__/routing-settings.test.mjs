import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveRoutingSettings, effectiveBuilder, BUILD_KINDS } from '../routing-settings.mjs';
import { resolveFixExecutorChain } from '../fix-executor-chain.mjs';

describe('routing settings', () => {
  it('ships claude and defaults to codex without a repo value', () => {
    expect(JSON.parse(readFileSync('scripts/settings/routing.json', 'utf8')).routing.builder).toBe('claude');
    expect(resolveRoutingSettings({ env: {}, repo: {} })).toMatchObject({ builder: 'codex', source: 'default', auditProvider: 'codex' });
  });
  it('env beats the repo file; invalid values are ignored', () => {
    const repo = { routing: { builder: 'claude' } };
    expect(resolveRoutingSettings({ env: { WE_ROUTING_BUILDER: 'codex' }, repo }).builder).toBe('codex');
    expect(resolveRoutingSettings({ env: { WE_ROUTING_BUILDER: 'nope' }, repo }).builder).toBe('claude');
  });
  it('auto goes to claude at the threshold; an unknown reading keeps codex', () => {
    const repo = { routing: { builder: 'auto', autoClaudeAbovePercent: 70 } };
    expect(effectiveBuilder({ env: {}, repo, quota: () => ({ used_percent: 90 }) }).builder).toBe('claude');
    expect(effectiveBuilder({ env: {}, repo, quota: () => ({ used_percent: 40 }) }).builder).toBe('codex');
    expect(effectiveBuilder({ env: {}, repo, quota: () => null }).builder).toBe('codex');
  });
  it('audit kinds are never build kinds', () => {
    expect(BUILD_KINDS).not.toContain('review');
    expect(BUILD_KINDS).toEqual(expect.arrayContaining(['prepare', 'takeover', 'design', 'ci-heal']));
  });
  it('builder claude collapses the repair chain; an explicit env chain still wins', () => {
    const repo = { routing: { builder: 'claude' }, fixExecutor: { fallbackChain: ['codex', 'codex-alt', 'claude'] } };
    expect(resolveFixExecutorChain({ env: {}, platform: {}, repo }).value).toEqual(['claude']);
    expect(resolveFixExecutorChain({ env: { WE_FIX_EXECUTOR_FALLBACK_CHAIN: 'codex,claude' }, platform: {}, repo }).value).toEqual(['codex', 'claude']);
    expect(resolveFixExecutorChain({ env: {}, platform: {}, repo: { ...repo, routing: { builder: 'codex' } } }).value).toEqual(['codex', 'codex-alt', 'claude']);
  });
});
