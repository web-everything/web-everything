// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { settleRedTeamSkip } from '../../lib/red-team-skip-outcome.mjs';
import { publishAttention, replay } from '../needs-you-feed.mjs';
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
    // The normal path's outcome follows the fixture verdict, not settlement; settlement order is asserted below.
    if (redTeamOnly) expect(out.outcome).toBe('red-team-only');
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

  it.each([{ status: 'error' }, { status: 'disabled' }, { unexpected: true }, null, undefined])(
    'production dispatch settles every incomplete outcome %j', redTeam => {
      const f = fixture();
      f.io.runRedTeam.mockReturnValue(redTeam);
      f.io.settleRedTeamSkip.mockReturnValue({ outcome: 'non-policy' });
      const out = runReviewJob({ repo, pr }, f.io);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledTimes(1);
      expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ redTeam, repo, pr, head }));
      expect(out.redTeam.outcome).toBe('non-policy');
    });

  it.each(['ran', 'resumed'])('completed %s does not settle', status => {
    const f = fixture({ status });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).not.toHaveBeenCalled();
  });

  it('stored review head takes precedence over the prepared lane head', () => {
    const f = fixture();
    f.io.prepareLane = () => ({ head: 'b'.repeat(40) });
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ head }));
  });

  it('two real lane heads without netBasis.rev publish twice', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-skip-heads-'));
    const path = join(root, 'feed.jsonl');
    try {
      for (const realHead of [head, 'b'.repeat(40)]) {
        const f = fixture({ status: 'skipped', reason: 'missing rev' });
        delete f.loopPayload.findings.read.netBasis.rev;
        f.io.prepareLane = () => ({ head: realHead });
        f.io.settleRedTeamSkip.mockImplementation(input => settleRedTeamSkip({ ...input, io: {
          env: { WE_SHARED_RUNS_DIR: join(root, 'runs') },
          publishNeedsYou: item => publishAttention(item, { path }),
        } }));
        runReviewJob({ repo, pr }, f.io);
        expect(f.io.settleRedTeamSkip.mock.calls[0][0].head).toBe(realHead);
      }
      expect(replay({ path }).map(item => item.head)).toEqual([head, 'b'.repeat(40)]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a missing pinned rev falls back to the prepared lane head, never a null identity', () => {
    const f = fixture({ status: 'skipped', reason: 'missing rev' });
    delete f.loopPayload.findings.read.netBasis.rev;
    runReviewJob({ repo, pr }, f.io);
    expect(f.io.settleRedTeamSkip).toHaveBeenCalledWith(expect.objectContaining({ head, runId: f.loopPayload.runId }));
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
