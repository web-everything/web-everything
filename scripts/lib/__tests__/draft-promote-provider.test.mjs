import { describe, it, expect } from 'vitest';
import { buildReadyArgs, createDraftPromoteProvider } from '../draft-promote-provider.mjs';

describe('draft-promote-provider (draft-first PRs)', () => {
  it('buildReadyArgs is exactly `gh pr ready <pr>`, pr coerced to a string', () => {
    expect(buildReadyArgs(42)).toEqual(['pr', 'ready', '42']);
    expect(buildReadyArgs('42')).toEqual(['pr', 'ready', '42']);
  });

  it('the adapter shells buildReadyArgs through the injected exec and hands its result straight back', () => {
    const seen = [];
    const provider = createDraftPromoteProvider({ cwd: '/repo', exec: (args) => { seen.push(args); return 'ok'; } });
    expect(provider.ready(42)).toBe('ok');
    expect(seen).toEqual([['pr', 'ready', '42']]);
  });


  it('is named "gh", matching the sibling forge-land-provider adapter', () => {
    expect(createDraftPromoteProvider({ exec: () => '' }).name).toBe('gh');
  });

  // we:backlog/x4ua3v8 — the cwd-inferred-repo fix: a caller that KNOWS the PR's repo (the multi-repo daemon
  // path) must be able to pin it explicitly rather than let `gh` infer it from `cwd`'s git remote.
  it('buildReadyArgs appends --repo <repo> when a repo is given, byte-identical when omitted', () => {
    expect(buildReadyArgs(42, 'plateauapp/plateau-app')).toEqual(['pr', 'ready', '42', '--repo', 'plateauapp/plateau-app']);
    expect(buildReadyArgs(42, undefined)).toEqual(['pr', 'ready', '42']);
    expect(buildReadyArgs(42, null)).toEqual(['pr', 'ready', '42']);
  });

  it('the adapter threads its bound repo through to every ready() call', () => {
    const seen = [];
    const provider = createDraftPromoteProvider({
      cwd: '/repo', repo: 'frontier-ui/frontierui', exec: (args) => { seen.push(args); return 'ok'; },
    });
    expect(provider.ready(7)).toBe('ok');
    expect(seen).toEqual([['pr', 'ready', '7', '--repo', 'frontier-ui/frontierui']]);
  });
});
