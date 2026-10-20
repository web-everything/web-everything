// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { completeListedFiles, queueFileOverlap, readQueueEntryFiles } from '../queue-file-overlap.mjs';
import { queueBlocksGroup } from '../card-group.mjs';

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
