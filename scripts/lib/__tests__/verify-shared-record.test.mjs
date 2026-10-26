import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARED_RECORD_DIR_ENV, SHARED_RECORD_GATE, resolveSharedRecordDir, normalizeRepoScope, repoScopeOf,
  sharedRecordPath, shouldWriteSharedRecord, writeSharedRecord, readSharedRecord,
  recordSharedGreen, sharedFinishGuardFallback,
} from '../verify-shared-record.mjs';
import * as sharedRecords from '../verify-shared-record.mjs';
import { computeWorkingTreeHash } from '../verify-lane-gate.mjs';
import { shouldRecordGreen, verifyGateDecision, readVerifyMarker } from '../lane-verify.mjs';
import { resolveFinishGuardVerdict } from '../../pr-land.mjs';

const temps = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'verify-shared-')); temps.push(dir); return dir; };
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const gitIn = (cwd) => (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (git, message) => git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', message]);
function clones() {
  const root = temp();
  const origin = join(root, 'origin.git');
  gitIn(root)(['init', '--bare', '-q', '--initial-branch=main', origin]);
  const a = join(root, 'A');
  gitIn(root)(['clone', '-q', origin, a]);
  const gitA = gitIn(a);
  writeFileSync(join(a, 'tracked.txt'), 'base\n');
  gitA(['add', '.']); commit(gitA, 'base'); gitA(['push', '-q', 'origin', 'main']);
  gitA(['checkout', '-qb', 'feature']);
  writeFileSync(join(a, 'tracked.txt'), 'feature\n');
  gitA(['add', '.']); commit(gitA, 'feature'); gitA(['push', '-q', 'origin', 'feature']);
  const b = join(root, 'B');
  gitIn(root)(['clone', '-q', '--branch', 'feature', origin, b]);
  const gitB = gitIn(b);
  const hash = (repo, runGit) => computeWorkingTreeHash({ runGit, fileMode: (f) => lstatSync(join(repo, f)).mode });
  const key = { dir: join(root, 'store'), sha: gitA(['rev-parse', 'HEAD']), treeHash: hash(a, gitA), mergeBase: gitA(['merge-base', 'HEAD', 'origin/main']), headTree: gitA(['rev-parse', 'HEAD^{tree}']), clean: true, gate: 'default', scope: repoScopeOf(gitA) };
  return { root, a, b, gitA, gitB, hash, key };
}
const syntheticKey = () => ({ dir: join(temp(), 'store'), sha: 'a'.repeat(40), treeHash: 'b'.repeat(64), mergeBase: 'c'.repeat(40), headTree: 'd'.repeat(40), clean: true, gate: 'default', scope: 'github:owner/repo' });

describe('shared record directory cascade and scope', () => {
  it('uses absolute env, then file, then coordination; invalid layers fall through', () => {
    const root = temp(); const settingsPath = join(root, 'settings.json');
    const coordinationRoot = join(root, 'coord'); const fileDir = join(root, 'configured');
    writeFileSync(settingsPath, JSON.stringify({ sharedRecordDir: fileDir }));
    const opts = { settingsPath, coordinationRoot, home: root };
    expect(SHARED_RECORD_DIR_ENV).toBe('WE_VERIFY_SHARED_RECORD_DIR');
    expect(SHARED_RECORD_GATE).toBe('default');
    expect(resolveSharedRecordDir({ ...opts, env: { WE_VERIFY_SHARED_RECORD_DIR: join(root, 'override') } })).toEqual({ dir: join(root, 'override'), source: 'env' });
    expect(resolveSharedRecordDir({ ...opts, env: { WE_VERIFY_SHARED_RECORD_DIR: 'relative' } })).toEqual({ dir: fileDir, source: 'file' });
    expect(resolveSharedRecordDir({ ...opts, env: { WE_VERIFY_SHARED_RECORD_DIR: '~/override' } })).toEqual({ dir: join(root, 'override'), source: 'env' });
    writeFileSync(settingsPath, JSON.stringify({ sharedRecordDir: '~/configured' }));
    expect(resolveSharedRecordDir({ ...opts, env: {} })).toEqual({ dir: fileDir, source: 'file' });
    for (const contents of ['{"sharedRecordDir":"relative"}', 'broken', 'null']) {
      writeFileSync(settingsPath, contents);
      expect(resolveSharedRecordDir({ ...opts, env: {} })).toEqual({ dir: join(coordinationRoot, 'verify-shared'), source: 'default' });
    }
    expect(resolveSharedRecordDir({ settingsPath: join(root, 'missing'), env: { WE_COORDINATION_ROOT: coordinationRoot } })).toEqual({ dir: join(coordinationRoot, 'verify-shared'), source: 'default' });
  });
  it('normalizes GitHub URL variants and preserves local origin paths', () => {
    for (const url of ['git@github.com:Owner/Repo.git', 'https://github.com/Owner/Repo', 'https://github.com/Owner/Repo.git/', 'https://github.com/Owner/Repo/', 'ssh://git@github.com/Owner/Repo.git']) {
      expect(normalizeRepoScope(url)).toBe('github:owner/repo');
    }
    expect(normalizeRepoScope('/Some/Origin.git///')).toBe('file:/Some/Origin.git');
    expect(normalizeRepoScope('../Origin/')).toBeNull();
    for (const value of ['', ' ', null, 3]) expect(normalizeRepoScope(value)).toBeNull();
    expect(repoScopeOf(() => { throw Error('no origin'); })).toBeNull();
  });
});

describe('atomic records and exact-match reads', () => {
  it('shares a verified feature between two real clones and refuses changed content or keys', () => {
    const { a, b, gitA, gitB, hash, key } = clones();
    expect(key.treeHash).toMatch(/^[a-f0-9]{64}$/);
    const treeB = hash(b, gitB);
    expect(treeB).toBe(hash(a, gitA));
    expect(repoScopeOf(gitB)).toBe(key.scope);
    const written = writeSharedRecord({ ...key, record: { suites: 'test', status: 'red', version: 7, sha: 'wrong' } });
    expect(written.ok).toBe(true);
    expect(readdirSync(key.dir)).toEqual([written.path.split('/').at(-1)]);
    const found = readSharedRecord({ ...key, sha: gitB(['rev-parse', 'HEAD']), treeHash: treeB, scope: repoScopeOf(gitB) });
    expect(found.record).toMatchObject({ sha: key.sha, treeHash: key.treeHash, gate: key.gate, scope: key.scope, status: 'green', version: 1 });
    expect(sharedFinishGuardFallback({ localVerdict: verifyGateDecision({ record: null, headSha: key.sha }), headSha: key.sha,
      readShared: () => found, decide: (record) => verifyGateDecision({ record, headSha: key.sha }) })).toMatchObject({ ok: true, status: 'green', source: 'shared-store' });
    for (const mismatch of [{ gate: 'explicit' }, { scope: 'other/repo' }, { sha: 'c'.repeat(40) }]) expect(readSharedRecord({ ...key, ...mismatch })).toBeNull();
    writeFileSync(join(b, 'tracked.txt'), 'dirty\n');
    expect(hash(b, gitB)).not.toBe(treeB);
    expect(readSharedRecord({ ...key, treeHash: hash(b, gitB) })).toBeNull();
  });
  it('rejects invalid keys and directories', () => {
    const key = syntheticKey();
    for (const invalid of [{ sha: 'A'.repeat(40) }, { sha: 'a'.repeat(39) }, { treeHash: 'b'.repeat(63) }, { mergeBase: null }, { headTree: 'x'.repeat(40) }, { gate: 'explicit' }, { scope: '' }, { dir: 'relative' }]) {
      expect(sharedRecordPath({ ...key, ...invalid })).toBeNull();
      expect(writeSharedRecord({ ...key, ...invalid })).toMatchObject({ ok: false });
      expect(readSharedRecord({ ...key, ...invalid })).toBeNull();
    }
  });
  it('fails closed on missing, corrupt, non-object, or mismatched payloads', () => {
    const key = syntheticKey();
    expect(readSharedRecord(key)).toBeNull();
    const { path } = writeSharedRecord({ ...key, record: {} });
    const valid = JSON.parse(readFileSync(path, 'utf8'));
    const payloads = ['broken', '[]', 'null', '"green"', ...[
      { status: 'red' }, { skipped: 'card-only' }, { corrupt: true }, { version: 2 },
      { sha: 'c'.repeat(40) }, { treeHash: 'd'.repeat(64) }, { gate: 'explicit' }, { scope: 'different' }, { mergeBase: 'e'.repeat(40) }, { headTree: 'f'.repeat(40) }, { suites: { toString: null } },
    ].map((change) => JSON.stringify({ ...valid, ...change }))];
    for (const payload of payloads) { writeFileSync(path, payload); expect(readSharedRecord(key)).toBeNull(); }
  });
  it.skipIf(process.getuid?.() === 0)('fails closed on an unreadable store', () => {
    const key = syntheticKey(); writeSharedRecord({ ...key, record: {} });
    chmodSync(key.dir, 0);
    try { expect(readSharedRecord(key)).toBeNull(); } finally { chmodSync(key.dir, 0o700); }
  });
  it('handles a regular file as store and cleans temporary files after failed writes', () => {
    const key = syntheticKey(); writeFileSync(key.dir, 'file');
    expect(writeSharedRecord({ ...key, record: {} }).ok).toBe(false);
    expect(readSharedRecord(key)).toBeNull();
    rmSync(key.dir); mkdirSync(key.dir);
    // A target directory forces rename failure after the temp file was written and synced.
    mkdirSync(sharedRecordPath(key));
    expect(writeSharedRecord({ ...key, record: {} }).ok).toBe(false);
    expect(readdirSync(key.dir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
});

describe('finish guard fallback', () => {
  it('accepts shared green only for absent local verification in the actual finish guard', () => {
    const { b, gitB, key } = clones();
    writeSharedRecord({ ...key, record: { suites: 'test' } });
    const readShared = vi.fn(() => readSharedRecord(key));
    const args = { gitDir: join(b, '.git'), headSha: key.sha, remote: 'origin', base: 'main', runGit: gitB, readMarker: readVerifyMarker };
    expect(resolveFinishGuardVerdict({ ...args, readSharedRecord: readShared })).toMatchObject({ ok: true, status: 'green', source: 'shared-store', sharedRecordPath: sharedRecordPath(key) });
    expect(readShared).toHaveBeenCalledWith({ headSha: key.sha });
    expect(resolveFinishGuardVerdict(args)).toEqual(verifyGateDecision({ record: null, headSha: key.sha }));
    for (const readSharedRecord of [() => null, () => { throw Error('unreadable'); }, () => ({ record: { sha: key.sha, status: 'red' } })]) {
      expect(resolveFinishGuardVerdict({ ...args, readSharedRecord })).toMatchObject({ ok: false, reason: 'unverified' });
    }
    for (const record of [{ corrupt: true }, ...['running', 'red', 'infrastructure-failure', 'green'].map((status) => ({ sha: key.sha, status }))]) {
      writeFileSync(join(b, '.git', '.lane-verify'), JSON.stringify(record));
      readShared.mockClear();
      expect(resolveFinishGuardVerdict({ ...args, readSharedRecord: readShared })).toEqual(resolveFinishGuardVerdict(args));
      expect(readShared).not.toHaveBeenCalled();
    }
    rmSync(join(b, '.git', '.lane-verify'));
    for (const bypass of [{ breakGlass: true }, { requireVerified: false }]) {
      readShared.mockClear();
      expect(resolveFinishGuardVerdict({ ...args, ...bypass, readSharedRecord: readShared })).toEqual(resolveFinishGuardVerdict({ ...args, ...bypass }));
      expect(readShared).not.toHaveBeenCalled();
    }
  });
  it('returns the same local verdict object for blocked or already accepted verdicts', () => {
    for (const localVerdict of [{ ok: true, status: 'absent' }, ...['corrupt', 'running', 'red', 'infrastructure-failure'].map((status) => ({ ok: false, status }))]) {
      const readShared = vi.fn();
      expect(sharedFinishGuardFallback({ localVerdict, readShared })).toBe(localVerdict);
      expect(readShared).not.toHaveBeenCalled();
    }
  });
});

describe('security regressions', () => {
  it('samples checkout identity and returns null fields when any git probe fails', () => {
    const { a, gitA, key } = clones();
    const fileMode = (f) => lstatSync(join(a, f)).mode;
    expect(sharedRecords.checkoutIdentity(gitA, { fileMode })).toEqual({ treeHash: key.treeHash,
      mergeBase: key.mergeBase, headTree: key.headTree, clean: true });
    for (const command of ['status', 'merge-base', 'rev-parse', 'diff', 'ls-files']) {
      const runGit = (args) => { if (args[0] === command) throw Error('unavailable'); return gitA(args); };
      expect(sharedRecords.checkoutIdentity(runGit, { fileMode })).toEqual({ treeHash: null, mergeBase: null, headTree: null, clean: null });
    }
  });
  it('rejects bare and relative scopes that alias real remotes; canonicalizes local symlinks', () => {
    for (const value of ['github.com/owner/repo', 'github:owner/repo', '../Origin', './repo', 'repo.git']) expect(normalizeRepoScope(value)).toBeNull();
    expect(normalizeRepoScope('https://example.com/owner/repo.git/')).toBe('url:https://example.com/owner/repo.git');
    expect(normalizeRepoScope('https://example.com/owner/repo')).not.toBe(normalizeRepoScope('https://example.com/owner/repo.git'));
    expect(normalizeRepoScope('git@example.com:owner/repo.git')).toBe('url:git@example.com:owner/repo.git');
    const root = temp(); const alias = join(root, 'alias'); const target = join(root, 'repo');
    mkdirSync(target); symlinkSync(target, alias);
    // realpath: the tmp dir itself may sit behind a symlink (macOS /var -> /private/var).
    expect(normalizeRepoScope(alias)).toBe(`file:${realpathSync(target)}`);
    expect(normalizeRepoScope(target)).toBe(`file:${realpathSync(target)}`);
    const { root: repoRoot, a, gitA, key } = clones();
    gitA(['remote', 'set-url', 'origin', 'github.com/owner/repo']);
    expect(recordSharedGreen({ env: { WE_VERIFY_SHARED_RECORD_DIR: join(repoRoot, 'store') }, repo: a, runGit: gitA,
      ...key, status: 'green', defaultGate: true, cleanTree: true, log: () => {} })).toMatchObject({ ok: false, skipped: expect.any(String) });
  });
  it('refuses the empty-patch collision with an older base and reverted tracked files', () => {
    const { a, b, gitA, gitB, hash, key } = clones();
    const olderBase = key.mergeBase;
    gitA(['update-ref', 'refs/remotes/origin/main', key.sha]);
    const writerKey = { ...key, treeHash: hash(a, gitA), mergeBase: key.sha };
    expect(recordSharedGreen({ env: { WE_VERIFY_SHARED_RECORD_DIR: key.dir }, repo: a, runGit: gitA, ...writerKey,
      status: 'green', defaultGate: true, cleanTree: true, suites: 'test', log: () => {} }).ok).toBe(true);
    expect(readSharedRecord({ ...writerKey, runGit: gitA })).not.toBeNull();
    // Same HEAD and empty diff, but against B instead of H; this matched before the fix.
    gitB(['restore', '--source', olderBase, '--worktree', '--', 'tracked.txt']);
    expect(hash(b, gitB)).toBe(writerKey.treeHash);
    expect(gitB(['rev-parse', 'HEAD'])).toBe(key.sha);
    expect(readSharedRecord({ ...writerKey, runGit: gitB })).toBeNull();
    expect(readSharedRecord({ ...writerKey, mergeBase: olderBase })).toBeNull();
    expect(readSharedRecord({ ...writerKey, headTree: 'f'.repeat(40) })).toBeNull();
  });
  it('requires actual clean status in the writer and reader, including untracked files', () => {
    const { a, gitA, key } = clones();
    const args = { ...key, env: { WE_VERIFY_SHARED_RECORD_DIR: key.dir }, repo: a, runGit: gitA,
      status: 'green', defaultGate: true, cleanTree: true, log: vi.fn() };
    for (const file of ['tracked.txt', 'untracked.txt']) {
      writeFileSync(join(a, file), 'dirty\n');
      expect(recordSharedGreen(args)).toMatchObject({ ok: false, skipped: expect.any(String) });
      expect(args.log.mock.calls.at(-1)[0]).toContain('skipped');
      writeSharedRecord({ ...key, record: {} });
      expect(readSharedRecord({ ...key, runGit: gitA })).toBeNull();
      if (file === 'tracked.txt') gitA(['restore', '--', file]);
      else rmSync(join(a, file));
    }
  });
  it('rejects malformed suites at the shared record read boundary', () => {
    const key = syntheticKey();
    const { path } = writeSharedRecord({ ...key, record: { suites: { toString: null } } });
    expect(JSON.parse(readFileSync(path, 'utf8')).suites).toEqual({ toString: null });
    expect(readSharedRecord(key)).toBeNull();
  });
  it('contains malformed suites exceptions from the real finish verdict', () => {
    const localVerdict = { ok: false, status: 'absent' };
    const record = { sha: 'a'.repeat(40), status: 'green', suites: { toString: null } };
    expect(sharedFinishGuardFallback({ localVerdict, readShared: () => ({ record }),
      decide: (record) => verifyGateDecision({ record, headSha: record.sha }) })).toBe(localVerdict);
  });
  it('contains verdict and detail exceptions, including malformed suites', () => {
    const localVerdict = { ok: false, status: 'absent' };
    const record = { sha: 'a'.repeat(40), status: 'green', suites: { toString: null } };
    const readShared = () => ({ record });
    for (const decide of [() => { throw Error('bad verdict'); },
      (record) => verifyGateDecision({ record, headSha: record.sha }),
      () => ({ ok: true, status: 'green', detail: { toString: null } })]) {
      expect(sharedFinishGuardFallback({ localVerdict, readShared, decide })).toBe(localVerdict);
    }
  });
});

describe('verify-lane shared-green hook', () => {
  it('delegates precisely to the existing green eligibility predicate', () => {
    expect(shouldWriteSharedRecord).toBe(shouldRecordGreen);
  });
  it('skips ordinary fixtures and ineligible greens; writes with an explicit override', () => {
    const { root, a, gitA, key } = clones();
    const log = vi.fn();
    const args = { env: { WE_COORDINATION_ROOT: join(root, 'coord') }, repo: a, runGit: gitA, sha: key.sha, treeHash: key.treeHash,
      status: 'green', defaultGate: true, admissionFallback: null, cleanTree: true, skipped: null, suites: 'test', log };
    expect(recordSharedGreen(args)).toMatchObject({ ok: false, skipped: expect.any(String) });
    expect(readdirSync(root)).not.toContain('coord');
    const env = { ...args.env, WE_VERIFY_SHARED_RECORD_DIR: key.dir };
    for (const change of [{ status: 'red' }, { admissionFallback: 'fallback' }, { cleanTree: false }, { skipped: 'card-only' }, { defaultGate: false }, { treeHash: null }]) {
      expect(recordSharedGreen({ ...args, env, ...change })).toMatchObject({ ok: false, skipped: expect.any(String) });
      expect(readSharedRecord(key)).toBeNull();
    }
    expect(recordSharedGreen({ ...args, env })).toMatchObject({ ok: true, path: sharedRecordPath(key) });
    expect(log.mock.calls.at(-1)[0]).toContain('(store source: env)');
    expect(recordSharedGreen({ ...args, env, runGit: () => { throw Error('no remote'); } })).toMatchObject({ skipped: 'repository scope unavailable' });
    const badDir = join(root, 'file-store'); writeFileSync(badDir, 'file');
    expect(recordSharedGreen({ ...args, env: { WE_VERIFY_SHARED_RECORD_DIR: badDir } })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(log.mock.calls.at(-1)[0]).toContain('FAILED');
    expect(() => recordSharedGreen({ ...args, env, log: () => { throw Error('log failure'); } })).not.toThrow();
  });
});
