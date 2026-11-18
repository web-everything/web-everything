/** Cap-only shared-reader subset: human card records, author/wrapper and head/result binding. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../../operations/review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, FINDING_FINGERPRINT_FIELDS, findingFingerprint, operatorRulingsOnLiveResult, resolveOperatorRulings, readOperatorRulings, gateRoundGrants, liveResultGateState, parseRedTeamComment, readRedTeamDisposition, redTeamGateMarker } from '../red-team-gate.mjs';
import { redTeamEnqueueHold } from '../drain-queue-safety.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { buildVerdictCarriedMarker } from '../review-verdict-carried-marker.mjs';
import { planRedTeamStatusLabels } from '../red-team-status-labels.mjs';
import { buildReviewedShaMarker, buildClearedHumanMarker } from '../review-escalation.mjs';
import { applyRedTeamGate } from '../../operations/red-team-gate-apply.mjs';

const H = '61782334289124cd4fcb51d0bdadb6ef3c795e82';
const P = 5502;
const CARD = 'we:backlog/xvi6k7s-per-pr-delivery-postmortem-on-merge-incident-coroner-trigger.md@pr5502';
const bot = (body, created_at) => ({ user: { login: 'web-everything', type: 'Bot' }, created_at, body }); // the automation login the test env trusts
const human = (body, created_at) => ({ user: { login: 'chalbert', type: 'User' }, created_at, body });
const F = (line, impact) => ({ summary: `break at ${line}`, category: 'edge-case', impactIfUnfixed: impact, file: 'scripts/operations/coroner-pr-postmortem.mjs', line, confirmedByRecheck: true });
const result = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'gpt-6.1-sol', recheckStatus: 'ok', foldedVerdict: 'changes',
  findings: [F(159, 'broken'), F(127, 'degraded'), F(166, 'degraded')] }), '2026-10-21T17:07:55Z');
const rid = liveResultGateState([result], P, H).resultId;
const gate = (who, outcome, line, at, id = rid, head = H) => who(`${redTeamGateMarker(P, head, outcome, id)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`) on head \`${head.slice(0, 12)}\`:\n${line}`, at);
const live = [result, gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T17:12:20Z')];
const cardLine = (ix) => `- ${ix.length} finding(s) carded by the operator to \`${CARD}\` (${ix.map((i) => `#${i}`).join(', ')}).`;
const operatorReleaseLines = [
  ['existing card', cardLine([1])],
  ['automatic card', '- 1 finding(s) filed as a follow-up card (#1) — landing job j.'],
  ['advisory', '- 1 finding(s) left advisory (#1).'],
];
const disp = (comments, head = H) => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS,
  operatorRulings: { anyState: false } });
const held = (d) => [...d.held, ...d.sendBack].map((f) => f.index);
const N = 'a'.repeat(40);
const carried = bot([
  redTeamGateMarker(P, N, 'round-cap', rid),
  buildVerdictCarriedMarker({ fromSha: H, toSha: N, patchId: 'b'.repeat(40) }),
  'Review verdict carried across an identical contribution.',
  result.body.replace(H, N),
].join('\n'), '2026-10-21T21:00:00Z');

describe('clear-human held-only compatibility', () => {
  it.each([false, true])('a standing send-back survives a live clear-human ceremony (anyState=%s)', anyState => {
    const repo = 'o/r';
    const at = '2026-10-21T18:00:00Z';
    const grant = human(buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert',
      channel: 'chat', reason: 'one more round', at }), at);
    const grants = gateRoundGrants([grant], P, repo).map(g => g.id);
    expect(grants).toHaveLength(1);
    const comments = [...live, grant,
      bot(`${redTeamGateMarker(P, H, 'sent-back', rid, grants)}\n- 1 confirmed break(s) sent back to the fixer (#1).`, '2026-10-21T19:00:00Z'),
      human(['✅ review — `review:human` cleared via the sanctioned path', '',
        'Cleared by chalbert via `review-set-label.mjs --to=clear-human` (gate-self).', '',
        buildReviewedShaMarker(H), buildClearedHumanMarker('chalbert')].join('\n'), '2026-10-21T20:00:00Z')];
    const context = { comments, repo, pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState } };
    // With only the cap action, this very ceremony is live and clears its held break.
    const capped = readRedTeamDisposition({ ...context, comments: [...live, comments.at(-1)] });
    expect(capped.dispositions.get(1).state).toBe('cleared');
    expect(held(capped)).toEqual([]);
    const d = readRedTeamDisposition(context);
    expect(d.outcome).toBe('sent-back');
    expect(d.held).toEqual([]);
    expect(d.sendBack.map(f => f.index)).toEqual([1]);
    expect(redTeamEnqueueHold({ ...context, env: {} })).not.toBeNull();
    expect(planRedTeamStatusLabels({ ...context, labels: ['red-team:clear'], env: {} }))
      .toEqual({ add: 'red-team:blocked', remove: ['red-team:clear'] });
  });
});

describe('operator-block held actions (shared reader)', () => {
  it.each([
    ['indexed send-back', '- 1 confirmed break(s) sent back to the fixer (#1).', rid, [1]],
    ['indexed hold', '- 1 confirmed break(s) NOT sent back: cap (#1).', rid, [1]],
    ['legacy unindexed hold', '- 1 confirmed break(s) NOT sent back: cap.', null, [1, 2, 3]],
  ].flatMap(([format, line, id, expected]) => [['human', human], ['bot', bot]].flatMap(([author, who]) =>
    [false, true].map(anyState => [format, author, anyState, line, id, expected, who]))))(
    '%s by %s supersedes only its covered clear-human findings (anyState=%s)',
    (_format, _author, anyState, line, id, expected, who) => {
      const comments = [result,
        gate(bot, 'round-cap', '- 3 confirmed break(s) NOT sent back: cap (#1, #2, #3).', '2026-10-21T17:12:20Z'),
        human(['✅ review — `review:human` cleared via the sanctioned path', '',
          'Cleared by chalbert via `review-set-label.mjs --to=clear-human` (gate-self).', '',
          buildReviewedShaMarker(H), buildClearedHumanMarker('chalbert')].join('\n'), '2026-10-21T20:00:00Z')];
      const disposition = () => readRedTeamDisposition({ comments, pr: P, head: H,
        setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });
      expect(held(disposition())).toEqual([]);
      expect(redTeamEnqueueHold({ comments, pr: P, head: H, env: {} })).toBeNull();

      comments.push(gate(who, 'operator-block', line, '2026-10-21T20:30:00Z', id));
      // An indexed block leaves the other clearances standing; a legacy line without
      // indices must conservatively supersede the ceremony for every confirmed finding.
      expect(disposition().held.map(f => f.index)).toEqual(expected);
      expect(disposition().sendBack).toEqual([]);
      expect(redTeamEnqueueHold({ comments, pr: P, head: H, env: {} })).not.toBeNull();
      expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['review:human', 'red-team:clear'], env: {} }))
        .toEqual({ add: 'red-team:blocked', remove: ['red-team:clear'] });
    });

  it.each([
    ['human', 'indexed', human, '- 1 confirmed break(s) NOT sent back: cap (#1).', rid, [1]],
    ['bot', 'indexed', bot, '- 1 confirmed break(s) NOT sent back: cap (#1).', rid, [1]],
    ['human', 'legacy unindexed', human, '- 1 confirmed break(s) NOT sent back: cap.', null, [1, 2, 3]],
    ['bot', 'legacy unindexed', bot, '- 1 confirmed break(s) NOT sent back: cap.', null, [1, 2, 3]],
  ])('preserves a %s-authored %s hold without a round-cap record', (_author, _format, who, line, id, expected) => {
    const d = disp([result, gate(who, 'operator-block', line, '2026-10-21T20:30:00Z', id)]);
    expect(d.held.map(f => f.index)).toEqual(expected);
    expect(d.sendBack).toEqual([]);
  });

  it.each([['human', human], ['bot', bot]])('keeps a %s-authored held line at ordinary priority', (_author, who) => {
    const comments = [result,
      gate(who, 'operator-block', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T20:30:00Z'),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:40:00Z')];
    const d = readRedTeamDisposition({ comments, pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState: true } });
    expect(d.held).toEqual([]);
    expect(d.sendBack).toEqual([]);
  });

  it.each([['human', human], ['bot', bot]])('does not let a %s-authored held line lower an existing human block', (_author, who) => {
    const comments = [result,
      gate(human, 'operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T20:20:00Z'),
      gate(who, 'operator-block', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T20:30:00Z'),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:40:00Z')];
    const d = readRedTeamDisposition({ comments, pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState: true } });
    expect(d.held).toEqual([]);
    expect(d.sendBack.map(f => f.index)).toEqual([1]);
  });

  it.each(operatorReleaseLines.flatMap(([format, line]) =>
    [['human', human], ['bot', bot]].map(([author, who]) => [format, author, line, who])))('ignores %s release lines in a %s-authored block record', (_format, _author, line, who) => {
    const d = readRedTeamDisposition({ comments: [...live, gate(who, 'operator-block', line, '2026-10-21T20:30:00Z')],
      pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } });
    expect(d.held.map(f => f.index)).toEqual([1]);
    expect(d.sendBack).toEqual([]);
  });
});

describe('operator card release at the cap (shared reader)', () => {
  const env = { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'false' };

  it.each([
    ['accepts a trusted human operator-card after a trusted cap', { login: 'chalbert', type: 'User' }, true],
    ['rejects an unregistered human operator-card after a trusted cap', { login: 'mallory', type: 'User' }, false],
    ['rejects a bot operator-card after a trusted cap', { login: 'web-everything', type: 'Bot' }, false],
  ])('%s across reader, queue and labels', (_, user, releases) => {
    const card = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const comments = [...live, { ...card, user }];
    expect(held(disp(comments))).toEqual(releases ? [] : [1]);
    const hold = redTeamEnqueueHold({ comments, pr: P, head: H, env });
    if (releases) expect(hold).toBeNull();
    else expect(hold).not.toBeNull();
    expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['red-team:blocked'], env }))
      .toEqual(releases ? { add: 'red-team:clear', remove: ['red-team:blocked'] } : { add: null, remove: [] });
  });
  it('keeps an identical re-posted result held when the operator card predates it', () => {
    const card = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const comments = [...live, card];
    expect(held(disp(comments))).toEqual([]);
    const repost = { ...result, created_at: '2026-10-21T21:00:00Z' };
    expect(liveResultGateState([repost], P, H).resultId).toBe(rid);
    // A marker-only new cap must not mask a stale release by overwriting its action with `held`.
    comments.push(repost, gate(bot, 'round-cap', '', '2026-10-21T21:10:00Z'));
    expect(liveResultGateState(comments, P, H).resultId).toBe(rid);
    expect(held(disp(comments))).toEqual([1]);
    expect(redTeamEnqueueHold({ comments, pr: P, head: H, env })).not.toBeNull();
    expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['red-team:blocked'], env }))
      .toEqual({ add: null, remove: [] });
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z'));
    expect(held(disp(comments))).toEqual([]);
  });
  it.each(operatorReleaseLines.flatMap(([format, line]) =>
    ['missing', 'sent-back', 'wrong result', 'wrong head', 'untrusted', 'later'].map(variant => [format, line, variant])))('rejects %s (%s) with a %s round-cap handover across reader, queue and labels', (_format, line, variant) => {
    const cap = gate(bot, 'round-cap', '', '2026-10-21T17:12:20Z');
    const before = {
      missing: [],
      'sent-back': [gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z')],
      'wrong result': [gate(bot, 'round-cap', '', cap.created_at, '0123456789abcdef')],
      'wrong head': [gate(bot, 'round-cap', '', cap.created_at, rid, N)],
      untrusted: [{ ...cap, user: { login: 'mallory', type: 'User' } }],
      later: [],
    }[variant];
    const comments = [result, ...before, gate(human, 'operator-card', line, '2026-10-21T20:30:00Z'),
      ...(variant === 'later' ? [cap] : [])];
    const d = disp(comments);
    expect(held(d)).toEqual([1]);
    expect(redTeamEnqueueHold({ comments, pr: P, head: H, env })).not.toBeNull();
    expect(planRedTeamStatusLabels({ comments, pr: P, head: H, labels: ['red-team:blocked'], env }))
      .toEqual({ add: null, remove: [] });
  });
  it('does not treat a held action in an operator record as a round-cap handover', () => {
    const d = disp([result, gate(human, 'operator-card', '- 1 confirmed break(s) NOT sent back: cap (#1).\n' + cardLine([1]), '2026-10-21T20:30:00Z')]);
    expect(held(d)).toEqual([1]);
  });
  it.each(operatorReleaseLines.flatMap(([format, line]) =>
    ['human', 'standing ruling'].map(kind => [format, line, kind])))('rejects %s (%s) after pending or consumed %s grants, including stale cap posts', (_format, line, kind) => {
    const repo = 'o/r';
    const standingRuling = kind === 'standing ruling' ? { ok: true, id: `${repo}#6000`, author: 'chalbert', by: 1,
      maxPerPr: 3, repos: [repo], cardOnlyHeads: { [H]: true }, uneditedComments: ['IC_auto'] } : null;
    const at = '2026-10-21T18:00:00Z';
    const grant = { id: 'IC_auto', author: { login: standingRuling ? 'web-everything[bot]' : 'chalbert', type: standingRuling ? 'Bot' : 'User' },
      createdAt: at, body: buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert', channel: 'chat', reason: 'one more round', at,
        ...(standingRuling ? { standingRuling: standingRuling.id, head: H, episode: `${repo}#${P}@${H}:review:12/12` } : {}) }) };
    const ids = gateRoundGrants([grant], P, repo, standingRuling).map(g => g.id);
    expect(ids).toHaveLength(1);
    const cap = bot(redTeamGateMarker(P, H, 'round-cap', rid, []), '2026-10-21T17:12:20Z');
    const sent = bot(`${redTeamGateMarker(P, H, 'sent-back', rid, ids)}\n- 1 confirmed break(s) sent back to the fixer (#1).`, at);
    const card = gate(human, 'operator-card', line, '2026-10-21T20:30:00Z');
    for (const prefix of [[result, cap, grant], [result, grant, cap], [result, cap, grant, sent], [result, grant, sent, cap]]) {
      const comments = [...prefix, card];
      const context = { comments, pr: P, head: H, repo, standingRuling, env };
      expect(held(readRedTeamDisposition(context))).toEqual([1]);
      expect(redTeamEnqueueHold(context)).not.toBeNull();
      expect(planRedTeamStatusLabels({ ...context, labels: ['red-team:blocked'] })).toEqual({ add: null, remove: [] });
    }
  });
  it('does not let a later grant retroactively invalidate a valid operator card', () => {
    const repo = 'o/r';
    const at = '2026-10-21T21:00:00Z';
    const grant = human(buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert', channel: 'chat', reason: 'another round', at }), at);
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), grant];
    expect(held(readRedTeamDisposition({ comments, repo, pr: P, head: H, env, setting: CONFIRMED_BREAKS_DEFAULTS }))).toEqual([]);
  });
  it('keeps fixer-owned breaks sent back without any gate record', () => {
    const d = disp([result]);
    expect(d.sendBack.map((f) => f.index)).toEqual([1]);
    expect(d.held).toEqual([]);
  });
  it('a human operator card record for this result releases #1', () => {
    const d = disp([...live, gate(human, 'operator-card', cardLine([1, 2, 3]), '2026-10-21T20:30:00Z')]);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
  });
  it('a human operator card record without a result id leaves #1 held', () => {
    const d = disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', null)]);
    expect(d.sendBack).toEqual([]);
    expect(d.held.map(f => f.index)).toEqual([1]);
  });
  it('same-head repost cannot inherit an earlier result card; cross-head matching findings can', () => {
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z')];
    expect(held(disp(comments))).toEqual([]);
    const freshResult = head => bot(renderRedTeamComment({ pr: P, rev: head, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z');
    const repost = freshResult(H);
    const repostId = liveResultGateState([repost], P, H).resultId;
    expect(repostId).not.toBe(rid);

    // Identical finding evidence carries across heads, but not to another result on this head.
    expect(held(disp([...comments, freshResult(N)], N))).toEqual([]);
    comments.push(repost);
    expect(held(disp(comments))).toEqual([1]);
    comments.push(gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).',
      '2026-10-21T21:10:00Z', repostId));
    expect(disp(comments).held.map(f => f.index)).toEqual([1]);
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:40:00Z', repostId));
    expect(held(disp(comments))).toEqual([]);
  });
  it.each([
    ['no result id', null],
    ['the older result id', rid],
  ])('an operator card record with %s posted after a newer same-head result leaves it held', (_, id) => {
    const next = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [F(160, 'broken')] }), '2026-10-21T21:00:00Z');
    const nextId = liveResultGateState([next], P, H).resultId;
    expect(nextId).not.toBe(rid);
    const comments = [...live, next,
      gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T21:10:00Z', nextId),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z', id)];
    const d = disp(comments);
    expect(d.sendBack).toEqual([]);
    expect(d.held.map(f => f.index)).toEqual([1]);
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:40:00Z', nextId));
    expect(held(disp(comments))).toEqual([]);
  });
  it.each([
    ['legacy card', '- 1 finding(s) filed as a follow-up card (#1).', null],
    ['legacy advisory', '- 1 finding(s) left advisory (#1).', null],
    ['named card', '- 1 finding(s) filed as a follow-up card (#1).', rid],
    ['named advisory', '- 1 finding(s) left advisory (#1).', rid],
  ])('default-mode %s release on a source head does not release carried findings', (_, line, id) => {
    const comments = [...live, gate(human, 'operator-card', line, '2026-10-21T20:30:00Z', id)];
    const read = head => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS,
      env: {}, operatorRulings: { anyState: false } });
    expect(held(read(H))).toEqual([]);
    comments.push(carried);
    const disposition = read(N);
    expect(disposition.result.rev).toBe(N);
    expect(disposition.sendBack).toEqual([]);
    expect(disposition.held.map(f => f.index)).toEqual([1]);
  });
  it('does not inherit an operator card release through a verdict carry without cited-line proof', () => {
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), carried];
    const d = disp(comments, N);
    expect(d.result.rev).toBe(N);
    expect(liveResultGateState(comments, P, N).resultId).toBe(rid);
    expect(d.sendBack).toEqual([]);
    expect(d.held.map(f => f.index)).toEqual([1]);
    expect(planRedTeamStatusLabels({ comments, pr: P, head: N, labels: ['red-team:blocked'], env }))
      .toEqual({ add: null, remove: [] });
  });
  it('releases a carried result when the operator card record names that exact head and result', () => {
    const comments = [...live, carried];
    expect(held(disp(comments, N))).toEqual([1]);
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T21:30:00Z', rid, N));
    const d = disp(comments, N);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
    expect(planRedTeamStatusLabels({ comments, pr: P, head: N, labels: ['red-team:blocked'], env }))
      .toEqual({ add: 'red-team:clear', remove: ['red-team:blocked'] });
  });
  it('automation can never use the operator card line, under any outcome', () => {
    for (const outcome of ['operator-card', 'card-queued', 'sent-back']) {
      expect(held(disp([...live, gate(bot, outcome, cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
    }
    expect(held(disp([...live, gate(human, 'card-queued', cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
  });
  it('a record naming another result releases nothing; a new head re-evaluates by fingerprint', () => {
    expect(held(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', '0123456789abcdef')]))).toEqual([1]);
    const N = 'a'.repeat(40);
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z');
    expect(held(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), next], N))).toEqual([]);
    // The old release must still refuse a different finding on the new head.
    next.body = next.body.replace('break at 159', 'different break at 159');
    expect(held(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), next], N))).toEqual([1]);
  });
});

describe('operator ruling in any state (shared reader)', () => {
  const live = [result, gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z')];
  const disp = (comments, anyState = true, head = H) => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });
  const sent = (d) => d.sendBack.map(f => f.index);
  it('#5502 before: #1 is sent back and blocks', () => { expect(sent(disp(live))).toEqual([1]); });
  it('a human operator card record for this result releases #1', () => {
    const d = disp([...live, gate(human, 'operator-card', cardLine([1, 2, 3]), '2026-10-21T20:30:00Z')]);
    expect(d.sendBack).toEqual([]);
    expect(d.held).toEqual([]);
  });
  it('automation can never use the operator card line, under any outcome', () => {
    for (const outcome of ['operator-card', 'card-queued', 'sent-back']) {
      expect(sent(disp([...live, gate(bot, outcome, cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
    }
    expect(sent(disp([...live, gate(human, 'card-queued', cardLine([1]), '2026-10-21T20:30:00Z')]))).toEqual([1]);
  });
  it('a record naming another result releases nothing; a new head re-evaluates by fingerprint', () => {
    expect(sent(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', '0123456789abcdef')]))).toEqual([1]);
    const N = 'a'.repeat(40);
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z');
    expect(sent(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), next], true, N))).toEqual([]);
    // The old release must still refuse a different finding on the new head.
    next.body = next.body.replace('break at 159', 'different break at 159');
    expect(sent(disp([...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), next], true, N))).toEqual([1]);
  });
  it.each(operatorReleaseLines)('kill switch off for %s: never overrides a live send-back, still releases a break handed over at the cap', (_format, line) => {
    const op = gate(human, 'operator-card', line, '2026-10-21T20:30:00Z');
    expect(held(disp([...live, op], true))).toEqual([]);
    expect(sent(disp([...live, op], false))).toEqual([1]);
    const cap = gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T18:00:00Z');
    expect(disp([...live, cap], false).held.map((f) => f.index)).toEqual([1]);
    expect(disp([...live, cap, op], false).held).toEqual([]);
  });
  it('operatorRulingsOnLiveResult: the operator actions and every carded break of the live result', () => {
    const gateCard = gate(bot, 'card-queued', '- 1 finding(s) filed as a follow-up card (#2) — landing job j.', '2026-10-21T17:12:23Z');
    const r = operatorRulingsOnLiveResult([...live, gateCard, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z')], P, H);
    expect(r.resultId).toBe(rid);
    expect([...r.ruled]).toEqual([[1, ['card']]]);
    expect([...r.carded].sort()).toEqual([1, 2]);
  });
  it('the cascade: default off, settings file and env opt in, invalid ignored', () => {
    expect(resolveOperatorRulings({}).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: false } } } }).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: true } } }, env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: '0' } }).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'banana' } }).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: true } } } }).value.anyState).toBe(true);
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'true' } }))
      .toMatchObject({ value: { anyState: true }, sources: { anyState: 'env' } });
  });
});

describe('operator ruling policy provenance', () => {
  it('resolves standard → platform → tool → environment and records each source', () => {
    const platform = { operatorRulings: { anyState: false } };
    const file = { redTeam: { operatorRulings: { anyState: true } } };
    expect(resolveOperatorRulings({})).toMatchObject({ value: { anyState: false }, sources: { anyState: 'standard' } });
    expect(resolveOperatorRulings({ platform })).toMatchObject({ value: { anyState: false }, sources: { anyState: 'platform' } });
    expect(resolveOperatorRulings({ platform, file })).toMatchObject({ value: { anyState: true }, sources: { anyState: 'tool' } });
    expect(resolveOperatorRulings({ platform, file, env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'false' } }))
      .toMatchObject({ value: { anyState: false }, sources: { anyState: 'env' } });
  });
  it('logs the effective scope and source when reading settings', () => {
    const logs = [];
    const scope = readOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'false' }, log: line => logs.push(line) });
    expect(scope).toMatchObject({ value: { anyState: false }, sources: { anyState: 'env' } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('redTeam.operatorRulings');
    expect(logs[0]).toContain('false');
    expect(logs[0]).toContain('env');
  });
  it('dedup ignores forged, missing-result and stale-result operator records', () => {
    const line = cardLine([1]);
    for (const record of [gate(bot, 'operator-card', line, '2026-10-21T20:30:00Z'),
      gate(human, 'operator-card', line, '2026-10-21T20:30:00Z', null),
      gate(human, 'operator-card', line, '2026-10-21T20:30:00Z', '0123456789abcdef')]) {
      const r = operatorRulingsOnLiveResult([...live, record], P, H);
      expect([...r.ruled]).toEqual([]);
      expect([...r.carded]).toEqual([]);
    }
  });
});

describe('latest operator action deduplication', () => {
  it('keeps action history in thread order and scopes it to the live result', () => {
    const first = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const later = gate(human, 'operator-card', '- 1 finding(s) left advisory (#1).', '2026-10-21T20:40:00Z');
    const r = operatorRulingsOnLiveResult([...live, later, first], P, H);
    expect(r.ruled.get(1)).toEqual(['card', 'advisory']);
    expect(r.ruled.get(1).at(-1)).toBe('advisory');
    expect([...r.carded]).toEqual([1]);
    const next = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [F(160, 'broken')] }), '2026-10-21T21:00:00Z');
    const fresh = operatorRulingsOnLiveResult([...live, first, later, next], P, H);
    expect([...fresh.ruled]).toEqual([]);
    expect([...fresh.carded]).toEqual([]);
    expect(operatorRulingsOnLiveResult([], P, H).resultId).toBeNull();
  });
});

describe('anyState keeps the pending round-extension guard (shared reader)', () => {
  it.each([false, true])('an operator card posted while a human grant is unconsumed releases nothing (anyState=%s)', anyState => {
    const repo = 'o/r';
    const at = '2026-10-21T18:00:00Z';
    const grant = human(buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert', channel: 'chat', reason: 'one more round', at }), at);
    const comments = [...live, grant, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z')];
    expect(liveResultGateState(comments, P, H, repo)).toMatchObject({ reopened: true });
    const d = readRedTeamDisposition({ comments, repo, pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });
    expect(held(d)).toEqual([1]);
  });
});


describe('operator card inheritance preserves original-head ownership', () => {
  it.each([
    ['fixer-owned', false],
    ['later cap', false],
    ['reopened cap', false],
    ['reopened cap', true],
  ])('does not inherit an operator card rejected by original-head ownership (%s, anyState=%s)', (mode, anyState) => {
    const repo = 'o/r';
    const sentBack = gate(bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z');
    const at = '2026-10-21T18:00:00Z';
    const grant = human(buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert',
      channel: 'chat', reason: 'one more round', at }), at);
    const comments = mode === 'reopened cap' ? [...live, grant] : [result, sentBack];
    comments.push(gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'));
    if (mode === 'later cap') comments.push(gate(bot, 'round-cap',
      '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T20:45:00Z'));
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z');
    const read = head => readRedTeamDisposition({ comments, repo, pr: P, head,
      setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState }, sealed: null });
    expect(held(read(H))).toEqual([1]);
    comments.push(next);
    expect(held(read(N))).toEqual([1]);
  });
  it('inherits a card eligible at posting time even after a later round grant', () => {
    const repo = 'o/r', at = '2026-10-21T20:45:00Z';
    const comments = [...live, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'),
      human(buildRoundExtensionComment({ repo, pr: P, by: 1, actor: 'chalbert', channel: 'chat', reason: 'another round', at }), at),
      bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm', recheckStatus: 'ok',
        foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z')];
    for (const head of [H, N]) expect(held(readRedTeamDisposition({ comments, repo, pr: P, head,
      setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: false }, sealed: null }))).toEqual([]);
  });
});


describe('operator cards share indexed hold invalidation', () => {
  it.each(['direct', 'inherited'].flatMap(source => ['indexed hold', 'indexed send-back', 'unrelated indexed hold', 'legacy unindexed hold']
    .map(kind => [source, kind])))(
    'a later indexed hold retires an inherited card and a direct card (%s, %s)', (source, kind) => {
      const comments = [result, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z')];
      const head = source === 'inherited' ? N : H;
      if (source === 'inherited') comments.push(bot(renderRedTeamComment({ pr: P, rev: head, provider: 'codex', model: 'm',
        recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken')] }), '2026-10-21T21:00:00Z'));
      const read = () => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS,
        operatorRulings: { anyState: true }, sealed: null });
      expect(held(read())).toEqual([]);
      expect(read().dispositions.get(1).state).toBe('released carded');
      const id = liveResultGateState(comments, P, head).resultId;
      const indexed = kind !== 'legacy unindexed hold';
      const sendBack = kind === 'indexed send-back';
      const line = sendBack ? '- 1 confirmed break(s) sent back to the fixer (#1).'
        : `- 1 confirmed break(s) NOT sent back: cap${indexed ? kind === 'unrelated indexed hold' ? ' (#2)' : ' (#1)' : ''}.`;
      comments.push(gate(bot, sendBack ? 'sent-back' : 'round-cap', line, '2026-10-21T21:30:00Z', id, head));
      const d = read();
      const retires = kind === 'indexed hold' || sendBack;
      expect(held(d).filter(i => i === 1)).toEqual(retires ? [1] : []);
      expect(d.dispositions.get(1).state).toBe(retires ? 'open' : 'released carded');
      expect(d.rulings.get(1).some(r => r.kind === 'card' && r.keys.includes(1))).toBe(!retires);
    });
});


describe('source-head card retirement before inheritance', () => {
  it.each([
    ['human operator block', human, 'operator-block', '- 1 confirmed break(s) sent back to the fixer (#1).'],
    ['indexed hold', bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).'],
    ['indexed send-back', bot, 'sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).'],
  ])('an intervening head with a %s retires the original card for a third head', (_name, who, outcome, line) => {
    const third = 'c'.repeat(40);
    const middle = { ...result, body: result.body.replace(H, N), created_at: '2026-10-21T21:00:00Z' };
    const fresh = { ...result, body: result.body.replace(H, third), created_at: '2026-10-21T22:00:00Z' };
    const comments = [result, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z'), middle];
    const read = head => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState: true }, sealed: null });
    expect(read(H).dispositions.get(1).state).toBe('released carded');
    expect(read(N).dispositions.get(1).state).toBe('released carded');
    const id = liveResultGateState(comments, P, N).resultId;
    comments.push(gate(who, outcome, line, '2026-10-21T21:30:00Z', id, N));
    expect(held(read(N))).toContain(1);
    comments.push(fresh);
    expect(read(third).dispositions.get(1).state).not.toBe('released carded');
    expect(held(read(third))).toContain(1);
  });

  it.each([
    ['operator block before card', 'operator-block', human, '- 1 confirmed break(s) sent back to the fixer (#1).', true],
    ['operator block after card', 'operator-block', human, '- 1 confirmed break(s) sent back to the fixer (#1).', false],
    ['indexed hold after card', 'round-cap', bot, '- 1 confirmed break(s) NOT sent back: cap (#1).', false],
    ['indexed send-back after card', 'sent-back', bot, '- 1 confirmed break(s) sent back to the fixer (#1).', false],
  ])('refuses inheritance after %s on the original head', (_name, outcome, who, line, before) => {
    const restriction = gate(who, outcome, line, '2026-10-21T20:00:00Z');
    const card = gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z');
    const next = { ...result, body: result.body.replace(H, N), created_at: '2026-10-21T21:00:00Z' };
    const comments = [result, ...(before ? [restriction, card] : [card, restriction]), next];
    const read = head => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState: true }, sealed: null });
    expect(held(read(H))).toContain(1);
    expect(held(read(N))).toContain(1);
    expect(read(N).dispositions.get(1).state).not.toBe('released carded');
  });
});

describe('inherited cards preserve meaningful summary operators', () => {
  it('does not reuse a less-than card for a fresh greater-than finding', () => {
    const source = { ...result, body: result.body.replace('break at 159', 'Reject x < 10') };
    const fresh = { ...source, body: source.body.replace(H, N).replace('Reject x < 10', 'Reject x > 10'),
      created_at: '2026-10-21T21:00:00Z' };
    const id = liveResultGateState([source], P, H).resultId;
    const comments = [source, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id), fresh];
    const read = head => readRedTeamDisposition({ comments, pr: P, head, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState: true }, sealed: null });
    expect(read(H).dispositions.get(1).state).toBe('released carded');
    expect(read(N).dispositions.get(1).state).not.toBe('released carded');
    expect(held(read(N))).toContain(1);
  });

  it.each([...'<>=!+-*/%&|^~?'])('does not erase the %s operator from a fingerprint', operator => {
    const source = { ...result, body: result.body.replace('break at 159', `Reject x ${operator} 10`) };
    const next = { ...source, body: source.body.replace(H, N).replace(`x ${operator} 10`, 'x 10'),
      created_at: '2026-10-21T21:00:00Z' };
    const id = liveResultGateState([source], P, H).resultId;
    const comments = [source, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id), next];
    expect(disp(comments, N).dispositions.get(1).state).not.toBe('released carded');
  });

  it.each([['<', '>'], ['<=', '>='], ['==', '!='], ['&&', '||'], ['+', '-'], ['*', '/']])(
    'does not inherit when %s changes to %s', (before, after) => {
      const source = { ...result, body: result.body.replace('break at 159', `Reject x ${before} 10`) };
      const next = { ...source, body: source.body.replace(H, N).replace(`x ${before} 10`, `x ${after} 10`),
        created_at: '2026-10-21T21:00:00Z' };
      const id = liveResultGateState([source], P, H).resultId;
      const comments = [source, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id), next];
      expect(disp(comments, N).dispositions.get(1).state).not.toBe('released carded');
    });
});

