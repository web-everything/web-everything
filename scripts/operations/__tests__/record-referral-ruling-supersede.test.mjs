/**
 * @file record-referral-ruling-supersede.test.mjs — held item 132 (card x5obpr2). A `block` ruling CARRIED onto a new
 *   head left the finding neither pending nor blocked, so `record-referral-ruling` refused ("no open findings") while
 *   the daemon kept reporting a `ruling-dispute`, and the operator's later `card` / `not-real` could never be recorded.
 *   Replays the real comment sequences of the two PRs it hit (fixtures, newest referral snapshot per run):
 *     #4271 (head 8f07252b: four disputed findings) and #4361 (head 5328ffbf: build-dispatch-orphan-adopt.mjs:393).
 *   Every `it` that needs `--supersedes` or the new `ruled` list is RED on the old code.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mandatoryReferralState, operatorRulingId, parseOperatorRulingComment, readOperatorRulings } from '../../lib/jury-core.mjs';
import { ignoredRulings, rulingNeeded } from '../../lib/ruling-ledger.mjs';
import { planRulingNeededLabel } from '../../conveyor/ruling-needed-sweep.mjs';
import { openReferralFindings, planOperatorRuling } from '../record-referral-ruling.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conveyor', '__tests__', 'fixtures');
const load = (name) => JSON.parse(readFileSync(join(dir, name), 'utf8'));
const CARD = { requested: 'xidoch3', ref: 'we:backlog/xidoch3-build-delivered-evidence-hardening-follow-up-to-4361.md@pr4427', readable: true };
const NOW = '2026-10-08T11:30:00.000Z';

const cases = [
  { name: '#4271', fx: () => load('pr-4271-carried-block-dispute.json') },
  { name: '#4361', fx: () => load('pr-4361-carried-block-dispute.json') },
];

const ctxOf = (fx) => ({ repo: fx.repo, pr: fx.pr, head: fx.headRefOid, body: fx.body, createdAt: fx.createdAt, cardReadable: () => true });
const pr = (fx, comments = fx.comments, labels = []) => ({ number: fx.pr, headRefOid: fx.headRefOid, body: fx.body,
  createdAt: fx.createdAt, labels: labels.map((name) => ({ name })), comments });
const readOf = (fx, comments = fx.comments) => {
  const o = openReferralFindings({ comments, ...ctxOf(fx) });
  return { head: fx.headRefOid, open: o.open, ruled: o.ruled, malformed: o.malformed, card: CARD, now: NOW, clearerId: 'session-x' };
};
const input = (fx, extra = {}) => ({ repo: fx.repo, pr: fx.pr, finding: 'all-open', ruling: 'card', actor: 'chalbert',
  channel: 'claude-code-chat', reason: 'Operator 2026-10-08 ~06:55 ET in chat: "Card"', ...extra });
/** The block ids standing on the live head (what the refusal lists to the operator). */
const blockIds = (read) => [...new Set(read.ruled.flatMap((r) => r.standing.filter((s) => s.result === 'block').map((s) => s.id)))];
const post = (fx, plan, login = 'chalbert') => [...fx.comments, { author: { login }, createdAt: NOW, body: plan.body }];

