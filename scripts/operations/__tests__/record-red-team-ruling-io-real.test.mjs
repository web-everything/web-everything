/** #2949 fidelity: resolve an operator's existing card against a real backlog tree. */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createRecordRedTeamRulingReader } from '../record-red-team-ruling-io.mjs';
import { resolveCardRef } from '../record-referral-ruling-io.mjs';
import { planRedTeamRuling, RED_TEAM_RULING_CARD_EFFECT } from '../record-red-team-ruling.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { redTeamGateMarker } from '../../lib/red-team-gate.mjs';

it('reads a real existing card for a cap-held ruling and refuses it after the file disappears', async () => {
  await withRealRepo(async ({ root, commit, head }) => {
    const file = 'backlog/5100-follow-up.md';
    commit({ [file]: '---\nbornAs: xvm9vbu\nstatus: open\n---\n# Follow-up\n' });
    const rev = head();
    const repo = 'o/r';
    const pr = 9;
    const comments = [
      { author: { login: 'web-everything' }, createdAt: '2026-10-20T23:00:00Z',
        body: renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
          findings: [{ summary: 'Recovery omits the rejected parent edge', category: 'edge-case',
            impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 24, confirmedByRecheck: true }] }) },
      { author: { login: 'web-everything' }, createdAt: '2026-10-20T23:41:12Z', body: redTeamGateMarker(pr, rev, 'round-cap') },
    ];
    // Keep GitHub and freshness checks offline. Card enumeration, bornAs lookup and
    // readability use the production resolver's real filesystem reads in the fixture.
    const read = createRecordRedTeamRulingReader({ env: {}, assertFresh: () => {},
      readThread: () => ({ headRefOid: rev.toUpperCase(), labels: [], comments }),
      resolveIdentity: () => ({ login: 'chalbert', type: 'User' }),
      resolveCard: (card) => resolveCardRef(card, { root }),
      now: () => '2026-10-21T00:00:00Z' });
    const input = { repo, pr, card: 'xvm9vbu', break: '1', ruling: 'card',
      actor: 'chalbert', channel: 'test', reason: 'Track the confirmed break in this existing card' };
    const context = read(input);
    expect(context.card).toMatchObject({ ref: `we:${file}`, readable: true, foundIn: 'main' });
    expect(planRedTeamRuling(context, input)).toMatchObject({
      effect: RED_TEAM_RULING_CARD_EFFECT, head: rev, indices: [1], cardRef: `we:${file}`,
    });

    unlinkSync(join(root, file));
    expect(read(input).card.readable).toBe(false);
    expect(() => planRedTeamRuling(read(input), input)).toThrow(/does not resolve to a readable backlog card/);
  });
});
