// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { completeListedFiles, queueFileOverlap, readQueueEntryFiles } from '../queue-file-overlap.mjs';
import { queueBlocksGroup } from '../card-group.mjs';


describe('main regression coverage', () => {
// @vitest-environment node




const file = 'backlog/1-card.md';
function reader({ nodes = [{ pullRequest: { number: 7 } }], hasNextPage = false, files = [{ path: file }], error, viewError, resolveFiles } = {}) {
  const exec = vi.fn((cmd, args) => {
    expect(cmd).toBe('gh');
    if (args[0] === 'api') {
      if (error) throw new Error(error);
      return JSON.stringify({ data: { repository: { mergeQueue: { entries: { nodes, pageInfo: { hasNextPage } } } } } });
    }
    if (viewError) throw new Error(viewError);
    return JSON.stringify({ files, headRefOid: 'a'.repeat(40), headRefName: 'lane/queued', baseRefName: 'main' });
  });
  return { exec, result: readQueueEntryFiles({ repo: 'o/r', exec, resolveFiles }) };
}

describe('readQueueEntryFiles fail-closed grouping reads', () => {
  it('reads a complete queue and keeps overlapping card paths', () => {
    const { result, exec } = reader();
    expect(result).toEqual({ entries: [{ num: 7, files: [file], headSha: 'a'.repeat(40) }] });
    expect(exec.mock.calls[0][1]).toContain('owner=o');
    expect(exec.mock.calls[0][1]).toContain('name=r');
    expect(queueFileOverlap({ candidateFiles: [file], queuedEntries: result.entries, includeCards: true }))
      .toEqual({ overlap: true, with: [{ num: 7, files: [file] }], unknown: [] });
  });

  it.each([
    ['more than 100 queue entries', { hasNextPage: true }],
    ['missing queue page', { nodes: null }],
    ['invalid entry', { nodes: [{ pullRequest: null }] }],
    ['invalid PR number', { nodes: [{ pullRequest: { number: '7' } }] }],
    ['unreadable queue', { error: 'offline' }],
    ['unreadable file list', { viewError: 'view offline' }],
  ])('refuses %s before a group claim', (_, options) => {
    const { result } = reader(options);
    expect(result.error).toBeTruthy();
    expect(queueBlocksGroup(result, { sources: [{ num: 1 }], files: [file] })).toMatch(/merge queue unreadable/);
  });

  it.each([
    ['missing list', null],
    ['100-path cap', Array.from({ length: 100 }, () => ({ path: file }))],
    ['malformed path', [{}]],
  ])('holds on an incomplete or malformed file list (%s)', (_, files) => {
    const { result } = reader({ files });
    expect(result.entries[0].files).toBeNull();
    expect(queueBlocksGroup(result, { sources: [{ num: 1 }], files: [file] })).toBeTruthy();
  });

  it('accepts 99 complete file paths, and distinguishes a complete empty list from unknown', () => {
    expect(completeListedFiles(Array.from({ length: 99 }, (_, i) => `backlog/${i}-card.md`))).toHaveLength(99);
    expect(reader({ files: [] }).result.entries[0].files).toEqual([]);
  });

  it('lets the git resolver replace a capped API list and passes head identity', () => {
    const resolveFiles = vi.fn(() => [file]);
    expect(reader({ files: Array(100).fill({ path: file }), resolveFiles }).result.entries[0].files).toEqual([file]);
    expect(resolveFiles).toHaveBeenCalledWith(expect.objectContaining({ num: 7, repo: 'o/r',
      view: expect.objectContaining({ headRefOid: 'a'.repeat(40), headRefName: 'lane/queued' }) }));
  });
});

});

describe('overlay regression coverage', () => {
// @vitest-environment node



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
      ['gh', 'pr', 'view', num, '--repo', 'owner/repo', '--json', 'files,headRefName,baseRefName,headRefOid']));
    return result;
  };
  it('reads paths once per PR, marking capped, missing and malformed lists unknown', () => {
    expect(read({ 42: [{ path: card }], 43: Array(100).fill({ path: script }), 44: undefined, 45: [null] }))
      .toEqual({ entries: [{ num: 42, files: [card] }, { num: 43, files: null }, { num: 44, files: null }, { num: 45, files: null }] });
  });
  it.each([[[ 'scripts/net.mjs' ]], [null]])('passes full PR metadata to the optional resolver and preserves its result: %j', files => {
    const view = { files: [{ path: card }], headRefName: 'lane/queued', baseRefName: 'main', headRefOid: 'a'.repeat(40) };
    const resolveFiles = vi.fn(() => files);
    const exec = vi.fn((_cmd, args) => args[0] === 'pr' ? JSON.stringify(view)
      : JSON.stringify({ data: { repository: { mergeQueue: { entries: {
        nodes: [{ pullRequest: { number: 42 } }], pageInfo: { hasNextPage: false },
      } } } } }));
    expect(readQueueEntryFiles({ repo: 'owner/repo', exec, resolveFiles })).toEqual({ entries: [{ num: 42, files, headSha: 'a'.repeat(40) }] });
    expect(resolveFiles).toHaveBeenCalledTimes(1);
    expect(resolveFiles).toHaveBeenCalledWith({ num: 42, repo: 'owner/repo', view });
    expect(exec.mock.calls[1][1]).toEqual(['pr', 'view', '42', '--repo', 'owner/repo', '--json', 'files,headRefName,baseRefName,headRefOid']);
  });
  it('fails open on queue pagination and read errors', () => {
    expect(read({}, true)).toMatchObject({ entries: [], error: expect.any(String) });
    for (const exec of [() => { throw new Error('offline'); }, () => '{', () => JSON.stringify({ errors: [{ message: 'denied' }] }), () => JSON.stringify({ data: {} })]) {
      expect(readQueueEntryFiles({ repo: 'owner/repo', exec })).toMatchObject({ entries: [], error: expect.any(String) });
    }
  });
});

});
