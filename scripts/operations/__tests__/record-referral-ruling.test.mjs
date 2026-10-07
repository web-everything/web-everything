/**
 * @file record-referral-ruling.test.mjs — #4979: the operator ruling path on mandatory referrals. Covers the gate
 *   (we:scripts/lib/jury-core.mjs#mandatoryReferralState), the sanctioned writer (record-referral-ruling + io),
 *   the acceptance entry point (we:scripts/review-set-label.mjs#assertMandatoryReferralsCleared) and the referral
 *   hold's wake-up (we:scripts/conveyor/review-referral-hold.mjs).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildOperatorRulingComment, mandatoryReferralReviewer, mandatoryReferralState, normalizeFinding,
  parseOperatorRulingComment, readOperatorRulings, referralFindingKey, renderReferralRecord, validateOperatorRuling,
  OPERATOR_RULING_MARKER,
} from '../../lib/jury-core.mjs';
import { assertMandatoryReferralsCleared, referralCardReadable } from '../../review-set-label.mjs';
import { decideReferralHold, reviewRunEvidence } from '../../conveyor/review-referral-hold.mjs';
import { newRunRecord } from '../run-store.mjs';
import { openReferralFindings, planOperatorRuling, selectFindings, planRulingFollowUp, recordReferralRulingOperation, OPERATOR_RULING_FOLLOW_UP_EFFECT, RULING_NEEDED_LABEL, OPERATOR_RULING_POST_EFFECT } from '../record-referral-ruling.mjs';
import { createRecordReferralRulingReader, createRecordReferralRulingSinks, resolveCardRef } from '../record-referral-ruling-io.mjs';

const repo = 'o/r';
const head = 'a'.repeat(40);
const newHead = 'b'.repeat(40);
const CARD = 'we:backlog/xvm9vbu-follow-up.md';
const gh = (body, login = 'web-everything', extra = {}) => ({ body, author: { login }, ...extra });
const finding = (summary) => ({ summary, file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' });

function referral({ runId = 'review-pr-1', h = head, summaries = ['protected list misses edits'], rulings = [] } = {}) {
  const seat = 'judgeCorrectnessAdvisory';
  const reviewer = mandatoryReferralReviewer(runId);
  const referrals = summaries.map((s) => ({ key: referralFindingKey(seat, finding(s)), seat, original: finding(s), finding: normalizeFinding(finding(s)) }));
  return { version: 1, repo, pr: 7, head: h, runId, reviewer, authorBody: '<!-- authored-by-actor: author -->',
    attempted: true, referrals, rulings: rulings.map((result, i) => ({ id: `${runId}:${i}`, key: referrals[i].key,
      reviewerId: reviewer.id, lens: 'correctness', result, rationale: 'checked', evidence: ['diff'],
      ...(result === 'card' ? { card: CARD } : {}) })) };
}
function ruling(rec, { result = 'card', key = rec.referrals[0].key, runId = rec.runId, h = rec.head, ...rest } = {}) {
  return { version: 1, repo, pr: 7, head: h, rulings: [{ runId, key, result, ...(result === 'card' ? { card: CARD } : {}) }],
    actor: 'chalbert', channel: 'claude-code-chat', reason: 'Accept', at: '2026-10-04T14:30:00Z', clearerId: 'session-1', ...rest };
}
const ctx = (over = {}) => ({ repo, pr: 7, head, body: '<!-- authored-by-actor: author -->', cardReadable: (c) => c === CARD, ...over });

describe('#4979 gate: operator rulings alongside reviewer rulings', () => {
  const blocked = referral({ rulings: ['block'] });
  const thread = (...extra) => [gh(renderReferralRecord(blocked)), ...extra];

  it('a reviewer block holds until the operator rules; an operator card on a readable card clears it', () => {
    expect(mandatoryReferralState(thread(), ctx()).blocked).toEqual([blocked.referrals[0].key]);
    const state = mandatoryReferralState(thread(gh(buildOperatorRulingComment(ruling(blocked)))), ctx());
    expect(state).toMatchObject({ pending: [], blocked: [] });
    expect(state.operatorRulings).toHaveLength(1);
  });
  it('card needs a readable card, both when written and at the gate', () => {
    expect(validateOperatorRuling({ ...ruling(blocked), rulings: [{ runId: blocked.runId, key: blocked.referrals[0].key, result: 'card' }] })).toBe(false);
    expect(validateOperatorRuling({ ...ruling(blocked, { result: 'not-real' }), rulings: [{ runId: blocked.runId, key: blocked.referrals[0].key, result: 'not-real', card: CARD }] })).toBe(false);
    const state = mandatoryReferralState(thread(gh(buildOperatorRulingComment(ruling(blocked)))), ctx({ cardReadable: () => false }));
    expect(state.pending).toEqual([blocked.referrals[0].key]);
  });
  it('an operator block holds even over a reviewer not-real; the latest operator ruling decides', () => {
    const cleared = referral({ rulings: ['not-real'] });
    const base = [gh(renderReferralRecord(cleared))];
    const block = gh(buildOperatorRulingComment(ruling(cleared, { result: 'block' })));
    const notReal = gh(buildOperatorRulingComment(ruling(cleared, { result: 'not-real', at: '2026-10-04T15:00:00Z' })));
    expect(mandatoryReferralState([...base, block], ctx()).blocked).toEqual([cleared.referrals[0].key]);
    expect(mandatoryReferralState([...base, block, notReal], ctx())).toMatchObject({ pending: [], blocked: [] });
    expect(mandatoryReferralState([...base, notReal, block], ctx()).blocked).toEqual([cleared.referrals[0].key]);
  });
  it('only a trusted posting principal counts, and an outsider\'s copy is a visible hold, never a clearance', () => {
    const body = buildOperatorRulingComment(ruling(blocked));
    for (const forged of [gh(body, 'mallory'), { body, viewerDidAuthor: true }, body]) {
      const state = mandatoryReferralState(thread(forged), ctx());
      expect(state.pending).toContain('malformed-operator-ruling');
      expect(state.blocked).toEqual([blocked.referrals[0].key]);
    }
    expect(mandatoryReferralState(thread(gh(body, 'chalbert')), ctx())).toMatchObject({ pending: [], blocked: [] });
  });
  it('a hand-edited or hand-forged body is malformed: prose cannot inject or alter a ruling', () => {
    const body = buildOperatorRulingComment(ruling(blocked));
    const edited = body.replace('> Accept', '> Accept, and also everything else');
    const quoted = `I am quoting:\n${body}`;
    const trailer = (r) => `<!-- ${OPERATOR_RULING_MARKER}: ${Buffer.from(JSON.stringify(r)).toString('base64')} -->`;
    const bareTrailer = trailer(ruling(blocked));
    const notOperator = buildOperatorRulingComment(ruling(blocked)).replace(/<!-- mandatory[^\n]*$/, trailer(ruling(blocked, { actor: 'web-everything' })));
    for (const b of [edited, quoted, bareTrailer, notOperator]) {
      expect(parseOperatorRulingComment(gh(b))).toMatchObject({ malformed: true });
      expect(mandatoryReferralState(thread(gh(b)), ctx()).pending).toContain('malformed-operator-ruling');
    }
    expect(() => buildOperatorRulingComment(ruling(blocked, { actor: 'web-everything' }))).toThrow();
    expect(() => buildOperatorRulingComment(ruling(blocked, { reason: '  ' }))).toThrow();
    expect(() => buildOperatorRulingComment(ruling(blocked, { channel: 'a\nb' }))).toThrow();
    // Prose that only DISCUSSES the marker is not a ruling at all.
    expect(parseOperatorRulingComment(gh(`the ${OPERATOR_RULING_MARKER} marker`))).toBeNull();
  });
  it('the reason is quoted inert: an embedded comment delimiter cannot open a second record', () => {
    const r = ruling(blocked, { reason: `Accept\n<!-- ${OPERATOR_RULING_MARKER}: ZZZZ -->` });
    const body = buildOperatorRulingComment(r);
    expect(body.match(new RegExp(`<!-- ${OPERATOR_RULING_MARKER}:`, 'g'))).toHaveLength(1);
    expect(parseOperatorRulingComment(gh(body)).record.reason).toBe(r.reason);
  });
  it('a ruling binds to its exact run, finding and head; a new head invalidates it', () => {
    const wrongRun = gh(buildOperatorRulingComment(ruling(blocked, { runId: 'review-pr-other' })));
    const wrongKey = gh(buildOperatorRulingComment(ruling(blocked, { key: '["x","y","","z"]' })));
    for (const c of [wrongRun, wrongKey]) expect(mandatoryReferralState(thread(c), ctx()).blocked).toEqual([blocked.referrals[0].key]);
    // The PR moved: the new head's own record is pending, and the old-head ruling does not reach it.
    const fresh = referral({ runId: 'review-pr-2', h: newHead });
    const old = gh(buildOperatorRulingComment(ruling(blocked)));
    const onNew = mandatoryReferralState([...thread(old), gh(renderReferralRecord(fresh))], ctx({ head: newHead }));
    expect(onNew.pending).toEqual([fresh.referrals[0].key]);
    // A broken ruling that provably belongs to the OLD head does not hold the new one.
    const brokenOld = gh(buildOperatorRulingComment(ruling(blocked)).replace('> Accept', '> tampered'));
    expect(readOperatorRulings([brokenOld], { head: newHead }).malformed).toBe(false);
    expect(readOperatorRulings([brokenOld], { head }).malformed).toBe(true);
  });
});

describe('#4979 the sanctioned writer', () => {
  const rec = referral({ summaries: ['first', 'second'], rulings: ['block'] });
  const comments = [gh(renderReferralRecord(rec))];
  const read = (over = {}) => ({ head, ...openReferralFindings({ comments, repo, pr: 7, head, body: rec.authorBody, cardReadable: (c) => c === CARD }),
    card: { requested: 'xvm9vbu', ref: CARD, readable: true }, now: '2026-10-04T14:30:00Z', clearerId: 's', ...over });
  const input = (over = {}) => ({ repo, pr: 7, finding: 'all-open', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'Accept', ...over });

  it('lists the open findings on the live head (blocked and pending), numbered in thread order', () => {
    expect(read().open.map((o) => [o.index, o.state, o.summary])).toEqual([[1, 'blocked', 'first'], [2, 'pending', 'second']]);
    expect(selectFindings(read().open, '2').map((o) => o.summary)).toEqual(['second']);
    expect(selectFindings(read().open, rec.referrals[0].key).map((o) => o.index)).toEqual([1]);
    expect(() => selectFindings(read().open, '3')).toThrow(/not an open finding/);
    expect(() => selectFindings([], 'all-open')).toThrow(/nothing to rule on/);
  });
  it('plans one record bound to PR, head, run and finding, carrying actor, channel, words and time', () => {
    const plan = planOperatorRuling(read(), input());
    expect(plan.record).toMatchObject({ repo, pr: 7, head, actor: 'chalbert', channel: 'claude-code-chat', reason: 'Accept',
      at: '2026-10-04T14:30:00Z', clearerId: 's' });
    expect(plan.record.rulings).toEqual(rec.referrals.map((f) => ({ runId: rec.runId, key: f.key, result: 'card', card: CARD })));
    expect(mandatoryReferralState([...comments, gh(plan.body)], ctx())).toMatchObject({ pending: [], blocked: [] });
  });
  it.each([
    ['a non-operator actor', {}, { actor: 'web-everything' }, /registered operator login/],
    ['no operator words', {}, { reason: ' ' }, /verbatim/],
    ['a multi-line channel', {}, { channel: 'a\nb' }, /one line/],
    ['card without a card', { card: null }, {}, /requires --card/],
    ['an unreadable card', { card: { requested: 'xnope00', ref: null, readable: false, reason: 'missing' } }, {}, /readable backlog card/],
    ['a card on not-real', {}, { ruling: 'not-real' }, /only to --ruling=card/],
    ['a malformed thread', { malformed: true }, {}, /malformed/],
  ])('refuses %s', (_, readOver, inputOver, message) => {
    expect(() => planOperatorRuling(read(readOver), input(inputOver))).toThrow(message);
  });

  it('the sink refuses a moved head, never double-posts, and proves the gate can read what it wrote', async () => {
    const plan = planOperatorRuling(read(), input());
    const payload = { repo, pr: 7, head, body: plan.body };
    let thread = { headRefOid: head, comments: [...comments] };
    const posts = [];
    const sinks = (login = 'web-everything') => createRecordReferralRulingSinks({
      readJson: () => structuredClone(thread),
      post: (_r, _p, body) => { posts.push(body); thread.comments.push(gh(body, login)); },
    })[OPERATOR_RULING_POST_EFFECT];
    await expect(sinks()(payload)).resolves.toMatchObject({ posted: true });
    await expect(sinks()(payload)).resolves.toMatchObject({ posted: false });
    expect(posts).toHaveLength(1);
    thread = { headRefOid: newHead, comments: [...comments] };
    await expect(sinks()(payload)).rejects.toThrow(/head moved/);
    thread = { headRefOid: head, comments: [...comments] };
    await expect(sinks('mallory')(payload)).rejects.toThrow(/not readable by the gate/);
  });

  it('resolves --card by number, provisional id, or a landed card\'s bornAs', () => {
    const root = mkdtempSync(join(tmpdir(), 'ruling-card-'));
    try {
      mkdirSync(join(root, 'backlog'));
      writeFileSync(join(root, 'backlog', '5100-landed.md'), '---\nbornAs: xvm9vbu\nstatus: open\n---\n# card\n');
      writeFileSync(join(root, 'backlog', 'xab12cd-provisional.md'), '---\nstatus: open\n---\n# card\n');
      expect(resolveCardRef('xvm9vbu', { root })).toMatchObject({ ref: 'we:backlog/5100-landed.md', readable: true });
      expect(resolveCardRef('5100', { root })).toMatchObject({ ref: 'we:backlog/5100-landed.md', readable: true });
      expect(resolveCardRef('xab12cd', { root })).toMatchObject({ ref: 'we:backlog/xab12cd-provisional.md', readable: true });
      expect(resolveCardRef('xzz99zz', { root })).toMatchObject({ readable: false });
      // A ruling that cited the provisional name keeps naming the card after JIT renumbering (#2288).
      expect(referralCardReadable('we:backlog/xvm9vbu-follow-up.md', root)).toBe(true);
      expect(referralCardReadable('we:backlog/xzz99zz-gone.md', root)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('#4979 acceptance and wake-up read the operator ruling', () => {
  const dirs = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('clear-human\'s referral assertion passes after an operator card ruling and refuses before it', () => {
    const rec = referral({ rulings: ['block'] });
    const state = { headRefOid: head, body: rec.authorBody, comments: [gh(renderReferralRecord(rec))] };
    const opts = { repo, pr: 7, cardReadable: (c) => c === CARD, readRuns: () => [] };
    expect(() => assertMandatoryReferralsCleared(state, opts)).toThrow(/mandatory referral hold/);
    state.comments.push(gh(buildOperatorRulingComment(ruling(rec))));
    expect(assertMandatoryReferralsCleared(state, opts)).toMatchObject({ pending: [], blocked: [] });
    expect(() => assertMandatoryReferralsCleared({ ...state, comments: [...state.comments, gh(state.comments[1].body, 'mallory')] }, opts)).toThrow(/malformed-operator-ruling/);
  });

  it('an operator ruling on the parked head wakes the paused review; one on another head does not', () => {
    const rec = referral({ summaries: ['broken case'] });
    const r = newRunRecord({ id: 'review-pr-parked', op: 'review-pr', input: { repo, pr: 7 } });
    const at = Date.parse('2026-10-04T08:00:00Z');
    r.findings = { read: { repo, pr: 7, netBasis: { rev: head } },
      mandatoryReferrals: { effects: [{ type: 'review.mandatory-referrals', result: { records: [rec] } }] },
      referralVerdict: { verdict: 'needs-human', pendingReferrals: [rec.referrals[0].key], referrals: rec.referrals } };
    r.stepTimings = [{ step: 'read', startedAt: new Date(at - 60_000).toISOString() }, { step: 'advise', finishedAt: new Date(at).toISOString() }];
    const runs = [reviewRunEvidence(r)];
    const pr = (comments) => ({ number: 7, headRefOid: head, comments });
    const later = new Date(at + 1000).toISOString();
    expect(decideReferralHold(pr([]), runs, { repo, now: at + 2000 })).not.toBeNull();
    const ok = gh(buildOperatorRulingComment(ruling(rec, { result: 'not-real' })), 'web-everything', { createdAt: later });
    expect(decideReferralHold(pr([ok]), runs, { repo, now: at + 2000 })).toBeNull();
    const other = gh(buildOperatorRulingComment(ruling(rec, { result: 'not-real', h: newHead })), 'web-everything', { createdAt: later });
    expect(decideReferralHold(pr([other]), runs, { repo, now: at + 2000 })).not.toBeNull();
  });
});


describe('operator finding selectors and follow-up', () => {
  const open = [
    { index: 1, runId: 'r', key: 'first-key', seat: 'correctness', file: 'src/x.ts', line: 55, summary: 'first', state: 'pending', rationale: '' },
    { index: 2, runId: 'r', key: 'second-key', seat: 'security', file: 'src/y.ts', line: null, summary: 'second', state: 'pending', rationale: '' },
  ];
  const input = (over = {}) => ({ repo, pr: 7, finding: 'all-open', ruling: 'block', actor: 'chalbert', channel: 'chat', reason: 'Fix it', ...over });
  const read = (over = {}) => ({ head, open, now: '2026-10-04T14:30:00Z', clearerId: 's', ...over });
  const follow = (over = {}) => planRulingFollowUp({ open, selected: open, ruling: 'block', reason: 'Fix it', enabled: true, head, ...over });

  it('selects file:line, a no-line file, and exact keys before file matching', () => {
    expect(selectFindings(open, 'src/x.ts:55')).toEqual([open[0]]);
    expect(selectFindings(open, 'src/y.ts')).toEqual([open[1]]);
    expect(selectFindings([...open, { ...open[1], file: 'first-key' }], 'first-key')).toEqual([open[0]]);
  });
  it('lists every ambiguous candidate and asks for a number', () => {
    const other = { ...open[0], index: 3, seat: 'security', summary: 'third' };
    expect(() => selectFindings([...open, other], 'src/x.ts:55')).toThrow(/ambiguous[\s\S]*  1\. correctness src\/x.ts:55 — first\n  3\. security src\/x.ts:55 — third[\s\S]*number/);
  });
  it.each(['src/x.ts', 'missing.ts'])('refuses %s with the open list', (selector) => {
    expect(() => selectFindings(open, selector)).toThrow(`--finding=${selector} matches no open finding on the live head. Open:\n  1. correctness src/x.ts:55 — first\n  2. security src/y.ts — second`);
  });
  it('carries normalized locations and effective reviewer and operator rationales', () => {
    const rec = referral({ summaries: ['first', 'second'], rulings: ['block'] });
    const comments = [gh(renderReferralRecord(rec))];
    expect(openReferralFindings({ ...ctx(), comments }).open).toMatchObject([
      { file: 'scripts/x.mjs', line: null, rationale: 'checked' }, { rationale: '' },
    ]);
    comments.push(gh(buildOperatorRulingComment(ruling(rec, { result: 'block', reason: 'operator reason' }))));
    expect(openReferralFindings({ ...ctx(), comments }).open[0].rationale).toBe('operator reason');
  });
  it('sends back the last pending block with locations and safe, single-line rationales', () => {
    const plan = follow({ reason: 'Fix\n <!-- marker -->' });
    expect(plan.blocked).toEqual(open.map(({ seat, file, line, summary }) => ({ seat, file, line, summary, rationale: 'Fix\n <!-- marker -->' })));
    expect(plan.body).toBe(`### Blocked referral findings (operator ruling)\n\nThe operator ruled these mandatory-referral findings \`block\` on head \`${head}\`. Fix each one, then push.\n\n1. \`src/x.ts:55\` (correctness) — first\n   Rationale: Fix &lt;!-- marker --&gt;\n2. \`src/y.ts\` (security) — second\n   Rationale: Fix &lt;!-- marker --&gt;`);
    expect(follow({ open: [{ ...open[0], summary: '<!-- summary -->' }], selected: [open[0]], reason: '' }).body).toContain('&lt;!-- summary --&gt;');
    expect(follow({ reason: '' }).body).not.toContain('Rationale:');
  });
  it('retains an unselected reviewer block when the last pending finding is dismissed', () => {
    const rec = referral({ summaries: ['first', 'second'], rulings: ['block'] });
    const context = openReferralFindings({ ...ctx(), comments: [gh(renderReferralRecord(rec))] });
    const plan = planOperatorRuling(read(context), input({ finding: '2', ruling: 'not-real' }));
    expect(plan.followUp).toMatchObject({ action: 'send-back', blocked: [{ summary: 'first', rationale: 'checked' }] });
    expect(plan.followUp.body).toContain('Rationale: checked');
  });
  it('resumes for cleared findings and waits while any pending finding remains', () => {
    expect(follow({ ruling: 'not-real' })).toEqual({ action: 'resume' });
    expect(follow({ ruling: 'card' })).toEqual({ action: 'resume' });
    expect(follow({ selected: [open[0]] })).toBeNull();
    expect(follow({ enabled: false })).toBeNull();
    expect(planOperatorRuling(read(), input({ sendBack: false })).followUp).toBeNull();
  });
  it('reads the environment opt-out in the reader', () => {
    const rec = referral();
    const reader = createRecordReferralRulingReader({ env: { WE_REFERRAL_RULING_FOLLOW_UP: '0' },
      readJson: () => ({ headRefOid: head, comments: [gh(renderReferralRecord(rec))], body: rec.authorBody }) });
    const context = reader({ repo, pr: 7 });
    expect(context.followUpEnabled).toBe(false);
    expect(planOperatorRuling(context, input()).followUp).toBeNull();
  });
  it('declares the follow-up after posting, but no follow-up while pending and no preview effects', () => {
    const op = recordReferralRulingOperation({ readRulingContext: () => read() });
    const write = op.steps.find((s) => s.name === 'write').step;
    const plan = op.steps.find((s) => s.name === 'plan').step;
    expect(plan.reads).toContain('input.sendBack');
    const verdict = planOperatorRuling(read(), input());
    const effects = write.effects({ verdict, input: {} });
    expect(effects.map((e) => e.type)).toEqual([OPERATOR_RULING_POST_EFFECT, OPERATOR_RULING_FOLLOW_UP_EFFECT]);
    expect(effects[1]).toMatchObject({ idempotent: true, payload: { repo, pr: 7, head, action: 'send-back', body: verdict.followUp.body, actor: 'chalbert', channel: 'chat' } });
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
    expect(write.effects({ verdict: planOperatorRuling(read(), input({ finding: '1' })), input: {} })).toHaveLength(1);
  });

  const payload = { repo, pr: 7, head, action: 'send-back', body: 'blocked body', actor: 'chalbert', channel: 'chat' };
  function sink({ labels = [RULING_NEEDED_LABEL], liveHead = head, result = '{"ok":true}', failure } = {}) {
    const calls = [];
    let bodyPath;
    const run = createRecordReferralRulingSinks({
      readPr: () => ({ headRefOid: liveHead, labels: labels.map((name) => ({ name })) }),
      runSetLabel: (exe, args, options) => {
        bodyPath = args.find((a) => a.startsWith('--body-file=')).slice('--body-file='.length);
        calls.push({ exe, args, options, body: readFileSync(bodyPath, 'utf8') });
        if (failure) throw failure;
        return result;
      },
      setLabels: (...args) => calls.push(args),
      appendEvents: () => {},
    })[OPERATOR_RULING_FOLLOW_UP_EFFECT];
    return { run, calls, path: () => bodyPath };
  }
  it('runs the send-back CLI then clears the advisory label and cleans its body file', async () => {
    const s = sink();
    await expect(s.run(payload)).resolves.toEqual({ action: 'send-back', sentBack: true, labelCleared: true });
    expect(s.calls[0]).toMatchObject({ exe: process.execPath, body: payload.body, options: { encoding: 'utf8', timeout: 120_000 } });
    expect(s.calls[0].args).toEqual([expect.stringMatching(/scripts\/review-set-label.mjs$/), '7', '--repo=o/r', '--to=changes', expect.stringMatching(/^--body-file=/), '--actor=chalbert', '--channel=chat']);
    expect(s.calls[1]).toEqual(['pr', 'edit', '7', '--repo', repo, '--remove-label', RULING_NEEDED_LABEL]);
    expect(existsSync(s.path())).toBe(false);
  });
  it('skips an already sent-back PR and resumes without changing review labels', async () => {
    for (const action of ['send-back', 'resume']) {
      const s = sink({ labels: ['review:changes', RULING_NEEDED_LABEL] });
      await expect(s.run({ ...payload, action })).resolves.toEqual({ action, sentBack: false, labelCleared: true });
      expect(s.calls).toHaveLength(1);
    }
    const s = sink({ labels: [] });
    await expect(s.run({ ...payload, action: 'resume' })).resolves.toMatchObject({ labelCleared: false });
    expect(s.calls).toEqual([]);
  });
  it('refuses a moved head without mutations', async () => {
    const s = sink({ liveHead: newHead });
    await expect(s.run(payload)).rejects.toThrow(/head moved/);
    expect(s.calls).toEqual([]);
  });
  it.each([{ result: '{"error":"send-back refused"}' }, { failure: new Error('send-back refused') }])('propagates send-back failures without clearing the label', async (options) => {
    const s = sink(options);
    await expect(s.run(payload)).rejects.toThrow('send-back refused');
    expect(s.calls).toHaveLength(1);
    expect(existsSync(s.path())).toBe(false);
  });
});
