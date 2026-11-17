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
// The encoding the module asks for is honoured (default utf8), so a test can tell a lossy decode from a byte-exact one.
const exec = (cmd, args, opts) => execFileSync(cmd, args, { encoding: 'utf8', ...opts, cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
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
    it('more paths than the cap → null, git never called (the caller keeps the raw range)', () => {
      const rawFiles = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`f${i}.txt`, null]));
      const calls = [];
      expect(netInterdiff({ exec: (...a) => { calls.push(a); return ''; }, ...valid(), rawFiles })).toBeNull();
      expect(calls).toEqual([]);
    });
    it('a path git does not see at either head → null (an empty diff must not read as "unchanged")', () => {
      expect(netInterdiff({ exec, ...valid(), rawFiles: { 'no/such/file.txt': null } })).toBeNull();
    });
    it.each([['undefined', undefined], ['null', null], ['a Buffer', Buffer.from('')]])(
      'an exec that returns %s for the diff → null, never an "unchanged" drop', (_n, value) => {
        const sha = valid().head;
        const exec3 = (cmd, args) => (args.includes('merge-base') ? `${sha}\n` : args.includes('ls-tree') ? 'a.txt\0' : value);
        expect(netInterdiff({ exec: exec3, ...valid() })).toBeNull();
      });
    it('a slow exec that uses up the total time budget → null, and no further git call is started', () => {
      let t = 0;
      const calls = [];
      const slow = (...a) => { calls.push(a); t += 40_000; return exec(...a); };
      const rawFiles = { 'a.txt': null, 'b.txt': null, 'c.txt': null };
      expect(netInterdiff({ exec: slow, ...valid(), rawFiles, budgetMs: 100_000, now: () => t })).toBeNull();
      // 2 merge-bases + 1 ls-tree use 120 s of a 100 s budget; the next call is refused before it reaches exec.
      expect(calls.length).toBe(3);
      // With enough budget the same input completes.
      t = 0;
      expect(netInterdiff({ exec: slow, ...valid(), rawFiles, budgetMs: 100_000_000, now: () => t })).not.toBeNull();
    });
    it('every git call is clamped to the time left in the budget', () => {
      const timeouts = [];
      const spy = (c, a, o) => { timeouts.push(o.timeout); return exec(c, a, o); };
      expect(netInterdiff({ exec: spy, ...valid(), budgetMs: 20_000 })).not.toBeNull();
      expect(timeouts.length).toBeGreaterThan(0);
      expect(Math.max(...timeouts)).toBeLessThanOrEqual(20_000);
    });
    it('the budget runs out AFTER a path was already judged "unchanged" → null, never a partial result', () => {
      let t = 0;
      const calls = [];
      // Scaled (10 s per call, 55 s budget) so the real git timeout derived from the budget stays generous on a loaded host.
      const tick = (...a) => { calls.push(a); t += 10_000; return exec(...a); };
      const rawFiles = { 'a.txt': null, 'b.txt': null };
      expect(netInterdiff({ exec: tick, ...valid(), rawFiles, budgetMs: 55_000, now: () => t })).toBeNull();
      // 2 merge-bases + all 3 calls for a.txt were made, so a.txt had been put in `dropped` before the budget ended.
      expect(calls.length).toBeGreaterThanOrEqual(5);
    });
    it('the budget is also checked after the last path (parsing between git calls counts)', () => {
      let t = 0;
      const lastCall = (...a) => { const r = exec(...a); if (a[1].includes('diff')) t += 100_000; return r; };
      // Only the diff calls are slow: 2 diffs × 100 s for the single path, budget 150 s → exhausted by the final check.
      expect(netInterdiff({ exec: lastCall, ...valid(), rawFiles: { 'a.txt': null }, budgetMs: 150_000, now: () => t })).toBeNull();
    });
    it('a fractional clock still gives whole-millisecond timeouts and completes', () => {
      const timeouts = [];
      const spy = (c, a, o) => { timeouts.push(o.timeout); return exec(c, a, o); };
      const out = netInterdiff({ exec: spy, ...valid(), budgetMs: 30_000.5, now: () => 12345.25 });
      expect(out).not.toBeNull();
      expect(timeouts.every(Number.isInteger)).toBe(true);
    });
    it('a clock that returns a non-number → null, git never called', () => {
      const calls = [];
      expect(netInterdiff({ exec: (...a) => { calls.push(a); return exec(...a); }, ...valid(), now: () => 'soon' })).toBeNull();
      expect(calls).toEqual([]);
    });
    it.each([['zero', 0], ['negative', -1], ['NaN', NaN], ['Infinity', Infinity], ['a string', '9']])('a %s budget → null, git never called', (_n, budgetMs) => {
      const calls = [];
      expect(netInterdiff({ exec: (...a) => { calls.push(a); return exec(...a); }, ...valid(), budgetMs })).toBeNull();
      expect(calls).toEqual([]);
    });
    it('non-function now → null', () => {
      expect(netInterdiff({ exec, ...valid(), now: 5 })).toBeNull();
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

describe('interdiffShadowLine', () => {
  it('reports a null interdiff as unavailable and a missing raw range as 0', () => {
    expect(interdiffShadowLine({ pr: 9, raw: { 'a.txt': null, 'b.txt': null }, net: null })).toBe('[net-interdiff] pr=9 raw=2 interdiff=unavailable');
    expect(interdiffShadowLine({ pr: 9, net: { files: {}, dropped: [] } })).toBe('[net-interdiff] pr=9 raw=0 interdiff=0');
    expect(interdiffShadowLine()).toBe('[net-interdiff] pr=? raw=0 interdiff=unavailable');
  });
});

describe('netInterdiff keeps every real PR change and drops only an identical one', () => {
  const lines40 = () => lines(40);
  const setLine = (text, n, v) => text.split('\n').map((l, i) => (i === n - 1 ? v : l)).join('\n');
  // Distinct first/last lines anchor the run so git merges main's edit above it without a conflict.
  const rep = () => `HEAD\n${'same\n'.repeat(40)}TAIL\n`;
  const insertAfter = (text, n, v) => { const a = text.split('\n'); a.splice(n, 0, v); return a.join('\n'); };
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
    // Repetitive files: 40 identical lines, so an insertion has the SAME 3-line context at every spot inside the run.
    write('rep.txt', rep()); write('rep2.txt', rep()); write('rep3.txt', rep()); write('rep4.txt', rep());
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

  it('keeps an insertion that MOVED between two spots with identical 3-line context (repetitive file)', () => {
    start('repmove');
    write('rep.txt', insertAfter(rep(), 10, 'PR'));
    const prior = commit('pr1 inserts inside the run at line 10');
    write('rep.txt', insertAfter(rep(), 25, 'PR'));
    const head = commit('pr2 inserts the same line at line 25');
    expect(Object.keys(net(prior, head).files)).toEqual(['rep.txt']);
  });

  it('drops a repetitive-file patch that only SHIFTED because main inserted lines above it', () => {
    start('repshift');
    write('rep2.txt', insertAfter(rep(), 10, 'PR'));
    const prior = commit('pr1');
    git('checkout', '-q', 'main');
    write('rep2.txt', `MAIN top 1\nMAIN top 2\n${rep()}`);
    commit('main inserts above the run');
    git('checkout', '-q', 'repshift');
    git('merge', '-q', '--no-edit', 'main');
    const head = git('rev-parse', 'HEAD');
    const raw = rawOf(prior, head);
    expect(Object.keys(raw)).toEqual(['rep2.txt']);
    expect(net(prior, head, raw)).toEqual({ files: {}, dropped: ['rep2.txt'] });
    // Fail closed: if the main-vs-main diff that explains the shift cannot be read, the file is not dropped, the result is null.
    const unreadable = (c, a, o) => { if (a.includes('--unified=0')) throw new Error('boom'); return exec(c, a, o); };
    const notString = (c, a, o) => (a.includes('--unified=0') ? Buffer.from('') : exec(c, a, o));
    expect(netInterdiff({ exec: unreadable, priorHead: prior, head, base: 'main', rawFiles: raw })).toBeNull();
    expect(netInterdiff({ exec: notString, priorHead: prior, head, base: 'main', rawFiles: raw })).toBeNull();
    git('checkout', '-q', 'main');
  });

  it('keeps a moved insertion in a repetitive file even when main also shifted the file', () => {
    start('repmoveshift');
    write('rep3.txt', insertAfter(rep(), 10, 'PR'));
    const prior = commit('pr1 inserts at line 10');
    git('checkout', '-q', 'main');
    write('rep3.txt', `MAIN top 1\nMAIN top 2\n${rep()}`);
    commit('main inserts above the run');
    git('checkout', '-q', 'repmoveshift');
    git('merge', '-q', '--no-edit', 'main');
    write('rep3.txt', insertAfter(`MAIN top 1\nMAIN top 2\n${rep()}`, 27, 'PR'));
    const head = commit('pr2 moves the insertion to line 27');
    expect(Object.keys(net(prior, head).files)).toEqual(['rep3.txt']);
    git('checkout', '-q', 'main');
  });

  it('keeps a moved insertion when main added one more identical line elsewhere in the same run (git may align main\'s edit at either end)', () => {
    start('runslide');
    write('rep4.txt', insertAfter(rep(), 30, 'PR'));
    const prior = commit('pr1 inserts after line 30');
    git('checkout', '-q', 'main');
    const mainText = insertAfter(rep(), 20, 'same');
    write('rep4.txt', mainText);
    commit('main adds one identical line inside the run');
    git('checkout', '-q', 'runslide');
    // `-s ours` records main as a parent (so the merge-base moves) while the tree stays under the test's control.
    git('merge', '-q', '-s', 'ours', '--no-edit', 'main');
    // With main's extra line above it, the SAME placement is "after line 31". Every other position is a real move.
    const moved = [];
    for (const q of [27, 28, 29, 30, 32, 33, 34, 35]) {
      write('rep4.txt', insertAfter(mainText, q, 'PR'));
      moved.push([q, commit(`pr2 inserts after line ${q}`)]);
    }
    for (const [q, head] of moved) {
      const out = net(prior, head, { 'rep4.txt': null });
      expect(Object.keys(out.files), `insertion after line ${q}`).toEqual(['rep4.txt']);
    }
    git('checkout', '-q', 'main');
  });

  it('keeps a changed file literally named "__proto__" as an own property of the result', () => {
    start('proto');
    write('__proto__', lines(5));
    const prior = commit('pr1 adds a file named __proto__');
    write('__proto__', setLine(lines(5), 2, 'PR2'));
    const head = commit('pr2 edits it');
    const arr = [2];
    const out = net(prior, head, Object.fromEntries([['__proto__', arr]]));
    expect(Object.keys(out.files)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(out.files, '__proto__')?.value).toBe(arr);
    expect(Object.getPrototypeOf(out.files)).toBe(Object.prototype);
  });

  it('keeps a text file whose edit only swaps one invalid-UTF-8 byte for another (no lossy decoding)', () => {
    start('legacy-bytes');
    // No NUL byte, so git emits a text patch; 0x80 and 0x81 both decode to U+FFFD if the patch is read as UTF-8.
    writeFileSync(join(dir, 'legacy.txt'), Buffer.from([0x62, 0x61, 0x73, 0x65, 0x0a]));
    commit('base legacy');
    writeFileSync(join(dir, 'legacy.txt'), Buffer.from([0x80, 0x0a]));
    const prior = commit('pr1 sets 0x80');
    writeFileSync(join(dir, 'legacy.txt'), Buffer.from([0x81, 0x0a]));
    const head = commit('pr2 sets 0x81');
    const out = net(prior, head, { 'legacy.txt': [1] });
    expect(Object.keys(out.files)).toEqual(['legacy.txt']);
    expect(out.dropped).toEqual([]);
  });

  it('keeps an invalid-byte edit inside surrounding text, and still drops one that is byte-identical at both heads', () => {
    start('legacy-mid');
    const body = (b) => Buffer.concat([Buffer.from('one\ntwo\nthree\n'), Buffer.from([b]), Buffer.from('\nfour\nfive\n')]);
    writeFileSync(join(dir, 'mid.txt'), Buffer.from('one\ntwo\nthree\nX\nfour\nfive\n'));
    writeFileSync(join(dir, 'same.txt'), Buffer.from('a\nb\n'));
    commit('base');
    writeFileSync(join(dir, 'mid.txt'), body(0xe9));
    writeFileSync(join(dir, 'same.txt'), Buffer.from([0x61, 0x0a, 0xff, 0x0a]));
    const prior = commit('pr1');
    writeFileSync(join(dir, 'mid.txt'), body(0xe8));
    const head = commit('pr2 changes only mid.txt');
    const out = net(prior, head, { 'mid.txt': null, 'same.txt': null });
    expect(Object.keys(out.files)).toEqual(['mid.txt']);
    expect(out.dropped).toEqual(['same.txt']);
  });

  it('fails closed (null) when the injected exec decodes diff output as UTF-8 despite the requested encoding', () => {
    start('forced-utf8');
    writeFileSync(join(dir, 'f.txt'), Buffer.from([0x80, 0x0a]));
    const prior = commit('pr1 sets 0x80');
    writeFileSync(join(dir, 'f.txt'), Buffer.from([0x81, 0x0a]));
    const head = commit('pr2 sets 0x81');
    const forcedUtf8 = (cmd, args, opts) => execFileSync(cmd, args, { ...opts, cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(netInterdiff({ exec: forcedUtf8, priorHead: prior, head, base: 'main', rawFiles: { 'f.txt': null } })).toBeNull();
  });

  it('fails closed (null) for a path containing U+FFFD (a lossily decoded name can alias a different file)', () => {
    start('fffd-path');
    write('x.txt', lines(5));
    const prior = commit('pr1');
    write('x.txt', setLine(lines(5), 2, 'PR2'));
    const head = commit('pr2');
    expect(net(prior, head, { 'x.txt': null, 'a�': null })).toBeNull();
  });

  it('fails closed (null) when a diff read comes back cut off at the buffer limit instead of throwing', () => {
    start('truncated');
    write('t.txt', lines(5));
    const prior = commit('pr1');
    write('t.txt', setLine(lines(5), 2, 'PR2'));
    const head = commit('pr2');
    // A spawnSync-style wrapper: returns exactly maxBuffer bytes of stdout (the same prefix at both heads) rather than throwing.
    const cutOff = (cmd, args, opts) => (args.includes('diff') ? 'a'.repeat(opts.maxBuffer) : exec(cmd, args, opts));
    expect(netInterdiff({ exec: cutOff, priorHead: prior, head, base: 'main', rawFiles: { 't.txt': null } })).toBeNull();
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
    write('q/*.txt', 'literal star file\n');
    const prior = commit('pr1 adds a file literally named q/*.txt');
    write('q/b.txt', setLine(lines(10), 2, 'B'));
    const head = commit('pr2 edits only q/b.txt');
    // As a glob, "q/*.txt" would also match q/b.txt and wrongly look changed; literally it is unchanged.
    const out = net(prior, head, { 'q/*.txt': null });
    expect(out).toEqual({ files: {}, dropped: ['q/*.txt'] });
  });

  it('keeps a submodule pointer bump even when git config says to ignore submodules', () => {
    start('sub');
    const gitlink = (id) => git('update-index', '--add', '--cacheinfo', `160000,${id},sub`);
    gitlink('1'.repeat(40));
    git('commit', '-q', '-m', 'pr1 adds submodule pointer');
    const prior = git('rev-parse', 'HEAD');
    gitlink('2'.repeat(40));
    git('commit', '-q', '-m', 'pr2 bumps submodule pointer');
    const head = git('rev-parse', 'HEAD');
    git('config', 'diff.ignoreSubmodules', 'all');
    try {
      expect(Object.keys(net(prior, head, { sub: null }).files)).toEqual(['sub']);
    } finally {
      git('config', '--unset', 'diff.ignoreSubmodules');
    }
  });

  it('keeps a submodule pointer change whose abbreviated hashes match when git config asks for log format', () => {
    start('sub-log');
    const gitlink = (id) => git('update-index', '--add', '--cacheinfo', `160000,${id},sub`);
    // The two ids share their first 7 hex digits, so `diff.submodule=log` (abbreviated hashes) prints the same line for both.
    gitlink('1111111' + 'a'.repeat(33));
    git('commit', '-q', '-m', 'pr1 adds submodule pointer');
    const prior = git('rev-parse', 'HEAD');
    gitlink('1111111' + 'b'.repeat(33));
    git('commit', '-q', '-m', 'pr2 moves submodule pointer within the same abbreviation');
    const head = git('rev-parse', 'HEAD');
    git('config', 'diff.submodule', 'log');
    try {
      expect(Object.keys(net(prior, head, { sub: null }).files)).toEqual(['sub']);
    } finally {
      git('config', '--unset', 'diff.submodule');
    }
  });
});