describe('inherited cards preserve changed snippet punctuation', () => {
  it.each([
    ['comma', 'Reject foo(x, y)', 'Reject foo(x y)'],
    ['semicolon', 'Reject foo(x; y)', 'Reject foo(x y)'],
    ['colon', 'Reject foo(x: y)', 'Reject foo(x y)'],
    ['period', 'Reject foo(x. y)', 'Reject foo(x y)'],
    ['exclamation', 'Reject x! y', 'Reject x y'],
    ['question', 'Reject x? y', 'Reject x y'],
    ['backtick', 'Reject `x`', 'Reject x'],
    ['adjacent operators', 'Reject x==y', 'Reject x= =y'],
  ])('changed snippet punctuation re-raises (%s)', (_name, before, after) => {
    const finding = { file: 'scripts/parser.mjs', category: 'edge-case', confirmed: true, impact: 'broken' };
    expect(findingFingerprint({ ...finding, summary: before }))
      .not.toBe(findingFingerprint({ ...finding, summary: after }));

    const source = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ ...F(159, 'broken'), summary: before }] }), result.created_at);
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ ...F(159, 'broken'), summary: after }] }), '2026-10-21T21:00:00Z');
    const id = liveResultGateState([source], P, H).resultId;
    const comments = [source,
      gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T17:30:00Z', id),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id), next];
    expect(disp(comments, H).dispositions.get(1).state).toBe('released carded');
    expect(disp(comments, N).dispositions.get(1).state).not.toBe('released carded');
    expect(held(disp(comments, N))).toEqual([1]);
  });
});

