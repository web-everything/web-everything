// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewJob, createReviewJobIo } from '../review-job.mjs';
import { speculateRedTeam } from '../review-extra-seats.mjs';

const repo = 'web-everything/web-everything', pr = 5872, head = 'a'.repeat(40);
const skipped = { status: 'skipped', policy: 'card-only', reason: 'red team skipped: card-only' };
const payload = () => ({ runId: 'review-pr-skip', stopped: 'complete',
  verdict: { verdict: 'accept', loop: { outcome: 'converged' }, findings: [], admittedFindings: [] },
  findings: { read: { title: 'Update card', body: '', diffText: 'diff --git a/backlog/5872.md b/backlog/5872.md\n+update\n',
    netChangedFiles: ['backlog/5872.md'], netRenameSources: [], netBasis: { rev: head } } },
});

function fixture(redTeam = skipped) {
  const loopPayload = payload(), events = [];
  const lanePath = join(tmpdir(), 'review-job-red-team-skip-lane');
  const io = {
    root: process.cwd(), now: () => 1_000, newActorId: () => 'actor',
    readPrevCompletion: () => null, claim: () => ({ ok: true }), updateRecord: vi.fn(), unclaim: vi.fn(),
    acquireLane: () => ({ lanePath }), releaseLane: vi.fn(), prepareLane: () => ({ head }),
    report: vi.fn(), log: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify(loopPayload), stderr: '' })),
    readRedTeamOnlyPayload: () => ({ head, loopPayload }), fetchRedTeamHead: () => ({ head }),
    runExtraSeats: vi.fn(), speculativeRedTeamSetting: () => ({ enabled: false }),
    runRedTeam: vi.fn(() => { events.push('red-team'); return redTeam; }),
    settleRedTeamSkip: vi.fn(() => { events.push('settle'); return { outcome: 'policy-clear' }; }),
    runRedTeamGate: vi.fn(() => { events.push('gate'); return { status: 'ok', outcome: 'advisory' }; }),
    redTeamStatus: vi.fn(({ status }) => { events.push(status); }), clearRedTeamQueued: vi.fn(),
  };
  return { io, events, loopPayload };
}

describe('review-job red-team skip settlement', () => {
  it.each([false, true])('skipped redTeam with policy settles before finished status and gate (redTeamOnly=%s)', redTeamOnly => {
    const f = fixture();
    const out = runReviewJob({ repo, pr, redTeamOnly, redTeamMode: 'fresh' }, f.io);
    expect(out.outcome).toBe(redTeamOnly ? 'red-team-only' : 'parked');
    expect(f.io.runRedTeam).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip.mock.calls[0][0]).toMatchObject({ redTeam: skipped, repo, pr, head });
    expect(f.events).toEqual(['queued', 'red-team', 'settle', 'finished', 'gate']);
    expect(f.io.runRedTeamGate.mock.calls).toEqual([[{ repo, pr }]]);
    expect(out.redTeam).toMatchObject({ status: 'skipped', outcome: 'policy-clear' });
    if (redTeamOnly) {
      expect(f.io.runLoop).not.toHaveBeenCalled();
      expect(f.io.runExtraSeats).not.toHaveBeenCalled();
      expect(f.io.report).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('non-policy skipped result also reaches settlement (redTeamOnly=%s)', redTeamOnly => {
    const redTeam = { status: 'skipped', reason: 'provider unavailable' };
    const f = fixture(redTeam);
    f.io.settleRedTeamSkip.mockImplementation(() => { f.events.push('settle'); return { outcome: 'non-policy' }; });
    const out = runReviewJob({ repo, pr, redTeamOnly }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
    expect(f.io.settleRedTeamSkip.mock.calls[0][0]).toMatchObject({ redTeam, repo, pr, head });
    expect(f.events.indexOf('settle')).toBeLessThan(f.events.indexOf('gate'));
    expect(out.redTeam).toMatchObject({ status: 'skipped', outcome: 'non-policy' });
  });

  it('createReviewJobIo exposes the settlement hook', () => {
    expect(createReviewJobIo({ env: {} }).settleRedTeamSkip).toEqual(expect.any(Function));
  });
});

describe('speculateRedTeam card-only skip provenance', () => {
  it('returns policy:card-only with the unchanged reason before any provider or budget work', async () => {
    const io = { now: () => 1_000, log: vi.fn(), readRecords: () => [],
      cliAvailable: vi.fn(() => { throw Error('card-only must skip before provider work'); }),
      reserveCalls: vi.fn(() => { throw Error('card-only must skip before reservation'); }),
      postComment: vi.fn(), append: vi.fn(),
    };
    const result = await speculateRedTeam({ repo, pr, read: payload().findings.read,
      env: { WE_REVIEW_RED_TEAM: '1', WE_REVIEW_EXTRA_SEATS: '1', WE_RED_TEAM_SKIP_CARD_ONLY: 'true' } }, io);
    expect(result).toEqual(skipped);
    for (const hook of ['cliAvailable', 'reserveCalls', 'postComment', 'append']) expect(io[hook]).not.toHaveBeenCalled();
  });
});
