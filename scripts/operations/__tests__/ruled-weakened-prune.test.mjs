/** Waiver retention, atomic compaction and dry-run CLI wiring, without network IO. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pruneEntries, rewriteStore, readStore, appendEntry, waiverRepository } from '../ruled-weakened-store.mjs';
import { pruneStore } from '../ruled-weakened-prune.mjs';

const sha = 'a'.repeat(40), head = 'b'.repeat(40);
const origin = 'https://example.test/team/a.git';
const repository = createHash('sha256').update(origin).digest('hex');
const withOrigin = exec => (cmd, args, opts) => args.includes('get-url') ? { status: 0, stdout: origin } : exec(cmd, args, opts);
const entry = ref => ({ ref, sha, ruling: 'R12', findings: ['finding'], actor: 'operator', quote: 'approved', at: '2026-11-19T12:00:00Z', repository });
let root, path;
beforeEach(() => { root = fs.mkdtempSync(join(process.env.TMPDIR, 'waiver-prune-')); path = join(root, 'store.jsonl'); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('pruneEntries', () => {
  it('never probes foreign or unowned entries, even with a colliding ref', () => {
    const foreign = { ...entry('current'), repository: 'f'.repeat(64) };
    const legacy = entry('current');
    delete legacy.repository;
    const headOf = vi.fn(() => null);
    expect(pruneEntries([foreign, legacy], { repository, headOf })).toEqual({ kept: [foreign, legacy], dropped: [] });
    expect(headOf).not.toHaveBeenCalled();
  });
  it('drops gone, merged and stale entries and retains current and same-diff carried entries in order', () => {
    const entries = ['gone', 'merged', 'stale', 'current', 'carried'].map(entry);
    const carries = vi.fn(e => e.ref === 'carried');
    const result = pruneEntries(entries, {
      repository,
      headOf: ref => ref === 'gone' ? null : ref === 'current' ? sha.toUpperCase() : head,
      isMerged: ref => ref === 'merged', carries,
    });
    expect(result).toEqual({ kept: entries.slice(3), dropped: entries.slice(0, 3) });
    expect(carries.mock.calls).toEqual([[entries[2], head], [entries[4], head]]);
    expect(entries).toHaveLength(5);
  });
  it.each(['headOf', 'isMerged', 'carries'])('keeps an entry when %s throws', key => {
    const e = entry('unknown');
    const probes = { repository, headOf: () => head, isMerged: () => false, carries: () => false };
    probes[key] = () => { throw Error('lookup failed'); };
    expect(pruneEntries([e], probes)).toEqual({ kept: [e], dropped: [] });
  });
});

describe('rewriteStore', () => {
  it('roundtrips valid entries and can atomically empty the store', () => {
    rewriteStore({ entries: [entry('one'), entry('two')], path });
    expect(readStore({ path }).entries).toEqual([entry('one'), entry('two')]);
    rewriteStore({ entries: [], path });
    expect(fs.readFileSync(path, 'utf8')).toBe('');
    expect(fs.readdirSync(root)).toEqual(['store.jsonl']);
  });
  it('preserves the original and cleans temporary files on rename failure; invalid data never replaces it', () => {
    rewriteStore({ entries: [entry('one')], path });
    const before = fs.readFileSync(path, 'utf8');
    expect(() => rewriteStore({ entries: [{}], path })).toThrow('invalid');
    expect(() => rewriteStore({ entries: [], path, fs: { ...fs, renameSync: () => { throw Error('rename failed'); } } })).toThrow('rename failed');
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    expect(fs.readdirSync(root)).toEqual(['store.jsonl']);
  });
});

describe('prune CLI IO', () => {
  it('keeps owned entries when origin identity cannot be read despite a successful branch lookup', () => {
    const e = entry('gone');
    rewriteStore({ entries: [e], path });
    const log = vi.fn();
    const exec = (_cmd, args) => args.includes('get-url') ? { status: 128 } : { status: 0, stdout: '' };
    expect(pruneStore({ path, exec, log })).toEqual({ kept: [e], dropped: [] });
    expect(readStore({ path }).entries).toEqual([e]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Restore origin configuration'));
  });
  it('keeps legacy waivers of unknown repository ownership, including absent and colliding refs', () => {
    const entries = ['lane/we-fix', 'lane/frontier-fix'].map(ref => {
      const value = entry(ref);
      delete value.repository;
      return value;
    });
    rewriteStore({ entries, path });
    const exec = (_cmd, args) => args.includes('ls-remote')
      ? { status: 0, stdout: `${head}\trefs/heads/lane/we-fix\n` } : { status: 0 };
    expect(pruneStore({ path, repo: root, exec: withOrigin(exec), log: () => {} })).toEqual({ kept: entries, dropped: [] });
    expect(readStore({ path }).entries).toEqual(entries);
  });
  it('dry-run leaves bytes untouched; apply removes absent and merged refs using bounded git calls', () => {
    const entries = ['gone', 'merged', 'current'].map(entry);
    rewriteStore({ entries, path });
    const before = fs.readFileSync(path, 'utf8');
    const exec = vi.fn((_cmd, args, opts) => {
      expect(opts.timeout).toBe(30000);
      expect(opts.maxBuffer).toBeGreaterThan(0);
      if (args.includes('ls-remote')) return { status: 0, stdout: `${head}\trefs/heads/merged\n${sha}\trefs/heads/current\n` };
      expect(args.slice(2)).toEqual(['merge-base', '--is-ancestor', expect.any(String), 'origin/main']);
      return { status: args.at(-2) === head ? 0 : 1 };
    });
    expect(pruneStore({ path, repo: root, exec: withOrigin(exec), dryRun: true, log: () => {} }).kept).toEqual([entries[2]]);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
    pruneStore({ path, repo: root, exec: withOrigin(exec), log: () => {} });
    expect(readStore({ path }).entries).toEqual([entries[2]]);
  });
  it('failed remote lookup keeps all bytes and reports recovery; failed ancestry keeps the entry', () => {
    const e = entry('current');
    rewriteStore({ entries: [e], path });
    const before = fs.readFileSync(path, 'utf8');
    const log = vi.fn();
    expect(pruneStore({ path, exec: () => ({ status: 128 }), log }).kept).toEqual([e]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Restore origin access'));
    const exec = (_cmd, args) => args.includes('ls-remote') ? { status: 0, stdout: `${head}\trefs/heads/current\n` } : { status: 128 };
    expect(pruneStore({ path, exec: withOrigin(exec), log }).kept).toEqual([e]);
    expect(fs.readFileSync(path, 'utf8')).toBe(before);
  });
  it.each(['recorded', 'current'])('retains the waiver through pruneStore when the %s fingerprint is missing', missing => {
    const e = entry('advanced');
    rewriteStore({ entries: [entry('gone'), e], path });
    const fingerprint = vi.fn((_repo, _base, revision) => revision === (missing === 'recorded' ? sha : head) ? null : 'c'.repeat(64));
    const exec = (_cmd, args) => args.includes('ls-remote')
      ? { status: 0, stdout: `${head}\trefs/heads/advanced\n` } : { status: 1 };
    const log = vi.fn();
    expect(pruneStore({ path, repo: root, exec: withOrigin(exec), fingerprint, log })).toEqual({ kept: [e], dropped: [entry('gone')] });
    expect(fingerprint.mock.calls).toEqual([[root, 'origin/main', sha], [root, 'origin/main', head]]);
    expect(readStore({ path }).entries).toEqual([e]);
    expect(log).toHaveBeenCalledWith('Fingerprint lookup failed; keeping entry. Restore local commit objects and retry.');
  });
  it.each([true, false])('uses readable fingerprints to decide same-diff carry through pruneStore: %s', sameDiff => {
    const e = entry('advanced');
    rewriteStore({ entries: [e], path });
    const fingerprint = (_repo, _base, revision) => (sameDiff || revision === sha ? 'c' : 'd').repeat(64);
    const exec = (_cmd, args) => args.includes('ls-remote')
      ? { status: 0, stdout: `${head}\trefs/heads/advanced\n` } : { status: 1 };
    const result = pruneStore({ path, repo: root, exec: withOrigin(exec), fingerprint, log: () => {} });
    expect(result).toEqual({ kept: sameDiff ? [e] : [], dropped: sameDiff ? [] : [e] });
    expect(readStore({ path }).entries).toEqual(result.kept);
  });
  it('refuses append and prune when the shared lock is busy, then releases after a failed prune', () => {
    rewriteStore({ entries: [entry('old')], path });
    const before = fs.readFileSync(path, 'utf8');
    const exec = () => {
      expect(() => appendEntry(entry('new'), { path, lockOptions: { waitMs: 0 } })).toThrow(/queue is busy; retry later/);
      expect(() => pruneStore({ path, lockOptions: { waitMs: 0 } })).toThrow(/queue is busy; retry later/);
      expect(fs.readFileSync(path, 'utf8')).toBe(before);
      throw Error('probe failed');
    };
    expect(() => pruneStore({ path, exec })).toThrow('probe failed');
    appendEntry(entry('new'), { path, lockOptions: { waitMs: 0 } });
    expect(readStore({ path }).entries.map(e => e.ref)).toEqual(['old', 'new']);
  });
  it('refuses to rewrite unreadable or malformed stores', () => {
    fs.mkdirSync(path);
    expect(() => pruneStore({ path })).toThrow('unreadable store');
    fs.rmSync(path, { recursive: true });
    fs.writeFileSync(path, '{bad\n');
    expect(() => pruneStore({ path })).toThrow('malformed JSON');
    expect(fs.readFileSync(path, 'utf8')).toBe('{bad\n');
  });
});

describe('waiver repository ownership', () => {
  it('uses the same remote identity across clones and distinguishes relative local origins', () => {
    const exec = (_cmd, _args) => ({ status: 0, stdout: origin });
    expect(waiverRepository('/fixture/a', { exec })).toBe(repository);
    expect(waiverRepository('/fixture/b', { exec })).toBe(repository);
    const local = () => ({ status: 0, stdout: '../remote.git' });
    expect(waiverRepository('/fixture/a/lane', { exec: local }))
      .not.toBe(waiverRepository('/fixture/b/lane', { exec: local }));
  });
  it.each(['', 'url\nsecond-url', 'url\u0000'])('rejects missing or malformed origin identity: %j', stdout => {
    expect(waiverRepository(root, { exec: () => ({ status: 0, stdout }) })).toBeNull();
  });
});
