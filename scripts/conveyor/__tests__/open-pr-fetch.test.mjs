import { describe, it, expect, vi } from 'vitest';
import { defaultFetchOpenPrs, readPrsFromFile, OPEN_PR_LIST_FIELDS, PR_LIST_LIMIT } from '../open-pr-fetch.mjs';
import { runGhSync } from '../../lib/gh-throttle.mjs';
import { defaultListOpenPrs } from '../duplicate-pr-watch.mjs';
import { defaultListParkedPrs as listConflicts } from '../parked-pr-conflict-watch.mjs';
import { defaultListParkedPrs as listProgress } from '../parked-pr-progress-watch.mjs';
import { defaultReadPrs } from '../reconcile-pass.mjs';

vi.mock('../../lib/gh-throttle.mjs', () => ({ runGhSync: vi.fn(), execFileSyncThrottled: vi.fn() }));

describe('shared open-PR discovery', () => {
  it('pins the deduplicated union and proves every standalone field is included', () => {
    expect(PR_LIST_LIMIT).toBe(200);
    expect(OPEN_PR_LIST_FIELDS).toBe('number,headRefName,title,body,labels,files,mergeable,mergeStateStatus,headRefOid,baseRefName,statusCheckRollup,comments');
    const union = OPEN_PR_LIST_FIELDS.split(',');
    expect(new Set(union).size).toBe(union.length);
    const standalone = new Set();
    for (const reader of [defaultListOpenPrs, listConflicts, listProgress, defaultReadPrs]) {
      reader({ exec: (cmd, args) => {
        expect(cmd).toBe('gh');
        for (const field of args[args.indexOf('--json') + 1].split(',')) standalone.add(field);
        return '[]';
      } });
    }
    expect([...standalone].sort()).toEqual([...union].sort());
  });

  it.each([null, 'owner/repo'])('uses runGhSync by default with the full query (repo %s)', (repo) => {
    const prs = [{ number: 123, comments: [{ body: 'retained' }], files: [{ path: 'a.mjs' }] }];
    runGhSync.mockReset().mockReturnValue(JSON.stringify(prs));
    expect(defaultFetchOpenPrs({ repo })).toEqual(prs);
    expect(runGhSync).toHaveBeenCalledTimes(1);
    expect(runGhSync).toHaveBeenCalledWith(
      ['pr', 'list', '--state', 'open', '--limit', '200', '--json', OPEN_PR_LIST_FIELDS, ...(repo ? ['--repo', repo] : [])],
      expect.objectContaining({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  });

  it.each(['', undefined, '{}', 'null'])('tolerates falsy or non-array output: %s', (out) => {
    expect(defaultFetchOpenPrs({ exec: () => out })).toEqual([]);
  });

  it('propagates fetch/parse failures so the runner can fall back', () => {
    expect(() => defaultFetchOpenPrs({ exec: () => { throw new Error('throttled'); } })).toThrow('throttled');
    expect(() => defaultFetchOpenPrs({ exec: () => '{broken' })).toThrow();
  });
});

describe('snapshot reader', () => {
  it('reads the exact path as UTF-8 and preserves the whole array', () => {
    const prs = [{ number: 1, labels: [], files: [], body: 'text' }];
    const readFile = vi.fn(() => JSON.stringify(prs));
    expect(readPrsFromFile('/tmp/snapshot.json', { readFile })).toEqual(prs);
    expect(readFile).toHaveBeenCalledWith('/tmp/snapshot.json', 'utf8');
  });
  it.each(['{broken', '{}', 'null', '3', '"text"', ''])('returns an empty list for invalid snapshot %s', (content) => {
    expect(readPrsFromFile('unused', { readFile: () => content })).toEqual([]);
  });
  it('returns an empty list for unreadable files', () => {
    expect(readPrsFromFile('unused', { readFile: () => { throw new Error('ENOENT'); } })).toEqual([]);
  });
});
