import { describe, it, expect } from 'vitest';
import {
  PROBATION_STATUSES, PROBATION_ROLES, DEFAULT_STATUS, NEVER_BLOCKING_ROLES,
  identityKey, validateProbationEntry, normalizeRegistry, findEntry, statusFor,
  isOnProbation, isDispatchEligible, assertRoleNeverBlocks, readRegistry, writeRegistry, liveStatusFor,
  PROBATION_REGISTRY_PATH,
} from '../model-probation.mjs';

const CODEX = { provider: 'codex', model: 'gpt-6-astra' };
const REG = normalizeRegistry({
  version: 1,
  entries: [
    { provider: 'codex', model: 'gpt-6-astra', roles: { delivery: 'probation', 'advisory-review': 'probation' }, since: '2026-09-13', owner: '3383' },
    { provider: 'anthropic', model: 'claude-hypothetical-9', roles: { delivery: 'trusted' }, since: '2026-01-01', owner: '1' },
  ],
});

describe('identityKey', () => {
  it('is case-insensitive on provider, case-sensitive on model, and joins deterministically', () => {
    expect(identityKey({ provider: 'Codex', model: 'gpt-6-astra' })).toBe(identityKey({ provider: 'codex', model: 'gpt-6-astra' }));
    expect(identityKey({ provider: 'codex', model: 'GPT-6-Astra' })).not.toBe(identityKey({ provider: 'codex', model: 'gpt-6-astra' }));
  });
});

describe('validateProbationEntry', () => {
  it('accepts a well-formed entry', () => {
    expect(validateProbationEntry({ provider: 'codex', model: 'gpt-6-astra', roles: { delivery: 'probation' }, since: '2026-09-13', owner: '3383' }).ok).toBe(true);
  });
  it('requires provider, model, since, owner, roles', () => {
    const v = validateProbationEntry({});
    expect(v.ok).toBe(false);
    expect(v.errors.length).toBeGreaterThanOrEqual(5);
  });
  it('rejects an unknown role or an unknown status, never throws', () => {
    expect(validateProbationEntry({ provider: 'x', model: 'y', since: '2026-09-13', owner: '1', roles: { flying: 'probation' } }).ok).toBe(false);
    expect(validateProbationEntry({ provider: 'x', model: 'y', since: '2026-09-13', owner: '1', roles: { delivery: 'super-trusted' } }).ok).toBe(false);
  });
  it('never throws on garbage input', () => {
    expect(() => validateProbationEntry(null)).not.toThrow();
    expect(() => validateProbationEntry('nope')).not.toThrow();
    expect(() => validateProbationEntry([])).not.toThrow();
  });
});

describe('normalizeRegistry — fails CLOSED', () => {
  it('an empty/malformed parse yields an empty registry, not a throw', () => {
    expect(normalizeRegistry(null).entries).toEqual([]);
    expect(normalizeRegistry(undefined).entries).toEqual([]);
    expect(normalizeRegistry({}).entries).toEqual([]);
    expect(normalizeRegistry('garbage').entries).toEqual([]);
  });
  it('drops an invalid entry into `dropped`, keeping the rest', () => {
    const reg = normalizeRegistry({ entries: [{ provider: 'x' }, { provider: 'ok', model: 'm', since: '2026-01-01', owner: '1', roles: { delivery: 'trusted' } }] });
    expect(reg.entries).toHaveLength(1);
    expect(reg.dropped).toHaveLength(1);
  });
  it('drops a duplicate identity, first wins', () => {
    const base = { provider: 'codex', model: 'gpt-6-astra', since: '2026-01-01', owner: '1', roles: { delivery: 'trusted' } };
    const reg = normalizeRegistry({ entries: [base, { ...base, roles: { delivery: 'probation' } }] });
    expect(reg.entries).toHaveLength(1);
    expect(reg.entries[0].roles.delivery).toBe('trusted');
    expect(reg.dropped).toHaveLength(1);
  });
});

describe('statusFor — the fail-closed identity lookup', () => {
  it('reads the declared status for a known identity+role', () => {
    expect(statusFor(REG, { ...CODEX, role: 'delivery' })).toBe('probation');
    expect(statusFor(REG, { ...CODEX, role: 'advisory-review' })).toBe('probation');
  });
  it('is GENERIC — a different provider/model reads its own independent status', () => {
    expect(statusFor(REG, { provider: 'anthropic', model: 'claude-hypothetical-9', role: 'delivery' })).toBe('trusted');
  });
  it('defaults to unvalidated for an unknown identity — an unlisted model never inherits trust', () => {
    expect(statusFor(REG, { provider: 'codex', model: 'some-future-model', role: 'delivery' })).toBe(DEFAULT_STATUS);
    expect(statusFor(REG, { provider: 'grok', model: 'grok-9', role: 'advisory-review' })).toBe(DEFAULT_STATUS);
  });
  it('defaults to unvalidated for a role the entry does not name, even for a known identity', () => {
    expect(statusFor(REG, { provider: 'anthropic', model: 'claude-hypothetical-9', role: 'advisory-review' })).toBe(DEFAULT_STATUS);
  });
  it('throws on an unknown ROLE name — a typo must not silently read as unvalidated for the wrong reason', () => {
    expect(() => statusFor(REG, { ...CODEX, role: 'typo-role' })).toThrow(/role/);
  });
  it('a model UPGRADE does not inherit the prior model\'s trust', () => {
    expect(statusFor(REG, { provider: 'codex', model: 'gpt-7-hypothetical', role: 'delivery' })).toBe('unvalidated');
  });
});

