import { describe, expect, it } from 'vitest';
import { claimIdentifiers, claimTerms, makeGitRepo, verifyFinding } from '../round-judge-verify.mjs';

const files = {
  'scripts/lib/__tests__/git-identity.test.mjs': "describe('x', () => {\n  it('non-leader timeout does not sweep unrelated group orphans', () => {\n    const env = { WE_VERIFY_SLOT_HEARTBEAT_MS: '1000' }\n    expect(env).toBeTruthy()\n  })\n})\n",
  'scripts/lib/git-identity.mjs': "export function repair() {\n  try { x() } catch (e) {\n    console.error('hook repair failed', e)\n    return { status: 'error', error: String(e) }\n  }\n}\n",
};
const repo = (tests = ['scripts/lib/__tests__/git-identity.test.mjs']) => ({ read: (p) => files[p] ?? null, tests: () => tests });

describe('claim extraction', () => {
  it('identifiers, subject first', () => {
    expect(claimIdentifiers('defaultReviewHostAdmission and its wiring into buildCliDaemonEffects are untested')).toEqual(['defaultReviewHostAdmission', 'buildCliDaemonEffects']);
    expect(claimIdentifiers('env WE_VERIFY_SLOT_HEARTBEAT_MS and `foo` matter')).toEqual(['WE_VERIFY_SLOT_HEARTBEAT_MS', 'foo'].sort((a, b) => 'env WE_VERIFY_SLOT_HEARTBEAT_MS and `foo` matter'.indexOf(a) - 'env WE_VERIFY_SLOT_HEARTBEAT_MS and `foo` matter'.indexOf(b)));
  });
  it('terms drop stop words', () => { expect(claimTerms('The caller group-leader guard has no named regression test')).toEqual(['group', 'leader', 'guard']); });
});

describe('verifyFinding', () => {
  it('coverage claim: a test title with two distinctive terms refutes, with file:line evidence', () => {
    const r = verifyFinding({ file: 'scripts/lib/git-identity.mjs', line: 9, summary: "COVERAGE: The caller's group-leader guard has no named regression test." }, repo());
    expect(r).toEqual({ status: 'refuted', evidence: 'scripts/lib/__tests__/git-identity.test.mjs:2 "non-leader timeout does not sweep unrelated group orphans"' });
  });
  it('coverage claim: terms co-occurring on a body line also refute (env name in a test)', () => {
    const r = verifyFinding({ file: 'scripts/lib/git-identity.mjs', line: 9, summary: 'The 5-minute slot heartbeat wiring has no test.' }, repo());
    expect(r.status).toBe('refuted');
    expect(r.evidence).toMatch(/git-identity\.test\.mjs:3 /);
  });
  it('coverage claim: the subject identifier in a test refutes', () => {
    const r = verifyFinding({ file: 'a.mjs', line: 1, summary: 'WE_VERIFY_SLOT_HEARTBEAT_MS is untested.' }, repo());
    expect(r).toMatchObject({ status: 'refuted', evidence: expect.stringContaining('uses WE_VERIFY_SLOT_HEARTBEAT_MS') });
  });
  it('coverage claim: a stem-word-only match is NOT evidence', () => {
    const r = verifyFinding({ file: 'scripts/lib/git-identity.mjs', line: 1, summary: 'The git identity retry has no test.' }, repo());
    expect(r.status).toBe('inconclusive');
  });
  it('coverage claim with no matching test -> inconclusive', () => {
    expect(verifyFinding({ file: 'a.mjs', line: 1, summary: 'The frobnicator quantum retry has no test.' }, repo()).status).toBe('inconclusive');
  });
  it('silent-failure claim: a log and an error-status return near the line refute', () => {
    const r = verifyFinding({ file: 'scripts/lib/git-identity.mjs', line: 2, summary: 'Hook-repair errors are silently discarded.' }, repo());
    expect(r).toEqual({ status: 'refuted', evidence: 'scripts/lib/git-identity.mjs:3 logs/throws and scripts/lib/git-identity.mjs:4 returns an error status, every catch in the function holding line 2 is handled' });
  });
  it('the old looser shapes (identifier outside a test body, a swallowing catch) are NOT refuted', () => {
    const loose = { 'scripts/lib/__tests__/git-identity.test.mjs': "describe('x', () => {\n  it('adds', () => {})\n  const env = { WE_VERIFY_SLOT_HEARTBEAT_MS: '1000' }\n})\n" };
    expect(verifyFinding({ file: 'a.mjs', line: 1, summary: 'WE_VERIFY_SLOT_HEARTBEAT_MS is untested.' }, { read: (p) => loose[p] ?? null, tests: () => Object.keys(loose) }).status).toBe('inconclusive');
  });
  it('silent-failure claim with only a log -> inconclusive', () => {
    const r = verifyFinding({ file: 'b.mjs', line: 1, summary: 'errors are silently ignored' }, { read: () => 'console.error(1)\n', tests: () => [] });
    expect(r.status).toBe('inconclusive');
  });
  it('behaviour claim naming identifiers absent from the cited file refutes; present -> inconclusive', () => {
    expect(verifyFinding({ file: 'scripts/lib/git-identity.mjs', line: 1, summary: 'ghostFunction mutates the ledger' }, repo()).status).toBe('refuted');
    expect(verifyFinding({ file: 'scripts/lib/git-identity.mjs', line: 1, summary: 'repair mutates the ledger; call `repair`' }, repo()).status).toBe('inconclusive');
  });
  it('missing file, no file, or a throwing repo -> inconclusive (never guesses not-real)', () => {
    expect(verifyFinding({ file: 'gone.mjs', line: 1, summary: 'ghostFunction mutates' }, repo()).status).toBe('inconclusive');
    expect(verifyFinding({ file: null, line: 1, summary: 'x' }, repo()).status).toBe('inconclusive');
    expect(verifyFinding({ file: 'a.mjs', line: 1, summary: 'no test for alpha' }, { read() { throw new Error('x'); }, tests() { throw new Error('x'); } }).status).toBe('inconclusive');
  });
});

