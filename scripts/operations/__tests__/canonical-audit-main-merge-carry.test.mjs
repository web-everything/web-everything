import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCanonicalAuditForOpen } from '../canonical-audit-gate.mjs';
import { QUESTION_HASH } from '../codex-audit.mjs';
import { netDiffFingerprint } from '../../lib/net-diff-fingerprint.mjs';
import { mergeTimingsJson } from '../../lib/daemon-rebuild/advisory-merge.mjs';

const dirs = [], timings = 'scripts/ci/test-timings.json', manifest = '.lane-manifest.json';
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture({ union = false, hops = 1, pass = false, conflict = false } = {}) {
  const repo = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'main-carry-')); dirs.push(repo);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: repo,
    WE_PLATFORM_PREFERENCES_FILE: join(repo, 'prefs.json') };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_REPLACE_REF_BASE']) delete env[key];
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const json = value => JSON.stringify({ unit: value, soak: { guard: 10 } }, null, 1) + '\n';
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
  put(timings, json({ base: 1 })); put('code.txt', 'base\n'); put(manifest, '{}\n'); const base = commit();
  git('checkout', '-qb', 'lane/test'); put('code.txt', 'lane\n'); if (union) put(timings, json({ base: 1, lane: 2 })); const A = commit();
  git('update-ref', 'refs/remotes/origin/main', base);
  const fingerprint = netDiffFingerprint(repo, base, A);
  const audit = { head: A, base, fingerprint, questionHash: QUESTION_HASH, at: '2026-11-20T00:00:00Z', verdict: pass ? 'NOT WEAKENED' : 'WEAKENED', findings: pass ? [] : ['missing guard'] };
  const waiver = { ref: 'lane/test', sha: A, fingerprint, ruling: 'R123', findings: ['missing guard'] };
  let B, main;
  for (let i = 0; i < hops; i++) {
    git('checkout', '-q', 'main'); put(`main-${i}.txt`, 'main\n'); if (union) put(timings, json({ base: 1, main: 3 })); if (conflict) put('code.txt', 'main\n'); main = commit();
    git('update-ref', 'refs/remotes/origin/main', main); git('checkout', '-q', 'lane/test');
    try { git('merge', '--no-ff', '--no-commit', main); } catch { /* resolve actual conflicts below */ }
    if (union) put(timings, mergeTimingsJson(git('show', `${base}:${timings}`), git('show', `${A}:${timings}`), git('show', `${main}:${timings}`)));
    if (conflict) put('code.txt', 'novel resolution\n'); B = commit();
  }
  const records = [audit], waivers = [waiver]; let withdrawn = '';
  const run = (over = {}) => checkCanonicalAuditForOpen({ repo, ref: 'lane/test', sha: B, env, fetchMain: () => {}, warn: () => {},
    readFile: path => {
      if (String(path).endsWith('scripts/settings/prototype-load.json')) return JSON.stringify({ auditRecordPath: join(repo, 'audit.jsonl'), ruledWeakened: waivers });
      if (path === join(repo, 'audit.jsonl')) return records.map(r => JSON.stringify(r)).join('\n');
      if (path === env.WE_PLATFORM_PREFERENCES_FILE) return '{}';
      if (String(path).endsWith('waiver-requests.jsonl')) return withdrawn;
      return readFileSync(path, 'utf8');
    }, ...over });
  const amend = (path, text) => { if (text === null) rmSync(join(repo, path)); else put(path, text); git('add', '-A'); git('commit', '--amend', '--no-edit', '-q'); B = git('rev-parse', 'HEAD'); };
  const parents = ps => { B = git('commit-tree', git('rev-parse', `${B}^{tree}`), ...ps.flatMap(p => ['-p', p]), '-m', 'shape'); };
  return { repo, env, git, A, base, main, audit, waiver, records, waivers, run, amend, parents, head: () => B,
    revoke: () => { withdrawn = JSON.stringify({ ref: waiver.ref, sha: A, ruling: 'WITHDRAWN' }); } };
}
describe('canonical main merge carry with real git objects', () => {
  it('carries a ruled WEAKENED audit across a merge of origin/main with an unchanged lane diff', () => {
    const f = fixture(); expect(f.run()).toMatchObject({ ok: true, carried: { kind: 'carried-across-main-merge', from: f.A, to: f.head(), mainParent: f.main, fingerprint: f.audit.fingerprint, ruling: 'R123' } });
  });
  it('carries when the merge resolves test-timings.json with the canonical union', () => { expect(fixture({ union: true }).run().ok).toBe(true); });
  it('carries byte-identical parent-two timings', () => { const f = fixture({ union: true }); f.amend(timings, f.git('show', `${f.main}:${timings}`) + '\n'); expect(f.run().ok).toBe(true); });
  it('refuses a tampered intermediate merge even when the final timings match a parent', () => {
    const f = fixture(); f.amend(timings, '{"unit":{},"soak":{}}');
    const tampered = f.head();
    f.git('checkout', '-q', 'main'); writeFileSync(join(f.repo, 'later-main.txt'), 'main'); f.git('add', '-A'); f.git('commit', '-qm', 'main advances');
    const main = f.git('rev-parse', 'HEAD'); f.git('update-ref', 'refs/remotes/origin/main', main);
    f.git('checkout', '-q', 'lane/test'); f.git('merge', '--no-ff', '-qm', 'second merge', main);
    expect(f.run({ sha: f.git('rev-parse', 'HEAD') }).ok).toBe(false);
    expect(tampered).not.toBe(f.A);
  });
  it('refuses a missing live fingerprint', () => { const f = fixture(); expect(f.run({ liveFingerprint: () => null }).ok).toBe(false); });
  it('refuses a differing audit fingerprint', () => { const f = fixture(); f.audit.fingerprint = 'f'.repeat(64); expect(f.run().ok).toBe(false); });
  it('refuses different waiver findings', () => { const f = fixture(); f.waiver.findings = ['reworded finding']; expect(f.run().ok).toBe(false); });
  it('names the applicable carry without directing a re-audit when a waiver is missing', () => { const f = fixture(); f.waivers.length = 0; const result = f.run(); expect(result.ok).toBe(false); expect(result.message).toMatch(/carry applies.*do not re-audit/i); });
  it('refuses a hand-edited test-timings.json resolution', () => { const f = fixture({ union: true }); f.amend(timings, '{"unit":{},"soak":{"guard":0}}'); expect(f.run().ok).toBe(false); });
  it('refuses PASS carry with hand-edited test-timings.json', () => { const f = fixture({ pass: true }); f.amend(timings, '{"unit":{},"soak":{}}'); expect(f.run().ok).toBe(false); });
  it.each(['waiver', 'audit'])('refuses a missing %s fingerprint', key => { const f = fixture(); delete f[key].fingerprint; expect(f.run().ok).toBe(false); });
  it.each(['bad', 'f'.repeat(64)])('refuses an invalid or differing waiver fingerprint %s', fp => { const f = fixture(); f.waiver.fingerprint = fp; expect(f.run().ok).toBe(false); });
  it('refuses a code conflict resolved with a new hunk', () => { expect(fixture({ conflict: true }).run().ok).toBe(false); });
  it('refuses deleted test-timings.json', () => { const f = fixture(); f.amend(timings, null); expect(f.run().ok).toBe(false); });
  it('refuses changed test-timings.json mode through the timings guard even with matching fingerprints', () => {
    const f = fixture();
    chmodSync(join(f.repo, timings), 0o755);
    f.amend(timings, readFileSync(join(f.repo, timings), 'utf8'));
    expect(f.git('diff', '--name-only', f.A, f.head())).toBe(`main-0.txt\n${timings}`);
    const originalFingerprint = f.audit.fingerprint;
    // Match the evidence to the mode-only diff so fingerprint mismatch cannot cause refusal.
    f.audit.fingerprint = f.waiver.fingerprint = netDiffFingerprint(f.repo, f.main, f.head());
    const timingReads = [];
    const result = f.run({ exec: (cmd, args, options) => {
      if (args.includes('ls-tree') && args.at(-1) === timings) timingReads.push(args.at(-3));
      return execFileSync(cmd, args, options);
    } });
    expect(timingReads).toEqual([f.head(), f.A, f.main]);
    expect(result).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    // Restoring only the mode clears the timings guard and permits the same carry.
    chmodSync(join(f.repo, timings), 0o644);
    f.amend(timings, readFileSync(join(f.repo, timings), 'utf8'));
    f.audit.fingerprint = f.waiver.fingerprint = originalFingerprint;
    expect(f.run().ok).toBe(true);
  });
  it('refuses swapped parents', () => { const f = fixture(); f.parents([f.main, f.A]); expect(f.run().ok).toBe(false); });
  it('refuses three parents', () => { const f = fixture(); const sibling = f.git('commit-tree', f.git('rev-parse', `${f.A}^{tree}`), '-p', f.base, '-m', 'sibling'); f.parents([f.A, f.main, sibling]); expect(f.run().ok).toBe(false); });
  it('refuses parent two outside origin/main', () => { const f = fixture(); f.git('update-ref', 'refs/remotes/origin/main', f.base); expect(f.run().ok).toBe(false); });
  it('refuses a failed main refresh', () => { const f = fixture(); expect(f.run({ fetchMain: () => { throw Error('offline'); } }).ok).toBe(false); });
  it('refuses a failed cat-file read', () => { const f = fixture(); const blob = f.git('rev-parse', `${f.head()}:${timings}`); rmSync(join(f.repo, '.git/objects', blob.slice(0, 2), blob.slice(2))); expect(f.run().ok).toBe(false); });
  it('refuses the head own newer WEAKENED', () => { const f = fixture(); f.records.push({ ...f.audit, head: f.head(), at: '2026-11-20T01:00:00Z' }); expect(f.run().ok).toBe(false); });
  it.each([undefined, 'bad', 'f'.repeat(64)])('refuses an intermediate unwaived WEAKENED with fingerprint %s', fingerprint => {
    const f = fixture({ hops: 4 });
    expect(f.run().ok).toBe(true);
    const intermediate = f.git('rev-parse', 'HEAD~2');
    f.records.push({ ...f.audit, head: intermediate, fingerprint, at: '2026-11-20T01:00:00Z' });
    const result = f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(fingerprint === 'bad' ? 'canonical-audit-missing' : 'canonical-audit-weakened');
    expect(result.carried).toBeUndefined();
  });
  it('accepts an intermediate WEAKENED without a fingerprint only with its own matching waiver', () => {
    const f = fixture({ hops: 2 });
    const intermediate = f.git('rev-parse', 'HEAD~1');
    f.records.push({ ...f.audit, head: intermediate, fingerprint: undefined, at: '2026-11-20T01:00:00Z' });
    expect(f.run().ok).toBe(false);
    f.waivers.push({ ...f.waiver, sha: intermediate });
    expect(f.run().ok).toBe(true);
  });
  it.each([undefined, true])('ignores an intermediate WEAKENED for an unaccepted question hash (fingerprinted: %s)', fingerprinted => {
    const f = fixture({ hops: 2, pass: true });
    expect(f.run().ok).toBe(true);
    const intermediate = f.git('rev-parse', 'HEAD~1');
    f.records.push({ ...f.audit, head: intermediate, fingerprint: fingerprinted ? f.audit.fingerprint : undefined,
      verdict: 'WEAKENED', findings: ['foreign finding'],
      questionHash: '0'.repeat(64), at: '2026-11-20T01:00:00Z' });
    expect(f.run()).toMatchObject({ ok: true, carried: { from: f.A } });
  });
  it.each([false, true])('ignores a superseded fingerprintless intermediate WEAKENED (backdated pass: %s)', backdated => {
    const f = fixture({ hops: 2, pass: true });
    const intermediate = f.git('rev-parse', 'HEAD~1');
    const weak = { ...f.audit, head: intermediate, fingerprint: undefined, verdict: 'WEAKENED',
      findings: ['obsolete finding'], at: '2026-11-20T01:00:00Z' };
    const pass = { ...weak, verdict: 'NOT WEAKENED', findings: [],
      at: backdated ? '2026-11-20T00:30:00Z' : '2026-11-20T02:00:00Z' };
    f.records.push(weak, pass);
    expect(f.run()).toMatchObject({ ok: true, carried: { from: f.A } });
  });
  it('keeps an intermediate WEAKENED on another base active after a passing re-audit', () => {
    const f = fixture({ hops: 2, pass: true });
    const intermediate = f.git('rev-parse', 'HEAD~1');
    f.records.push({ ...f.audit, head: intermediate, fingerprint: undefined, verdict: 'WEAKENED',
      findings: ['still active'], at: '2026-11-20T01:00:00Z' });
    f.records.push({ ...f.audit, head: intermediate, base: f.main, fingerprint: undefined,
      at: '2026-11-20T02:00:00Z' });
    expect(f.run()).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
  });
  it('keeps a later-appended intermediate WEAKENED active despite a backdated timestamp', () => {
    const f = fixture({ hops: 2, pass: true });
    const intermediate = f.git('rev-parse', 'HEAD~1');
    f.records.push({ ...f.audit, head: intermediate, fingerprint: undefined, at: '2026-11-20T02:00:00Z' });
    f.records.push({ ...f.audit, head: intermediate.toUpperCase(), base: f.base.toUpperCase(),
      fingerprint: undefined, verdict: 'WEAKENED', findings: ['active finding'], at: '2026-11-20T01:00:00Z' });
    expect(f.run()).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
  });
  it('requires each intermediate base to have its own matching waiver', () => {
    const f = fixture({ hops: 2, pass: true });
    const intermediate = f.git('rev-parse', 'HEAD~1');
    const weak = { ...f.audit, head: intermediate, fingerprint: undefined, verdict: 'WEAKENED',
      findings: ['first finding'], at: '2026-11-20T01:00:00Z' };
    f.records.push(weak, { ...weak, base: f.main, findings: ['second finding'] });
    f.waivers.push({ ...f.waiver, sha: intermediate, findings: ['first finding'] });
    expect(f.run()).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    f.waivers.push({ ...f.waiver, sha: intermediate, findings: ['second finding'] });
    // ref+sha+ruling is the waiver identity: reusing R123 cannot add separate findings.
    expect(f.run()).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
    f.waivers.at(-1).ruling = 'R124';
    expect(f.run()).toMatchObject({ ok: true, carried: { from: f.A } });
  });
  it('preserves the newer unwaived sibling WEAKENED veto despite identical findings and fingerprint', () => {
    const f = fixture();
    expect(f.run().ok).toBe(true);
    const sibling = f.git('commit-tree', f.git('rev-parse', `${f.A}^{tree}`), '-p', f.base, '-m', 'sibling');
    f.records.push({ ...f.audit, head: sibling, at: '2026-11-20T01:00:00Z' });
    expect(f.run()).toMatchObject({ ok: false, reason: 'canonical-audit-weakened' });
  });
  it('refuses a waiver for another ref', () => { const f = fixture(); f.waiver.ref = 'lane/other'; expect(f.run().ok).toBe(false); });
  it('refuses a revoked waiver on a later check', () => { const f = fixture(); expect(f.run().ok).toBe(true); f.revoke(); expect(f.run().ok).toBe(false); });
  it('refuses a five-hop chain with an operator fallback', () => { const f = fixture({ hops: 5 }); const r = f.run(); expect(r.ok).toBe(false); expect(r.message).toMatch(/audit|operator/i); });
  it.each([2, 4])('carries a %i-hop chain', hops => { expect(fixture({ hops }).run().ok).toBe(true); });
  it('ignores GIT_DIR and a planted replace ref for A', () => { const f = fixture({ union: true }); f.git('replace', f.A, f.base); expect(f.run({ env: { ...f.env, GIT_DIR: '/nonexistent', GIT_WORK_TREE: '/nonexistent', GIT_INDEX_FILE: '/nonexistent', GIT_COMMON_DIR: '/nonexistent', GIT_REPLACE_REF_BASE: 'refs/evil' } }).ok).toBe(true); });
  it('refuses a waiver on a sibling sha', () => { const f = fixture(); f.waiver.sha = f.git('commit-tree', f.git('rev-parse', `${f.A}^{tree}`), '-p', f.base, '-m', 'sibling'); expect(f.run().ok).toBe(false); });
  it('refuses a changed manifest but allows its absence', () => { const f = fixture(); f.amend(manifest, '{"evil":true}'); expect(f.run().ok).toBe(false); f.amend(manifest, null); expect(f.run().ok).toBe(true); });
  it('refuses moved refs in place of the pinned merge head', () => { const f = fixture(); f.git('update-ref', 'refs/heads/lane/test', f.A); expect(f.run({ sha: 'lane/test' }).carried).toBeUndefined(); });
});
