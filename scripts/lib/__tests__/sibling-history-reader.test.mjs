import { describe, expect, it, vi } from 'vitest';
import { createSiblingHistoryReader } from '../sibling-base-check.mjs';

describe('sibling history Git boundary', () => {
  it.each(['rev-parse', 'check-ref-format', 'rev-list', 'cherry'])('permits %s with bounded, hardened reads', command => {
    const readGit = vi.fn(() => 'evidence');
    const args = [command, 'HEAD'];
    expect(createSiblingHistoryReader(readGit)(args)).toBe('evidence');
    expect(readGit).toHaveBeenCalledOnce();
    expect(readGit).toHaveBeenCalledWith(args, expect.objectContaining({
      timeout: 5000, maxBuffer: 8 * 1024 * 1024,
      env: expect.objectContaining({ GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' }),
    }));
  });

  it.each([
    ['push', 'origin', 'HEAD'], ['fetch', 'origin'], ['update-ref', 'refs/heads/main', 'HEAD'],
    ['-c', 'alias.read=!git push', 'read'], ['--no-pager', 'push'], ['unknown'], [], null,
  ].map(args => ({ args })))('rejects commands outside the history read set before calling Git: $args', ({ args }) => {
    const readGit = vi.fn();
    expect(() => createSiblingHistoryReader(readGit)(args)).toThrow('Unsupported sibling history command');
    expect(readGit).not.toHaveBeenCalled();
  });

  it('propagates read failures to the admission checker', () => {
    const readGit = vi.fn(() => { throw new Error('unreadable history'); });
    expect(() => createSiblingHistoryReader(readGit)(['rev-list', 'HEAD'])).toThrow('unreadable history');
  });
});
