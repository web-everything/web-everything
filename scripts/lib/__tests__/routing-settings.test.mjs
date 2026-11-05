import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveRoutingSettings, effectiveBuilder, BUILD_KINDS } from '../routing-settings.mjs';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDeclaredSettings } from '../settings-files.mjs';
import { resolveDispatchRoute, readRoutingPolicy } from '../dispatch-routing-policy-io.mjs';
import { resolveFixExecutorChain } from '../fix-executor-chain.mjs';
import { inheritedRoutingPolicy } from './inherited-routing-policy.mjs';

// Passthrough mocks, off by default: a test points the settings readers at a temp dir, fixes the Codex quota
// reading, or records the availability resolveDispatchRoute hands to the router. Both settings readers are
// redirected, so a regression from the declared reader back to readSettings() cannot fall through to the
// shipped scripts/settings (which says builder=claude and would hide it).
const state = vi.hoisted(() => ({ dir: null, quota: undefined, seen: [] }));
vi.mock('../settings-files.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  const at = o => (state.dir ? { ...o, dir: state.dir, legacyPath: null } : o);
  return { ...actual, readDeclaredSettings: o => actual.readDeclaredSettings(at(o)), readSettings: o => actual.readSettings(at(o)) };
});
vi.mock('../codex-usage-ledger.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readCodexQuota: env => (state.quota === undefined ? actual.readCodexQuota(env) : state.quota) };
});
vi.mock('../dispatch-contracts.mjs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, decideDispatchRoute: (d, o) => { state.seen.push({ kind: d?.kind, availability: { ...o?.availability } }); return actual.decideDispatchRoute(d, o); } };
});
beforeEach(() => { vi.stubEnv('WE_ROUTING_BUILDER', ''); });
afterEach(() => { state.dir = null; state.quota = undefined; state.seen = []; vi.unstubAllEnvs(); });

