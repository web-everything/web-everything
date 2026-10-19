// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { queueFileOverlap, readQueueEntryFiles } from '../queue-file-overlap.mjs';

const card = 'backlog/123-card.md';
const script = 'scripts/settings/prevention-batch.json';
const check = (candidateFiles, queuedEntries, includeCards = true) => queueFileOverlap({ candidateFiles, queuedEntries, includeCards });
describe('queue file overlap', () => {
  it('blocks shared cards and reports matching PRs and files', () => {
    expect(check([card], [{ num: 42, files: [card] }])).toEqual({ overlap: true, with: [{ num: 42, files: [card] }], unknown: [] });
  });
  it('can ignore cards while still blocking shared scripts', () => {
    expect(check([card], [{ num: 42, files: [card] }], false).overlap).toBe(false);
    expect(check([card, script], [{ num: 42, files: [card, script] }], false).with).toEqual([{ num: 42, files: [script] }]);
  });
  it('reports unknown files without blocking, and allows disjoint paths', () => {
    expect(check([card], [{ num: 42, files: null }, { num: 43, files: [script] }])).toEqual({ overlap: false, with: [], unknown: [42] });
  });
});

describe('read queue entry files', () => {
  const read = (lists, hasNextPage = false) => {
    const calls = [];
    const result = readQueueEntryFiles({ repo: 'owner/repo', exec: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'pr') return JSON.stringify({ files: lists[Number(args[2])] });
      return JSON.stringify({ data: { repository: { mergeQueue: { entries: {
        nodes: Object.keys(lists).map(num => ({ pullRequest: { number: Number(num) } })), pageInfo: { hasNextPage },
      } } } } });
    } });
    expect(calls).toHaveLength(hasNextPage ? 1 : 1 + Object.keys(lists).length);
    expect(calls.every(call => call[0] === 'gh')).toBe(true);
    expect(calls[0].join(' ')).not.toContain('files(first:');
    expect(calls[0].join(' ')).not.toContain('mutation');
    if (!hasNextPage) expect(calls.slice(1)).toEqual(Object.keys(lists).map(num =>
      ['gh', 'pr', 'view', num, '--repo', 'owner/repo', '--json', 'files']));
    return result;
  };
  it('reads paths once per PR, marking capped, missing and malformed lists unknown', () => {
    expect(read({ 42: [{ path: card }], 43: Array(100).fill({ path: script }), 44: undefined, 45: [null] }))
      .toEqual({ entries: [{ num: 42, files: [card] }, { num: 43, files: null }, { num: 44, files: null }, { num: 45, files: null }] });
  });
  it('fails open on queue pagination and read errors', () => {
    expect(read({}, true)).toMatchObject({ entries: [], error: expect.any(String) });
    for (const exec of [() => { throw new Error('offline'); }, () => '{', () => JSON.stringify({ errors: [{ message: 'denied' }] }), () => JSON.stringify({ data: {} })]) {
      expect(readQueueEntryFiles({ repo: 'owner/repo', exec })).toMatchObject({ entries: [], error: expect.any(String) });
    }
  });
});