describe('false-refutation probes (audit round 2)', () => {
  const R = (map) => ({ read: (p) => map[p] ?? null, tests: () => Object.keys(map).filter((p) => /test/.test(p)) });
  it('an unused import of the subject is not coverage', () => {
    const r = verifyFinding({ file: 'pay.mjs', line: 1, summary: 'retryPayment is untested.' },
      R({ 'pay.test.mjs': "import { retryPayment } from './pay.mjs';\ndescribe('x', () => { it('adds', () => { expect(1 + 1).toBe(2) }) })\n" }));
    expect(r.status).toBe('inconclusive');
  });
  it('terms match whole words only (backoffice is not backoff)', () => {
    const r = verifyFinding({ file: 'b.mjs', line: 1, summary: 'The retry backoff has no test.' }, R({ 'b.test.mjs': "it('retry button renders backoffice label', () => {})\n" }));
    expect(r.status).toBe('inconclusive');
  });
  it('a log and an error return in a DIFFERENT function do not refute a swallowed error', () => {
    const src = "function payment() { try { throw Error('payment'); } catch {} }\nfunction unrelated() {\n  console.error('unrelated'); return { status: 'error' };\n}\n";
    expect(verifyFinding({ file: 'p.mjs', line: 1, summary: 'Payment errors are silently discarded.' }, R({ 'p.mjs': src })).status).toBe('inconclusive');
  });
  it('a bare empty catch inside the cited function blocks the refutation', () => {
    const src = "function f() {\n  try { a() } catch (e) { console.error(e); return { status: 'error' } }\n  try { b() } catch {}\n}\n";
    expect(verifyFinding({ file: 'p.mjs', line: 2, summary: 'errors are silently discarded' }, R({ 'p.mjs': src })).status).toBe('inconclusive');
  });
  it('an identifier used OUTSIDE a test body is not coverage', () => {
    const r = verifyFinding({ file: 'pay.mjs', line: 1, summary: 'retryPayment is untested.' }, R({ 'pay.test.mjs': "it('arithmetic', () => { expect(1+1).toBe(2); });\nconst unused = retryPayment;\n" }));
    expect(r.status).toBe('inconclusive');
  });
  it('one handled catch does not excuse another swallowing catch in the same function', () => {
    const src = "function pay() {\n  try { charge(); } catch (e) { void e; }\n  try { audit(); } catch (e) {\n    console.error(e);\n    return { status: 'error' };\n  }\n}\n";
    expect(verifyFinding({ file: 'p.mjs', line: 2, summary: 'Payment errors are silently discarded.' }, R({ 'p.mjs': src })).status).toBe('inconclusive');
  });
  it('a skipped test is not coverage', () => {
    const r = verifyFinding({ file: 'pay.mjs', line: 1, summary: 'retryPayment is untested.' }, R({ 'pay.test.mjs': "it.skip('retryPayment', () => { retryPayment(); });\n" }));
    expect(r.status).toBe('inconclusive');
    expect(verifyFinding({ file: 'pay.mjs', line: 1, summary: 'retryPayment is untested.' }, R({ 'pay.test.mjs': "describe.skip('s', () => {\n  it('x', () => {\n    retryPayment();\n  })\n})\n" })).status).toBe('inconclusive');
  });
  it('a second swallowing catch on the SAME line blocks the refutation', () => {
    const src = "function pay() {\n  try { audit(); } catch(e) { console.error(e); return {status:'error'}; } try { charge(); } catch(e) { void e; }\n}\n";
    expect(verifyFinding({ file: 'p.mjs', line: 2, summary: 'Payment errors are silently discarded.' }, R({ 'p.mjs': src })).status).toBe('inconclusive');
  });
  it('an absence claim is not refuted by the identifier being absent', () => {
    expect(verifyFinding({ file: 'r.mjs', line: 1, summary: 'The response omits required requestId.' }, R({ 'r.mjs': 'export function response() { return {}; }' })).status).toBe('inconclusive');
  });
});