describe('inherited cards bind all parsed risk fields', () => {
  // Separate expected keys pin removal too; iterating only the production list would
  // silently lose a test when a field was removed from that list.
  const variants = {
    confirmed: [true, 'confirmed'], recheckOutcome: ['confirmed', 'unverifiable'],
    category: ['edge-case', 'edge-case.'], impact: ['broken', 'unknown-impact'],
    scenario: ['public input', 'private input'], recheck: ['public reproducer', 'private reproducer'],
    securityReachableToday: [true, false], findingClass: ['live-reproduced', 'correctness-in-normal-use'],
    classBasis: ['public input', 'private input'], alsoClasses: [['live-reproduced'], ['security-reachable-today']],
  };
  it('pins the complete fingerprint field list', () => {
    expect([...FINDING_FINGERPRINT_FIELDS].sort()).toEqual(Object.keys(variants).sort());
  });
  it.each(FINDING_FINGERPRINT_FIELDS)('binds changed and one-sided %s independently of break class', key => {
    const [before, after] = variants[key];
    const base = { file: 'scripts/x.mjs', summary: 'parser drops input', category: 'edge-case', confirmed: true, impact: 'broken' };
    const source = { ...base, [key]: before }, next = { ...base, [key]: after };
    const absent = { ...source };
    delete absent[key];
    expect(findingFingerprint(source)).not.toBeNull();
    expect(findingFingerprint(next)).not.toBe(findingFingerprint(source));
    expect(findingFingerprint(absent)).not.toBe(findingFingerprint(source));
    // Explicit undefined is still evidence of presence; it cannot equal absence.
    if (key !== 'category') expect(findingFingerprint({ ...absent, [key]: undefined })).not.toBe(findingFingerprint(absent));
    expect(findingFingerprint({ ...source })).toBe(findingFingerprint(source));
  });
  it.each([undefined, null, '', 42, {}, []])('refuses missing or non-string raw file evidence (%j)', file => {
    expect(findingFingerprint({ file, summary: 'parser drops input', category: 'edge-case', confirmed: true })).toBeNull();
  });
  it.each([
    ['recheck text', '   - Re-check: confirmed by public input', '   - Re-check: confirmed by private input'],
    ['one-sided recheck text', '   - Re-check: confirmed by public input', ''],
    ['scenario', '   - Scenario: public input reaches the parser', '   - Scenario: authenticated input reaches the parser'],
    ['security reachability', '   - Security class: security-reachable-today', ''],
    ['finding class', '   - Class: correctness-in-normal-use → fix-now', '   - Class: live-reproduced → fix-now'],
    ['additional classes', '   - Also class: live-reproduced', '   - Also class: security-reachable-today'],
    ['class basis', '   - Class: live-reproduced → fix-now (basis: public input)', '   - Class: live-reproduced → fix-now (basis: private input)'],
    ['one-sided scenario', '   - Scenario: public input reaches the parser', ''],
    ['one-sided finding class', '   - Class: live-reproduced → fix-now', ''],
    ['one-sided additional classes', '   - Also class: live-reproduced', ''],
    ['impact', '', ''],
  ].flatMap(row => [false, true].map(reverse => [...row, reverse])))('refuses changed or one-sided %s (%s → %s; reverse=%s)',
    (field, oldLine, newLine, reverse) => {
      const source = { ...result, body: result.body + (oldLine ? '\n' + oldLine : '') };
      const next = { ...result, body: result.body.replace(H, N) + (newLine ? '\n' + newLine : ''), created_at: '2026-10-21T21:00:00Z' };
      if (field === 'impact') next.body = next.body.replace('(edge-case, broken)', '(edge-case, impact?)');
      if (reverse) [source.body, next.body] = [next.body.replace(N, H), source.body.replace(H, N)];
      const id = liveResultGateState([source], P, H).resultId;
      // Appended sub-lines describe the last finding (#3); impact changes #1.
      const index = field === 'impact' ? 1 : 3;
      const comments = [source, gate(human, 'operator-card', cardLine([index]), '2026-10-21T20:30:00Z', id), next];
      const d = readRedTeamDisposition({ comments, pr: P, head: N, setting: CONFIRMED_BREAKS_DEFAULTS,
        operatorRulings: { anyState: true }, sealed: null });
      expect(d.dispositions.get(index).state).not.toBe('released carded');
    });
});

