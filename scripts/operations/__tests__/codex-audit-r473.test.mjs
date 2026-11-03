import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_QUESTION, QUESTION_HASH, findAudit, main } from '../codex-audit.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const ARGS = ['--base=origin/main', `--head=${HEAD}`, '--json'];
const LEGACY_QUESTION = 'You are a read-only auditor. Judge the WHOLE diff `git diff <base>...<head>`, including pre-existing behaviour the diff now relies on, not only the changed lines. Does the change WEAKEN anything: a guard, gate, test, assertion or fail-closed path; a loosened check or threshold; removed validation; a new bypass, override or silent fallback; a test that no longer fails when the behaviour breaks? Pre-existing limitations the diff relies on count. Answer with the FIRST line exactly `NOT WEAKENED` or `WEAKENED`, then findings, one per line, each with file:line and why. Do not edit files.';
const LEGACY_HASH = createHash('sha256').update(LEGACY_QUESTION).digest('hex');
const finding = (extra = {}) => ({ id: 'f1', class: 'E1', file: 'scripts/output.mjs', line: 12,
  invariant: 'Output preserves label', trigger: 'Empty label', consequence: 'Wrong reversible output', relation: 'introduced', ...extra });
const answer = (findings, first = 'NOT WEAKENED') => `${first}\n${findings.map(f => JSON.stringify(f)).join('\n')}`;

// Stage-2 adapter contract: settings() supplies trusted resolved review settings;
// recheck(finding, {base, head}) returns a replacement classified finding, never a vote.
function fixture(findings, { stage = 'prerelease', first, recheck } = {}) {
  const records = [], output = [], errors = [];
  const deps = {
    resolveSha: vi.fn(ref => ref === 'origin/main' ? BASE : HEAD),
    runCodex: vi.fn(async () => answer(findings, first)),
    settings: vi.fn(() => ({ releaseStage: stage, raceBlockPaths: [], rulings: [] })),
    recheck: recheck ?? vi.fn(async f => ({ ...f, class: 'D3', trigger: 'No concrete breaking input found' })),
    appendRecord: vi.fn(record => records.push(record)), now: () => '2026-11-03T12:00:00.000Z',
    stdout: text => output.push(text), stderr: text => errors.push(text),
  };
  return { deps, records, output, errors, result: () => JSON.parse(output.join('')) };
}

