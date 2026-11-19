import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { netDiffFingerprint, carriesAcross } from '../net-diff-fingerprint.mjs';

let dir; const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (file, text, msg) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
const S = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ndfp-'));
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  mkdirSync(join(dir, 'scripts/ci'), { recursive: true }); writeFileSync(join(dir, 'scripts/ci/test-timings.json'), '{"t":0}\n'); git('add', 'scripts/ci/test-timings.json');
  commit('a.mjs', 'one\ntwo\nthree\n', 'base');
  S.base = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  S.A = commit('a.mjs', 'one\ntwo\nthree\nfour\n', 'pr change');
  // rebase-only: main moves on an unrelated file, the PR commit is replayed on top
  git('checkout', '-q', 'main'); S.main2 = commit('other.txt', 'x\n', 'main moves');
  git('checkout', '-q', '-b', 'rebased', 'pr'); git('rebase', '-q', 'main'); S.rebased = git('rev-parse', 'HEAD');
  // merge-of-main: merge main into the PR branch
  git('checkout', '-q', 'pr'); git('merge', '-q', '--no-edit', 'main'); S.merged = git('rev-parse', 'HEAD');
  // code change: one character differs
  git('checkout', '-q', '-b', 'changed', 'rebased'); S.changed = commit('a.mjs', 'one\ntwo\nthree\nfouR\n', 'tweak');
  // mechanical path only: the root lane manifest is excluded
  git('checkout', '-q', '-b', 'fe', 'rebased'); S.fe = commit('b.txt', Buffer.from([0x61, 0xfe, 0x0a]), 'fe');
  git('checkout', '-q', '-b', 'ff', 'rebased'); S.ff = commit('b.txt', Buffer.from([0x61, 0xff, 0x0a]), 'ff');
  git('checkout', '-q', '-b', 'timings', 'rebased'); S.timings = commit('scripts/ci/test-timings.json', '{"t":1}\n', 'timings');
  git('checkout', '-q', '-b', 'manifest', 'rebased'); S.manifest = commit('.lane-manifest.json', '{"a":1}\n', 'manifest');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('netDiffFingerprint / carriesAcross', () => {
  it('rebase-only carries', () => {
    const a = netDiffFingerprint(dir, 'main', S.A), b = netDiffFingerprint(dir, 'main', S.rebased);
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(carriesAcross(a, b)).toBe(true);
  });
  it('merge-of-main carries', () => {
    expect(carriesAcross(netDiffFingerprint(dir, S.base, S.A), netDiffFingerprint(dir, 'main', S.merged))).toBe(true);
  });
  it('a one-character code change does not carry', () => {
    expect(carriesAcross(netDiffFingerprint(dir, 'main', S.rebased), netDiffFingerprint(dir, 'main', S.changed))).toBe(false);
  });
  it('excludes only the root lane manifest', () => {
    expect(carriesAcross(netDiffFingerprint(dir, 'main', S.rebased), netDiffFingerprint(dir, 'main', S.manifest))).toBe(true);
  });
  it('a change to the CI timing file alone carries (R503 part 4)', () => {
    expect(carriesAcross(netDiffFingerprint(dir, 'main', S.rebased), netDiffFingerprint(dir, 'main', S.timings))).toBe(true);
  });
  it('distinct invalid UTF-8 bytes do not collapse into one fingerprint', () => {
    const fe = netDiffFingerprint(dir, 'main', S.fe), ff = netDiffFingerprint(dir, 'main', S.ff);
    expect(fe).toMatch(/^[0-9a-f]{64}$/); expect(carriesAcross(fe, ff)).toBe(false);
  });
  it('isolates every Git call from replacement objects and grafts and preserves all diff protections', () => {
    const calls = []; let graft;
    const exec = (c, a, o) => {
      calls.push(a);
      expect(a.slice(0, 3)).toEqual(['-C', dir, '--no-replace-objects']);
      expect(o.env.GIT_NO_REPLACE_OBJECTS).toBe('1');
      graft = o.env.GIT_GRAFT_FILE;
      expect(existsSync(dirname(graft))).toBe(true);
      expect(existsSync(graft)).toBe(false);
      return execFileSync(c, a, o);
    };
    expect(netDiffFingerprint(dir, 'main', S.A, { exec })).toMatch(/^[0-9a-f]{64}$/);
    expect(calls.map(a => a[3])).toEqual(['rev-parse', 'rev-parse', 'merge-base', 'diff']);
    const diff = calls.find((a) => a.includes('diff'));
    expect(diff).toEqual(expect.arrayContaining(['--no-relative', '--text', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--end-of-options']));
    expect(existsSync(dirname(graft))).toBe(false);
  });
  it('diff.relative=true from a subdirectory cannot omit changes outside that directory', () => {
    const expected = netDiffFingerprint(dir, S.base, S.A);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    git('config', 'diff.relative', 'true');
    try {
      expect(netDiffFingerprint(join(dir, 'scripts'), S.base, S.A)).toBe(expected);
    } finally { git('config', '--unset', 'diff.relative'); }
  });
  it('binary attributes and an external diff driver cannot hide changed text', () => {
    const expected = netDiffFingerprint(dir, S.base, S.A);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(join(dir, '.git/info/attributes'), '*.mjs binary\n');
    try {
      expect(netDiffFingerprint(dir, S.base, S.A)).toBe(expected);
      writeFileSync(join(dir, '.git/info/attributes'), '*.mjs diff=hidden\n');
      git('config', 'diff.hidden.command', 'false');
      expect(netDiffFingerprint(dir, S.base, S.A)).toBe(expected);
    } finally {
      rmSync(join(dir, '.git/info/attributes'), { force: true });
      git('config', '--unset', 'diff.hidden.command');
    }
  });
  it('replace refs and repository or inherited grafts cannot change the fingerprint', () => {
    const expected = netDiffFingerprint(dir, S.base, S.A);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    git('replace', S.A, S.base);
    try { expect(netDiffFingerprint(dir, S.base, S.A)).toBe(expected); }
    finally { git('replace', '-d', S.A); }
    const graft = join(dir, '.git/info/grafts');
    const inherited = process.env.GIT_GRAFT_FILE;
    writeFileSync(graft, `${S.A}\n`);
    try {
      expect(netDiffFingerprint(dir, S.base, S.A)).toBe(expected);
      process.env.GIT_GRAFT_FILE = graft;
      expect(netDiffFingerprint(dir, S.base, S.A)).toBe(expected);
    } finally {
      if (inherited === undefined) delete process.env.GIT_GRAFT_FILE;
      else process.env.GIT_GRAFT_FILE = inherited;
      rmSync(graft, { force: true });
    }
  });
  it('Git failure returns no carry evidence and removes the graft scratch directory', () => {
    let scratch;
    const fingerprint = netDiffFingerprint(dir, S.base, S.A, { exec: (_c, _a, options) => {
      scratch = dirname(options.env.GIT_GRAFT_FILE);
      throw new Error('unreadable git');
    } });
    expect(fingerprint).toBeNull();
    expect(existsSync(scratch)).toBe(false);
    expect(carriesAcross(fingerprint, 'a'.repeat(64))).toBe(false);
  });
  it('unreadable fingerprints never carry', () => {
    const ok = netDiffFingerprint(dir, 'main', S.A);
    expect(netDiffFingerprint(dir, 'main', 'f'.repeat(40))).toBeNull();
    expect(netDiffFingerprint(join(dir, 'nope'), 'main', S.A)).toBeNull();
    expect(netDiffFingerprint(dir, 'main', '--output=x')).toBeNull();
    expect(carriesAcross(null, ok)).toBe(false); expect(carriesAcross(ok, null)).toBe(false); expect(carriesAcross(null, null)).toBe(false);
    expect(carriesAcross('', '')).toBe(false); expect(carriesAcross('abc', 'abc')).toBe(false);
  });
  it('an empty net diff has no fingerprint (no carry)', () => {
    expect(netDiffFingerprint(dir, 'main', 'main')).toBeNull();
  });
});
