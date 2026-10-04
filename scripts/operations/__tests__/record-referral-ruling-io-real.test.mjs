/**
 * @file scripts/operations/__tests__/record-referral-ruling-io-real.test.mjs
 * @description #4979 — the #2949 fidelity qualifier for `record-referral-ruling-io.mjs`: its real non-GitHub
 *   mechanism is reading the checkout's backlog to resolve `--card`, and the gate's own readability check on that
 *   same tree. Exercised against a REAL repository with committed cards (a numbered card, a provisional card, and
 *   a landed card carrying `bornAs:` after JIT renumbering); only the GitHub read is injected.
 */
import { it, expect } from 'vitest';
import { renderReferralRecord, mandatoryReferralReviewer, normalizeFinding, referralFindingKey } from '../../lib/jury-core.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
import { createRecordReferralRulingReader, resolveCardRef } from '../record-referral-ruling-io.mjs';
import { planOperatorRuling } from '../record-referral-ruling.mjs';

it('resolves --card in a real checkout and plans a ruling the gate would honour', async () => {
  await withRealRepo(async ({ root, commit }) => {
    commit({
      'backlog/5100-landed-follow-up.md': '---\nbornAs: xvm9vbu\nstatus: open\n---\n# follow-up\n',
      'backlog/xab12cd-provisional.md': '---\nstatus: open\n---\n# provisional\n',
      'backlog/5101-no-frontmatter.md': '# not a card\n',
    }, 'fixture: backlog cards');
    expect(resolveCardRef('xvm9vbu', { root })).toMatchObject({ ref: 'we:backlog/5100-landed-follow-up.md', readable: true });
    expect(resolveCardRef('xab12cd', { root })).toMatchObject({ ref: 'we:backlog/xab12cd-provisional.md', readable: true });
    expect(resolveCardRef('5101', { root })).toMatchObject({ readable: false });
    expect(resolveCardRef('xnope00', { root })).toMatchObject({ readable: false });

    const head = 'c'.repeat(40);
    const original = { summary: 'protected list misses edits', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const seat = 'judgeCorrectnessAdvisory';
    const runId = 'review-pr-real';
    const reviewer = mandatoryReferralReviewer(runId);
    const key = referralFindingKey(seat, original);
    const record = { version: 1, repo: 'o/r', pr: 9, head, runId, reviewer, authorBody: '<!-- authored-by-actor: a -->', attempted: true,
      referrals: [{ key, seat, original, finding: normalizeFinding(original) }],
      rulings: [{ id: `${runId}:0`, key, reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'gap', evidence: ['diff'] }] };
    const readJson = () => ({ headRefOid: head, body: record.authorBody, createdAt: '2026-10-04T00:00:00Z',
      comments: [{ body: renderReferralRecord(record), author: { login: 'web-everything' } }] });
    const read = createRecordReferralRulingReader({ root, readJson, now: () => '2026-10-04T14:30:00Z', env: { CLAUDE_CODE_SESSION_ID: 's' } })
      ({ repo: 'o/r', pr: 9, card: 'xvm9vbu' });
    expect(read.open.map((o) => o.state)).toEqual(['blocked']);
    const plan = planOperatorRuling(read, { repo: 'o/r', pr: 9, finding: 'all-open', ruling: 'card', actor: 'chalbert', channel: 'test', reason: 'Accept' });
    expect(plan.record.rulings).toEqual([{ runId, key, result: 'card', card: 'we:backlog/5100-landed-follow-up.md' }]);
  });
});
