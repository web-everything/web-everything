import { describe, expect, it, vi } from 'vitest';
import { restampAcceptance } from '../merge-ai-prs.mjs';

describe('acceptance restamp repository resolution', () => {
  it('resolves the local repo for a PR with no explicit repo', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(restampAcceptance({ pr: 5338, repo: null, newHead: 'abc',
      localRepo: () => 'owner/name', spawn })).toEqual({ ok: true });
    expect(spawn.mock.calls[0][1]).toContain('--repo=owner/name');
  });
  it('prefers an explicit repo without resolving the local repo', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    const localRepo = vi.fn();
    expect(restampAcceptance({ pr: 5338, repo: 'a/b', newHead: 'abc', localRepo, spawn })).toEqual({ ok: true });
    expect(spawn.mock.calls[0][1]).toContain('--repo=a/b');
    expect(localRepo).not.toHaveBeenCalled();
  });
  it('refuses without spawning when neither repo can be resolved', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    expect(restampAcceptance({ pr: 5338, repo: null, newHead: 'abc', localRepo: () => null, spawn }))
      .toEqual({ ok: false, reason: 'no repo to re-stamp (PR repo unset and the local repo slug unreadable)' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
