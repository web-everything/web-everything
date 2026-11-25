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

  it('hydrates only after a failed local patch read, with bounded hardened calls', () => {
    const readGit = vi.fn((args, { env }) => {
      if (args[0] === 'config') return '';
      if (env.GIT_NO_LAZY_FETCH === '1') throw new Error('missing blob');
      return 'patch evidence';
    });
    expect(createSiblingHistoryReader(readGit)(['cherry', 'main', 'HEAD'])).toBe('patch evidence');
    expect(readGit).toHaveBeenCalledTimes(3);
    expect(readGit.mock.calls[1]).toEqual([
      ['config', '--show-scope', '--list', '--includes', '-z'],
      expect.objectContaining({ timeout: 5000, maxBuffer: 8 * 1024 * 1024,
        env: expect.objectContaining({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'file:https:http:ssh:git' }) }),
    ]);
    expect(readGit.mock.calls[2]).toEqual([
      ['cherry', 'main', 'HEAD'],
      expect.objectContaining({ timeout: 5000, maxBuffer: 8 * 1024 * 1024,
        env: expect.objectContaining({ GIT_NO_LAZY_FETCH: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null',
          GIT_ALLOW_PROTOCOL: 'file:https:http:ssh:git', GIT_TERMINAL_PROMPT: '0' }) }),
    ]);
  });

  it.each(['local', 'worktree', 'global', 'system', 'command'])('rejects executable hydration config from %s scope', scope => {
    for (const key of ['remote.origin.uploadpack', 'remote.other.vcs', 'core.gitProxy', 'url.ext::helper.insteadOf',
      'uploadpack.packObjectsHook', 'include.path', 'includeIf.gitdir:/another/repository.path',
      'remote.line\nbreak.uploadpack']) {
      const readGit = vi.fn(args => {
        if (args[0] === 'cherry') throw new Error('missing blob');
        return `${scope}\0${key}\ncustom-command\0`;
      });
      expect(() => createSiblingHistoryReader(readGit)(['cherry', 'main', 'HEAD'])).toThrow('unsafe hydration transport config');
      expect(readGit).toHaveBeenCalledTimes(2);
      expect(readGit.mock.calls[1][0][0]).toBe('config');
    }
  });

  it.each(['local\0core.test\nvalue', 'local\0', 'unknown\0core.test\nvalue\0', 'local\0\0'])
    ('refuses incomplete hydration configuration: %s', config => {
      const readGit = vi.fn(args => {
        if (args[0] === 'cherry') throw new Error('missing blob');
        return config;
      });
      expect(() => createSiblingHistoryReader(readGit)(['cherry', 'main', 'HEAD'])).toThrow(/hydration config/);
      expect(readGit).toHaveBeenCalledTimes(2);
    });

  it('accepts unrelated key-only boolean config entries', () => {
    const readGit = vi.fn((args, { env }) => {
      if (args[0] === 'config') return 'local\0fetch.prune\0';
      if (env.GIT_NO_LAZY_FETCH === '1') throw new Error('missing blob');
      return 'patch evidence';
    });
    expect(createSiblingHistoryReader(readGit)(['cherry', 'main', 'HEAD'])).toBe('patch evidence');
    expect(readGit).toHaveBeenCalledTimes(3);
  });

  it('constrains hydration protocols and ignores inherited executable overrides', () => {
    try {
      vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ext');
      vi.stubEnv('GIT_EXEC_PATH', '/untrusted/helpers');
      vi.stubEnv('GIT_PROXY_COMMAND', 'untrusted-proxy');
      const readGit = vi.fn((args, { env }) => {
        if (args[0] === 'config') return 'local\0protocol.ext.allow\nalways\0';
        if (env.GIT_NO_LAZY_FETCH === '1') throw new Error('missing blob');
        return '';
      });
      createSiblingHistoryReader(readGit)(['cherry', 'main', 'HEAD']);
      for (const [, { env }] of readGit.mock.calls.slice(1)) {
        expect(env.GIT_ALLOW_PROTOCOL).toBe('file:https:http:ssh:git');
        expect(env.GIT_EXEC_PATH).toBeUndefined();
        expect(env.GIT_PROXY_COMMAND).toBeUndefined();
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('fails closed after one unsuccessful hydration retry', () => {
    const readGit = vi.fn(args => {
      if (args[0] === 'config') return '';
      throw new Error('promisor unavailable');
    });
    expect(() => createSiblingHistoryReader(readGit)(['cherry', 'main', 'HEAD'])).toThrow('promisor unavailable');
    expect(readGit).toHaveBeenCalledTimes(3);
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