describe('makeGitRepo', () => {
  const HEAD = 'a'.repeat(40);
  it('reads via git show of the head only; refuses odd paths and a bad head', () => {
    const calls = [];
    const r = makeGitRepo({ head: HEAD, run: (a) => { calls.push(a); return 'body'; } });
    expect(r.read('scripts/x.mjs')).toBe('body');
    expect(calls[0]).toEqual(['show', `${HEAD}:scripts/x.mjs`]);
    expect(r.read('../etc/passwd')).toBeNull();
    expect(r.read('/abs')).toBeNull();
    expect(makeGitRepo({ head: 'zzz', run: () => 'x' }).read('a.mjs')).toBeNull();
  });
  it('a commit missing from the clone gives null / no tests, not a throw', () => {
    const r = makeGitRepo({ head: HEAD, run: () => { throw new Error('bad object'); } });
    expect(r.read('a.mjs')).toBeNull();
    expect(r.tests('a')).toEqual([]);
  });
  it('an identifier that looks like a git option is never passed as one', () => {
    const calls = [];
    const r = makeGitRepo({ head: HEAD, run: (a) => { calls.push(a); return ''; } });
    r.tests('a', ['--files-without-match', 'good_id']);
    const grepCalls = calls.filter((a) => a[0] === 'grep');
    expect(grepCalls).toHaveLength(1);
    expect(grepCalls[0]).toContain('-e');
    expect(grepCalls[0][grepCalls[0].indexOf('-e') + 1]).toBe('good_id');
  });
  it('tests(): name-based test files first, then tests that contain the identifier; only read-only git verbs', () => {
    const calls = [];
    const r = makeGitRepo({ head: HEAD, run: (a) => { calls.push(a[0]); return a[0] === 'ls-tree' ? 'scripts/a.mjs\nscripts/__tests__/a.test.mjs\nscripts/__tests__/other.test.mjs' : `${HEAD}:scripts/__tests__/id.test.mjs`; } });
    expect(r.tests('a', ['someIdentifier'])).toEqual(['scripts/__tests__/a.test.mjs', 'scripts/__tests__/id.test.mjs']);
    expect(new Set(calls)).toEqual(new Set(['ls-tree', 'grep']));
  });
});
