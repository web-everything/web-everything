// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settleRedTeamSkip } from '../red-team-skip-outcome.mjs';
import { redTeamStatusDir } from '../drain-red-team-evidence.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'red-team-skip-regressions-'));
  roots.push(root);
  const env = { WE_SHARED_RUNS_DIR: join(root, 'runs') };
  const input = { repo: 'web-everything/web-everything', pr: 5872, head: 'a'.repeat(40), comments: [] };
  const io = { env, postComment: vi.fn(), publishNeedsYou: vi.fn(), log: vi.fn() };
  const markerDir = join(redTeamStatusDir(env), 'skip-published');
  const markers = () => existsSync(markerDir) ? readdirSync(markerDir) : [];
  const settle = (redTeam, overrides = {}) => settleRedTeamSkip({ ...input, redTeam, io, ...overrides });
  return { input, io, markers, settle };
}

describe('red-team skip pre-review regressions', () => {
  it.each([
    ['missing policy', { status: 'skipped', reason: 'red team skipped: card-only' }],
    ['missing status', { policy: 'card-only', reason: 'red team skipped: card-only' }],
    ['disabled status', { status: 'disabled', policy: 'card-only', reason: 'red team skipped: card-only' }],
    ['error status', { status: 'error', policy: 'card-only', reason: 'red team skipped: card-only' }],
    ['unknown policy', { status: 'skipped', policy: 'other', reason: 'red team skipped: card-only' }],
    ['unstructured input', 'red team skipped: card-only'],
  ])('policy predicate requires both structured fields: %s cannot clear', (_name, redTeam) => {
    const f = fixture();
    expect(f.settle(redTeam).outcome).toBe('non-policy');
    expect(f.io.postComment).not.toHaveBeenCalled();
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    expect(f.io.publishNeedsYou.mock.calls[0][0]).toMatchObject({ kind: 'needs-you',
      reason: expect.stringMatching(/^red team skipped \(.+\); not cleared$/) });
    expect(planRedTeamStatusLabels({ ...f.input, labels: ['red-team:pending'] }).add).not.toBe('red-team:clear');
  });

  it('failed publication leaves no marker; retry succeeds before deduplication begins', () => {
    const f = fixture(), redTeam = { status: 'skipped', reason: 'provider unavailable' };
    f.io.publishNeedsYou.mockImplementationOnce(() => { throw Error('feed unavailable'); });
    expect(f.settle(redTeam).outcome).toBe('non-policy');
    expect(f.markers()).toEqual([]);
    expect(f.io.log).toHaveBeenCalledTimes(1);
    f.io.publishNeedsYou.mockImplementationOnce(() => {
      // A marker written before publication would suppress a later retry after failure.
      expect(f.markers()).toEqual([]);
    });
    expect(f.settle(redTeam).outcome).toBe('non-policy');
    expect(f.markers()).toHaveLength(1);
    f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.io.postComment).not.toHaveBeenCalled();
  });

  it.each(['repo', 'pr', 'head', 'reason'])('successful publication deduplicates by repo/PR/head/reason: changing %s publishes again', field => {
    const f = fixture(), reason = 'provider unavailable';
    const redTeam = { status: 'skipped', reason };
    f.settle(redTeam);
    const expectedKey = createHash('sha256')
      .update(JSON.stringify([f.input.repo, f.input.pr, f.input.head, reason])).digest('hex');
    expect(f.markers()).toEqual([`${expectedKey}.json`]);
    f.settle(redTeam);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(1);
    const changed = { repo: 'frontier-ui/frontierui', pr: 5873, head: 'b'.repeat(40), reason: 'missing input' };
    const next = field === 'reason' ? { ...redTeam, reason: changed.reason } : redTeam;
    const overrides = field === 'reason' ? {} : { [field]: changed[field] };
    f.settle(next, overrides);
    f.settle(next, overrides);
    expect(f.io.publishNeedsYou).toHaveBeenCalledTimes(2);
    expect(f.markers()).toHaveLength(2);
    expect(f.io.postComment).not.toHaveBeenCalled();
  });
});