describe('R473 classified audit prompt and records', () => {
  it.each(['WEAKENED', 'WEAKENED\n\n  \t'])('refuses a weakened opening without findings %j and requests human review', async raw => {
    const f = fixture([]);
    f.deps.runCodex.mockResolvedValue(raw);
    expect(await main(ARGS, f.deps)).toBe(3);
    expect(f.records).toEqual([]);
    expect(f.output).toEqual([]);
    expect(f.errors.join('')).toMatch(/incomplete.*human review/);
    expect(f.deps.recheck).not.toHaveBeenCalled();
  });

  it.each(['E1', 'E2'])('preserves prerelease ship and card for parsed %s after a weakened opening', async cls => {
    const f = fixture([finding({ class: cls })], { first: 'WEAKENED' });
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.result().ships).toContainEqual(expect.objectContaining({ class: cls }));
    expect(f.result().cards).toContainEqual(expect.objectContaining({ class: cls }));
  });

  it('changes the question hash and requests every structured evidence column', () => {
    expect(QUESTION_HASH).not.toBe(LEGACY_HASH);
    expect(QUESTION_HASH).toBe(createHash('sha256').update(CANONICAL_QUESTION).digest('hex'));
    for (const field of ['class', 'file:line', 'invariant', 'trigger', 'consequence', 'relation']) expect(CANONICAL_QUESTION).toContain(field);
    expect(CANONICAL_QUESTION).toContain('WHOLE diff');
    expect(CANONICAL_QUESTION).toContain('pre-existing');
  });

  it.each(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])('computes WEAKENED for %s despite a NOT WEAKENED model opening', async cls => {
    const f = fixture([finding({ class: cls })]);
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.result()).toMatchObject({ verdict: 'WEAKENED', releaseStage: 'prerelease',
      findings: [expect.objectContaining({ id: 'f1', class: cls })] });
    expect(f.deps.runCodex).toHaveBeenCalledTimes(1);
  });

  it('computes NOT WEAKENED from prerelease E1 despite a WEAKENED opening and records its card', async () => {
    const f = fixture([finding()], { first: 'WEAKENED' });
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.result()).toMatchObject({ verdict: 'NOT WEAKENED', releaseStage: 'prerelease', cards: [expect.objectContaining({ id: 'f1', class: 'E1' })] });
    expect(f.records[0]).toMatchObject({ base: BASE, head: HEAD, questionHash: QUESTION_HASH,
      releaseStage: 'prerelease', findings: [expect.objectContaining({ class: 'E1' })], cards: f.result().cards });
    expect(f.deps.settings).toHaveBeenCalled();
  });

  it.each(['E1', 'E2'])('uses trusted prod settings to block %s, not model text', async cls => {
    const f = fixture([finding({ class: cls })], { stage: 'prod' });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.result()).toMatchObject({ verdict: 'WEAKENED', releaseStage: 'prod' });
    expect(f.records[0].releaseStage).toBe('prod');
  });

  it('parses pipe evidence rather than retaining opaque finding strings', async () => {
    const f = fixture([]);
    f.deps.runCodex.mockResolvedValue('NOT WEAKENED\nB3|scripts/gate.mjs:9|Unknown state refuses admission|Metadata unreadable|Admission proceeds|introduced');
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.result().findings).toContainEqual(expect.objectContaining({ class: 'B3', file: 'scripts/gate.mjs', line: 9,
      invariant: 'Unknown state refuses admission', trigger: 'Metadata unreadable', consequence: 'Admission proceeds', relation: 'introduced' }));
  });

  it.each([
    'NOT WEAKENED\nscripts/gate.mjs:9 old unclassified finding',
    'NOT WEAKENED\n{"class":"E1"}',
    'NOT WEAKENED\nE1|scripts/gate.mjs:9|missing columns',
    'NOT WEAKENED\n{"id":"f1","class":"b1","file":"x","line":1}',
  ])('refuses clearance from malformed or legacy evidence %j with an operator fallback', async raw => {
    const f = fixture([]); f.deps.runCodex.mockResolvedValue(raw);
    expect(await main(ARGS, f.deps)).not.toBe(0);
    expect(f.records.some(r => r.verdict === 'NOT WEAKENED')).toBe(false);
    expect(f.output.join('')).not.toMatch(/"verdict":"NOT WEAKENED"/);
    expect(f.errors.join('') + f.output.join('')).toMatch(/human|adjudicat|recheck|retry|WEAKENED/i);
  });

  it('findAudit rejects persisted old-question evidence even at the same base/head', () => {
    const legacy = { at: '2026-11-03T12:00:00Z', base: BASE, head: HEAD, questionHash: LEGACY_HASH, verdict: 'NOT WEAKENED', findings: [] };
    expect(findAudit([legacy], { base: BASE, head: HEAD, questionHash: QUESTION_HASH })).toBeNull();
    expect(findAudit([legacy], { base: BASE, head: HEAD, questionHash: LEGACY_HASH })).toBeNull();
  });

  it('findAudit accepts a newly computed record only for its exact base/head/new hash', async () => {
    const f = fixture([finding()]); await main(ARGS, f.deps);
    const query = { base: BASE, head: HEAD, questionHash: QUESTION_HASH };
    expect(f.records[0]).toHaveProperty('releaseStage', 'prerelease');
    expect(findAudit(f.records, query)).toBe(f.records[0]);
    for (const changed of [{ base: HEAD }, { head: BASE }, { questionHash: LEGACY_HASH }]) expect(findAudit(f.records, { ...query, ...changed })).toBeNull();
  });
});

