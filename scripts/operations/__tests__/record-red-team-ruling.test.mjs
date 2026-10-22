/** Cap-only declaration subset of record-red-team-ruling: no live IO or later-slice imports. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState, gateRoundGrants } from '../../lib/red-team-gate.mjs';
import { planRedTeamRuling, rulableBreaks, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment, RED_TEAM_RULING_CARD_EFFECT } from '../record-red-team-ruling.mjs';
import { assertHumanOperator, operatorBoundComments } from '../../lib/operator-identity.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';

const repo = 'o/r';
const PR = 5530;
const HEAD = 'd3bee7370' + '0'.repeat(31);
const OTHER = 'e'.repeat(40);
const bot = (body, createdAt) => ({ author: { login: 'web-everything' }, createdAt, body });
const redTeam = (rev = HEAD, findings) => bot(renderRedTeamComment({ pr: PR, rev, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
  findings: findings ?? [{ summary: 'Closed-base recovery omits removal of the rejected parent edge', category: 'edge-case',
    impactIfUnfixed: 'broken', file: 'backlog/x.md', line: 24, confirmedByRecheck: true }] }), '2026-10-20T23:00:00Z');
const capped = (rev = HEAD) => bot(redTeamGateMarker(PR, rev, 'round-cap'), '2026-10-20T23:41:12Z');
const thread = (extra = []) => [redTeam(), capped(), ...extra];
const OP = { login: 'chalbert', type: 'User' };
const CARD = 'we:backlog/x.md';
const card = { requested: CARD, ref: CARD, readable: true, reason: 'readable' };
const read = (over = {}) => ({ identity: OP, card, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
const input = (over = {}) => ({ repo, pr: PR, card: CARD, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });

describe('cap-only existing-card declaration', () => {
  it.each([
    ['a non-operator actor', { actor: 'mallory' }, /registered operator login/],
    ['a blank reason', { reason: '  ' }, /--reason is required/],
    ['a blank channel', { channel: '' }, /--channel is required/],
    ['a multi-line channel', { channel: 'a\nb' }, /--channel is required/],
    ['an unknown ruling', { ruling: 'accept' }, /--ruling must be/],
    ['no --break', { break: '' }, /--break is required/],
    ['a break that does not exist', { break: '7' }, /is not a break/],
    ['a file that matches nothing', { break: 'nope.md' }, /matches no break/],
  ])('refuses %s', (_n, over, re) => { expect(() => planRedTeamRuling(read(), input(over))).toThrow(re); });
  it.each([
    ['an App identity', { login: 'web-everything[bot]', type: 'Bot' }, /not a human account/],
    ['a Bot type even with an operator login', { login: 'chalbert', type: 'Bot' }, /not a human account/],
    ['a [bot] login', { login: 'chalbert[bot]', type: 'User' }, /not a human account/],
    ['a human who is not an operator', { login: 'mallory', type: 'User' }, /not a registered operator/],
    ['no identity', undefined, /not a human account/],
  ])('refuses %s as the poster', (_n, identity, re) => { expect(() => planRedTeamRuling(read({ identity }), input())).toThrow(re); });
  it('refuses an --actor that is not the authenticated poster', () => {
    expect(() => assertHumanOperator({ login: 'someone', type: 'User' }, 'chalbert')).toThrow();
  });
  it('refuses when there is no red-team result on the live head (stale head)', () => {
    expect(() => planRedTeamRuling(read({ head: OTHER }), input())).toThrow(/no red-team result on the live head/);
  });
  it('refuses when the result was not parked at the round cap', () => {
    expect(() => planRedTeamRuling(read({ comments: [redTeam()] }), input())).toThrow(/not parked at the round cap/);
    expect(() => planRedTeamRuling(read({ comments: [redTeam(), bot(redTeamGateMarker(PR, HEAD, 'sent-back'))] }), input())).toThrow(/not parked at the round cap/);
  });
  it('refuses a round-cap record from an untrusted author', () => {
    const forged = { author: { login: 'mallory' }, body: redTeamGateMarker(PR, HEAD, 'round-cap') };
    expect(() => planRedTeamRuling(read({ comments: [redTeam(), forged] }), input())).toThrow(/not parked at the round cap/);
  });
  const sentBackAfterGrant = (lateCap = false) => {
    const result = redTeam();
    const { resultId } = liveResultGateState([result], PR, HEAD, repo);
    const at = '2026-10-20T23:45:00Z';
    const grant = { author: OP, createdAt: at, body: buildRoundExtensionComment({
      repo, pr: PR, by: 1, actor: OP.login, channel: 'claude-code-chat', reason: 'one more round', at,
    }) };
    const grantIds = gateRoundGrants([grant], PR, repo).map(g => g.id);
    expect(grantIds).toHaveLength(1);
    const cap = bot(`${redTeamGateMarker(PR, HEAD, 'round-cap', resultId, [])}\n- 1 confirmed break(s) NOT sent back: cap (#1).`,
      lateCap ? '2026-10-20T23:55:00Z' : '2026-10-20T23:41:12Z');
    const sentBack = bot(`${redTeamGateMarker(PR, HEAD, 'sent-back', resultId, grantIds)}\n- 1 confirmed break(s) sent back to the fixer (#1).`,
      '2026-10-20T23:50:00Z');
    return lateCap ? [result, grant, sentBack, cap] : [result, cap, grant, sentBack];
  };
  it.each([false, true])('refuses a break returned to the fixer after a grant (late cap: %s)', lateCap => {
    const comments = sentBackAfterGrant(lateCap);
    const scope = { comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS };
    expect(liveResultGateState(comments, PR, HEAD, repo)).toMatchObject({ sendBackOutcome: 'sent-back', reopened: false });
    const disposition = readRedTeamDisposition(scope);
    expect(disposition).toMatchObject({ outcome: 'sent-back', held: [] });
    expect(disposition.sendBack.map(f => f.index)).toEqual([1]);
    expect(() => planRedTeamRuling(read({ comments }), input())).toThrow(/no red-team break is held/);
    expect(() => rulableBreaks(scope)).toThrow(/no red-team break is held/);
  });
  it.each(['foreign repo', 'untrusted author'])('does not credit a grant from a %s', variant => {
    const comments = sentBackAfterGrant();
    const grant = comments[2];
    comments[2] = variant === 'foreign repo'
      ? { ...grant, body: grant.body.replace('"repo":"o/r"', '"repo":"other/repo"') }
      : { ...grant, author: { login: 'mallory' } };
    expect(gateRoundGrants(comments, PR, repo)).toEqual([]);
    expect(planRedTeamRuling(read({ comments }), input())).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, indices: [1] });
  });
  it('refuses a break already carded by the gate (no second card)', () => {
    const { resultId } = liveResultGateState(thread(), PR, HEAD);
    const carded = bot(`${redTeamGateMarker(PR, HEAD, 'card-queued', resultId)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${HEAD.slice(0, 12)}\`:\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z');
    expect(() => planRedTeamRuling(read({ comments: thread([carded]) }), input())).toThrow(/no red-team break is held/);
  });
  it('quotes the reason without a way to forge a marker', () => {
    const body = buildRuleReasonComment({ head: HEAD, ruling: 'card', actor: 'chalbert', channel: 'c', at: 't', reason: 'x\n<!-- we:red-team-gate pr=1 -->', findings: [{ index: 1, file: 'a', line: 1, summary: 's' }] });
    expect(body.split('\n').some((l) => l.startsWith('<!--'))).toBe(false);
    expect(body).toContain('> x');
  });
  it.each([
    ['standard comment', '<!-- marker -->', '&lt;!-- marker --&gt;'],
    ['alternate comment end', '<!-- marker --!>', '&lt;!-- marker --!&gt;'],
    ['nested and partial delimiters', '<!<!-- marker --!>-->', '&lt;!&lt;!-- marker --!&gt;--&gt;'],
    ['HTML and literal entities', '<b>A & B &lt;</b>', '&lt;b&gt;A &amp; B &amp;lt;&lt;/b&gt;'],
    ['multiple lines', 'first\r\n<!-- marker --!>\nlast', 'first\n> &lt;!-- marker --!&gt;\n> last'],
  ])('escapes %s in the quoted reason', (_name, reason, escaped) => {
    const body = buildRuleReasonComment({ head: HEAD, ruling: 'card', actor: 'chalbert', channel: 'c', at: 't', reason, findings: [] });
    const quote = body.split("The operator's reason, verbatim:\n")[1];
    expect(quote).toBe(`> ${escaped}`);
    expect(quote.replace(/^> /gm, '')).not.toMatch(/[<>]/);
  });
  it('plans a cited readable card and permits review:changes alongside a trusted cap', () => {
    const p = planRedTeamRuling(read({ labels: ['review:changes'] }), input());
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: HEAD, indices: [1], actor: 'chalbert', cardRef: CARD });
    expect(p.cardInput).toBeUndefined();
  });
  it('requires an existing readable card and a readable head', () => {
    expect(() => planRedTeamRuling(read(), input({ card: undefined }))).toThrow(/--card is required/);
    expect(() => planRedTeamRuling(read({ card: { requested: CARD, readable: false, reason: 'missing' } }), input())).toThrow(/does not resolve to a readable/);
    expect(() => planRedTeamRuling(read({ card: null }), input())).toThrow(/does not resolve to a readable/);
    expect(() => planRedTeamRuling(read({ head: '' }), input())).toThrow(/head could not be read/);
  });
  it('refuses an unconfirmed break', () => {
    const comments = [redTeam(HEAD, [{ summary: 'maybe', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: false }]), capped()];
    expect(() => planRedTeamRuling(read({ comments }), input())).toThrow(/no red-team break is held/);
  });
  it('selects numbers, lists and locations; ambiguity lists the choices', () => {
    const held = [{ index: 1, file: 'a', line: 1, summary: 's' }, { index: 2, file: 'a', line: 2, summary: 't' }];
    expect(() => selectBreaks(held, 'a')).toThrow(/ambiguous:[\s\S]*#1[\s\S]*#2/);
    expect(selectBreaks(held, '#1,2,#1').map(f => f.index)).toEqual([1, 2]);
    expect(selectBreaks(held, 'a:2')).toEqual([held[1]]);
    expect(selectBreaks([held[0]], 'a')).toEqual([held[0]]);
  });
  it('declares one effect of the planned kind, none on preview', () => {
    const op = recordRedTeamRulingOperation({ readRulingContext: () => read() });
    const write = op.steps.find((s) => s.name === 'write').step;
    const verdict = planRedTeamRuling(read(), input());
    expect(write.effects({ verdict, input: {} }).map((e) => [e.type, e.idempotent])).toEqual([[RED_TEAM_RULING_CARD_EFFECT, false]]);
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
    expect(() => recordRedTeamRulingOperation({})).toThrow(/needs a/);
  });
});