describe('fresh-head card regression paths', () => {
  const freshResult = (head, findings, at = '2026-10-21T21:00:00Z') => bot(renderRedTeamComment({ pr: P, rev: head,
    provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings }), at);
  const carded = source => {
    const id = liveResultGateState([source], P, H).resultId;
    return [source,
      gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T17:30:00Z', id),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id)];
  };
  const read = (comments, head = N) => readRedTeamDisposition({ comments, pr: P, head,
    setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true }, sealed: null });

  it.each([
    ['bare', '', ''],
    ['backticks', '`', '`'],
    ['single quotes', "'", "'"],
    ['double quotes', '"', '"'],
    ['brackets', '[', ']'],
    ['call expression', 'fetch("', '")'],
    ['escaped quotes', '\\"', '\\"'],
    ['Unicode quotes', '“', '”'],
    ['invisible prefix', '\u200b', ''],
    ['option prefix', '--url=', ''],
    ['concatenated expression', 'base+"', '"'],
    ['newline', '\n`', '`'],
    ['carriage return', '\r`', '`'],
    ['Unicode line separator', '\u2028`', '`'],
  ])('holds changed protocol-relative URL ports through parser and card lookup (%s)', (_name, open, close) => {
    const summary = port => `Parser accepts ${open}//cdn/a.js:${port}${close} incorrectly`;
    const source = freshResult(H, [{ ...F(159, 'broken'), summary: summary(8080) }], result.created_at);
    const next = freshResult(N, [{ ...F(159, 'broken'), summary: summary(8443) }]);
    const comments = [...carded(source), next];
    expect(read(comments, H).dispositions.get(1).state).toBe('released carded');
    expect(held(read(comments))).toEqual([1]);
    expect(read(comments).dispositions.get(1).state).not.toBe('released carded');
  });

  it.each([['lines 1–2', 'lines 2–3'], ['ln 1', 'ln 2'], ['retries 3', 'retries 5']])(
    'does not inherit when non-location numbers change (%s → %s)', (before, after) => {
      const source = freshResult(H, [{ ...F(159, 'broken'), summary: `Parser drops ${before} of multiline input` }], result.created_at);
      const next = freshResult(N, [{ ...F(159, 'broken'), summary: `Parser drops ${after} of multiline input` }]);
      expect(held(read([...carded(source), next]))).toEqual([1]);
    });

  it('holds when only explicit file:line references change in the summary', () => {
    const source = freshResult(H, [{ ...F(159, 'broken'), summary: 'Parser drops input at scripts/parser.mjs:10' }], result.created_at);
    const next = freshResult(N, [{ ...F(159, 'broken'), summary: 'Parser drops input at scripts/parser.mjs:20' }]);
    expect(held(read([...carded(source), next]))).toEqual([1]);
  });

  it.each([null, '', '  '])('missing file evidence never inherits an operator card (%j)', file => {
    const source = freshResult(H, [{ ...F(159, 'broken'), file }], result.created_at);
    const next = freshResult(N, [{ ...F(159, 'broken'), file }]);
    expect(held(read([...carded(source), next]))).toEqual([1]);
  });

  it.each(['not confirmed', 'unverifiable'])('refuses changed confirmation/recheck outcome (%s)', tag => {
    const source = freshResult(H, [F(159, 'broken')], result.created_at);
    const next = freshResult(N, [F(159, 'broken')]);
    next.body = next.body.replace('[**confirmed**]', `[${tag}]`);
    expect(read([...carded(source), next]).dispositions.get(1).state).not.toBe('released carded');
  });

  it('preserves one inherited card through an intermediate duplicate result', () => {
    const third = 'c'.repeat(40);
    const source = freshResult(H, [F(159, 'broken')], result.created_at);
    const comments = [...carded(source), freshResult(N, [F(159, 'broken'), F(159, 'broken')])];
    expect(held(read(comments))).toEqual([2]);
    comments.push(freshResult(third, [F(159, 'broken')], '2026-10-21T22:00:00Z'));
    expect(held(read(comments, third))).toEqual([]);
    expect(read(comments, third).dispositions.get(1).state).toBe('released carded');
  });

  it('retires a card across a gap head where the finding is absent', () => {
    const third = 'c'.repeat(40);
    const source = freshResult(H, [F(159, 'broken')], result.created_at);
    const comments = [...carded(source), freshResult(N, []),
      freshResult(third, [F(159, 'broken')], '2026-10-21T22:00:00Z')];
    expect(held(read(comments, third))).toEqual([1]);
  });

  it.each([1, 5, null].flatMap(round => [false, true].flatMap(mixed => ['broken', 'degraded'].map(impact => [round, mixed, impact]))))(
    'gate writer preserves carried cards before the reader runs (round=%s, mixed=%s, impact=%s)', async (round, mixed, impact) => {
      const source = freshResult(H, [F(159, impact)], result.created_at);
      const comments = [...carded(source), freshResult(N, [F(159, impact), ...(mixed ? [F(127, 'broken')] : [])])];
      const writes = [];
      const io = {
        readPr: () => ({ headRefOid: N, labels: [], comments }), readHead: () => N,
        readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readRound: () => round,
        sendBack: args => { writes.push(args); return { ok: true }; }, appendSendBackEvent: async () => {},
        dequeueSentBack: () => {}, fileCard: () => { throw new Error('must not file again'); },
        postComment: args => { writes.push(args); comments.push(bot(args.body, '2026-10-21T22:00:00Z')); },
        log: () => {},
      };
      const applied = await applyRedTeamGate({ repo: 'o/r', pr: P }, io);
      expect(applied.status).toBe(mixed ? 'applied' : 'advisory-only');
      expect(applied.plan.sendBack.map(f => f.index)).toEqual(mixed ? [2] : []);
      expect(applied.plan.card).toEqual([]);
      expect(writes.every(w => !w.body.includes('(#1)'))).toBe(true);
      if (!mixed) expect(writes).toEqual([]);
      expect(read(comments).dispositions.get(1).state).toBe('released carded');
      expect(held(read(comments))).toEqual(mixed ? [2] : []);
    });
});

