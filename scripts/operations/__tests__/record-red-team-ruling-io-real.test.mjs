/** #2949 fidelity: resolve an operator's existing card against a real backlog tree. */
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { withNarrowClone } from './helpers/real-repo.mjs';
import { createRecordRedTeamRulingReader, createRecordRedTeamRulingSinks } from '../record-red-team-ruling-io.mjs';
import { planRedTeamRuling, RED_TEAM_RULING_CARD_EFFECT } from '../record-red-team-ruling.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, readRedTeamDisposition, redTeamGateMarker } from '../../lib/red-team-gate.mjs';

it('reads published cards from a real origin and refuses checkout-only cards in the reader and sink', async () => {
  await withNarrowClone(async ({ clone, commit, git, seedOriginBranch }) => {
    const file = 'backlog/5100-follow-up.md';
    const unmerged = 'backlog/6935-prevention-require-named-refusal-and-post-failure-coverage-f.md';
    const body = '---\nbornAs: xvm9vbu\nstatus: open\n---\n# Follow-up\n';
    seedOriginBranch('main', { [file]: body });
    const rev = commit({ [file]: body, [unmerged]: body });
    // A feature-only refspec must not leave origin/main stale after a successful fetch.
    git(['config', 'remote.origin.fetch', '+refs/heads/feature:refs/remotes/origin/feature']);
    const repo = 'o/r';
    const pr = 9;
    const comments = [
      { author: { login: 'web-everything' }, createdAt: '2026-10-20T23:00:00Z',
        body: renderRedTeamComment({ pr, rev, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
          findings: [{ summary: 'Recovery omits the rejected parent edge', category: 'edge-case',
            impactIfUnfixed: 'broken', file: 'scripts/example.mjs', line: 24, confirmedByRecheck: true }] }) },
      { author: { login: 'web-everything' }, createdAt: '2026-10-20T23:41:12Z', body: redTeamGateMarker(pr, rev, 'round-cap') },
    ];
    // Only GitHub is stubbed: enumeration, content and refresh use real Git against a local origin.
    const options = { runGit: args => git(args), readStandingRulingScope: () => null,
      readThread: () => ({ headRefOid: rev.toUpperCase(), labels: [], comments: [...comments] }),
      resolveIdentity: () => ({ login: 'chalbert', type: 'User' }) };
    const read = createRecordRedTeamRulingReader({ env: {}, assertFresh: () => {},
      ...options, readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }),
      now: () => '2026-10-21T00:00:00Z' });
    const input = { repo, pr, card: 'xvm9vbu', break: '1', ruling: 'card',
      actor: 'chalbert', channel: 'test', reason: 'Track the confirmed break in this existing card' };
    const context = read(input);
    expect(context.card).toMatchObject({ ref: `we:${file}`, readable: true, foundIn: 'main' });
    expect(planRedTeamRuling(context, input)).toMatchObject({
      effect: RED_TEAM_RULING_CARD_EFFECT, head: rev, indices: [1], cardRef: `we:${file}`,
    });

    unlinkSync(join(clone, file));
    expect(read(input).card.readable).toBe(true); // A dirty checkout cannot change publication evidence.
    const unpublishedInput = { ...input, card: `we:${unmerged}` };
    const unpublished = read(unpublishedInput);
    expect(unpublished.card).toMatchObject({ readable: false, foundIn: 'main' });
    expect(unpublished.card.reason).toMatch(/has it landed on main.*cite it as/);
    expect(() => planRedTeamRuling(unpublished, unpublishedInput)).toThrow(/does not resolve to a readable backlog card/);

    const posted = [];
    const sinks = createRecordRedTeamRulingSinks({ ...options,
      post: (_repo, _pr, body) => {
        posted.push(body);
        comments.push({ author: { login: 'chalbert', type: 'User' }, createdAt: '2026-10-21T00:00:00Z', body });
      },
      syncLabels: () => { throw new Error('unpublished card must remain held'); },
    });
    // Simulate a plan made by the old checkout-backed reader; the production sink must distrust it.
    const oldPlan = planRedTeamRuling({ ...unpublished, card: { ...unpublished.card, readable: true } }, unpublishedInput);
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](oldPlan)).toThrow(/no release record written/);
    expect(posted).toHaveLength(1);
    expect(readRedTeamDisposition({ comments, pr, head: rev, setting: CONFIRMED_BREAKS_DEFAULTS }).held).toHaveLength(1);

    // Refresh again at release time, even if the earlier reader successfully saw a published card.
    const plan = planRedTeamRuling(read(input), input);
    seedOriginBranch('main', { [file]: '# No longer a readable card\n' });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](plan)).toThrow(/no release record written/);
    expect(posted).toHaveLength(2); // Both comments are reasons; neither released the held break.
    expect(readRedTeamDisposition({ comments, pr, head: rev, setting: CONFIRMED_BREAKS_DEFAULTS }).held).toHaveLength(1);
  });
});