/** A temp settings dir holding the given files; the readers use it until the test ends. */
function settingsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'route-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  state.dir = dir;
  return dir;
}
const SCOPED = { size: 3, scopePaths: ['we:scripts/example.mjs'] };
const route = (dispatch) => resolveDispatchRoute(dispatch, { routingPolicy: inheritedRoutingPolicy });
/** The availability resolveDispatchRoute passed to the router for one dispatch (null when it returned before routing). */
function availabilityFor(dispatch) {
  state.seen = [];
  try { route(dispatch); } catch { /* an unroutable kind still records what it was handed */ }
  return state.seen.length ? state.seen.at(-1).availability : null;
}
const NON_BUILD_KINDS = ['review', 'red-team', 'audit', 'codex-audit', 'advise', 'judge'];
// The kinds routing.json's $comment promises are held, pinned literally so dropping one from BUILD_KINDS goes red.
const DOCUMENTED_BUILD_KINDS = ['build', 'fix', 'ci-heal', 'prepare', 'takeover', 'design'];
const HELD_KINDS = [...new Set([...DOCUMENTED_BUILD_KINDS, ...BUILD_KINDS])];
// Build kinds whose dispatch ignores a deliveryAgent marker (only build, fix and ci-heal read it).
const NON_MARKER_BUILD_KINDS = BUILD_KINDS.filter(k => !['build', 'fix', 'ci-heal'].includes(k));

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
  it('kind is normalised once: a padded or upper-cased build kind is refused and held exactly like the plain one', () => {
    const plain = resolveDispatchRoute({ kind: 'build', ...SCOPED, deliveryAgent: 'codex' }, {});
    expect(plain.outcome).toBe('refused');
    for (const kind of [' build ', 'BUILD', 'build\n', '\tBuild']) {
      const r = resolveDispatchRoute({ kind, ...SCOPED, deliveryAgent: 'codex' }, {});
      expect(r.outcome, JSON.stringify(kind)).toBe('refused');
      expect(r.refusal, JSON.stringify(kind)).toBe(plain.refusal);
    }
    for (const kind of [' fix ', 'CI-HEAL', ' prepare ', 'Design\n']) {
      expect(availabilityFor({ kind, ...SCOPED })?.codex, JSON.stringify(kind)).toMatch(/routing\.builder=claude/);
      // Both layers see the same kind: the router is handed the normalised kind, not the padded one.
      expect(state.seen.at(-1).kind, JSON.stringify(kind)).toBe(kind.trim().toLowerCase());
    }
  });
  it('the codex hold never strands a ci-heal while native Claude is available; it still refuses when native Claude is held too', () => {
    const dispatch = { kind: 'ci-heal', scopePaths: ['we:scripts/example.mjs'], reason: 'red-ci' };
    const options = { routingPolicy: readRoutingPolicy(), scorecards: [], ciHealAvailability: { 'antigravity-claude': 'quota held' } };
    const r = resolveDispatchRoute(dispatch, options);
    expect(r.outcome, r.refusal).not.toBe('refused');
    expect(r.probationWorker?.provider ?? null).not.toBe('codex');
    expect(r.auditTrail.some(row => row.criterion === 'ci-heal-native-claude-fallback')).toBe(true);
    const nativeHeldAvailability = resolveDispatchRoute(dispatch, { ...options, ciHealAvailability: { 'antigravity-claude': 'quota held', claude: 'quota held' } });
    expect(nativeHeldAvailability.outcome).toBe('refused');
    const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
    const nativeHeldScore = resolveDispatchRoute(dispatch, { ...options, scorecards: [{ provider: 'claude', status: 'quota-exhausted', quotaResetsAt: resetsAt }] });
    expect(nativeHeldScore.outcome).toBe('refused');
    // builder=codex is unchanged: the roster-exhausted refusal stays (no native fallback without the claude builder).
    settingsDir({ 'routing.json': { routing: { builder: 'codex' } } });
    expect(resolveDispatchRoute(dispatch, { ...options, ciHealAvailability: { 'antigravity-claude': 'held', 'antigravity-gemini': 'held', codex: 'held' } }).outcome).toBe('refused');
  });
  it('a malformed routing.json is surfaced by the declared reader and resolves to claude', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-'));
    writeFileSync(join(dir, 'routing.json'), '{ not json');
    const declared = readDeclaredSettings({ dir, legacyPath: null });
    expect(declared.errors.length).toBe(1);
    expect(effectiveBuilder({ env: {}, declared }).builder).toBe('claude');
  });
  it('fix-executor-chain with no repo argument drops the codex rungs when routing.json is malformed', () => {
    // fixExecutor.json is valid and asks for codex first; only the unreadable routing.json says otherwise.
    settingsDir({ 'fixExecutor.json': { fixExecutor: { fallbackChain: ['codex', 'codex-alt', 'claude'] } }, 'routing.json': '{ not json' });
    expect(resolveFixExecutorChain({ env: {}, platform: {} }).value).toEqual(['claude']);
  });
  it('fix-executor-chain with no repo argument keeps the codex rungs when routing.json says builder=codex', () => {
    settingsDir({ 'fixExecutor.json': { fixExecutor: { fallbackChain: ['codex', 'codex-alt', 'claude'] } }, 'routing.json': { routing: { builder: 'codex' } } });
    expect(resolveFixExecutorChain({ env: {}, platform: {} }).value).toEqual(['codex', 'codex-alt', 'claude']);
  });
  it('auto routes to claude at, and above, a configured threshold; codex only below it', () => {
    for (const [threshold, used, builder] of [[70, 69, 'codex'], [70, 70, 'claude'], [70, 71, 'claude'], [50, 49, 'codex'], [50, 50, 'claude'], [50, 51, 'claude']]) {
      const repo = { routing: { builder: 'auto', autoClaudeAbovePercent: threshold } };
      expect(effectiveBuilder({ env: {}, repo, quota: () => ({ used_percent: used }) }).builder, `${used}% vs ${threshold}`).toBe(builder);
    }
  });
  it('claude builder routes an ordinary build away from codex; codex builder still picks it', () => {
    settingsDir({ 'routing.json': { routing: { builder: 'claude' } } });
    for (const kind of ['build', 'fix']) {
      const r = route({ kind, ...SCOPED });
      expect(r.outcome, kind).toBe('routed');
      expect(r.probationWorker?.provider ?? null, kind).not.toBe('codex');
    }
    settingsDir({ 'routing.json': { routing: { builder: 'codex' } } });
    for (const kind of ['build', 'fix']) expect(route({ kind, ...SCOPED }).probationWorker?.provider, kind).toBe('codex');
  });
  it('claude builder holds codex for every build kind and for no other kind', () => {
    settingsDir({ 'routing.json': { routing: { builder: 'claude' } } });
    for (const kind of HELD_KINDS) expect(availabilityFor({ kind, ...SCOPED })?.codex, kind).toMatch(/routing\.builder=claude/);
    for (const kind of NON_BUILD_KINDS) {
      expect(BUILD_KINDS).not.toContain(kind);
      expect(availabilityFor({ kind, ...SCOPED })?.codex, kind).toBeUndefined();
    }
  });
  it('codex builder holds codex for no kind', () => {
    settingsDir({ 'routing.json': { routing: { builder: 'codex' } } });
    for (const kind of [...HELD_KINDS, ...NON_BUILD_KINDS]) expect(availabilityFor({ kind, ...SCOPED })?.codex, kind).toBeUndefined();
  });
  it('auto builder at dispatch holds codex over the quota threshold or on an unreadable reading, not below it', () => {
    settingsDir({ 'routing.json': { routing: { builder: 'auto', autoClaudeAbovePercent: 70 } } });
    for (const [quota, held] of [[{ used_percent: 90 }, true], [{ used_percent: 70 }, true], [null, true], [{ used_percent: 40 }, false]]) {
      state.quota = quota;
      const codex = availabilityFor({ kind: 'build', ...SCOPED })?.codex;
      if (held) expect(codex, JSON.stringify(quota)).toMatch(/routing\.builder=claude/);
      else expect(codex, JSON.stringify(quota)).toBeUndefined();
      expect(availabilityFor({ kind: 'review' })?.codex, JSON.stringify(quota)).toBeUndefined();
    }
  });
  it('codexReserveForAudit=false honours an explicit deliveryAgent=codex build; ordinary builds stay held', () => {
    settingsDir({ 'routing.json': { routing: { builder: 'claude', codexReserveForAudit: false } } });
    const explicit = { kind: 'build', ...SCOPED, deliveryAgent: 'codex', deliveryAgentReason: 'operator asked for codex' };
    const r = route(explicit);
    expect(r.outcome).not.toBe('refused');
    expect(availabilityFor(explicit)?.codex).toBeUndefined();
    expect(availabilityFor({ kind: 'build', ...SCOPED })?.codex).toMatch(/routing\.builder=claude/);
    for (const kind of ['fix', 'ci-heal']) expect(availabilityFor({ ...explicit, kind })?.codex, kind).toBeUndefined();
  });
  it('a deliveryAgent=codex marker on a build kind that ignores markers neither lifts the hold nor is refused', () => {
    expect(NON_MARKER_BUILD_KINDS.length).toBeGreaterThan(0);
    for (const codexReserveForAudit of [false, true]) {
      settingsDir({ 'routing.json': { routing: { builder: 'claude', codexReserveForAudit } } });
      for (const kind of NON_MARKER_BUILD_KINDS) {
        const dispatch = { kind, ...SCOPED, deliveryAgent: 'codex', deliveryAgentReason: 'x' };
        expect(availabilityFor(dispatch)?.codex, `${kind} reserve=${codexReserveForAudit}`).toMatch(/routing\.builder=claude/);
      }
    }
  });
  it('the explicit deliveryAgent=codex refusal fires from a routing.json reserve, not only the shipped file', () => {
    settingsDir({ 'routing.json': { routing: { builder: 'claude', codexReserveForAudit: true } } });
    const r = route({ kind: 'build', ...SCOPED, deliveryAgent: 'codex', deliveryAgentReason: 'x' });
    expect(r.outcome).toBe('refused');
    expect(r.refusal).toMatch(/codexReserveForAudit/);
    expect(route({ kind: 'review', deliveryAgent: 'codex' }).refusal ?? '').not.toMatch(/codexReserveForAudit/);
  });
  it('audit kinds are never build kinds; build is', () => {
    expect(BUILD_KINDS).toContain('build');
    expect(BUILD_KINDS).not.toContain('review');
    expect(BUILD_KINDS).toEqual(expect.arrayContaining(DOCUMENTED_BUILD_KINDS));
    // The full held list, pinned literally: dropping any kind (prepare-item, worker, ...) lets Codex write code under builder=claude.
    expect([...BUILD_KINDS].sort()).toEqual(['build', 'ci-heal', 'design', 'doc-fix', 'fix', 'prepare', 'prepare-card', 'prepare-complex', 'prepare-item', 'prevention-card', 'takeover', 'worker']);
  });
  it('fix-executor-chain honours a caller-passed env WE_ROUTING_BUILDER over the repo builder', () => {
    const chain = ['codex', 'codex-alt', 'claude'];
    const claudeRepo = { routing: { builder: 'claude' }, fixExecutor: { fallbackChain: chain } };
    expect(resolveFixExecutorChain({ env: { WE_ROUTING_BUILDER: 'codex' }, platform: {}, repo: claudeRepo }).value).toEqual(chain);
    const codexRepo = { routing: { builder: 'codex' }, fixExecutor: { fallbackChain: chain } };
    expect(resolveFixExecutorChain({ env: { WE_ROUTING_BUILDER: 'claude' }, platform: {}, repo: codexRepo }).value).toEqual(['claude']);
  });
  it('builder claude collapses the repair chain; an env chain cannot bring codex back, only builder=codex can', () => {
    const repo = { routing: { builder: 'claude' }, fixExecutor: { fallbackChain: ['codex', 'codex-alt', 'claude'] } };
    expect(resolveFixExecutorChain({ env: {}, platform: {}, repo }).value).toEqual(['claude']);
    expect(resolveFixExecutorChain({ env: { WE_FIX_EXECUTOR_FALLBACK_CHAIN: 'codex,claude' }, platform: {}, repo }).value).toEqual(['claude']);
    expect(resolveFixExecutorChain({ env: {}, platform: {}, repo: { ...repo, routing: { builder: 'codex' } } }).value).toEqual(['codex', 'codex-alt', 'claude']);
  });
});
