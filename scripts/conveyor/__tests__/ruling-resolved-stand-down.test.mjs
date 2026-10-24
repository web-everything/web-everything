import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildStandDownComment, standDownFindingRefs, standDownHead, standDownTrailerReason } from '../stand-down.mjs';
import { buildOperatorAnswer, parseOperatorAnswer, latestUnresolvedStandDown } from '../stand-down-answer-core.mjs';
import { buildOperatorRulingComment, mandatoryReferralReviewer, normalizeFinding, referralFindingKey, renderReferralRecord, readReferralRecords, parseOperatorRulingComment } from '../../lib/jury-core.mjs';
import { planRulingResolvedStandDown, runRulingResolvesStandDownPass } from '../ruling-resolved-stand-down.mjs';
import { resolveReviewSettings, resolveReviewSettingSource } from '../../lib/review-settings.mjs';

const repo = 'o/r', head = 'a'.repeat(40);
it('the fixer brief binds its needs-judgment stand-down to explicit finding refs', () => {
  const brief = readFileSync('skills-src/conveyor/fix-agent-brief.md', 'utf8').replace(/\\\r?\n/g, '');
  const commands = brief.match(/node[^\n]*stand-down\.mjs[^\n]*--reason=needs-judgment[^\n]*/g);
  expect(commands).not.toBeNull();
  for (const command of commands) expect(command).toContain('--finding-refs=');
});
const comment = (id, body, login = 'web-everything') => ({ id, body, author: { login }, createdAt: `2026-10-04T14:00:0${id}Z` });
function fixture({ second = false, file = 'scripts/y.mjs', actor = 'chalbert', reason = 'needs-judgment', bound = true } = {}) {
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
  return { number: 7, headRefOid: head, labels: ['review:changes', 'review:human'], labelEvents: [], body: rec.authorBody,
    createdAt: '2026-10-04T13:00:00Z', comments: [comment(1, renderReferralRecord(rec)),
      comment(2, buildStandDownComment({ reason, detail: 'Please rule not-real.',
        findingRefs: bound && reason === 'needs-judgment' ? [{ runId, key: referrals[0].key }] : undefined })),
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
it('off performs no reads; on posts the answer before labels and is idempotent', async () => {
  const pr = fixture(), calls = [];
  const deps = { repo, settingSource: 'file', listPrs: () => { calls.push('list'); return [pr]; },
    readPr: () => pr, editLabels: (_n, plan) => {
      calls.push('labels'); pr.labels = pr.labels.filter(l => !plan.removeLabels.includes(l));
    }, postComment: (_n, body) => {
      calls.push('comment'); pr.comments.push(comment(4, body));
    }, log: () => {} };
  expect(await runRulingResolvesStandDownPass({ ...deps, setting: 'off' })).toMatchObject({ rows: [], setting: 'off' });
  expect(calls).toEqual([]);
  expect((await runRulingResolvesStandDownPass({ ...deps, setting: 'on' })).rows[0].action).toBe('resolve');
  expect(calls).toEqual(['list', 'comment', 'labels']);
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
it('retries after a failed answer post without a stood-down status label', async () => {
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
  expect(pr.labels).toContain('review:changes');
  expect((await runRulingResolvesStandDownPass(deps)).rows[0]).toMatchObject({ action: 'resolve', removeLabels: ['review:changes'] });
  expect(writes).toEqual(['answer', 'labels']);
});

it('a ruling does not resolve a non-finding needs-judgment question', () => {
  const pr = fixture({ bound: false });
  pr.comments[1].body = buildStandDownComment({ reason: 'needs-judgment', detail: 'Which conflicting instruction should I follow?' });
  expect(planRulingResolvedStandDown(pr, { repo })).toBeNull();
});
it.each(['needs-judgment', 'conflict'])('does not silently supersede an older unanswered %s hold', (reason) => {
  const pr = fixture();
  pr.comments.unshift(comment(0, buildStandDownComment({ reason, detail: 'An older unrelated question' })));
  expect(planRulingResolvedStandDown(pr, { repo })).toBeNull();
});
it('requires later rulings for every named finding in the same review run', () => {
  const pr = fixture();
  for (const refs of [
    [{ runId: 'other-review-run', key: referralFindingKey('judgeCorrectnessAdvisory', { file: 'scripts/x.mjs', summary: 'first' }) }],
    [{ runId: 'review-pr-1', key: 'unrelated-finding' }],
    [{ runId: 'review-pr-1', key: referralFindingKey('judgeCorrectnessAdvisory', { file: 'scripts/x.mjs', summary: 'first' }) },
      { runId: 'review-pr-1', key: 'unrelated-finding' }],
  ]) {
    pr.comments[1].body = buildStandDownComment({ reason: 'needs-judgment', findingRefs: refs });
    expect(planRulingResolvedStandDown(pr, { repo })).toBeNull();
  }
});
it('resolves only after separate later rulings cover every waited finding', () => {
  const pr = fixture({ second: true });
  const record = readReferralRecords(pr.comments).records[0];
  pr.comments[1].body = buildStandDownComment({ reason: 'needs-judgment', head: head.slice(0, 7),
    findingRefs: record.referrals.map(f => ({ runId: record.runId, key: f.key })) });
  expect(planRulingResolvedStandDown(pr, { repo })).toBeNull();
  const ruling = parseOperatorRulingComment(pr.comments[2]).record;
  pr.comments.push(comment(4, buildOperatorRulingComment({ ...ruling, at: '2026-10-04T14:00:04Z',
    rulings: [{ runId: record.runId, key: record.referrals[1].key, result: 'not-real' }] }), 'chalbert'));
  expect(planRulingResolvedStandDown(pr, { repo })).toMatchObject({ action: 'resolve', standDownId: 2 });
});
it.each(['blocked', 'new-review', 'malformed', 'answered', 'new-question'])('holds when %s arrives between reads on the same head', async (state) => {
  const pr = fixture(), writes = []; let reads = 0;
  let fresh = fixture({ second: true });
  if (state === 'new-review') {
    fresh = fixture();
    const record = readReferralRecords(fresh.comments).records[0];
    const runId = 'review-pr-2', reviewer = mandatoryReferralReviewer(runId);
    fresh.comments.push(comment(4, renderReferralRecord({ ...record, runId, reviewer,
      rulings: record.rulings.map((r, i) => ({ ...r, id: `${runId}:${i}`, reviewerId: reviewer.id })) })));
  } else if (state === 'malformed') {
    fresh = fixture(); fresh.comments.push(comment(4, '<!-- mandatory-referrals-v1: not-json -->'));
  } else if (state === 'answered') {
    fresh = fixture(); fresh.comments.push(comment(4, buildOperatorAnswer({ standDownId: '2', actor: 'chalbert', channel: 'chat', reason: 'Handled by hand' })));
  } else if (state === 'new-question') {
    fresh = fixture(); fresh.comments.push(comment(4, buildStandDownComment({ reason: 'needs-judgment', detail: 'Choose a design' })));
  }
  await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr],
    readPr: () => ++reads === 1 ? pr : fresh, editLabels: () => writes.push('labels'),
    postComment: () => writes.push('comment'), log: () => {} });
  expect(writes).toEqual([]);
});
it('retries failed labels after posting an answer without posting it twice', async () => {
  const pr = fixture(), writes = []; let fail = true;
  const deps = { repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: (_n, body) => { writes.push('answer'); pr.comments.push(comment(4, body)); },
    editLabels: (_n, plan) => {
      if (fail) { fail = false; throw new Error('labels failed'); }
      writes.push('labels'); pr.labels = pr.labels.filter(l => !plan.removeLabels.includes(l));
    }, log: () => {} };
  expect((await runRulingResolvesStandDownPass(deps)).rows[0].action).toBe('error');
  expect((await runRulingResolvesStandDownPass(deps)).rows[0].action).toBe('resolve');
  expect(writes).toEqual(['answer', 'labels']);
  expect(pr.labels).toEqual(['review:human']);
});
it('finding subjects round-trip without changing head/reason readers or trusting detail text', () => {
  const refs = [{ runId: 'review-pr-1', key: '\n\r\u2028`"--../é\u200b<!-- quoted -->' }];
  const body = buildStandDownComment({ reason: 'needs-judgment', head, findingRefs: refs });
  expect(standDownFindingRefs(body)).toEqual(refs);
  expect(standDownHead(body)).toBe(head);
  expect(standDownTrailerReason(body)).toBe('needs-judgment');
  expect(standDownFindingRefs(buildStandDownComment({ reason: 'needs-judgment', detail: body }))).toBeNull();
  expect(standDownFindingRefs(body.replace(/findings=\S+/, 'findings=not-json'))).toBeNull();
  expect(() => buildStandDownComment({ reason: 'conflict', findingRefs: refs })).toThrow();
  expect(() => buildStandDownComment({ reason: 'needs-judgment', findingRefs: [] })).toThrow();
});
it('does not use a prior relay to remove labels after a newer review', async () => {
  const pr = fixture();
  pr.comments.push(comment(4, planRulingResolvedStandDown(pr, { repo }).body));
  pr.comments.push(comment(5, 'A new review requests changes on this head.'));
  const writes = [];
  await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: () => writes.push('answer'), editLabels: () => writes.push('labels'), log: () => {} });
  expect(writes).toEqual([]);
});
it('does not use a prior relay after review:changes was re-added without a comment', async () => {
  const pr = fixture();
  pr.comments.push(comment(4, planRulingResolvedStandDown(pr, { repo }).body));
  pr.labelEvents = [{ event: 'labeled', label: { name: 'review:changes' }, created_at: '2026-10-04T14:00:05Z' }];
  const writes = [];
  await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: () => writes.push('answer'), editLabels: () => writes.push('labels'), log: () => {} });
  expect(writes).toEqual([]);
});
it.each(['missing', 'malformed', 'same-second', 'later-unlabel'])('fails closed on %s label history during recovery', async (state) => {
  const pr = fixture();
  pr.comments.push(comment(4, planRulingResolvedStandDown(pr, { repo }).body));
  if (state === 'missing') delete pr.labelEvents;
  else pr.labelEvents = [{ event: state === 'later-unlabel' ? 'unlabeled' : 'labeled', label: { name: 'review:changes' },
    created_at: state === 'malformed' ? 'unknown' : `2026-10-04T14:00:0${state === 'same-second' ? 4 : 5}Z` }];
  const writes = [];
  await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: () => writes.push('answer'), editLabels: () => writes.push('labels'), log: () => {} });
  expect(writes).toEqual([]);
});
it('recovers failed labels when their complete history predates the answer', async () => {
  const pr = fixture();
  pr.comments.push(comment(4, planRulingResolvedStandDown(pr, { repo }).body));
  pr.labelEvents = [{ event: 'labeled', label: { name: 'review:changes' }, created_at: '2026-10-04T14:00:01Z' }];
  const writes = [];
  await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: () => writes.push('answer'), editLabels: () => writes.push('labels'), log: () => {} });
  expect(writes).toEqual(['labels']);
});
it.each(['new-review', 'relabel'])('holds when %s arrives during the answer post', async (state) => {
  const pr = fixture(), writes = [];
  const result = await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: (_n, body) => {
      pr.comments.push(comment(4, body));
      if (state === 'new-review') pr.comments.push(comment(5, 'New review requests changes.'));
      else pr.labelEvents.push({ event: 'labeled', label: { name: 'review:changes' }, created_at: '2026-10-04T14:00:03Z' });
    }, editLabels: () => writes.push('labels'), log: () => {} });
  expect(writes).toEqual([]);
  expect(result.rows).toMatchObject([{ action: 'state-changed' }]);
});
it('holds when the head moves during the answer post', async () => {
  const pr = fixture(), writes = [];
  const result = await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], readPr: () => pr,
    postComment: (_n, body) => { pr.comments.push(comment(4, body)); pr.headRefOid = 'b'.repeat(40); },
    editLabels: () => writes.push('labels'), log: () => {} });
  expect(writes).toEqual([]);
  expect(result.rows).toMatchObject([{ action: 'head-moved' }]);
});
it.each(['paged-relabel', 'unreadable', 'malformed-pages', 'post-head-moved'])('the production reader fails closed for %s', async (state) => {
  const pr = fixture(), calls = [];
  if (state !== 'post-head-moved') pr.comments.push(comment(4, planRulingResolvedStandDown(pr, { repo }).body));
  const escape = s => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  const exec = (_file, args, options) => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'graphql') {
      return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: pr.comments.length } } } } });
    }
    if (args.includes(`repos/${repo}/issues/7/comments`)) return pr.comments.map(c =>
      [c.body, c.createdAt, c.author.login, String(c.id)].map(escape).join('\t')).join('\n');
    if (args.includes(`repos/${repo}/issues/7/events?per_page=100`)) {
      expect(args).toContain('--paginate'); expect(args).toContain('--slurp');
      if (state === 'unreadable') throw new Error('events unavailable');
      if (state === 'malformed-pages') return '{}';
      return JSON.stringify(state === 'paged-relabel'
        ? [[], [{ event: 'labeled', label: { name: 'review:changes' }, created_at: '2026-10-04T14:00:05Z' }]] : [[]]);
    }
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr);
    if (args[0] === 'pr' && args[1] === 'comment') {
      pr.comments.push(comment(4, options.input)); pr.headRefOid = 'b'.repeat(40); return '';
    }
    throw new Error(`Unexpected write: ${args.join(' ')}`);
  };
  const result = await runRulingResolvesStandDownPass({ repo, setting: 'on', listPrs: () => [pr], exec, log: () => {} });
  expect(calls.some(args => args[1] === 'edit')).toBe(false);
  if (state === 'post-head-moved') expect(result.rows).toMatchObject([{ action: 'head-moved' }]);
  if (state === 'unreadable' || state === 'malformed-pages') expect(result.rows).toMatchObject([{ action: 'error' }]);
});
