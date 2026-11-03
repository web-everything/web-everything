import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveRoutingSettings, effectiveBuilder, BUILD_KINDS } from '../routing-settings.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeclaredSettings } from '../settings-files.mjs';
import { resolveDispatchRoute } from '../dispatch-routing-policy-io.mjs';
import { resolveFixExecutorChain } from '../fix-executor-chain.mjs';

describe('routing settings', () => {
  it('ships claude and defaults to codex without a repo value', () => {
    expect(JSON.parse(readFileSync('scripts/settings/routing.json', 'utf8')).routing.builder).toBe('claude');
    expect(resolveRoutingSettings({ env: {}, repo: {} })).toMatchObject({ builder: 'codex', source: 'default', auditProvider: 'codex' });
  });
  it('env beats the repo file; invalid values are ignored', () => {
    const repo = { routing: { builder: 'claude' } };
    expect(resolveRoutingSettings({ env: { WE_ROUTING_BUILDER: 'codex' }, repo }).builder).toBe('codex');
    expect(resolveRoutingSettings({ env: { WE_ROUTING_BUILDER: 'nope' }, repo: {} }).builder).toBe('claude');
    expect(resolveRoutingSettings({ env: {}, repo: { routing: { builder: 'cluade' } } }).builder).toBe('claude');
  });
  it('auto goes to claude at the threshold; an unknown reading goes to claude', () => {
    const repo = { routing: { builder: 'auto', autoClaudeAbovePercent: 70 } };
    expect(effectiveBuilder({ env: {}, repo, quota: () => ({ used_percent: 90 }) }).builder).toBe('claude');
    expect(effectiveBuilder({ env: {}, repo, quota: () => ({ used_percent: 40 }) }).builder).toBe('codex');
    expect(effectiveBuilder({ env: {}, repo, quota: () => null }).builder).toBe('claude');
  });
  it('a malformed settings file, or unreadable auto quota, resolves to claude', () => {
    const bad = { settings: {}, errors: [{ source: 'settings/routing.json', error: 'Unexpected token' }] };
    expect(resolveRoutingSettings({ env: {}, declared: bad })).toMatchObject({ builder: 'claude', source: 'unreadable-settings' });
    expect(effectiveBuilder({ env: {}, repo: { routing: { builder: 'auto' } }, quota: () => null }).builder).toBe('claude');
  });
  it('explicit deliveryAgent=codex is refused with a named reason while the reserve is on', () => {
    const r = resolveDispatchRoute({ kind: 'build', deliveryAgent: 'codex' }, {});
    expect(r.outcome).toBe('refused');
    expect(r.refusal).toMatch(/codexReserveForAudit/);
  });
  it('deliveryAgent is trimmed and lower-cased before the refusal check', () => {
    for (const agent of [' codex ', 'CODEX', 'Codex\n']) {
      expect(resolveDispatchRoute({ kind: 'build', deliveryAgent: agent }, {}).outcome).toBe('refused');
    }
  });
  it('fix-executor-chain reads routing.json through the error-surfacing reader (malformed means claude)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-'));
    writeFileSync(join(dir, 'routing.json'), '{ not json');
    const declared = readDeclaredSettings({ dir, legacyPath: null });
    expect(declared.errors.length).toBe(1);
    expect(effectiveBuilder({ env: {}, declared }).builder).toBe('claude');
  });
  it('audit kinds are never build kinds; build is', () => {
    expect(BUILD_KINDS).toContain('build');
    expect(BUILD_KINDS).not.toContain('review');
    expect(BUILD_KINDS).toEqual(expect.arrayContaining(['prepare', 'takeover', 'design', 'ci-heal']));
  });
  it('builder claude collapses the repair chain; an env chain cannot bring codex back, only builder=codex can', () => {
    const repo = { routing: { builder: 'claude' }, fixExecutor: { fallbackChain: ['codex', 'codex-alt', 'claude'] } };
    expect(resolveFixExecutorChain({ env: {}, platform: {}, repo }).value).toEqual(['claude']);
    expect(resolveFixExecutorChain({ env: { WE_FIX_EXECUTOR_FALLBACK_CHAIN: 'codex,claude' }, platform: {}, repo }).value).toEqual(['claude']);
    expect(resolveFixExecutorChain({ env: {}, platform: {}, repo: { ...repo, routing: { builder: 'codex' } } }).value).toEqual(['codex', 'codex-alt', 'claude']);
  });
});