describe('R473 per-finding recheck, never 2-of-3 voting', () => {
  it.each(['D3', 'E1', 'E2', 'X2'])('one recheck returning disputed %s stays unresolved (fingerprint-void keeps the original D1)', async cls => {
    const f = fixture([finding({ class: 'D1', trigger: null })], {
      recheck: vi.fn(async f => ({ ...f, class: cls, disputed: true, trigger: 'Evidence remains disputed' })),
    });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.deps.runCodex).toHaveBeenCalledTimes(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: cls === 'D3' ? 'X2' : 'D1' }));
    expect(f.result().ships).toEqual([]);
    expect(f.result().cards).toEqual([]);
    expect(f.records.some(r => r.verdict === 'NOT WEAKENED')).toBe(false);
  });

  it('one recheck returning X2 without a dispute flag stays unresolved', async () => {
    const f = fixture([finding({ class: 'D1', trigger: null })], {
      recheck: vi.fn(async f => ({ ...f, class: 'X2', trigger: 'Evidence is incomplete' })),
    });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ class: 'D1' }));
    expect(f.records.some(r => r.verdict === 'NOT WEAKENED')).toBe(false);
  });

  it('rechecks D1 once against the same commits then records advisory D3 with a card', async () => {
    const claim = finding({ class: 'D1', trigger: null });
    const f = fixture([claim]);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.deps.recheck).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }), expect.objectContaining({ base: BASE, head: HEAD }));
    expect(f.deps.runCodex).toHaveBeenCalledTimes(1);
    expect(f.result().cards).toContainEqual(expect.objectContaining({ id: 'f1', class: 'D3' }));
  });

  it('dedupes stable file/invariant identities and rechecks distinct disputes independently', async () => {
    const a = finding({ class: 'D1', trigger: null });
    const b = finding({ id: 'f2', class: 'D1', file: 'scripts/other.mjs', trigger: null });
    const f = fixture([a, { ...a, id: 'model-renamed-duplicate' }, b]);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(f.deps.recheck).toHaveBeenCalledTimes(2);
    expect(f.result().cards.map(c => c.id).sort()).toEqual(['f1', 'f2']);
    expect(f.deps.runCodex).toHaveBeenCalledTimes(1);
  });

  it.each(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'])('a failed repro cannot downgrade disputed %s', async cls => {
    const claim = finding({ class: cls, disputed: true });
    const f = fixture([claim], { recheck: vi.fn(async f => ({ ...f, class: 'D3', trigger: 'Could not reproduce' })) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().blocks).toContainEqual(expect.objectContaining({ id: 'f1', class: cls }));
    expect(f.deps.runCodex).toHaveBeenCalledTimes(1);
  });

  it.each(['B4', 'E1'])('a D1 recheck that upgrades to %s changes the fingerprint, is void, and the original D1 stands', async cls => {
    const claim = finding({ class: 'D1', trigger: null });
    const f = fixture([claim], { stage: 'prod', recheck: vi.fn(async f => ({ ...f, class: cls, trigger: 'A pauses; B replaces state; A writes stale state' })) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: 'D1' }));
    expect(f.result().verdict).toBe('WEAKENED');
  });

  it.each(['unavailable', 'malformed', 'still-D1', 'different-finding', 'timeout'])('one %s recheck retains unresolved evidence and never clears', async mode => {
    const claim = finding({ class: 'D1', trigger: null });
    const recheck = vi.fn(async f => {
      if (mode === 'timeout') throw new Error('timeout');
      if (mode === 'unavailable') return null;
      if (mode === 'malformed') return { class: 'D3' };
      if (mode === 'different-finding') return { ...f, id: 'other', file: 'elsewhere.mjs', class: 'D3' };
      return f;
    });
    const f = fixture([claim], { recheck });
    expect(await main(ARGS, f.deps)).not.toBe(0);
    expect(recheck).toHaveBeenCalledTimes(1);
    expect(f.deps.runCodex).toHaveBeenCalledTimes(1);
    expect(f.records.some(r => r.verdict === 'NOT WEAKENED')).toBe(false);
  });

  it('advisory resolution of one dispute never clears a separate block', async () => {
    const f = fixture([finding({ class: 'D1', trigger: null }), finding({ id: 'guard', class: 'B3' })]);
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().blocks).toContainEqual(expect.objectContaining({ id: 'guard', class: 'B3' }));
    expect(f.result().cards).toContainEqual(expect.objectContaining({ id: 'f1', class: 'D3' }));
  });
});