describe('isOnProbation / isDispatchEligible', () => {
  it('probation is dispatch-eligible but not exactly "trusted"', () => {
    expect(isOnProbation(REG, { ...CODEX, role: 'delivery' })).toBe(true);
    expect(isDispatchEligible(REG, { ...CODEX, role: 'delivery' })).toBe(true);
  });
  it('trusted is dispatch-eligible but not "on probation"', () => {
    const id = { provider: 'anthropic', model: 'claude-hypothetical-9', role: 'delivery' };
    expect(isOnProbation(REG, id)).toBe(false);
    expect(isDispatchEligible(REG, id)).toBe(true);
  });
  it('unvalidated is neither', () => {
    const id = { provider: 'codex', model: 'unknown-model', role: 'delivery' };
    expect(isOnProbation(REG, id)).toBe(false);
    expect(isDispatchEligible(REG, id)).toBe(false);
  });
});

describe('NEVER_BLOCKING_ROLES / assertRoleNeverBlocks — the structural non-veto guarantee', () => {
  it('advisory-review is declared never-blocking', () => {
    expect(NEVER_BLOCKING_ROLES).toContain('advisory-review');
    expect(assertRoleNeverBlocks('advisory-review')).toBe(true);
  });
  it('delivery is NOT declared never-blocking (it is not a review role at all — no veto question applies)', () => {
    expect(NEVER_BLOCKING_ROLES).not.toContain('delivery');
  });
  it('refuses to vouch for an undeclared role rather than silently returning false', () => {
    expect(() => assertRoleNeverBlocks('some-new-role')).toThrow();
  });
});

describe('findEntry', () => {
  it('returns null for an unknown identity, never throws', () => {
    expect(findEntry(REG, { provider: 'nope', model: 'nope' })).toBeNull();
  });
});

describe('IO shell — readRegistry/writeRegistry', () => {
  it('readRegistry degrades to empty on an unreadable file', () => {
    const reg = readRegistry({ path: '/nonexistent/path.json' });
    expect(reg.entries).toEqual([]);
  });
  it('readRegistry parses a well-formed injected file', () => {
    const reg = readRegistry({ path: 'fake', read: () => JSON.stringify({ version: 1, entries: [{ provider: 'codex', model: 'gpt-6-astra', since: '2026-09-13', owner: '3383', roles: { delivery: 'probation' } }] }) });
    expect(statusFor(reg, { provider: 'codex', model: 'gpt-6-astra', role: 'delivery' })).toBe('probation');
  });
  it('writeRegistry serializes via the injected writer, never touching real disk in a test', () => {
    let written = null;
    writeRegistry({ version: 1, entries: [] }, { path: 'fake', write: (p, s) => { written = { p, s }; } });
    expect(written.p).toBe('fake');
    expect(JSON.parse(written.s)).toEqual({ version: 1, entries: [] });
  });
  it('the real registry file on disk is well-formed and names codex on probation for both roles', () => {
    const reg = readRegistry({ path: PROBATION_REGISTRY_PATH });
    expect(reg.dropped).toEqual([]);
    expect(statusFor(reg, { provider: 'codex', model: 'gpt-6-astra', role: 'delivery' })).toBe('probation');
    expect(statusFor(reg, { provider: 'codex', model: 'gpt-6-astra', role: 'advisory-review' })).toBe('probation');
  });
  it('liveStatusFor reads the real on-disk registry in one call', () => {
    expect(liveStatusFor({ provider: 'codex', model: 'gpt-6-astra', role: 'advisory-review' })).toBe('probation');
  });
  // #3383 — the FIFTH review-panel seat's registration (`review-pr.mjs`'s `judgeAntigravityReview`), a
  // genuinely different identity from codex's own entry above: zero prior trials in ANY role, so only
  // `advisory-review` is declared (no `delivery` role at all — there is no Antigravity delivery agent).
  it('the real registry file on disk also names antigravity on probation for advisory-review only', () => {
    const reg = readRegistry({ path: PROBATION_REGISTRY_PATH });
    expect(statusFor(reg, { provider: 'antigravity', model: 'gemini-4-argon-high', role: 'advisory-review' })).toBe('probation');
    // No `delivery` role declared for this identity — falls through to the fail-closed default.
    expect(statusFor(reg, { provider: 'antigravity', model: 'gemini-4-argon-high', role: 'delivery' })).toBe(DEFAULT_STATUS);
  });
  it('liveStatusFor reads the real antigravity entry too, independent of the codex identity', () => {
    expect(liveStatusFor({ provider: 'antigravity', model: 'gemini-4-argon-high', role: 'advisory-review' })).toBe('probation');
  });
});
