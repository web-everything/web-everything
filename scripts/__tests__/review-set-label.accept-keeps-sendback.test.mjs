import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { decideSetLabel, runReviewLabelCli, buildVerdictComment, REVIEW_LABEL_TARGETS } from '../review-set-label.mjs';
import { gateOutcomesForHead, sendBackStepOutcome, gateRoundGrants, GATE_OUTCOMES, redTeamGateMarker, liveResultGateState, redTeamBreaksAgree, readRedTeamDisposition } from '../lib/red-team-gate.mjs';
import { buildVerdictCarriedMarker } from '../lib/review-verdict-carried-marker.mjs';
import { renderRedTeamComment } from '../operations/review-extra-seats.mjs';
import { buildRoundExtensionComment } from '../conveyor/round-extension-mark.mjs';
import { OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { normalizeFinding, referralFindingKey, mandatoryReferralReviewer, renderReferralRecord } from '../lib/jury-core.mjs';
import { PR_COMMENTS_PAGE_SIZE } from '../lib/review-label-provider.mjs';
import { sealedStatusPath } from '../lib/red-team-sealed-status.mjs';

const PR = 7031;
const HEAD = 'a'.repeat(40);
const NEW_HEAD = 'b'.repeat(40);
const record = (outcome = GATE_OUTCOMES.SENT_BACK, rev = HEAD, login = 'web-everything') => ({
  author: { login }, body: redTeamGateMarker(PR, rev, outcome),
});
const sentBack = (comments, head = HEAD) => sendBackStepOutcome(gateOutcomesForHead(comments, PR, head)) === GATE_OUTCOMES.SENT_BACK;
const apply = (labels, decision) => [...new Set([...labels.filter(l => !decision.removeLabels.includes(l)), decision.addLabel])];

function accept({ labels = ['review:changes'], comments = withResult([record()]), head = HEAD, readComments, freshComments = comments, freshHead = head, freshThrows = false, postCommentState = {}, readGrantScope = () => null } = {}) {
  let liveLabels = [...labels];
  const posted = [];
  const output = [];
  const signalFix = vi.fn();
  const appendLedgerVerdict = vi.fn(() => ({ ok: true }));
  const setLabels = vi.fn((_repo, _pr, { add, remove }) => { liveLabels = apply(liveLabels, { addLabel: add, removeLabels: remove }); });
  let reads = 0;
  let afterPost = {};
  const provider = {
    readPrState: () => {
      if (reads++ && freshThrows) throw new Error('fresh state unavailable');
      return { state: 'OPEN', headRefOid: reads > 1 ? freshHead : head, labels: liveLabels, comments: reads > 1 ? freshComments : comments, body: '', ...afterPost };
    },
    readComments: readComments ?? (() => comments),
    readLabels: () => liveLabels,
    setLabels,
    postComment: (_repo, _pr, body) => { posted.push(body); afterPost = postCommentState; },
  };
  const stopped = new Error('CLI exit');
  let exitCode;
  const exit = vi.spyOn(process, 'exit').mockImplementation(code => { exitCode = code; throw stopped; });
  try { runReviewLabelCli({
    argv: [String(PR), '--repo=o/n', '--to=accepted'], defaultActor: 'test', usage: 'test', provider,
    buildComment: o => buildVerdictComment(o), successResult: o => ({ ok: true, ...o }),
    refusalResult: o => ({ ok: false, ...o }), emit: line => output.push(JSON.parse(line)),
    appendLedgerVerdict, signalFix, readGrantScope,
    fileApprovalPrevention: vi.fn(), findFiledApprovalPrevention: () => null,
  }); } catch (error) { if (error !== stopped) throw error; } finally { exit.mockRestore(); }
  return { labels: liveLabels, posted, result: output.at(-1), signalFix, exitCode, setLabels, appendLedgerVerdict };
}

function expectRefused(result, labels = ['review:changes']) {
  expect(result.exitCode).toBe(1);
  expect(result.labels).toEqual(labels);
  expect(result.posted).toEqual([]);
  expect(result.setLabels).not.toHaveBeenCalled();
  expect(result.appendLedgerVerdict).not.toHaveBeenCalled();
  expect(result.signalFix).not.toHaveBeenCalled();
  expect(result.result.decision?.reason ?? result.result.error).toMatch(/send.back|unreadable|head changed|malformed|unavailable/i);
}

function operatorReleaseThread({ count = 1, releaseLine, summary = 'confirmed break' } = {}) {
  const result = { author: { login: 'web-everything' }, body: renderRedTeamComment({
    pr: PR, rev: HEAD, provider: 'codex', model: 'gpt-6.1-sol', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: Array.from({ length: count }, (_, i) => ({ summary: `${summary} ${i + 1}`, category: 'edge-case', impactIfUnfixed: 'broken',
      file: 'scripts/review-set-label.mjs', line: 1521 + i, confirmedByRecheck: true })),
  }) };
  const resultId = liveResultGateState([result], PR, HEAD).resultId;
  expect(resultId).toBeTruthy();
  const indices = Array.from({ length: count }, (_, i) => `#${i + 1}`).join(', ');
  return [result,
    { author: { login: 'web-everything' }, body: `${redTeamGateMarker(PR, HEAD, 'sent-back', resultId)}\n- ${count} confirmed break(s) sent back to the fixer (${indices}).` },
    { author: { login: OPERATOR_LOGINS[0] }, body: `${redTeamGateMarker(PR, HEAD, 'operator-card', resultId)}\n${releaseLine ?? `- ${count} finding(s) carded by the operator to \`we:backlog/x1b8hlo-follow-up.md@pr7031\` (${indices}).`}` },
  ];
}

function withResult(comments) {
  return [operatorReleaseThread()[0], ...comments];
}

describe('accept refuses a red-team send-back without writes', () => {
  describe.each([
    ['legacy', false, false],
    ['bound', true, true],
    ['legacy send-back and bound cap', false, true],
    ['bound send-back and legacy cap', true, false],
  ])('%s result grouping', (_binding, bindSendBack, bindCap) => {
    function gatesFor(first, second) {
      const sendBack = bindSendBack ? first[1] : record();
      const cap = bindCap
        ? { ...second[1], body: second[1].body.replace('outcome=sent-back', 'outcome=round-cap') }
        : record(GATE_OUTCOMES.ROUND_CAP);
      return { sendBack, cap };
    }

    it.each(['initial', 'fresh', 'post-comment', 'paginated'])('a later result cap supersedes the earlier send-back on the %s read', stage => {
      const first = operatorReleaseThread({ summary: 'first confirmed break' });
      const second = operatorReleaseThread({ summary: 'second confirmed break' });
      const { sendBack, cap } = gatesFor(first, second);
      const comments = [first[0], sendBack, second[0], cap];
      const page = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ body: `ordinary ${i}` }));
      const result = accept(stage === 'initial' ? { comments }
        : stage === 'fresh' ? { comments: [], freshComments: comments }
          : stage === 'post-comment' ? { comments: [], postCommentState: { comments } }
            : { comments: page, readComments: () => [...page, ...comments] });
      expect(result.exitCode).toBe(0);
      expect(result.labels).toEqual(['review:accepted']);
    });

    it('still lets a cap supersede a send-back for the same result', () => {
      const first = operatorReleaseThread();
      const { sendBack, cap } = gatesFor(first, first);
      const result = accept({ comments: [first[0], sendBack, cap] });
      expect(result.exitCode).toBe(0);
      expect(result.labels).toEqual(['review:accepted']);
    });

    it('honors a delayed release of the older send-back after the newer capped result is released', () => {
      const first = operatorReleaseThread({ summary: 'first confirmed break' });
      const second = operatorReleaseThread({ summary: 'second confirmed break' });
      const { sendBack, cap } = gatesFor(first, second);
      const result = accept({ comments: [first[0], sendBack, second[0], cap, second[2], first[2]] });
      expect(result.exitCode).toBe(0);
      expect(result.labels).toEqual(['review:accepted']);
    });
  });

  it('an orphan legacy send-back does not override the live result cap', () => {
    const [result] = operatorReleaseThread();
    expect(accept({ comments: [record(), result, record(GATE_OUTCOMES.ROUND_CAP)] }).exitCode).toBe(0);
  });

  it.each(['initial', 'fresh', 'post-comment', 'paginated'])('accepts independently released same-head results on the %s read', stage => {
    const first = operatorReleaseThread({ summary: 'first break' });
    const second = operatorReleaseThread({ summary: 'second break' });
    expect(accept({ comments: first }).exitCode).toBe(0);
    expect(accept({ comments: second }).exitCode).toBe(0);
    const comments = [...first, ...second];
    const page = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ body: `ordinary ${i}` }));
    const accepted = accept(stage === 'initial' ? { comments }
      : stage === 'fresh' ? { comments: [], freshComments: comments }
        : stage === 'post-comment' ? { comments: [], postCommentState: { comments } }
          : { comments: page, readComments: () => [...page, ...comments] });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.labels).toEqual(['review:accepted']);
    expect(accepted.setLabels).toHaveBeenCalledTimes(1);
  });

  it.each(['bound', 'legacy'])('accepts delayed releases for both results with %s send-backs', binding => {
    const first = operatorReleaseThread({ summary: 'first break' });
    const second = operatorReleaseThread({ summary: 'second break' });
    if (binding === 'legacy') {
      first[1].body = first[1].body.replace(/ result=[a-f0-9]{16}/, '');
      second[1].body = second[1].body.replace(/ result=[a-f0-9]{16}/, '');
    }
    const accepted = accept({ comments: [...first.slice(0, 2), ...second, first[2]] });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.labels).toEqual(['review:accepted']);
  });

  it('accepts a released live result despite an unreleased older result', () => {
    const first = operatorReleaseThread({ summary: 'first break' });
    const second = operatorReleaseThread({ summary: 'second break' });
    expect(accept({ comments: [...first.slice(0, 2), ...second] }).exitCode).toBe(0);
  });

  it('refuses an unreleased live result despite a released older result', () => {
    const first = operatorReleaseThread({ summary: 'first break' });
    const second = operatorReleaseThread({ summary: 'second break' });
    expectRefused(accept({ comments: [...first, ...second.slice(0, 2)] }));
  });

  it.each(['matching', 'conflicting', 'unreadable'])('keeps the %s head seal separate from released send-back findings', seal => {
    const first = operatorReleaseThread({ summary: 'first break' });
    const second = operatorReleaseThread({ summary: 'second break' });
    const comments = [...first, ...second];
    const root = mkdtempSync(join(tmpdir(), 'accept-sendback-history-seal-'));
    vi.stubEnv('WE_SHARED_RUNS_DIR', join(root, 'runs'));
    try {
      const path = sealedStatusPath({ repo: 'o/n', pr: PR, head: HEAD });
      mkdirSync(dirname(path), { recursive: true });
      const sealedBreaks = redTeamBreaksAgree({ comments: seal === 'matching' ? second : first, pr: PR, head: HEAD, breaks: [] }).keys;
      expect(sealedBreaks).toHaveLength(1);
      writeFileSync(path, seal === 'unreadable' ? '{unreadable' : JSON.stringify({ repo: 'o/n', pr: PR, head: HEAD, sealedBreaks }));
      const disposition = readRedTeamDisposition({ comments, pr: PR, head: HEAD, repo: 'o/n' });
      expect(disposition.outcome).toBe(GATE_OUTCOMES.SENT_BACK);
      expect(disposition.sendBack).toHaveLength(0);
      expect(disposition.held).toHaveLength(seal === 'matching' ? 0 : 1);
      const accepted = accept({ comments });
      expect(accepted.exitCode).toBe(0);
      expect(accepted.labels).toEqual(['review:accepted']);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['initial', 'fresh', 'post-comment', 'paginated'])('accepts after an authorized operator cards the same-head sent-back finding on the %s read', stage => {
    const comments = operatorReleaseThread();
    expectRefused(accept({ comments: comments.slice(0, 2) }));
    const page = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ body: `ordinary ${i}` }));
    const accepted = accept(stage === 'initial' ? { comments }
      : stage === 'fresh' ? { comments: [], freshComments: comments }
        : stage === 'post-comment' ? { comments: [], postCommentState: { comments } }
          : { comments: page, readComments: () => [...page, ...comments] });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.labels).toEqual(['review:accepted']);
    expect(accepted.setLabels).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['operator card', undefined],
    ['follow-up card', '- 1 finding(s) filed as a follow-up card (#1) — landing job j.'],
    ['advisory/not-real', '- 1 finding(s) left advisory (#1).'],
  ])('honors the shared reader release spelling: %s', (_name, releaseLine) => {
    const accepted = accept({ comments: operatorReleaseThread({ releaseLine }) });
    expect(accepted.exitCode).toBe(0);
    expect(accepted.labels).toEqual(['review:accepted']);
  });

  it('releases all findings only when each one is covered', () => {
    const comments = operatorReleaseThread({ count: 2 });
    expect(accept({ comments }).exitCode).toBe(0);
    comments[2].body = comments[2].body.replace('(#1, #2)', '(#1)');
    expectRefused(accept({ comments }));
  });

  it.each(['mallory', 'web-everything', 'web-everything[bot]'])('rejects an operator-card authored by %s', login => {
    const comments = operatorReleaseThread();
    comments[2].author.login = login;
    expectRefused(accept({ comments }));
  });

  it.each([
    ['PR', body => body.replace(`pr=${PR}`, 'pr=7210')],
    ['head', body => body.replace(HEAD, NEW_HEAD)],
    ['result', body => body.replace(/result=[a-f0-9]{16}/, 'result=1111111111111111')],
    ['missing result', body => body.replace(/ result=[a-f0-9]{16}/, '')],
    ['finding', body => body.replace('(#1)', '(#2)')],
  ])('rejects a ruling with a different or missing %s binding', (_name, change) => {
    const comments = operatorReleaseThread();
    comments[2].body = change(comments[2].body);
    expectRefused(accept({ comments }));
  });

  it('honors the anyState=false kill switch for operator releases over send-backs', () => {
    vi.stubEnv('WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE', 'false');
    try { expectRefused(accept({ comments: operatorReleaseThread() })); }
    finally { vi.unstubAllEnvs(); }
  });

  it('does not let an operator card override an operator block', () => {
    const [result, sendBack, ruling] = operatorReleaseThread();
    const block = { author: { login: OPERATOR_LOGINS[0] }, body: sendBack.body.replace('outcome=sent-back', 'outcome=operator-block') };
    expectRefused(accept({ comments: [result, sendBack, block, ruling] }));
  });

  it('does not let a ruling before the send-back or result release a later hold', () => {
    const [result, sendBack, ruling] = operatorReleaseThread();
    expectRefused(accept({ comments: [result, ruling, sendBack] }));
    expectRefused(accept({ comments: [ruling, result, sendBack] }));
  });

  it('honors an operator release for a legacy send-back bound to its preceding result', () => {
    const comments = operatorReleaseThread();
    comments[1].body = comments[1].body.replace(/ result=[a-f0-9]{16}/, '');
    expect(accept({ comments }).exitCode).toBe(0);
  });

  it('ignores orphan and other-result send-backs after a live release', () => {
    const comments = operatorReleaseThread();
    expect(accept({ comments: [record(), ...comments] }).exitCode).toBe(0);
    const other = { ...comments[1], body: comments[1].body.replace(/result=[a-f0-9]{16}/, 'result=1111111111111111') };
    expect(accept({ comments: [...comments, other] }).exitCode).toBe(0);
  });

  it('ignores markers without a result but refuses unreadable grant evidence', () => {
    const [, sendBack, ruling] = operatorReleaseThread();
    expect(accept({ comments: [sendBack, ruling] }).exitCode).toBe(0);
    expectRefused(accept({ comments: operatorReleaseThread(), readGrantScope: () => { throw new Error('grant evidence unreadable'); } }));
  });

  it('keeps unreadable sealed evidence held after an operator releases the send-back', () => {
    const root = mkdtempSync(join(tmpdir(), 'accept-sendback-seal-'));
    vi.stubEnv('WE_SHARED_RUNS_DIR', join(root, 'runs'));
    try {
      const path = sealedStatusPath({ repo: 'o/n', pr: PR, head: HEAD });
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '{unreadable');
      const comments = operatorReleaseThread();
      const disposition = readRedTeamDisposition({ comments, pr: PR, head: HEAD, repo: 'o/n' });
      expect(disposition.outcome).toBe(GATE_OUTCOMES.SENT_BACK);
      expect(disposition.sendBack).toHaveLength(0);
      expect(disposition.held).toHaveLength(1);
      expect(accept({ comments }).exitCode).toBe(0);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('enumerates every acceptance target: accepted refuses; clear-human and restamp are explicit hardening exemptions (x6nxokb)', () => {
    const contexts = [
      { currentLabels: ['review:pending'] },
      { currentLabels: ['review:human'] },
      { currentLabels: ['review:accepted'] },
      { currentLabels: ['review:held-mechanical'], humanCarry: { action: 'carry', human: true, reason: 'operator clearance' } },
    ];
    const policies = {
      accepted: 'refused',
      // Existing operator ceremony and carry-forward policy; broadening the guard
      // to these targets is the explicitly deferred x6nxokb hardening work.
      'clear-human': 'operator ceremony exemption',
      restamp: 'existing acceptance / operator carry exemption',
    };
    const acceptanceTargets = REVIEW_LABEL_TARGETS.filter(to => contexts.some(context =>
      decideSetLabel({ to, ...context, reason: 'test verdict' }).addLabel === 'review:accepted'));
    expect(acceptanceTargets.sort()).toEqual(Object.keys(policies).sort());
    acceptanceTargets.forEach(to => contexts.forEach(context => {
      const base = decideSetLabel({ to, ...context, reason: 'test verdict' });
      if (!base.allowed || base.addLabel !== 'review:accepted') return;
      const guarded = decideSetLabel({ to, ...context, reason: 'test verdict', sentBackSameHead: true });
      if (policies[to] === 'refused') {
        expect(guarded).toMatchObject({ allowed: false, addLabel: '', removeLabels: [] });
        expect(guarded.reason).toMatch(/send.back/i);
      } else {
        expect(guarded).toEqual(base);
      }
    }));
  });

  // Planned post-merge live test (the CLI runs from deployed daemon clones):
  // create a trusted same-head sent-back record with review:changes, attempt
  // re-accept, and observe refusal plus preserved review:changes. Then observe
  // the real fix daemon dispatching a fix for this repo/PR/head, with a durable
  // claim/session id and ET timestamps after the refusal. No pickup means failure.
  it.todo('same-head re-accept preserves changes and triggers fix-daemon pickup');

  it('pure decision refuses from pending too, while rearm remains unaffected', () => {
    expect(decideSetLabel({ to: 'accepted', currentLabels: ['review:pending'], sentBackSameHead: true })).toMatchObject({ allowed: false, addLabel: '', removeLabels: [] });
    expect(decideSetLabel({ to: 'rearm', currentLabels: ['review:changes'], sentBackSameHead: true }).addLabel).toBe('review:pending');
  });

  it('pure decision refuses same-head sent-back changes without a label mutation', () => {
    const decision = decideSetLabel({ to: 'accepted', currentLabels: ['review:changes', 'review:pending'], sentBackSameHead: true });
    expect(decision).toMatchObject({ allowed: false, addLabel: '', removeLabels: [] });
    expect(decision.reason).toMatch(/send.back/i);
  });

  it('CLI refusal leaves every label untouched and writes no comment, ledger row or stamp', () => {
    const labels = ['review:changes', 'review:pending', 'review:accepted', 'ready-to-merge', 'redteam:accepted', 'advisory:accepted'];
    expectRefused(accept({ labels }), labels);
  });

  it.each([['review:pending'], []])('refuses a same-head send-back even with labels %j', (...labels) => {
    expectRefused(accept({ labels }), labels);
  });

  it('accept on a newer head is unaffected: exact rev equality is required', () => {
    expect(sentBack([record()], NEW_HEAD)).toBe(false);
    const result = accept({ head: NEW_HEAD });
    expect(result.labels).toContain('review:accepted');
    expect(result.labels).not.toContain('review:changes');
    expect(result.result.to).toBe('accepted');
  });

  it.each([[GATE_OUTCOMES.ROUND_CAP], [GATE_OUTCOMES.SENT_BACK, GATE_OUTCOMES.ROUND_CAP]])('round-cap is not a send-back (%j)', (...outcomes) => {
    const comments = withResult(outcomes.map(outcome => record(outcome)));
    expect(sentBack(comments)).toBe(false);
    expect(accept({ comments }).labels).toEqual(['review:accepted']);
  });

  it('an untrusted author cannot hold acceptance with a forged gate record', () => {
    const comments = withResult([record(GATE_OUTCOMES.SENT_BACK, HEAD, 'mallory')]);
    expect(sentBack(comments)).toBe(false);
    expect(accept({ comments }).labels).toEqual(['review:accepted']);
  });

  it('replays #7031: changes, rearm to pending, red-team send-back, same-head re-accept still owes a fix', () => {
    const rearmed = apply(['review:changes'], decideSetLabel({ to: 'rearm', currentLabels: ['review:changes'] }));
    expect(rearmed).toEqual(['review:pending']);
    const sentBackLabels = apply(rearmed, decideSetLabel({ to: 'changes', currentLabels: rearmed, reason: 'confirmed red-team break' }));
    expectRefused(accept({ labels: sentBackLabels }));
  });

  it('unreadable embedded comment thread keeps changes, never accepts', () => {
    const result = accept({ comments: null });
    expect(result.labels).toEqual(['review:changes']);
    expect(result.posted).toEqual([]);
    expect(result.exitCode).toBe(1);
  });

  it.each(['throws', 'unreadable', 'incomplete'])('no fail-open catch: complete gate-record read %s keeps changes', mode => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ id: i, body: 'ordinary comment' }));
    const readComments = () => { if (mode === 'throws') throw new Error('thread unavailable'); return mode === 'unreadable' ? null : []; };
    expectRefused(accept({ comments, readComments }));
  });

  it('reads the full thread so a send-back beyond the embedded page still holds', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({ author: { login: 'web-everything' }, body: `ordinary comment ${i}` }));
    const thread = [...comments.map(c => ({ ...c, author: { login: 'web-everything[bot]' } })), ...withResult([record()])];
    const readGrantScope = vi.fn(() => null);
    expectRefused(accept({ comments, readComments: () => thread, readGrantScope }));
    expect(readGrantScope).toHaveBeenCalledWith({ repo: 'o/n', pr: { number: PR, headRefOid: HEAD, comments: thread } });
  });

  describe.each(['initial', 'fresh'])('%s embedded page completeness', stage => {
    it.each([
      ['author', 'web-everything[bot]'],
      ['user', 'WEB-EVERYTHING[BoT]'],
      ['author', 'WEB-EVERYTHING'],
    ])('accepts a complete thread with REST %s login %s and no send-back', (field, login) => {
      const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({
        author: { login: 'web-everything' }, body: `ordinary comment ${i}`,
      }));
      const thread = comments.map(c => ({ body: c.body, [field]: { login } }));
      const result = accept({ comments: stage === 'initial' ? comments : [], freshComments: comments, readComments: () => thread });
      expect(result.exitCode).toBe(0);
      expect(result.labels).toEqual(['review:accepted']);
      expect(result.setLabels).toHaveBeenCalledTimes(1);
    });

    it.each(['body', 'author'])('still refuses a full-length thread with a missing %s match', mismatch => {
      const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({
        author: { login: 'web-everything' }, body: `ordinary comment ${i}`,
      }));
      const thread = comments.map(c => ({ ...c, author: { login: 'web-everything[bot]' } }));
      thread[0] = mismatch === 'body' ? { ...thread[0], body: 'different comment' } : { ...thread[0], author: { login: 'mallory' } };
      expectRefused(accept({ comments: stage === 'initial' ? comments : [], freshComments: comments, readComments: () => thread }));
    });
  });

  it('accepts a complete normalized thread on the post-comment re-read', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, (_, i) => ({
      author: { login: 'web-everything' }, body: `ordinary comment ${i}`,
    }));
    const thread = comments.map(c => ({ body: c.body, user: { login: 'Web-Everything[bot]' } }));
    const result = accept({ comments: [], postCommentState: { comments }, readComments: () => thread });
    expect(result.exitCode).toBe(0);
    expect(result.labels).toEqual(['review:accepted']);
    expect(result.posted).toHaveLength(1);
    expect(result.setLabels).toHaveBeenCalledTimes(1);
  });

  it('a superseded cap plus a grant and later send-back still refuses', () => {
    const grant = { author: { login: OPERATOR_LOGINS[0] }, body: buildRoundExtensionComment({
      repo: 'o/n', pr: PR, by: 1, actor: OPERATOR_LOGINS[0], channel: 'test', reason: 'one more fix', at: '2026-11-20T00:00:00Z',
    }) };
    const comments = withResult([record(GATE_OUTCOMES.ROUND_CAP), grant, record()]);
    const readGrantScope = vi.fn(() => null);
    expectRefused(accept({ comments, readGrantScope }));
    expect(readGrantScope).toHaveBeenCalledWith({ repo: 'o/n', pr: { number: PR, headRefOid: HEAD, comments } });
  });

  it('a stale cap posted after the granted send-back cannot override its snapshot', () => {
    const grant = { author: { login: OPERATOR_LOGINS[0] }, body: buildRoundExtensionComment({
      repo: 'o/n', pr: PR, by: 1, actor: OPERATOR_LOGINS[0], channel: 'test', reason: 'one more fix', at: '2026-11-20T00:00:00Z',
    }) };
    const [result] = operatorReleaseThread();
    const resultId = liveResultGateState([result], PR, HEAD).resultId;
    const grantIds = gateRoundGrants([grant], PR, 'o/n').map(g => g.id);
    expect(grantIds).toHaveLength(1);
    const comments = [result, grant,
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.SENT_BACK, resultId, grantIds) },
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.ROUND_CAP, resultId, []) },
    ];
    expectRefused(accept({ comments }));
  });

  it('a cap for a different result cannot override a send-back', () => {
    const [result, sendBack] = operatorReleaseThread();
    const comments = [result,
      { author: { login: 'web-everything' }, body: redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.ROUND_CAP, '1'.repeat(16)) },
      sendBack,
    ];
    expectRefused(accept({ comments }));
  });

  it('a send-back appearing in the fresh pre-write thread refuses before ledger, comment and labels', () => {
    expectRefused(accept({ comments: [], freshComments: withResult([record()]) }));
  });

  it('re-reads a full fresh thread and refuses a send-back arriving past its embedded page', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => ({ body: 'ordinary' }));
    let reads = 0;
    expectRefused(accept({ comments, readComments: () => reads++ ? [...comments, ...withResult([record()])] : comments }));
    expect(reads).toBe(2);
  });

  it.each([[null], [{}], [{ body: 1 }], ['ordinary comment']])('malformed short embedded thread entry %j refuses', entry => {
    expectRefused(accept({ comments: [entry] }));
  });

  it.each([null, [{}], [{ body: 1 }]])('malformed fresh evidence %j refuses', freshComments => {
    expectRefused(accept({ comments: [], freshComments }));
  });

  it('a malformed entry in the paginated thread refuses', () => {
    const comments = Array.from({ length: PR_COMMENTS_PAGE_SIZE }, () => ({ body: 'ordinary' }));
    expectRefused(accept({ comments, readComments: () => [...comments, null] }));
  });

  it('refuses the acceptance label when the head changes during postComment', () => {
    const result = accept({ comments: [], postCommentState: { headRefOid: NEW_HEAD } });
    expect(result.exitCode).toBe(1);
    expect(result.result.error).toMatch(/head changed before acceptance/i);
    expect(result.posted).toHaveLength(1);
    expect(result.appendLedgerVerdict).toHaveBeenCalledTimes(1);
    expect(result.setLabels).not.toHaveBeenCalled();
    expect(result.labels).toEqual(['review:changes']);
    expect(result.signalFix).not.toHaveBeenCalled();
  });

  it('refuses the acceptance label when a mandatory referral arrives during postComment', () => {
    const original = { summary: 'broken', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
    const referral = { version: 1, repo: 'o/n', pr: PR, head: HEAD, runId: 'run-late-referral',
      reviewer: mandatoryReferralReviewer('run-late-referral'), authorBody: '<!-- authored-by-actor: author -->', attempted: true,
      referrals: [{ key: referralFindingKey('judgeAdvisory', original), seat: 'judgeAdvisory', original, finding: normalizeFinding(original) }], rulings: [] };
    const comments = [{ author: { login: 'web-everything' }, body: renderReferralRecord(referral) }];
    const result = accept({ comments: [], postCommentState: { comments } });
    expect(result.exitCode).toBe(1);
    expect(result.result.error).toMatch(/mandatory referral hold/i);
    expect(result.posted).toHaveLength(1);
    expect(result.appendLedgerVerdict).toHaveBeenCalledTimes(1);
    expect(result.setLabels).not.toHaveBeenCalled();
    expect(result.labels).toEqual(['review:changes']);
    expect(result.signalFix).not.toHaveBeenCalled();
  });

  it('refuses the acceptance label when a send-back arrives during postComment', () => {
    const result = accept({ comments: [], postCommentState: { comments: withResult([record()]) } });
    expect(result.exitCode).toBe(1);
    expect(result.result.error).toMatch(/same-head red-team send-back/i);
    expect(result.posted).toHaveLength(1);
    expect(result.appendLedgerVerdict).toHaveBeenCalledTimes(1);
    expect(result.setLabels).not.toHaveBeenCalled();
    expect(result.labels).toEqual(['review:changes']);
    expect(result.signalFix).not.toHaveBeenCalled();
  });

  it('a bad initial head refuses acceptance', () => {
    expectRefused(accept({ comments: [], head: 'bad-head' }));
  });

  it('a bad fresh head refuses acceptance', () => {
    expectRefused(accept({ comments: [], freshHead: 'bad-head' }));
  });

  it('a thrown fresh state read refuses acceptance', () => {
    expectRefused(accept({ comments: [], freshThrows: true }));
  });

  // Judge R10 regressions: the guard is the shared reader, so these follow its answers.
  it('(a) a carry comment with card-queued then sent-back for the same result is refused', () => {
    const [result] = operatorReleaseThread();
    const resultId = liveResultGateState([result], PR, HEAD).resultId;
    const carry = { author: { login: 'web-everything' }, body: [
      redTeamGateMarker(PR, HEAD, 'card-queued', resultId),
      redTeamGateMarker(PR, HEAD, GATE_OUTCOMES.SENT_BACK, resultId),
      buildVerdictCarriedMarker({ fromSha: NEW_HEAD, toSha: HEAD, patchId: 'c'.repeat(40) }),
      'Review verdict carried across an identical contribution.',
      result.body,
    ].join('\n') };
    const comments = [carry];
    // The old first-marker reader misses the send-back in this carry.
    expect(sentBack(comments)).toBe(false);
    const disposition = readRedTeamDisposition({ comments, pr: PR, head: HEAD, repo: 'o/n' });
    expect(disposition.outcome).toBe(GATE_OUTCOMES.SENT_BACK);
    expect(disposition.sendBack).toHaveLength(1);
    expectRefused(accept({ comments }));
  });

  it('(b) a same-head send-back followed by a valid operator-card release is allowed', () => {
    const accepted = accept({ comments: operatorReleaseThread() });
    expect(accepted.exitCode).toBe(0);
  });

  it('(c) two results each sent back and then released are allowed', () => {
    const comments = [...operatorReleaseThread({ summary: 'first break' }), ...operatorReleaseThread({ summary: 'second break' })];
    const ids = comments.filter(c => liveResultGateState([c], PR, HEAD).resultId).map(c => liveResultGateState([c], PR, HEAD).resultId);
    expect(new Set(ids).size).toBe(2);
    expect(accept({ comments }).exitCode).toBe(0);
  });

  it('(d) an unbound send-back for result A then an unbound cap for result B follows the shared reader (cap, no refusal)', () => {
    // B supersedes A; the cap holds merge through `held`.
    const [resultA] = operatorReleaseThread({ summary: 'result a' });
    const [resultB] = operatorReleaseThread({ summary: 'result b' });
    const comments = [resultA, record(GATE_OUTCOMES.SENT_BACK), resultB, record(GATE_OUTCOMES.ROUND_CAP)];
    expect(accept({ comments }).exitCode).toBe(0);
  });
});
