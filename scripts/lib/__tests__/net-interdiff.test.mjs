// R883 slice 2 — the PR's OWN change between two reviewed heads, ignoring commits that came in from main.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'node:fs';
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
    expect(netInterdiff({ exec: () => { throw new Error('boom'); }, priorHead: 'abc', head: 'def', base: 'main', rawFiles: raw })).toBeNull();
    expect(netInterdiff({})).toBeNull();
  });

  // Table-driven: every case is an otherwise VALID input with exactly one bad field, so exactly one guard trips.
  // The spy proves the guard fired before any git call (an option-injecting base never reaches git).
  describe('fails closed, one guard at a time', () => {
    const valid = () => {
      const sha = git('rev-parse', 'HEAD');
      return { priorHead: sha, head: sha, base: 'main', rawFiles: { 'a.txt': null } };
    };
    const bad = [
      ['empty base', { base: '' }],
      ['non-string base', { base: 5 }],
      ['dash-prefixed base', { base: '--all' }],
      ['option-injecting base', { base: '--output=x' }],
      ['base with a space (REF regex)', { base: 'a b' }],
      ['base with a shell metachar (REF regex)', { base: 'a;b' }],
      ['null rawFiles', { rawFiles: null }],
      ['array rawFiles', { rawFiles: ['a.txt'] }],
      ['string rawFiles', { rawFiles: 'a.txt' }],
      ['dash-prefixed path', { rawFiles: { '-x': null } }],
      ['empty path', { rawFiles: { '': null } }],
      ['non-hex priorHead', { priorHead: 'zzzz' }],
      ['non-hex head', { head: 'not-a-sha' }],
      ['too-short head', { head: 'abc' }],
    ];
    it('a fully valid input is accepted (the table varies one field of it)', () => {
      expect(netInterdiff({ exec, ...valid() })).not.toBeNull();
    });
    it.each(bad)('%s → null, git never called', (_name, patch) => {
      const calls = [];
      const spy = (...a) => { calls.push(a); return exec(...a); };
      expect(netInterdiff({ exec: spy, ...valid(), ...patch })).toBeNull();
      expect(calls).toEqual([]);
    });
    it('non-function exec → null', () => {
      expect(netInterdiff({ exec: 'git', ...valid() })).toBeNull();
    });
    it('unreadable merge-base → null', () => {
      expect(netInterdiff({ exec: () => 'not a sha', ...valid() })).toBeNull();
    });
    it('a git failure such as an over-sized diff (ENOBUFS) → null, so the caller keeps the raw range', () => {
      const exec2 = (cmd, args) => {
        if (args.includes('merge-base')) return `${valid().head}\n`;
        throw Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
      };
      expect(netInterdiff({ exec: exec2, ...valid() })).toBeNull();
    });
  });
});

