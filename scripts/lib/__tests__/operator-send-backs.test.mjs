import { describe, expect, it } from 'vitest';
import { operatorSendBacks, openOperatorSendBacks, renderOperatorSendBackBrief,
  renderOperatorSendBackReviewBlock, sendBackNotAddressed } from '../operator-send-backs.mjs';
import { withPlannedContext, planFixesFromReconcile, postRulingNotice } from '../../conveyor/reconcile-fix-dispatch.mjs';
import { planReconcile } from '../../conveyor/reconcile-core.mjs';
import { evaluatePr, evaluateCeremonyOwed } from '../../operations/operator-queue.mjs';
import { buildReviewJudgeRequest, advisoryLabelOutcome, shapeReadFinding } from '../../operations/review-pr.mjs';
import { buildRedTeamTask, redTeamReadFingerprint, replayPayload } from '../../operations/review-extra-seats.mjs';
import { defaultListPrComments } from '../../conveyor/pr-comments-list.mjs';

const OLD = 'e5ed9cb74' + 'a'.repeat(31), HEAD = '245c40542' + 'b'.repeat(31);
const MUST_FIX = 'MUST FIX: preserve the operator’s original requested repair.';
const comment = (id, login, at, body) => ({ id, author: { login }, createdAt: `2026-10-14T${at}:00Z`,
  url: `https://github.com/web-everything/web-everything/pull/5243#issuecomment-${id}`, body });
const original = comment('1001', 'chalbert', '20:07', `🔁 review — changes requested\n\nRecorded by chalbert via claude-code-chat.\n\nOperator send-back (human review ceremony), 2026-10-14 ~16:20 ET, at head e5ed9cb74.\n\n${MUST_FIX}\n<!-- private metadata -->`);
const mechanical = comment('1002', 'web-everything', '21:06', '🔁 review — changes requested\n\nRecorded by parked-pr-conflict-watch via automation.\n\nResolve the merge conflict.');
const ended = comment('1003', 'web-everything', '21:35', '🔓 conveyor fix-end\nConflict fixed; re-arm review.');
const advisory = comment('1004', 'web-everything', '22:00', `**Verdict:** accept\n**Advisory outcome:** accept\nNet basis: \`${OLD}..${HEAD}\``);
const fixture = (over = {}) => ({ number: 5243, state: 'OPEN', headRefName: 'lane/341-send-back', headRefOid: HEAD,
  labels: [{ name: 'review:human' }, { name: 'advisory:accepted' }], mergeable: 'MERGEABLE',
  statusCheckRollup: [], comments: [original, mechanical, ended, advisory], ...over });
const evidence = (head = HEAD, text = '<!-- addresses-operator-send-back: 1001 -->', login = 'web-everything') =>
  comment('1005', login, '23:00', `## Fix evidence\nHead: \`${head}\`\n${text}\nFixed and verified.`);

