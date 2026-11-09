// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { build, canonicalJson, digest, verify, LOCAL_REQUIRED } from '../drain-verdict.mjs';

const inputs = () => ({ repo: 'o/r', pr: 7, headSha: 'head', mainSha: 'main', codeSha: 'code',
  gateTree: 'tree', settingsDigest: digest({ a: 1 }), inputsDigest: digest({ b: 2 }),
  decision: 'enqueue', gates: [], actions: [], computedAt: '2026-11-09T12:00:00.000Z' });
const now = Date.parse('2026-11-09T12:05:00.000Z');

describe('drain-verdict/1', () => {
  it('builds the schema with both local-only gates always not evaluable', () => {
    const v = build(inputs());
    expect(v.schema).toBe('drain-verdict/1');
    expect(v.localRequired).toEqual(LOCAL_REQUIRED);
    expect(v.gates.map(g => g.result)).toEqual(['unknown', 'unknown']);
    expect(build({ ...inputs(), gates: [{ id: 'card-group', result: 'pass', evidence: 'local' }] }).gates).toEqual(v.gates);
  });
  it('canonicalizes nested shuffled keys with deterministic build and sha256', () => {
    expect(canonicalJson({ z: [{ b: 2, a: 1 }], a: 3 })).toBe(canonicalJson({ a: 3, z: [{ a: 1, b: 2 }] }));
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(digest({})).toMatch(/^[a-f0-9]{64}$/);
    expect(build(Object.fromEntries(Object.entries(inputs()).reverse()))).toEqual(build(inputs()));
    expect(digest(build(inputs()))).toBe(digest(build(Object.fromEntries(Object.entries(inputs()).reverse()))));
  });
  it.each(['decision', 'repo', 'pr', 'codeSha', 'headSha', 'mainSha', 'gateTree', 'settingsDigest', 'inputsDigest', 'computedAt', 'gates', 'actions'])('refuses missing build field %s', field => {
    const value = inputs(); delete value[field];
    expect(() => build(value)).toThrow();
  });
  it('refuses invalid decisions, gate ids and unsupported JSON evidence', () => {
    expect(() => build({ ...inputs(), decision: 'merge' })).toThrow('decision');
    expect(() => build({ ...inputs(), gates: [{ id: 'invented', result: 'pass', evidence: '' }] })).toThrow('gates');
    expect(() => digest({ missing: undefined })).toThrow();
  });
  it.each(['schema', 'decision', 'localRequired', 'repo', 'pr', 'headSha', 'mainSha', 'gateTree', 'settingsDigest', 'inputsDigest'])('refuses %s mismatch and names the field', field => {
    const v = { ...build(inputs()), [field]: field === 'localRequired' ? [] : 'wrong' };
    expect(verify(v, inputs(), { now })).toEqual({ ok: false, reason: field });
  });
  it.each(['repo', 'pr'])('refuses a different live %s even with identical head and evidence bindings', field => {
    const live = { ...inputs(), [field]: field === 'repo' ? 'other/repo' : 8 };
    expect(verify(build(inputs()), live, { now })).toEqual({ ok: false, reason: field });
  });
  it.each(['repo', 'pr'])('refuses absent %s on either verdict or live target', field => {
    const missing = inputs(); delete missing[field];
    expect(verify(build(inputs()), missing, { now })).toEqual({ ok: false, reason: field });
    expect(verify({ ...build(inputs()), [field]: undefined }, inputs(), { now })).toEqual({ ok: false, reason: field });
  });
  it('requires localRequired even when absent or partially stripped', () => {
    for (const localRequired of [undefined, null, [], ['card-group']]) {
      expect(verify({ ...build(inputs()), localRequired }, inputs(), { now }).reason).toBe('localRequired');
    }
  });
  it.each(['2026-11-09T11:00:00Z', '2026-11-09T12:06:00Z', 'invalid', undefined])('refuses stale, future or unparsable age %s', computedAt => {
    expect(verify({ ...build(inputs()), computedAt }, inputs(), { now })).toEqual({ ok: false, reason: 'computedAt' });
  });
  it('checks schema before decision, bindings before age, and refuses missing live evidence', () => {
    expect(verify({ schema: 'bad', decision: 'bad' }, {}).reason).toBe('schema');
    expect(verify({ ...build(inputs()), headSha: 'wrong', computedAt: 'bad' }, inputs(), { now }).reason).toBe('headSha');
    expect(verify(build(inputs()), {}, { now }).reason).toBe('repo');
    expect(verify(build(inputs()), { repo: inputs().repo, pr: inputs().pr }, { now }).reason).toBe('headSha');
  });
  it('accepts matching evidence through the exact age boundary', () => {
    expect(verify(build(inputs()), inputs(), { now })).toEqual({ ok: true, reason: 'verified' });
    expect(verify(build(inputs()), inputs(), { now: now + 300_000 }).ok).toBe(true);
    expect(verify(build(inputs()), inputs(), { now: now + 300_001 }).ok).toBe(false);
  });
});

describe('codeSha presence', () => {
  it('refuses a verdict whose codeSha was removed', async () => {
    const { verify } = await import('../drain-verdict.mjs');
    const v = { schema: 'drain-verdict/1', decision: 'local', localRequired: ['red-main-freeze', 'card-group'], repo: 'o/r', pr: 1,
      headSha: 'h', mainSha: 'm', gateTree: 't', settingsDigest: 's', inputsDigest: 'i', computedAt: new Date(0).toISOString() };
    const live = { repo: 'o/r', pr: 1, headSha: 'h', mainSha: 'm', gateTree: 't', settingsDigest: 's', inputsDigest: 'i' };
    expect(verify(v, live, { now: 1000 })).toMatchObject({ ok: false, reason: 'codeSha' });
    expect(verify({ ...v, codeSha: 'c' }, live, { now: 1000 }).ok).toBe(true);
  });
});
