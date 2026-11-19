import { describe, expect, it } from 'vitest';
import { countRedTeamFixComments, RED_TEAM_FIX_COMMENT_MARKER, RED_TEAM_REARM_COMMENT_MARKER } from '../red-team-fix-round-count.mjs';

const trusted = body => ({ author: { login: 'web-everything' }, body });
const receipt = (head, result) => trusted(`${RED_TEAM_FIX_COMMENT_MARKER}\n\nRed-team repair dispatched: head=${head} result=${result} attempt=launch-1`);

describe('countRedTeamFixComments', () => {
  it('deduplicates a duplicate launch id across new heads and results', () => {
    expect(countRedTeamFixComments([receipt('a'.repeat(40), 'result-a'), receipt('b'.repeat(40), 'result-b')])).toBe(1);
  });

  it('charges an orphan hand-back that has no preceding dispatch receipt', () => {
    expect(countRedTeamFixComments([trusted(RED_TEAM_REARM_COMMENT_MARKER)])).toBe(1);
  });

  it('counts a receipt followed by its hand-back as one round, not two', () => {
    expect(countRedTeamFixComments([receipt('a'.repeat(40), 'result-a'), trusted(RED_TEAM_REARM_COMMENT_MARKER)])).toBe(1);
  });
});