describe('operator send-backs, PR #5243 replay', () => {
  it('keeps the operator request across a newer mechanical bounce, fix-end and advisory accept', () => {
    const pr = fixture();
    expect(operatorSendBacks(pr.comments)).toEqual([expect.objectContaining({ id: '1001', login: 'chalbert',
      at: '2026-10-14T20:07:00.000Z', head: 'e5ed9cb74', etLabel: '~16:20 ET', index: 0 })]);
    const open = openOperatorSendBacks(pr);
    expect(open.map(x => x.id)).toEqual(['1001']);
    expect(open[0].body).toContain(MUST_FIX);
    expect(open[0].body).not.toContain('private metadata');
    expect(sendBackNotAddressed(pr)).toEqual({ head: HEAD, items: open });
    const brief = renderOperatorSendBackBrief(open);
    expect(brief).toContain(MUST_FIX);
    expect(brief).toContain(original.url);
    expect(brief).toContain('<!-- addresses-operator-send-back: 1001 -->');
    expect(brief).toContain('DATA');
    expect(renderOperatorSendBackReviewBlock(open)).toContain('must NOT accept');
  });
  it.each(['<!-- addresses-operator-send-back: 1001 -->', '1001', original.url,
    '2026-10-14T20:07:00.000Z', 'send-back of ~16:20 ET'])('resolves only explicitly named later-head evidence: %s', text => {
    expect(openOperatorSendBacks(fixture({ comments: [original, evidence(HEAD, text)] }))).toEqual([]);
  });
  it('does not resolve same-head evidence even when the PR has since moved', () => {
    expect(openOperatorSendBacks(fixture({ comments: [original, evidence(OLD)] }))).toHaveLength(1);
    expect(openOperatorSendBacks(fixture({ comments: [original, evidence('e5ed9cb74')] }))).toHaveLength(1);
  });
  it('requires trusted fix evidence, later in the thread, and an explicit reference', () => {
    for (const c of [evidence(HEAD, 'fixed everything'), evidence(HEAD, '16:20 ET'),
      evidence(HEAD, '1001', 'stranger'), { ...evidence(), body: 'Accepted 1001' },
      { ...evidence(), body: `⛔ conveyor — ruling not addressed\n\nQuoted DATA: ${evidence().body}` }]) {
      expect(openOperatorSendBacks(fixture({ comments: [original, c] }))).toHaveLength(1);
    }
    expect(openOperatorSendBacks(fixture({ comments: [evidence(), original] }))).toHaveLength(1);
    expect(openOperatorSendBacks(fixture({ labels: [{ name: 'review:accepted' }] }))).toHaveLength(1);
  });
  it('uses the current head only when evidence omits Head', () => {
    const c = { ...evidence(), body: '## Fix evidence\n<!-- addresses-operator-send-back: 1001 -->' };
    expect(openOperatorSendBacks(fixture({ comments: [original, c] }))).toEqual([]);
    expect(openOperatorSendBacks(fixture({ headRefOid: OLD, comments: [original, c] }))).toHaveLength(1);
  });
  it('accepts marker-only evidence and stays unresolved when the send-back head is unknown', () => {
    const c = { ...evidence(), body: `Head: \`${HEAD}\`\n<!-- addresses-operator-send-back: 1001 -->` };
    expect(openOperatorSendBacks(fixture({ comments: [original, c] }))).toEqual([]);
    const noHead = { ...original, body: original.body.replace('at head e5ed9cb74', 'head unknown') };
    expect(operatorSendBacks([noHead])[0].head).toBeNull();
    expect(openOperatorSendBacks(fixture({ comments: [noHead, c] }))).toHaveLength(1);
    expect(sendBackNotAddressed(fixture({ comments: [original, c] }))).toBeNull();
  });
  it('bounds bodies and matches ids and ET times without substring collisions', () => {
    expect(operatorSendBacks([{ ...original, body: original.body + 'x'.repeat(5000) }])[0].body.length).toBeLessThanOrEqual(4000);
    expect(openOperatorSendBacks(fixture({ comments: [original, evidence(HEAD, 'send-back 116:20 ET; id 10012')] }))).toHaveLength(1);
    expect(renderOperatorSendBackBrief([])).toBe('');
    expect(renderOperatorSendBackReviewBlock([])).toBe('');
  });
  it('carries resolution backwards from a later send-back naming 16:20 ET', () => {
    const later = comment('1006', 'chalbert', '23:41', `🔁 review — changes requested\n\nRecorded by chalbert via console.\n\nOperator send-back ~19:45 ET, at head 245c40542. The 16:20 ET send-back was never addressed.`);
    const pr = fixture({ headRefOid: 'c'.repeat(40), comments: [original, mechanical, ended, advisory, later] });
    expect(openOperatorSendBacks(pr).map(x => x.id)).toEqual(['1001', '1006']);
    pr.comments.push(comment('1007', 'web-everything', '23:59', '## Fix evidence\nHead: `ccccccccccc`\n<!-- addresses-operator-send-back: 1006 -->'));
    expect(openOperatorSendBacks(pr)).toEqual([]);
  });
  it('never counts mechanical Recorded-by lines even under an operator credential', () => {
    expect(operatorSendBacks([{ ...mechanical, author: { login: 'chalbert' } },
      { ...original, author: { login: 'stranger' } }])).toEqual([]);
  });
  it('waits for a fixer chance; accepts a trusted later fix-end even without a head change', () => {
    expect(sendBackNotAddressed(fixture({ headRefOid: OLD, comments: [original] }))).toBeNull();
    expect(sendBackNotAddressed(fixture({ headRefOid: OLD, comments: [original, { ...ended, author: { login: 'stranger' } }] }))).toBeNull();
    expect(sendBackNotAddressed(fixture({ headRefOid: OLD, comments: [original, ended] }))).not.toBeNull();
  });
});