describe.each(cases)('replay $name: a carried block can be superseded', ({ fx: loadFx }) => {
  const fx = loadFx();

  it('the sequence reproduces the bug: a dispute is up, and nothing is open to rule on', () => {
    expect(readOf(fx).open).toEqual([]);
    expect(ignoredRulings(pr(fx))?.matches.length).toBeGreaterThan(0);
    expect(rulingNeeded(pr(fx))?.findings.every((f) => f.reason === 'dispute')).toBe(true);
  });

  it('without --supersedes the refusal now names the standing rulings instead of only "nothing open"', () => {
    expect(() => planOperatorRuling(readOf(fx), input(fx))).toThrow(/--supersedes=<id>/);
  });

  it('a superseding card ruling is recorded, and the dispute and ruling-needed clear', () => {
    const read = readOf(fx);
    const ids = blockIds(read);
    expect(ids.length).toBeGreaterThan(0);
    const plan = planOperatorRuling(read, input(fx, { supersedes: ids.join(',') }));
    expect(plan.record.rulings.every((r) => r.result === 'card' && r.supersedes.length > 0)).toBe(true);
    const after = post(fx, plan);
    expect(parseOperatorRulingComment(after.at(-1))?.record).toBeTruthy();
    expect(ignoredRulings(pr(fx, after))).toBeNull();
    expect(rulingNeeded(pr(fx, after))).toBeNull();
    const state = mandatoryReferralState(after, ctxOf(fx));
    expect(state.malformed).toBe(false);
    expect(state.blocked).toEqual([]);
  });

  it('a superseding not-real ruling clears it too', () => {
    const read = { ...readOf(fx), card: null };
    const plan = planOperatorRuling(read, input(fx, { ruling: 'not-real', supersedes: blockIds(read).join(',') }));
    expect(ignoredRulings(pr(fx, post(fx, plan)))).toBeNull();
  });

  it('the block is only weakened by the operator: a forged copy from another login clears nothing', () => {
    const read = readOf(fx);
    const plan = planOperatorRuling(read, input(fx, { supersedes: blockIds(read).join(',') }));
    const forged = post(fx, plan, 'someone-else');
    expect(ignoredRulings(pr(fx, forged))?.matches.length).toBeGreaterThan(0);
    expect(rulingNeeded(pr(fx, forged))).not.toBeNull();
  });

  it('refuses a non-operator actor, a blank reason, an unknown id, and an id no selected finding uses', () => {
    const read = readOf(fx);
    const ids = blockIds(read).join(',');
    expect(() => planOperatorRuling(read, input(fx, { supersedes: ids, actor: 'web-everything' }))).toThrow(/operator login/);
    expect(() => planOperatorRuling(read, input(fx, { supersedes: ids, reason: '  ' }))).toThrow(/--reason/);
    expect(() => planOperatorRuling(read, input(fx, { supersedes: 'review-pr-nope:0' }))).toThrow(/names no standing ruling/);
    const first = read.ruled[0];
    const other = read.ruled.flatMap((r) => r.rulingIds).find((id) => !first.rulingIds.includes(id));
    if (other) {
      expect(() => planOperatorRuling(read, input(fx, { supersedes: `${first.rulingIds[0]},${other}`, finding: '1' }))).toThrow(/not a standing ruling on any selected finding/);
    }
  });

  it('a later operator block over the card is a fresh block on the head, so the finding is blocked again (not cleared)', () => {
    const read = readOf(fx);
    const afterCard = post(fx, planOperatorRuling(read, input(fx, { supersedes: blockIds(read).join(',') })));
    const read2 = readOf(fx, afterCard);
    const operatorIds = read2.ruled.flatMap((r) => r.standing.filter((s) => s.source === 'operator').map((s) => s.id));
    expect(operatorIds.length).toBeGreaterThan(0);
    const block = planOperatorRuling({ ...read2, card: null }, input(fx, { ruling: 'block', supersedes: operatorIds.join(',') }));
    const afterBlock = [...afterCard, { author: { login: 'chalbert' }, createdAt: NOW, body: block.body }];
    expect(mandatoryReferralState(afterBlock, ctxOf(fx)).blocked.length).toBeGreaterThan(0);
  });
});

describe('operator ruling ids', () => {
  it('are derived from the ruling, stable, and differ per finding', () => {
    const a = { head: 'a'.repeat(40), runId: 'r', key: 'k1', at: 't' };
    expect(operatorRulingId(a)).toBe(operatorRulingId({ ...a }));
    expect(operatorRulingId(a)).not.toBe(operatorRulingId({ ...a, key: 'k2' }));
  });
  it('a ruling record with a malformed supersedes list is not read (a hold, never a clearance)', () => {
    const fx = load('pr-4361-carried-block-dispute.json');
    const read = readOf(fx);
    const plan = planOperatorRuling(read, input(fx, { supersedes: blockIds(read).join(',') }));
    const trailer = /<!-- mandatory-referral-operator-ruling-v1: ([A-Za-z0-9+/=]+) -->/.exec(plan.body)[1];
    const rec = JSON.parse(Buffer.from(trailer, 'base64').toString());
    rec.rulings[0].supersedes = 'not-a-list';
    const body = plan.body.replace(trailer, Buffer.from(JSON.stringify(rec)).toString('base64'));
    expect(readOperatorRulings([{ author: { login: 'chalbert' }, body }]).malformed).toBe(true);
    expect(readOperatorRulings([{ author: { login: 'chalbert' }, body }]).rulings).toEqual([]);
  });
});

describe('advisory:ruling-needed is dropped when the PR is accepted', () => {
  const fx = load('pr-4271-carried-block-dispute.json');
  it('a disputed PR that carries review:accepted needs no ruling, and the stale label is removed', () => {
    expect(rulingNeeded(pr(fx))).not.toBeNull();
    const accepted = pr(fx, fx.comments, ['review:accepted', 'advisory:ruling-needed']);
    expect(rulingNeeded(accepted)).toBeNull();
    expect(planRulingNeededLabel(accepted)).toMatchObject({ action: 'remove' });
  });
  it('the label is removed once nothing is pending or disputed, and is not added to an accepted PR', () => {
    expect(planRulingNeededLabel(pr(fx, fx.comments, ['review:accepted']))).toMatchObject({ action: 'none' });
    expect(planRulingNeededLabel(pr(fx, fx.comments, ['review:human']))).toMatchObject({ action: 'add' });
  });
});
