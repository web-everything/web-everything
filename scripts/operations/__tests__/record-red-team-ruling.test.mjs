/**
 * @file record-red-team-ruling.test.mjs — the operator's ruling on a red-team break parked at the round cap:
 *   the planner (with its refusals), the sinks (card / block / not-real, with a fake thread that evolves as the
 *   sinks post), and the operation's declared effects. No network, no spawn.
 */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState } from '../../lib/red-team-gate.mjs';
import {
  planRedTeamRuling, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment,
  RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT,
} from '../record-red-team-ruling.mjs';
import { createRecordRedTeamRulingSinks, createRecordRedTeamRulingReader } from '../record-red-team-ruling-io.mjs';
import { redTeamRulingCommands } from '../operator-queue-red-team-ruling.mjs';

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
const read = (over = {}) => ({ head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
const input = (over = {}) => ({ repo, pr: PR, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });

describe('planRedTeamRuling: refusals', () => {
  it('plans a card for a confirmed round-cap break on the live head', () => {
    const p = planRedTeamRuling(read(), input());
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: HEAD, indices: [1], actor: 'chalbert' });
    expect(p.cardInput.digest).toContain('card it, ship the PR');
    expect(p.cardInput.scope).toContain('backlog/x.md');
  });
  it.each([
    ['a non-operator actor', { actor: 'mallory' }, /registered operator login/],
    ['a blank reason', { reason: '  ' }, /--reason is required/],
    ['a blank channel', { channel: '' }, /--channel is required/],
    ['a multi-line channel', { channel: 'a\nb' }, /--channel is required/],
    ['an unknown ruling', { ruling: 'accept' }, /--ruling must be/],
    ['no --break', { break: '' }, /--break is required/],
    ['a break that does not exist', { break: '7' }, /not a break held/],
    ['a file that matches nothing', { break: 'nope.md' }, /matches no break/],
  ])('refuses %s', (_n, over, re) => { expect(() => planRedTeamRuling(read(), input(over))).toThrow(re); });
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
  it('refuses while the PR is under review:changes', () => {
    expect(() => planRedTeamRuling(read({ labels: ['review:changes'] }), input())).toThrow(/under review:changes/);
  });
  it('refuses an unconfirmed break (it is never held, so it cannot be selected)', () => {
    const comments = [redTeam(HEAD, [{ summary: 'maybe', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: false }]), capped()];
    expect(() => planRedTeamRuling(read({ comments }), input())).toThrow(/no red-team break is held/);
  });
  it('refuses a break already carded (no second card)', () => {
    const { resultId } = liveResultGateState(thread(), PR, HEAD);
    const carded = bot(`${redTeamGateMarker(PR, HEAD, 'card-queued', resultId)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${HEAD.slice(0, 12)}\`:\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z');
    expect(() => planRedTeamRuling(read({ comments: thread([carded]) }), input())).toThrow(/no red-team break is held/);
  });
  it('plans block and not-real, and the ambiguity message lists the choices', () => {
    expect(planRedTeamRuling(read(), input({ ruling: 'block' }))).toMatchObject({ effect: RED_TEAM_RULING_BLOCK_EFFECT });
    expect(planRedTeamRuling(read(), input({ ruling: 'not-real', break: 'backlog/x.md:24' }))).toMatchObject({ effect: RED_TEAM_RULING_NOT_REAL_EFFECT, indices: [1] });
    const held = [{ index: 1, file: 'a', line: 1, summary: 's' }, { index: 2, file: 'a', line: 1, summary: 't' }];
    expect(() => selectBreaks(held, 'a:1')).toThrow(/ambiguous/);
    expect(selectBreaks(held, '#1,2').map((f) => f.index)).toEqual([1, 2]);
  });
  it('quotes the reason without a way to forge a marker', () => {
    const body = buildRuleReasonComment({ head: HEAD, ruling: 'card', actor: 'chalbert', channel: 'c', at: 't', reason: 'x\n<!-- we:red-team-gate pr=1 -->', findings: [{ index: 1, file: 'a', line: 1, summary: 's' }] });
    expect(body.split('\n').some((l) => l.startsWith('<!--'))).toBe(false);
    expect(body).toContain('> x');
  });
});

/** A fake PR whose thread grows as the sinks post, so the read-back proves the gate released the break. */
function fake({ cardOk = true, postFails = null, liveHead = HEAD, labels = [] } = {}) {
  const comments = thread();
  const posted = [], cards = [], labelCalls = [];
  const sinks = createRecordRedTeamRulingSinks({
    readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
    fileCard: (c) => { cards.push(c); return cardOk ? { ok: true, session: 'red-team-card-1' } : { ok: false, error: 'spawn failed' }; },
    post: (r, n, body) => { if (postFails?.(body)) throw new Error('gh down'); posted.push(body); comments.push(bot(body, '2026-10-20T23:55:00Z')); },
    runSetLabel: (exe, args) => { labelCalls.push(args); return '{"ok":true}'; },
    appendEvents: async () => {}, warn: () => {},
  });
  return { sinks, posted, cards, labelCalls, comments };
}
const payloadFor = (over = {}) => planRedTeamRuling(read(), input(over));
const heldAfter = (comments) => readRedTeamDisposition({ comments, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS }).held;

describe('sinks', () => {
  it('card: queues the card, posts the gate record then the reason, and the break stops being held', () => {
    const f = fake();
    expect(heldAfter(f.comments)).toHaveLength(1);
    const p = payloadFor();
    expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ ruling: 'card', indices: [1] });
    expect(f.cards).toHaveLength(1);
    expect(f.posted[0]).toMatch(/^<!-- we:red-team-gate pr=5530 rev=d3bee7370\w+ outcome=card-queued result=[0-9a-f]{16} -->/);
    expect(f.posted[0]).toContain('filed as a follow-up card (#1)');
    expect(f.posted[1]).toContain('> card it, ship the PR');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('card: a second run refuses (no duplicate card)', () => {
    const f = fake();
    f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor());
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/no longer held/);
    expect(f.cards).toHaveLength(1);
  });
  it('card: a card that was not queued records nothing', () => {
    const f = fake({ cardOk: false });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not queued/);
    expect(f.posted).toEqual([]);
  });
  it('card: a record that cannot be posted says a re-run would duplicate', () => {
    const f = fake({ postFails: () => true });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/DUPLICATE/);
  });
  it('refuses a moved head or a PR that moved to review:changes, writing nothing', () => {
    const moved = fake({ liveHead: OTHER });
    expect(() => moved.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/head moved/);
    const changes = fake({ labels: [{ name: 'review:changes' }] });
    expect(() => changes.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/review:changes/);
    expect(moved.cards.length + moved.posted.length + changes.cards.length + changes.posted.length).toBe(0);
  });
  it('not-real: leaves the break advisory and clears nothing else', () => {
    const f = fake();
    f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real' }));
    expect(f.cards).toEqual([]);
    expect(f.posted[0]).toContain('outcome=operator-not-real');
    expect(f.posted[1]).toContain('does not clear `review:human`');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('block: sends back through review-set-label --to=changes with the operator as actor', async () => {
    const f = fake();
    await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }))).resolves.toMatchObject({ sentBack: true });
    expect(f.labelCalls[0]).toEqual(expect.arrayContaining(['5530', '--repo=o/r', '--to=changes', '--actor=chalbert', '--channel=claude-code-chat']));
    expect(f.posted).toEqual([]);
  });
});

describe('operation', () => {
  it('declares one effect of the planned kind, none on preview', () => {
    const op = recordRedTeamRulingOperation({ readRulingContext: () => read() });
    const write = op.steps.find((s) => s.name === 'write').step;
    const verdict = planRedTeamRuling(read(), input());
    expect(write.effects({ verdict, input: {} }).map((e) => [e.type, e.idempotent])).toEqual([[RED_TEAM_RULING_CARD_EFFECT, false]]);
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
    expect(() => recordRedTeamRulingOperation({})).toThrow(/needs a/);
  });
  it('the reader pins the live head, labels, thread and setting', () => {
    const r = createRecordRedTeamRulingReader({ assertFresh: () => {}, readThread: () => ({ headRefOid: HEAD.toUpperCase(), labels: [], comments: thread() }),
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), now: () => 'T' })({ repo, pr: PR });
    expect(r).toMatchObject({ head: HEAD, now: 'T', setting: CONFIRMED_BREAKS_DEFAULTS });
  });
  it('the queue suggestions name the declared operation', () => {
    expect(redTeamRulingCommands(repo, PR).card).toContain('run.mjs record-red-team-ruling --pr=5530 --repo=o/r');
  });
});
