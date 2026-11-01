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


it('uses the drain CODE checkout even when the pass runs from stale DATA, preserving the target cwd', () => {
  const spawn = vi.fn(() => ({ status: 0 }));
  restampAcceptance({ pr: 5674, repo: 'a/b', newHead: 'abc', cwd: '/ws/sibling', spawn,
    env: { DRAIN_DAEMON_WE_CLONE: '/ws/drain/lane-1' }, exists: () => true });
  expect(spawn.mock.calls[0][1][0]).toBe('/ws/drain/code/scripts/review-set-label.mjs');
  expect(spawn.mock.calls[0][2].cwd).toBe('/ws/sibling');
});
it('honors an explicit drain CODE path and propagates its staleness refusal', () => {
  const spawn = vi.fn(() => ({ status: 1, stderr: 'STALE code from this checkout' }));
  expect(restampAcceptance({ pr: 5674, repo: 'a/b', newHead: 'abc', spawn,
    env: { DRAIN_DAEMON_WE_CLONE: '/ws/data', DRAIN_DAEMON_WE_CODE_CLONE: '/ws/current' }, exists: () => true }))
    .toEqual({ ok: false, reason: 'STALE code from this checkout' });
  expect(spawn.mock.calls[0][1][0]).toBe('/ws/current/scripts/review-set-label.mjs');
});

it('keeps the original guarded CLI when no drain CODE entry exists', () => {
  const paths = [];
  const spawn = vi.fn(() => ({ status: 1, stderr: 'STALE code from this checkout' }));
  restampAcceptance({ pr: 5674, repo: 'a/b', newHead: 'abc', spawn, env: {} });
  paths.push(spawn.mock.calls[0][1][0]);
  expect(restampAcceptance({ pr: 5674, repo: 'a/b', newHead: 'abc', spawn,
    env: { DRAIN_DAEMON_WE_CLONE: '/ws/data' }, exists: () => false }))
    .toEqual({ ok: false, reason: 'STALE code from this checkout' });
  expect(spawn.mock.calls[1][1][0]).toBe(paths[0]);
});