describe('netInterdiff keeps every real PR change and drops only an identical one', () => {
  const lines40 = () => lines(40);
  const setLine = (text, n, v) => text.split('\n').map((l, i) => (i === n - 1 ? v : l)).join('\n');
  const start = (name) => { git('checkout', '-q', 'main'); git('checkout', '-q', '-b', name, 'main'); };
  const net = (prior, head, raw = rawOf(prior, head)) => netInterdiff({ exec, priorHead: prior, head, base: 'main', rawFiles: raw });

  beforeAll(() => {
    git('checkout', '-q', 'main');
    write('m.txt', lines40());
    write('h.txt', `${lines(5)}--old\n---\n${lines(5)}`);
    write('s2.txt', lines40());
    write('p.txt', lines(20));
    write('q/a.txt', lines(10)); write('q/b.txt', lines(10));
    write('e.txt', lines(5));
    commit('main fixtures for the edge-case matrix');
  });

  it('keeps a binary file the PR replaced between the heads', () => {
    start('bin');
    write('img.bin', Buffer.from([0, 1, 2, 3, 0, 5]));
    const prior = commit('pr1 adds binary');
    write('img.bin', Buffer.from([0, 9, 9, 9, 0, 5]));
    const head = commit('pr2 replaces binary');
    expect(Object.keys(net(prior, head).files)).toEqual(['img.bin']);
  });

  it('keeps a mode-only change (chmod +x)', () => {
    start('mode');
    write('s.sh', 'echo hi\n');
    const prior = commit('pr1 adds script');
    chmodSync(join(dir, 's.sh'), 0o755);
    const head = commit('pr2 makes it executable');
    expect(Object.keys(net(prior, head).files)).toEqual(['s.sh']);
  });

  it('keeps an empty file added between the heads', () => {
    start('empty');
    write('e1.txt', lines(3));
    const prior = commit('pr1');
    write('empty.txt', '');
    const head = commit('pr2 adds an empty file');
    expect(Object.keys(net(prior, head).files)).toEqual(['empty.txt']);
  });

  it('keeps a block that was moved (same added line, different place)', () => {
    start('moved');
    write('m.txt', setLine(lines40(), 3, 'line 3\nMOVED'));
    const prior = commit('pr1 inserts after line 3');
    write('m.txt', setLine(lines40(), 20, 'line 20\nMOVED'));
    const head = commit('pr2 inserts after line 20');
    expect(Object.keys(net(prior, head).files)).toEqual(['m.txt']);
  });

  it('keeps an edit whose content looks like a diff header ("--old" → "++new")', () => {
    start('hdr');
    write('c1.txt', lines(3));
    const prior = commit('pr1 touches nothing in h.txt');
    write('h.txt', `${lines(5)}++new\n---\n${lines(5)}`);
    const head = commit('pr2 rewrites the header-like line');
    expect(Object.keys(net(prior, head, { 'h.txt': null }).files)).toEqual(['h.txt']);
  });

  it('keeps a deleted "---" line', () => {
    start('rule');
    write('c3.txt', lines(3));
    const prior = commit('pr1 touches nothing in h.txt');
    write('h.txt', `${lines(5)}--old\n${lines(5)}`);
    const head = commit('pr2 deletes the "---" rule');
    expect(Object.keys(net(prior, head, { 'h.txt': null }).files)).toEqual(['h.txt']);
  });

  it('drops a PR patch that only SHIFTED because main inserted lines above it', () => {
    start('shift');
    write('s2.txt', setLine(lines40(), 30, 'PR edit'));
    const prior = commit('pr1 edits line 30');
    git('checkout', '-q', 'main');
    write('s2.txt', `MAIN top 1\nMAIN top 2\nMAIN top 3\n${lines40()}`);
    commit('main inserts above');
    git('checkout', '-q', 'shift');
    git('merge', '-q', '--no-edit', 'main');
    write('c2.txt', 'pr2\n');
    const head = commit('pr2 elsewhere');
    const raw = rawOf(prior, head);
    expect(Object.keys(raw)).toContain('s2.txt');
    const out = net(prior, head, raw);
    expect(out.dropped).toContain('s2.txt');
    expect(Object.keys(out.files)).toEqual(['c2.txt']);
    // restore main for the next tests (main moved in this one)
    git('checkout', '-q', 'main');
  });

  it('preserves the raw line arrays of kept files (same reference)', () => {
    start('arrays');
    write('p.txt', setLine(lines(20), 4, 'PR'));
    const prior = commit('pr1');
    write('p.txt', setLine(lines(20), 9, 'PR2'));
    const head = commit('pr2');
    const arr = [9, 10];
    const out = net(prior, head, { 'p.txt': arr });
    expect(out.files['p.txt']).toBe(arr);
    expect(out.files['p.txt']).toEqual([9, 10]);
  });

  it('treats a data-derived path literally, never as a glob pathspec', () => {
    start('glob');
    write('q/a.txt', setLine(lines(10), 2, 'A'));
    const prior = commit('pr1 edits q/a.txt');
    write('q/b.txt', setLine(lines(10), 2, 'B'));
    const head = commit('pr2 edits q/b.txt');
    // "q/*.txt" is not a file; as a glob it would match both q files and wrongly look changed.
    const out = net(prior, head, { 'q/*.txt': null });
    expect(out).toEqual({ files: {}, dropped: ['q/*.txt'] });
  });
});