describe('R473 failed exemptions and mandatory race protection', () => {
  it('unauthenticated X1 security exemption cannot clear when independent reclassification is unavailable', async () => {
    const claim = finding({ class: 'X1', ruling: 'R-invented',
      invariant: 'Only authorized callers may access secrets', consequence: 'Security bypass exposes secrets' });
    const f = fixture([claim], { recheck: vi.fn(async () => null) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: 'X2' }));
    expect(f.result().ships).toEqual([]);
    expect(f.records.some(r => r.verdict === 'NOT WEAKENED')).toBe(false);
  });

  it('unauthenticated X1 stays unresolved X2; a recheck that changes its class is void', async () => {
    const claim = finding({ class: 'X1', ruling: 'R-invented', consequence: 'Security bypass exposes secrets' });
    const f = fixture([claim], { recheck: vi.fn(async f => ({ ...f, class: 'B1' })) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: 'X2' }));
    expect(f.result().verdict).toBe('WEAKENED');
    expect(f.result().cards).toEqual([]);
  });

  it('trusted empty race paths still block a concrete built-in file-lock ownership race', async () => {
    const f = fixture([finding({ class: 'D3', file: 'scripts/lib/file-locks.mjs',
      invariant: 'Only one owner may write', trigger: 'A reads old lock; B acquires replacement; A deletes B lock',
      consequence: 'Race permits two owners', interleaving: [{ actor: 'A', action: 'Reads old lock' },
        { actor: 'B', action: 'Acquires replacement' }, { actor: 'A', action: 'Deletes replacement' }] })]);
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.result().blocks).toContainEqual(expect.objectContaining({ id: 'f1', class: 'B4' }));
    expect(f.deps.recheck).not.toHaveBeenCalled();
    expect(f.result().ships).toEqual([]);
  });
});

describe('R473 cached clearance follows current policy', () => {
  const query = { base: BASE, head: HEAD, questionHash: QUESTION_HASH };
  const settings = extra => ({ releaseStage: 'prerelease', raceBlockPaths: [], rulings: [], ...extra });
  it.each(['E1', 'E2'])('prerelease-to-prod cache invalidation rejects cached %s clearance', async cls => {
    const f = fixture([finding({ class: cls })]);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(findAudit(f.records, query, settings())).toBe(f.records[0]);
    expect(findAudit(f.records, query, settings({ releaseStage: 'prod' }))).toBeNull();
  });
  it('cache lookup without injected settings reads the current trusted prod stage', async () => {
    const f = fixture([finding()]);
    await main(ARGS, f.deps);
    vi.stubEnv('WE_REVIEW_RELEASE_STAGE', 'prod');
    try { expect(findAudit(f.records, query)).toBeNull(); }
    finally { vi.unstubAllEnvs(); }
  });
  it('new protected race paths invalidate cached advisory clearance', async () => {
    const f = fixture([finding({ class: 'D3', file: 'custom/writer.mjs' })]);
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(findAudit(f.records, query, settings())).toBe(f.records[0]);
    expect(findAudit(f.records, query, settings({ raceBlockPaths: ['custom/**'] }))).toBeNull();
  });
  it('revoking an authenticated ruling invalidates its cached X1 clearance', async () => {
    const claim = finding({ class: 'X1', ruling: 'R452' });
    const ruling = { id: 'R452', scope: Object.fromEntries(
      ['file', 'line', 'invariant', 'trigger', 'consequence', 'relation'].map(k => [k, claim[k]])) };
    const f = fixture([claim]);
    f.deps.settings.mockReturnValue(settings({ rulings: [ruling] }));
    expect(await main(ARGS, f.deps)).toBe(0);
    expect(findAudit(f.records, query, settings({ rulings: [ruling] }))).toBe(f.records[0]);
    expect(findAudit(f.records, query, settings())).toBeNull();
  });
  it('cached clearance with missing findings cannot be recomputed and requires a fresh audit', async () => {
    const f = fixture([]); await main(ARGS, f.deps);
    const { findings, ...incomplete } = f.records[0];
    expect(findAudit([incomplete], query, settings())).toBeNull();
  });
  it('a persisted block is never cleared automatically by more permissive settings', async () => {
    const f = fixture([finding()], { stage: 'prod' });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(findAudit(f.records, query, settings())).toBe(f.records[0]);
  });
});