it('holds unchanged recheck text when the cited line drifts', () => {
  const source = { ...result, body: result.body + '\n   - Re-check: reproduced with public input' };
  const next = { ...source, body: source.body.replace(H, N).replace(':166`', ':170`'), created_at: '2026-10-21T21:00:00Z' };
  const id = liveResultGateState([source], P, H).resultId;
  const comments = [source, gate(human, 'operator-card', cardLine([3]), '2026-10-21T20:30:00Z', id), next];
  expect(readRedTeamDisposition({ comments, pr: P, head: N, setting: CONFIRMED_BREAKS_DEFAULTS,
    operatorRulings: { anyState: true }, sealed: null }).dispositions.get(3).state).not.toBe('released carded');
});


it('holds scenario whitespace changes and cited-line drift', () => {
  const source = { ...result, body: result.body + '\n   - Scenario: public input   reaches the parser' };
  const next = { ...source, body: source.body.replace(H, N).replace('input   reaches', 'input reaches')
    .replace(':166`', ':170`'), created_at: '2026-10-21T21:00:00Z' };
  const id = liveResultGateState([source], P, H).resultId;
  const comments = [source, gate(human, 'operator-card', cardLine([3]), '2026-10-21T20:30:00Z', id), next];
  const d = readRedTeamDisposition({ comments, pr: P, head: N, setting: CONFIRMED_BREAKS_DEFAULTS,
    operatorRulings: { anyState: true }, sealed: null });
  expect(d.dispositions.get(3).state).not.toBe('released carded');
});