describe('send-back wiring', () => {
  it('preserves comment URLs through the complete paginated reader', () => {
    const esc = s => s.replaceAll('\\', '\\\\').replaceAll('\n', '\\n');
    const [read] = defaultListPrComments({ number: 5243, repo: 'web-everything/web-everything', exec: (_file, args) => {
      expect(args.at(-1)).toContain('.html_url');
      return [original.body, original.createdAt, 'chalbert', original.id, original.url].map(esc).join('\t');
    } });
    expect(operatorSendBacks([read])[0].url).toBe(original.url);
  });
  it('projects open requests into the review read and replay inputs', () => {
    const raw = { state: 'OPEN', comments: fixture().comments, detail: { pr: 5243, repo: 'we', title: 'Repair', labels: [] },
      net: { paths: ['docs/example.md'], base: OLD, rev: HEAD, scored: true }, diff: { text: '+repair', scored: true } };
    expect(shapeReadFinding(raw).openOperatorSendBacks.map(x => x.id)).toEqual(['1001']);
    expect(replayPayload({ view: fixture(), diffText: '+repair' }).findings.read.openOperatorSendBacks.map(x => x.id)).toEqual(['1001']);
  });
  it.each([false, true])('carries the brief through reconcile and fix planning, including conflict=%s', conflict => {
    const pr = fixture({ labels: conflict ? [{ name: 'review:changes' }, { name: 'merge-status:conflicting' }] : fixture().labels });
    const plan = planReconcile({ prs: [pr], agents: [], now: Date.parse('2026-10-15T00:00Z'), requiredChecks: [] });
    const row = plan.dispatch.find(x => x.kind === 'fix');
    expect(row).toBeDefined();
    const { planned } = planFixesFromReconcile([row], () => ({ num: '341', scope: ['we:scripts/lib/operator-send-backs.mjs'] }), () => [], () => [], 'we', () => ['scripts/lib/operator-send-backs.mjs']);
    expect(withPlannedContext('BASE', planned[0])).toContain(MUST_FIX);
    expect(withPlannedContext('BASE', planned[0])).toContain('<!-- addresses-operator-send-back: 1001 -->');
    if (!conflict) {
      const calls = [];
      expect(postRulingNotice({ repo: 'we', pr: 5243, ruling: row.rulingNotAddressed, exec: (...args) => calls.push(args) })).toBe(true);
      expect(calls[0][1].at(-1)).toContain('⛔ conveyor — ruling not addressed');
      expect(calls[0][1].at(-1)).toContain(MUST_FIX);
      expect(postRulingNotice({ repo: 'we', pr: 5243, ruling: row.rulingNotAddressed,
        exec: () => { throw new Error('resume fallback must not repeat the notice'); } })).toBe(false);
      const noticed = comment('1008', 'web-everything', '23:59', calls[0][1].at(-1));
      expect(openOperatorSendBacks({ ...pr, comments: [...pr.comments, noticed] })).toHaveLength(1);
      const again = planReconcile({ prs: [{ ...pr, comments: [...pr.comments, noticed] }], agents: [], requiredChecks: [] });
      expect(postRulingNotice({ repo: 'we', pr: 5243, ruling: again.dispatch.find(x => x.kind === 'fix')?.rulingNotAddressed, exec: () => { throw new Error('duplicate notice'); } })).toBe(false);
    }
  });
  it('withholds NEEDS YOU and advisory acceptance while an operator request remains open', () => {
    expect(evaluatePr(fixture())).toMatchObject({ ready: false,
      reasons: expect.arrayContaining([expect.stringContaining('operator send-back of 2026-10-14T20:07')]) });
    expect(evaluateCeremonyOwed(fixture({ labels: [{ name: 'review:accepted' }] })).owed).toBe(false);
    expect(advisoryLabelOutcome({ read: { netBasis: { rev: HEAD }, openOperatorSendBacks: openOperatorSendBacks(fixture()) },
      verdict: { verdict: 'accept', lensVerdicts: { correctness: 'accept', security: 'accept' } } })).toBe('changes');
  });
  it('briefs both advisory reviewers and the post-accept red team', () => {
    const open = openOperatorSendBacks(fixture());
    const read = { pr: 5243, repo: 'we', title: 'Repair', body: '', netChangedFiles: [], diffText: 'diff',
      netBasis: { rev: HEAD }, openOperatorSendBacks: open };
    const review = buildReviewJudgeRequest({ read, lens: 'correctness' });
    expect(review.mandate + review.input).toContain(MUST_FIX);
    expect(review.mandate + review.input).toContain('must NOT accept');
    expect(buildRedTeamTask({ pr: 5243, repo: 'we', openOperatorSendBacks: open })).toContain(MUST_FIX);
    expect(redTeamReadFingerprint(read)).not.toBe(redTeamReadFingerprint({ ...read, openOperatorSendBacks: [] }));
  });
});
