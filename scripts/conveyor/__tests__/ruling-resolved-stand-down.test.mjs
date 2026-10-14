import { expect, it } from 'vitest';
import { buildStandDownComment } from '../stand-down.mjs';
import { buildOperatorAnswer, parseOperatorAnswer, latestUnresolvedStandDown } from '../stand-down-answer-core.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord } from '../../lib/jury-core.mjs';
import { planRulingResolvedStandDown, runRulingResolvesStandDownPass } from '../ruling-resolved-stand-down.mjs';
import { resolveReviewSettings, resolveReviewSettingSource } from '../../lib/review-settings.mjs';

const repo = 'o/r', head = 'a'.repeat(40);
const comment = (id, body, login = 'web-everything') => ({ id, body, author: { login }, createdAt: `2026-10-04T14:00:0${id}Z` });
function fixture({ second = false, file = 'scripts/y.mjs', actor = 'chalbert', reason = 'needs-judgment' } = {}) {
  const seat = 'judgeCorrectnessAdvisory', runId = 'review-pr-1';
  const findings = [{ file: 'scripts/x.mjs', summary: 'first', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' },
    ...(second ? [{ file, summary: 'second', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' }] : [])];
  const referrals = findings.map(f => ({ key: referralFindingKey(seat, f), seat, original: f, finding: normalizeFinding(f) }));
  const reviewer = mandatoryReferralReviewer(runId);
  const rec = { version: 1, repo, pr: 7, head, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->',
    attempted: true, referrals, rulings: referrals.map((f, i) => ({ id: `${runId}:${i}`, key: f.key,
      reviewerId: reviewer.id, lens: 'correctness', result: 'block', rationale: 'checked', evidence: ['diff'] })) };
  const record = { version: 1, repo, pr: 7, head, actor, channel: 'chat', reason: 'Not real',
    at: '2026-10-04T14:00:03Z', clearerId: 'session-1', rulings: [{ runId, key: referrals[0].key, result: actor === 'auto-policy' ? 'block' : 'not-real' }] };
  return { number: 7, headRefOid: head, labels: ['review:changes', 'review:human'], body: rec.authorBody,
    createdAt: '2026-10-04T13:00:00Z', comments: [comment(1, renderReferralRecord(rec)),
      comment(2, buildStandDownComment({ reason, detail: 'Please rule not-real.' })),
      comment(3, buildOperatorRulingComment(record), actor === 'auto-policy' ? 'web-everything' : actor)] };
}
it('resolves the stand-down, keeps the human gate and publishes a readable answer', () => {
  const pr = fixture(), plan = planRulingResolvedStandDown(pr, { repo });
  expect(plan).toMatchObject({ action: 'resolve', standDownId: 2, head, actor: 'chalbert' });
  expect(plan.removeLabels).toContain('review:changes');
  expect(plan.removeLabels).not.toContain('review:human');
  const answer = comment(4, plan.body);
  expect(parseOperatorAnswer(answer)).toMatchObject({ standDownId: '2', actor: 'chalbert' });
  expect(latestUnresolvedStandDown([...pr.comments, answer])).toBeNull();
  expect(planRulingResolvedStandDown({ ...pr, labels: ['review:human'] }, { repo })).toMatchObject({ removeLabels: [], addLabels: [] });
  const explicit = comment(4, buildOperatorAnswer({ standDownId: '2', actor: 'chalbert', channel: 'chat', reason: 'Answered' }));
  expect(planRulingResolvedStandDown({ ...pr, comments: [...pr.comments, explicit] }, { repo })).toBeNull();
});
it.each(['scripts/y.mjs', ''])('holds while the second finding at %s is blocked', (file) => {
  expect(planRulingResolvedStandDown(fixture({ second: true, file }), { repo })).toMatchObject({
    action: 'held', remaining: [{ file, summary: 'second', state: 'blocked' }],
  });
});
it('ignores auto-policy, other reasons, old rulings and old heads', () => {
  expect(planRulingResolvedStandDown(fixture({ actor: 'auto-policy' }), { repo })).toBeNull();
  expect(planRulingResolvedStandDown(fixture({ reason: 'conflict' }), { repo })).toBeNull();
  const pr = fixture();
  expect(planRulingResolvedStandDown({ ...pr, comments: [pr.comments[0], pr.comments[2], pr.comments[1]] }, { repo })).toBeNull();
  expect(planRulingResolvedStandDown({ ...pr, headRefOid: 'b'.repeat(40) }, { repo })).toBeNull();
});
it('off performs no reads; on writes labels before the answer and is idempotent', async () => {
  const pr = fixture(), calls = [];
  const deps = { repo, settingSource: 'file', listPrs: () => { calls.push('list'); return [pr]; },
    readPr: () => pr, editLabels: () => calls.push('labels'), postComment: (_n, body) => {
      calls.push('comment'); pr.comments.push(comment(4, body));
    }, log: () => {} };
  expect(await runRulingResolvesStandDownPass({ ...deps, setting: 'off' })).toMatchObject({ rows: [], setting: 'off' });
  expect(calls).toEqual([]);
  expect((await runRulingResolvesStandDownPass({ ...deps, setting: 'on' })).rows[0].action).toBe('resolve');
  expect(calls).toEqual(['list', 'labels', 'comment']);
  expect((await runRulingResolvesStandDownPass({ ...deps, setting: 'on' })).rows).toEqual([]);
});
it('skips a moved head and isolates per-PR errors', async () => {
  const pr = fixture(); let reads = 0;
  const result = await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr, { ...pr, number: 8 }],
    readPr: n => { if (n === 8) throw new Error('unreadable'); return ++reads === 1 ? pr : { ...pr, headRefOid: 'b'.repeat(40) }; },
    editLabels: () => { throw new Error('must not write'); }, postComment: () => { throw new Error('must not post'); }, log: () => {} });
  expect(result.rows).toMatchObject([{ action: 'head-moved' }, { pr: 8, action: 'error', why: 'unreadable' }]);
});
it('settings validate independently and expose cascade sources', () => {
  expect(resolveReviewSettings({ fileConfig: {}, env: {} })).toMatchObject({ rulingResolvesStandDown: 'on', standDownQueueSection: 'needs-you' });
  expect(resolveReviewSettings({ fileConfig: { rulingResolvesStandDown: 'off' }, env: { WE_REVIEW_STAND_DOWN_QUEUE_SECTION: 'stood-down' } }))
    .toMatchObject({ rulingResolvesStandDown: 'off', standDownQueueSection: 'stood-down' });
  expect(resolveReviewSettingSource('rulingResolvesStandDown', { fileRaw: {}, env: {} })).toBe('built-in');
  expect(resolveReviewSettingSource('rulingResolvesStandDown', { fileRaw: { rulingResolvesStandDown: 'off' }, env: {} })).toBe('file');
  expect(resolveReviewSettingSource('rulingResolvesStandDown', { fileRaw: {}, env: { WE_REVIEW_RULING_RESOLVES_STAND_DOWN: 'off' } })).toBe('env');
  expect(resolveReviewSettingSource('rulingResolvesStandDown', { fileRaw: {}, env: { WE_REVIEW_RULING_RESOLVES_STAND_DOWN: 'invalid' } })).toBe('built-in');
});
it('does not trust a forged ruling or answer an already resolved stand-down', () => {
  const pr = fixture();
  pr.comments[2].author.login = 'outsider';
  expect(planRulingResolvedStandDown(pr, { repo })).toBeNull();
  pr.comments[2].author.login = 'chalbert';
  pr.comments.push(comment(4, buildOperatorAnswer({ standDownId: '2', actor: 'chalbert', channel: 'chat', reason: 'Proceed' })));
  expect(planRulingResolvedStandDown(pr, { repo })).toBeNull();
});
it('retries after a failed answer post without repeating the label write', async () => {
  const pr = fixture(), writes = []; let fail = true;
  const deps = { repo, setting: 'on', settingSource: 'env', listPrs: () => [pr], readPr: () => pr,
    editLabels: (_n, plan) => {
      if (plan.removeLabels.length || plan.addLabels.length) writes.push('labels');
      pr.labels = pr.labels.filter(l => !plan.removeLabels.includes(l));
    },
    postComment: (_n, body) => {
      if (fail) { fail = false; throw new Error('post failed'); }
      writes.push('answer'); pr.comments.push(comment(4, body));
    }, log: () => {} };
  expect((await runRulingResolvesStandDownPass(deps)).rows[0]).toMatchObject({ action: 'error', standDownId: 2 });
  pr.labels.push('status:stood-down');
  expect((await runRulingResolvesStandDownPass(deps)).rows[0]).toMatchObject({ action: 'resolve', removeLabels: [] });
  expect(writes).toEqual(['labels', 'answer']);
});