describe('raw finding fingerprints fail closed across heads', () => {
  it.each([
    ['percent-encoded scheme', 'data%3Atext/plain%2Csrc/x.txt:10', 'data%3Atext/plain%2Csrc/x.txt:20'],
    ['literal hash versus location', 'src/input.txt#', 'src/input.txt:20'],
    ['escaped scheme', String.raw`data\u{3a}text/plain,src/input.txt:10`, String.raw`data\u{3a}text/plain,src/input.txt:20`],
    ['trailing space', 'Reject input', 'Reject input '],
    ['case change', 'Reject input', 'reject input'],
    ['internal whitespace', 'Reject  input', 'Reject input'],
    ['line citation', 'src/input.txt:10', 'src/input.txt:20'],
    ['byte-identical control', 'Reject input', 'Reject input'],
  ])('%s carries only byte-identical posted payloads', (_name, before, after) => {
    const source = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm',
      recheckStatus: 'ok', foldedVerdict: 'changes', findings: [{ ...F(159, 'broken'), summary: 'SUMMARY' }] })
      .replace('SUMMARY', before), result.created_at);
    const next = { ...source, body: source.body.replace(H, N).replace(before, after), created_at: '2026-10-21T21:00:00Z' };
    const a = parseRedTeamComment(source.body).findings[0], b = parseRedTeamComment(next.body).findings[0];
    expect(a.summary).toBe(before);
    expect(b.summary).toBe(after);
    expect(findingFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
    expect(findingFingerprint(a) === findingFingerprint(b)).toBe(before === after);
    const id = liveResultGateState([source], P, H).resultId;
    const comments = [source, gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id), next];
    const d = readRedTeamDisposition({ comments, pr: P, head: N, setting: CONFIRMED_BREAKS_DEFAULTS,
      operatorRulings: { anyState: true }, sealed: null });
    expect(d.dispositions.get(1).state === 'released carded').toBe(before === after);
    expect(held(d)).toEqual(before === after ? [] : [1]);
  });
  const base = { file: 'src/input.txt', category: 'edge-case', summary: 'Reject input' };
  it.each(['file', 'category', 'summary', 'scenario', 'recheck', 'impact', 'classBasis', 'findingClass', 'recheckOutcome'])(
    'refuses non-string %s', key => expect(findingFingerprint({ ...base, [key]: 42 })).toBeNull());
  it.each(['file', 'category', 'summary'])('refuses absent, undefined, null or empty %s', key => {
    const absent = { ...base }; delete absent[key];
    expect(findingFingerprint(absent)).toBeNull();
    for (const value of [undefined, null, '']) expect(findingFingerprint({ ...base, [key]: value })).toBeNull();
  });
  it('refuses missing and unreadable payloads', () => {
    expect(findingFingerprint(null)).toBeNull();
    expect(findingFingerprint({ get file() { throw new Error('unreadable'); } })).toBeNull();
  });
  it('keeps raw path bytes, line, string whitespace and class order', () => {
    const source = { ...base, line: 10, scenario: 'input', alsoClasses: ['live-reproduced', 'theoretical-race'] };
    for (const change of [{ file: './src/input.txt' }, { file: 'src/input.txt:10' }, { file: '`src/input.txt`' },
      { file: 'src\\input.txt' }, { line: 20 }, { scenario: 'input ' }, { category: 'edge-case ' },
      { alsoClasses: [...source.alsoClasses].reverse() }]) {
      expect(findingFingerprint({ ...source, ...change })).not.toBe(findingFingerprint(source));
    }
    const absent = findingFingerprint(base);
    expect(findingFingerprint({ ...base, line: undefined })).not.toBe(absent);
    expect(findingFingerprint({ ...base, line: null })).not.toBe(findingFingerprint({ ...base, line: undefined }));
  });
});

