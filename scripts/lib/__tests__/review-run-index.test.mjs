// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRunIds, readRun } from '../../operations/run-store.mjs';
import { readMatchingReviewRuns } from '../review-run-index.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const head = 'a'.repeat(40);
const record = (id, { repo = 'web-everything/web-everything', pr = 7, rev = head, op = 'review-pr', note = '' } = {}) => ({
  id, op, input: { repo, pr }, findings: { read: { netBasis: { rev } }, note },
  state: 'running', steps: [], startedAt: '2026-10-19T00:00:00Z',
});
function dir() {
  const runsDir = mkdtempSync(join(tmpdir(), 'review-run-index-')); roots.push(runsDir);
  const put = (id, opts) => writeFileSync(join(runsDir, `${id}.json`), JSON.stringify(record(id, opts)));
  return { runsDir, put };
}
const counting = () => {
  const reads = [];
  return { reads, read: (id, d) => { reads.push(id); return JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8')); } };
};
// `later` = an hour on, so files written by the test are older than the 10-minute settle window.
const later = () => Date.now() + 3_600_000;
const ask = (runsDir, extra = {}) => readMatchingReviewRuns({ runsDir, repo: 'Web-Everything/web-everything', pr: 7, head: head.toUpperCase(), list: listRunIds, now: later, settleMs: 600_000, ...extra });

describe('readMatchingReviewRuns', () => {
  it('returns only matching review-pr runs, in list order, read fresh', () => {
    const { runsDir, put } = dir();
    put('review-pr-b'); put('review-pr-a'); put('review-pr-c', { pr: 8 }); put('review-pr-d', { rev: 'b'.repeat(40) });
    put('review-pr-e', { op: 'other' }); put('other-x');
    const { reads, read } = counting();
    expect(ask(runsDir, { read }).map(h => h.id)).toEqual(['review-pr-a', 'review-pr-b']);
    expect(reads).not.toContain('other-x');
  });

  it('second scan re-reads only matching runs; a changed file is re-read and re-indexed', () => {
    const { runsDir, put } = dir();
    put('review-pr-a'); put('review-pr-c', { pr: 8 }); put('review-pr-d', { pr: 9 });
    const first = counting(); ask(runsDir, { read: first.read });
    expect(first.reads.sort()).toEqual(['review-pr-a', 'review-pr-c', 'review-pr-d']);
    const second = counting();
    expect(ask(runsDir, { read: second.read }).map(h => h.id)).toEqual(['review-pr-a']);
    expect(second.reads).toEqual(['review-pr-a']);
    put('review-pr-c', { pr: 7, note: 'changed so the size differs' }); // updated in place: now matches
    const third = counting();
    expect(ask(runsDir, { read: third.read }).map(h => h.id)).toEqual(['review-pr-a', 'review-pr-c']);
    expect(third.reads.sort()).toEqual(['review-pr-a', 'review-pr-c']);
  });

  it('a corrupt record still throws on every scan, as readRun does', () => {
    const { runsDir, put } = dir();
    writeFileSync(join(runsDir, 'review-pr-z.json'), '{not json');
    expect(() => ask(runsDir, { read: readRun })).toThrow(/refusing to read run review-pr-z/);
    expect(() => ask(runsDir, { read: readRun })).toThrow(/refusing to read run review-pr-z/);
  });

  it('a file newer than the settle window is always read, never served from the index', () => {
    const { runsDir, put } = dir();
    put('review-pr-c', { pr: 8 });
    const fresh = { now: Date.now, settleMs: 600_000 };
    ask(runsDir, { ...fresh, read: counting().read });
    const again = counting();
    ask(runsDir, { ...fresh, read: again.read });
    expect(again.reads).toEqual(['review-pr-c']);
  });

  it('closes the stat-to-skip race: a skipped file rewritten mid-scan is re-stat, read and matched', () => {
    const { runsDir, put } = dir();
    put('review-pr-a', { pr: 8 }); put('review-pr-b', { pr: 9 });
    ask(runsDir, { read: counting().read }); // both indexed as non-matching
    let swapped = false;
    const stat = (path, opts) => {
      const st = statSync(path, opts);
      if (!swapped && path.endsWith('review-pr-a.json')) { // atomic replace right AFTER the stat, as writeRun does
        swapped = true;
        const tmp = join(runsDir, 'tmp-a');
        writeFileSync(tmp, JSON.stringify(record('review-pr-a', { pr: 7, note: 'now an accepting run' })));
        renameSync(tmp, join(runsDir, 'review-pr-a.json'));
      }
      return st;
    };
    const { reads, read } = counting();
    expect(ask(runsDir, { read, stat }).map(h => h.id)).toEqual(['review-pr-a']);
    expect(reads).toEqual(['review-pr-a']);
  });

  it('a skipped file corrupted or deleted mid-scan still throws, never skipped', () => {
    for (const mutate of ['corrupt', 'delete']) {
      const { runsDir, put } = dir();
      put('review-pr-a', { pr: 8 });
      ask(runsDir, { read: counting().read });
      let done = false;
      const stat = (path, opts) => {
        const st = statSync(path, opts);
        if (!done) { done = true; if (mutate === 'corrupt') { const tmp = join(runsDir, 't'); writeFileSync(tmp, '{bad'); renameSync(tmp, path); } else unlinkSync(path); }
        return st;
      };
      expect(() => ask(runsDir, { read: readRun, stat })).toThrow(/review-pr-a/);
    }
  });

  it('a stat error means the file is read, so its read error surfaces', () => {
    const { runsDir, put } = dir();
    put('review-pr-a', { pr: 8 });
    ask(runsDir, { read: counting().read });
    const { reads, read } = counting();
    ask(runsDir, { read, stat: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } });
    expect(reads).toEqual(['review-pr-a']);
  });
});