describe('R473 protected-path paraphrase adjudication', () => {
  const claim = finding({ class: 'D3', file: 'scripts/lib/file-locks.mjs', invariant: 'Exclusive access',
    trigger: 'A reads before B replaces the lock and A deletes the replacement', consequence: 'Two concurrent writers proceed' });
  it('the concrete race paraphrase never clears after an unstructured advisory recheck', async () => {
    const f = fixture([claim]);
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: 'X2' }));
    expect(f.result().cards).toEqual([]);
  });
  it('one recheck supplies structured evidence and blocks the paraphrased race as B4', async () => {
    const f = fixture([claim], { recheck: vi.fn(async f => ({ ...f, interleaving: [
      { actor: 'A', action: 'Reads the lock' }, { actor: 'B', action: 'Replaces the lock' },
      { actor: 'A', action: 'Deletes the replacement' },
    ] })) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.recheck).toHaveBeenCalledTimes(1);
    expect(f.result().blocks).toContainEqual(expect.objectContaining({ id: 'f1', class: 'B4' }));
  });
  it('oversized structured evidence refuses clearance with an operator-visible human fallback', async () => {
    const f = fixture([{ ...claim, interleaving: Array.from({ length: 33 }, (_, i) => ({ actor: String(i), action: 'Writes' })) }]);
    expect(await main(ARGS, f.deps)).toBe(3);
    expect(f.errors.join('')).toMatch(/human review/);
    expect(f.records).toEqual([]);
  });

describe('R473 recheck fingerprint binding (D-R451)', () => {
  it.each([
    ['relation', { relation: 'untouched' }], ['class', { class: 'E2' }],
    ['id', { id: 'other' }], ['file', { file: 'scripts/else.mjs' }], ['invariant', { invariant: 'Something else' }],
    ['hunkHash', { hunkHash: 'f'.repeat(64) }],
    // Location and consequence are part of the claim: a drifted recheck cannot relocate or rewrite it.
    ['line', { line: 13 }], ['consequence', { consequence: 'Only a cosmetic difference' }],
  ])('a recheck that changes %s is void and the original stands', async (_name, change) => {
    const claim = finding({ class: 'D1', trigger: null });
    const f = fixture([claim], { recheck: vi.fn(async x => ({ ...x, class: 'D3', trigger: 'Swapped', ...change })) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.result().verdict).toBe('WEAKENED');
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: 'D1' }));
  });
  it.each([
    ['trigger', { trigger: 'A different input' }], ['line', { line: 13 }],
    ['consequence', { consequence: 'Only a cosmetic difference' }],
  ])('a same-class recheck that changes %s is void (only a D1 to D3 downgrade may restate the trigger)', async (_name, change) => {
    const claim = finding({ disputed: true });
    const f = fixture([claim], { recheck: vi.fn(async x => ({ ...x, disputed: false, ...change })) });
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.result().recheck).toContainEqual(expect.objectContaining({ id: 'f1', class: 'X2' }));
    expect(f.result().cards).toEqual([]);
  });
  it('a same-class recheck with the identical fingerprint resolves the dispute', async () => {
    const f = fixture([finding({ disputed: true })], { recheck: vi.fn(async x => ({ ...x, disputed: false })) });
    expect(await main(ARGS, f.deps)).toBe(0);
  });
  it('a same-fingerprint D1 to D3 downgrade clears with a card', async () => {
    const f = fixture([finding({ class: 'D1', trigger: null })]);
    expect(await main(ARGS, f.deps)).toBe(0);
  });
  it('uses deps.hunkHash when supplied and binds to it', async () => {
    const f = fixture([finding({ class: 'D1', trigger: null })], { recheck: vi.fn(async x => ({ ...x, class: 'D3', hunkHash: 'a'.repeat(64) })) });
    f.deps.hunkHash = vi.fn(async () => 'b'.repeat(64));
    expect(await main(ARGS, f.deps)).toBe(1);
    expect(f.deps.hunkHash).toHaveBeenCalled();
  });
});

});