describe('carded approvals are a multiset keyed by fingerprint and occurrence (R952)', () => {
  const dup = line => ({ ...F(line, 'broken'), summary: 'Parser drops multiline input' });
  const freshResult = (head, findings, at = '2026-10-21T21:00:00Z') => bot(renderRedTeamComment({ pr: P, rev: head,
    provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings }), at);
  const cardedTwo = () => {
    const source = freshResult(H, [dup(159), dup(160)], result.created_at);
    const id = liveResultGateState([source], P, H).resultId;
    return [source,
      gate(bot, 'round-cap', '- 2 confirmed break(s) NOT sent back: cap (#1, #2).', '2026-10-21T17:30:00Z', id),
      gate(human, 'operator-card', cardLine([1, 2]), '2026-10-21T20:30:00Z', id)];
  };
  const read = comments => readRedTeamDisposition({ comments, pr: P, head: N,
    setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true }, sealed: null });
  it('holds the finding that moves while carrying the unchanged line', () => {
    const d = read([...cardedTwo(), freshResult(N, [dup(160), dup(161)])]);
    expect(held(d)).toEqual([2]);
    expect(d.dispositions.get(1).state).toBe('released carded');
  });
  it('does not release a third finding on an unapproved line', () => {
    const d = read([...cardedTwo(), freshResult(N, [dup(159), dup(160), dup(300)])]);
    expect(held(d)).toEqual([3]);
    expect([1, 2].map(i => d.dispositions.get(i).state)).toEqual(['released carded', 'released carded']);
  });
  it('keeps occurrences stable when the findings reorder: exact payloads match independently of index', () => {
    const d = read([...cardedTwo(), freshResult(N, [dup(300), dup(160), dup(159)])]);
    expect(held(d)).toEqual([1]);
  });
  it('one approval releases only one of two same-fingerprint findings', () => {
    const source = freshResult(H, [dup(159)], result.created_at);
    const id = liveResultGateState([source], P, H).resultId;
    const comments = [source, gate(bot, 'round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T17:30:00Z', id),
      gate(human, 'operator-card', cardLine([1]), '2026-10-21T20:30:00Z', id), freshResult(N, [dup(159), dup(159)])];
    expect(held(read(comments))).toEqual([2]);
  });
});
