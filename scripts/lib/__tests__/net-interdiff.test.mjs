// R883 slice 2 — the PR's OWN change between two reviewed heads, ignoring commits that came in from main.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { netInterdiff, interdiffShadowLine } from '../net-interdiff.mjs';

let dir;
const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (p, text) => { mkdirSync(join(dir, p, '..'), { recursive: true }); writeFileSync(join(dir, p), text); };
const commit = (msg) => { git('add', '-A'); git('commit', '-q', '-m', msg); return git('rev-parse', 'HEAD'); };
const exec = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const rawOf = (a, b) => Object.fromEntries(git('diff', '--name-only', a, b).split('\n').filter(Boolean).map(p => [p, null]));
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'interdiff-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com'); git('config', 'user.name', 't');
  write('a.txt', lines(20)); write('b.txt', lines(20)); write('c.txt', lines(20));
  commit('base');
});
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('netInterdiff', () => {
  it('no merges: gives the same files as the raw diff', () => {
    git('checkout', '-q', '-b', 'plain', 'main');
    write('a.txt', lines(20).replace('line 3', 'PR one'));
    const prior = commit('pr1');
    write('b.txt', lines(20).replace('line 5', 'PR two'));
    const head = commit('pr2');
    const raw = rawOf(prior, head);
    const out = netInterdiff({ exec, priorHead: prior, head, base: 'main', rawFiles: raw });
    expect(out.files).toEqual(raw);
    expect(Object.keys(out.files)).toEqual(['b.txt']);
  });

  it('main merge: drops files that only main changed, keeps the PR change', () => {
    git('checkout', '-q', '-b', 'merged', 'main');
    write('a.txt', lines(20).replace('line 3', 'PR one'));
    const prior = commit('pr1');
    git('checkout', '-q', 'main');
    write('c.txt', lines(20).replace('line 9', 'MAIN change'));
    write('d.txt', 'main only\n');
    commit('main moves');
    git('checkout', '-q', 'merged');
    git('merge', '-q', '--no-edit', 'main');
    write('b.txt', lines(20).replace('line 5', 'PR two'));
    const head = commit('pr2');
    const raw = rawOf(prior, head);
    expect(Object.keys(raw).sort()).toEqual(['b.txt', 'c.txt', 'd.txt']);
    const out = netInterdiff({ exec, priorHead: prior, head, base: 'main', rawFiles: raw });
    expect(Object.keys(out.files)).toEqual(['b.txt']);
    expect(out.dropped.sort()).toEqual(['c.txt', 'd.txt']);
    expect(interdiffShadowLine({ pr: 7, raw, net: out })).toMatch(/raw=3 interdiff=1/);
  });

  it('rebase onto a newer main: only the PR own change remains', () => {
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'rebased', 'main');
    write('a.txt', lines(20).replace('line 2', 'PR one'));
    const prior = commit('pr1');
    git('checkout', '-q', 'main');
    write('c.txt', lines(20).replace('line 11', 'MAIN again'));
    commit('main moves 2');
    git('checkout', '-q', 'rebased');
    git('rebase', '-q', 'main');
    write('b.txt', lines(20).replace('line 6', 'PR three'));
    const head = commit('pr2');
    const raw = rawOf(prior, head);
    expect(Object.keys(raw)).toContain('c.txt');
    const out = netInterdiff({ exec, priorHead: prior, head, base: 'main', rawFiles: raw });
    expect(Object.keys(out.files)).toEqual(['b.txt']);
  });

  it('keeps a file the PR changed again even when main also touched it', () => {
    git('checkout', '-q', 'main');
    git('checkout', '-q', '-b', 'both', 'main');
    write('a.txt', lines(20).replace('line 1\n', 'PR first\n'));
    const prior = commit('pr1');
    git('checkout', '-q', 'main');
    write('a.txt', lines(20).replace('line 19', 'MAIN tail'));
    commit('main edits a');
    git('checkout', '-q', 'both');
    git('merge', '-q', '--no-edit', 'main');
    write('a.txt', lines(20).replace('line 1\n', 'PR second\n').replace('line 19', 'MAIN tail'));
    const head = commit('pr2');
    const out = netInterdiff({ exec, priorHead: prior, head, base: 'main', rawFiles: rawOf(prior, head) });
    expect(Object.keys(out.files)).toEqual(['a.txt']);
  });

  it('fails closed to null on unreadable input', () => {
    const raw = { 'a.txt': null };
    expect(netInterdiff({ exec, priorHead: 'deadbeef', head: 'cafebabe', base: 'main', rawFiles: raw })).toBeNull();
    expect(netInterdiff({ exec, priorHead: 'x', head: 'y', base: '', rawFiles: raw })).toBeNull();
    expect(netInterdiff({ exec, priorHead: 'x', head: 'y', base: 'main', rawFiles: null })).toBeNull();
    expect(netInterdiff({ exec: () => { throw new Error('boom'); }, priorHead: 'abc', head: 'def', base: 'main', rawFiles: raw })).toBeNull();
    expect(netInterdiff({})).toBeNull();
  });
});
