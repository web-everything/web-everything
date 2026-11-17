import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/drain-red-team-evidence.mjs', () => ({ readDrainRedTeamEvidence: vi.fn() }));

import { readDrainRedTeamEvidence } from '../../lib/drain-red-team-evidence.mjs';
import { currentHeadHumanReviewGates, redTeamClearAtCurrentHead } from '../../lib/human-review-gates.mjs';
import { withHumanReviewEvidence } from '../../lib/__tests__/helpers/human-review-evidence.mjs';
import { liveRedTeam, runDelegatedClearHuman } from '../delegated-clear-human.mjs';

const repo = 'owner/repo';
const head = 'a'.repeat(40);
const pr = withHumanReviewEvidence({ repo, number: 7, headRefOid: head,
  labels: ['review:human', 'advisory:accepted'], comments: [],
  statusCheckRollup: [{ name: 'unit', conclusion: 'SUCCESS', status: 'COMPLETED' }],
});
const known = { inFlight: false, scheduled: false, recorded: true };

beforeEach(() => { readDrainRedTeamEvidence.mockReset().mockReturnValue(known); });

describe('unknown newer review-run evidence vetoes delegated approval', () => {
  it('accepts published current-head proof when run evidence is readable', async () => {
    expect(currentHeadHumanReviewGates(pr).eligible).toBe(true);
    expect((await liveRedTeam({ repo }))(pr, head)).toBe(true);
    expect(readDrainRedTeamEvidence).toHaveBeenCalledWith({ repo, pr: 7, head });
  });

  it.each([
    ['unreadable newer run', () => ({ ok: false, reason: 'run-read-failed' })],
    ['unknown newer run', () => ({ ok: false, reason: 'review-unfinished' })],
    ['capped newer run scan', () => ({ ok: false, reason: 'run-scan-capped' })],
    ['missing evidence', () => null],
    ['incomplete evidence', () => ({})],
    ['asynchronous evidence', () => Promise.resolve(known)],
    ['throwing reader', () => { throw Error('run unreadable'); }],
  ])('%s vetoes shared readiness and the live delegate despite an older clean comment', async (_name, read) => {
    readDrainRedTeamEvidence.mockImplementation(read);
    expect(redTeamClearAtCurrentHead(pr, head)).toBe(false);
    expect(currentHeadHumanReviewGates(pr)).toMatchObject({ eligible: false,
      failed: ['red-team:clear not proven on the current head'] });
    const redTeamClearAtHead = await liveRedTeam({ repo });
    const clearHuman = vi.fn();
    const emit = vi.fn();
    for (const mode of ['shadow', 'on']) {
      const result = await runDelegatedClearHuman({ prs: [pr], mode, redTeamClearAtHead,
        scoreNet: () => ({ scored: true, humanRequired: false }), readLiveHead: () => head, clearHuman, emit });
      expect(result.refused).toEqual([{ pr: 7, failed: ['red-team:clear not proven on the current head'] }]);
      expect(result.cleared).toEqual([]);
      expect(result.wouldApprove).toEqual([]);
    }
    expect(clearHuman).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(readDrainRedTeamEvidence).toHaveBeenCalledWith({ repo, pr: 7, head });
  });
});
