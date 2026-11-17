import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../hung-session.mjs', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    readHungInfo: vi.fn(() => ({ hung: true, reason: 'stale' })),
    readClaudeAuthExpiredInfo: vi.fn(() => ({ authExpired: true, reason: 'expired' })),
    readIdleFinishedInfo: vi.fn(() => ({ finished: true, reason: 'idle' })),
    readTranscriptTailActivity: vi.fn(() => ({ lastActivityMs: 123 })),
  };
});

import * as hung from '../hung-session.mjs';
import {
  makeHungResolver, makeAuthExpiredResolver, makeIdleFinishedResolver, resolveLastActivityMs, runSessionReaperPass,
} from '../session-reaper.mjs';

describe('session-reaper inherited-store transcript boundary', () => {
  let root, inherited;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reaper-store-boundary-'));
    mkdirSync(join(root, '.claude'));
    inherited = realpathSync(join(root, '.claude'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['default-store', 'default', true],
    ['other-store', 'other', false],
    ['unknown-store', 'unknown', false],
  ])('%s session transcript boundary', (_label, store, allowed) => {
    const session = {
      id: 'job', sessionId: 'session', cwd: '/repo', kind: 'background', state: 'working', name: 'fix-1',
      ...(store === 'unknown' ? {} : { storeKey: store === 'default' ? inherited : join(root, 'other') }),
    };
    const calls = [
      [() => makeHungResolver()(session), hung.readHungInfo],
      [() => makeAuthExpiredResolver()(session), hung.readClaudeAuthExpiredInfo],
      [() => makeIdleFinishedResolver()(session), hung.readIdleFinishedInfo],
      [() => resolveLastActivityMs(session), hung.readTranscriptTailActivity],
    ];
    for (const [read, spy] of calls) {
      const result = read();
      expect(spy).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed) expect(spy.mock.calls[0][0]).toBe(session);
      else expect(result).toBeNull();
    }
    const stop = vi.fn(() => ({ alreadyGone: false }));
    const result = runSessionReaperPass({
      listAgents: () => [session], stop, log: () => {},
      completionFor: null, groundTruthFor: null, noOutcomeFor: null, chatSpawnGuardFor: null,
      awaitingVerifyFor: null, backstopCompletion: false,
    });
    expect(result.stopped).toBe(allowed ? 1 : 0);
    expect(stop).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it('follows an explicitly inherited CLAUDE_CONFIG_DIR rather than HOME/.claude', () => {
    mkdirSync(join(root, 'selected'));
    const selected = realpathSync(join(root, 'selected'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', selected);
    const read = makeHungResolver();
    expect(read({ storeKey: inherited })).toBeNull();
    expect(hung.readHungInfo).not.toHaveBeenCalled();
    expect(read({ storeKey: selected })).toMatchObject({ hung: true });
    expect(hung.readHungInfo).toHaveBeenCalledTimes(1);
  });
});
