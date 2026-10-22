import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardOnlyOverlap, isCardFile, dryMergeOnto, cardOverlapRelief, readCardOverlapCleanMerge, readQueueTip } from '../card-overlap-clean-merge.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function repoWith() {
  const dir = mkdtempSync(join(tmpdir(), 'card-merge-'));
  git(dir, 'init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'backlog'));
  writeFileSync(join(dir, 'backlog/1-card.md'), 'a\nb\nc\nd\ne\nf\ng\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  const branch = (name, content) => {
    git(dir, 'checkout', '-q', '-b', name, base);
    writeFileSync(join(dir, 'backlog/1-card.md'), content);
    git(dir, 'commit', '-q', '-am', name);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, tip: branch('queued', 'A\nb\nc\nd\ne\nf\ng\n'), clean: branch('clean', 'a\nb\nc\nd\ne\nf\nG\n'), conflict: branch('conflict', 'Z\nb\nc\nd\ne\nf\ng\n') };
}

describe('card-overlap clean-merge', () => {
  it('recognises only top-level backlog card files', () => {
    expect(isCardFile('backlog/5360-x.md')).toBe(true);
    expect(isCardFile('backlog/sub/x.md')).toBe(false);
    expect(isCardFile('backlog/x.json')).toBe(false);
    expect(isCardFile('docs/backlog/x.md')).toBe(false);
    expect(isCardFile('backlog/x.md\n')).toBe(false);
    expect(isCardFile('backlog/x.md\nscripts/y.mjs')).toBe(false);
  });
  it('treats an overlap as card-only only when every shared path is a card and no list is unknown', () => {
    expect(cardOnlyOverlap({ overlap: true, with: [{ num: 1, files: ['backlog/a.md'] }], unknown: [] })).toBe(true);
    expect(cardOnlyOverlap({ overlap: true, with: [{ num: 1, files: ['backlog/a.md', 'scripts/a.mjs'] }], unknown: [] })).toBe(false);
    expect(cardOnlyOverlap({ overlap: true, with: [{ num: 1, files: ['backlog/a.md'] }], unknown: [2] })).toBe(false);
    expect(cardOnlyOverlap({ overlap: false, with: [], unknown: [] })).toBe(false);
  });
  it('dry-merges in the object DB: clean, conflict, and bad input', () => {
    const r = repoWith();
    try {
      const before = git(r.dir, 'for-each-ref');
      expect(dryMergeOnto({ head: r.clean, tip: r.tip, cwd: r.dir })).toEqual({ clean: true });
      expect(dryMergeOnto({ head: r.conflict, tip: r.tip, cwd: r.dir })).toEqual({ clean: false, conflict: true, paths: ['backlog/1-card.md'] });
      expect(dryMergeOnto({ head: 'nope', tip: r.tip, cwd: r.dir })).toMatchObject({ clean: false, error: expect.any(String) });
      expect(dryMergeOnto({ head: 'f'.repeat(40), tip: r.tip, cwd: r.dir })).toMatchObject({ clean: false, error: expect.stringMatching(/^fetch failed/) });
      expect(git(r.dir, 'for-each-ref')).toBe(before); // no ref written
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('relief logs each decision and fails closed', () => {
    const r = repoWith();
    const overlap = { overlap: true, with: [{ num: 7, files: ['backlog/1-card.md'] }], unknown: [] };
    const setting = { enabled: true, source: 'tool' };
    const QH = 'e'.repeat(40);
    try {
      const ok = cardOverlapRelief({ num: 9, headSha: r.clean, overlap, repo: 'o/r', setting, cwd: r.dir, queued: [{ num: 7, headSha: QH }], readTip: () => ({ sha: r.tip, num: 7, entries: [{ num: 7, headSha: QH }] }) });
      expect(ok.relieve).toBe(true);
      expect(ok.line).toMatch(/^card-overlap clean-merge: #9 with #7 → enqueue .*drain\.cardOverlapCleanMerge=on \(tool\)$/);
      const bad = cardOverlapRelief({ num: 9, headSha: r.conflict, overlap, repo: 'o/r', setting, cwd: r.dir, queued: [{ num: 7, headSha: QH }], readTip: () => ({ sha: r.tip, num: 7, entries: [{ num: 7, headSha: QH }] }) });
      expect(bad).toMatchObject({ relieve: false, line: expect.stringContaining('→ skip: conflict') });
      expect(cardOverlapRelief({ num: 9, headSha: r.clean, overlap, repo: 'o/r', setting, cwd: r.dir, readTip: () => { throw new Error('boom'); } }))
        .toMatchObject({ relieve: false, line: expect.stringContaining('→ skip: error (boom)') });
      expect(cardOverlapRelief({ num: 9, headSha: r.clean, overlap, queued: [{ num: 7, headSha: QH }], repo: 'o/r', setting, cwd: r.dir, readTip: () => ({ sha: r.tip, num: 8, entries: [{ num: 7, headSha: QH }, { num: 8, headSha: QH }] }) }))
        .toMatchObject({ relieve: false, line: expect.stringContaining('→ skip: queue changed between reads') });
      expect(cardOverlapRelief({ num: 9, headSha: r.clean, overlap, repo: 'o/r', setting, cwd: r.dir, readTip: () => ({ sha: r.tip, num: 7, entries: [{ num: 7, headSha: QH }] }) }))
        .toMatchObject({ relieve: false, line: expect.stringContaining('→ skip: queue changed between reads') });
      expect(cardOverlapRelief({ num: 9, headSha: r.clean, overlap, repo: 'o/r', setting: { enabled: false }, cwd: r.dir })).toEqual({ relieve: false, line: null });
    } finally { rmSync(r.dir, { recursive: true, force: true }); }
  });
  it('reads the queue tip from the last entry and refuses an entry without a merge-group commit', () => {
    const body = nodes => JSON.stringify({ data: { repository: { mergeQueue: { entries: { pageInfo: { hasNextPage: false }, nodes } } } } });
    const a = 'a'.repeat(40), b = 'b'.repeat(40);
    expect(readQueueTip({ repo: 'o/r', exec: () => body([{ position: 2, headCommit: { oid: b }, pullRequest: { number: 2 } }, { position: 1, headCommit: { oid: a }, pullRequest: { number: 1 } }]) }))
      .toMatchObject({ sha: b, num: 2, entries: [{ num: 2, headSha: null }, { num: 1, headSha: null }] });
    expect(readQueueTip({ repo: 'o/r', exec: () => body([{ position: 1, headCommit: null, pullRequest: { number: 1 } }]) })).toHaveProperty('error');
    expect(readQueueTip({ repo: 'o/r', exec: () => body([]) })).toHaveProperty('error');
  });
  it('resolves the setting through the cascade with its source', () => {
    expect(readCardOverlapCleanMerge({ env: { VITEST: '1' }, tool: {}, platform: {} })).toEqual({ enabled: false, source: 'standard' });
    expect(readCardOverlapCleanMerge({ env: { VITEST: '1' }, tool: { cardOverlapCleanMerge: true }, platform: {} })).toEqual({ enabled: true, source: 'tool' });
    expect(readCardOverlapCleanMerge({ env: { VITEST: '1', WE_DRAIN_CARD_OVERLAP_CLEAN_MERGE: 'off' }, tool: { cardOverlapCleanMerge: true }, platform: {} })).toMatchObject({ enabled: false });
  });
});
