import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { netDiffFingerprint, carriesAcross } from '../net-diff-fingerprint.mjs';

let dir; const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (file, text, msg) => { writeFileSync(join(dir, file), text); git('add', file); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
const S = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ndfp-'));
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
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
  git('checkout', '-q', '-b', 'timings', 'rebased'); mkdirSync(join(dir, 'scripts/ci'), { recursive: true }); S.timings = commit('scripts/ci/test-timings.json', '{"t":1}\n', 'timings');
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
  it('asks git for a diff no text converter or submodule setting can hide', () => {
    const calls = []; const exec = (c, a, o) => { calls.push(a); return execFileSync(c, a, o); };
    netDiffFingerprint(dir, 'main', S.A, { exec });
    const diff = calls.find((a) => a.includes('diff'));
    expect(diff).toEqual(expect.arrayContaining(['--no-ext-diff', '--no-textconv', '--ignore-submodules=none']));
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
