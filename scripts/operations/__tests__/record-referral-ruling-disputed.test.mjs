/**
 * @file record-referral-ruling-disputed.test.mjs — held item 132, live #4361 (head 5328ffbf). The ruling-dispute's
 *   findings were not "open" to the tool, so a `--finding` for the disputed block was refused ("matches no open
 *   finding on the live head"). The tool now lists them under `disputed` (with the disputed block's id), accepts
 *   `--finding` (+ `--supersedes`) for them, and names the block. Replays the exact live thread (fixture).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readReferralRecords, renderReferralRecord } from '../../lib/jury-core.mjs';
import { ignoredRulings } from '../../lib/ruling-ledger.mjs';
import { openReferralFindings, planOperatorRuling } from '../record-referral-ruling.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'conveyor', '__tests__', 'fixtures');
// Held item 141: the recorded threads below are no longer disputes. A later head's reviewer ruled each blocked finding
// not-real (fixed) with evidence, and that ruling was carried onto the live head; that satisfies the older block. To
// keep testing the supersede path on a GENUINE dispute, `asGenuineDispute` turns those reviewer clearances into `card`
// deferrals: a reviewer who defers a blocked finding to a card disagrees with the block, so the dispute stands while
// nothing is open on the head (the shape held item 132 fixed).
const DEFERRAL_CARD = 'we:backlog/xidoch3-build-delivered-evidence-hardening-follow-up-to-4361.md';
const asGenuineDispute = (fx) => ({ ...fx, comments: fx.comments.map((c) => {
  if (!/^[ \t]*<!-- mandatory-referrals-v1:/m.test(c.body ?? '')) return c;
  const [rec] = readReferralRecords([c]).records;
  if (!rec) return c;
  const toCard = (x) => (x.result === 'not-real' ? { ...x, result: 'card', card: DEFERRAL_CARD } : x);
  return { ...c, body: renderReferralRecord({ ...rec, rulings: rec.rulings.map(toCard), ...(rec.carried ? { carried: rec.carried.map(toCard) } : {}) }) };
}) });
const recorded = JSON.parse(readFileSync(join(dir, 'pr-4361-live-disputed.json'), 'utf8'));
const fx = asGenuineDispute(recorded);
const CARD = { requested: 'xidoch3', ref: 'we:backlog/x.md@pr4427', readable: true };
const BLOCK = 'review-pr-818f371c-ad92-48f4-909e-c0a52de29c37:0';
const LOC = 'scripts/conveyor/build-dispatch-orphan-adopt.mjs:393';
const o = openReferralFindings({ comments: fx.comments, repo: fx.repo, pr: fx.pr, head: fx.headRefOid, body: fx.body,
  createdAt: fx.createdAt, cardReadable: () => true });
const read = { head: fx.headRefOid, open: o.open, ruled: o.ruled, disputed: o.disputed, malformed: o.malformed, card: CARD,
  now: '2026-10-08T11:30:00.000Z', clearerId: 's' };
const input = (extra = {}) => ({ repo: fx.repo, pr: fx.pr, finding: LOC, ruling: 'card', actor: 'chalbert', channel: 'chat',
  reason: 'Card', ...extra });
const prOf = (comments) => ({ number: fx.pr, headRefOid: fx.headRefOid, body: fx.body, createdAt: fx.createdAt, labels: [], comments });

describe('live #4361: the disputed block is a valid supersede target', () => {
  it('held item 141: the recorded thread itself raises no dispute (the later reviewer not-real satisfied the block)', () => {
    expect(ignoredRulings(prOf(recorded.comments))).toBeNull();
  });
  it('the dispute is up, and the disputed finding is listed with the id of its block', () => {
    expect(ignoredRulings(prOf(fx.comments))?.matches.length).toBeGreaterThan(0);
    expect(o.disputed.map((d) => `${d.file}:${d.line}`)).toContain(LOC);
    expect(o.disputed.find((d) => d.line === 393).blockIds).toContain(BLOCK);
  });
  it('--finding for the disputed finding alone supersedes its block, and the dispute clears', () => {
    const plan = planOperatorRuling(read, input());
    expect(plan.supersedes).toEqual([BLOCK]);
    const after = [...fx.comments, { author: { login: 'chalbert' }, createdAt: read.now, body: plan.body }];
    expect(ignoredRulings(prOf(after))).toBeNull();
  });
  it('--finding with an explicit --supersedes works too', () => {
    expect(planOperatorRuling(read, input({ supersedes: BLOCK })).record.rulings[0].supersedes).toEqual([BLOCK]);
  });
  it('a refusal for an unrelated finding names the disputed block', () => {
    expect(() => planOperatorRuling(read, input({ finding: 'scripts/conveyor/build-delivery-evidence.mjs:52' })))
      .toThrow(new RegExp(`DISPUTED BLOCK \\(supersede this one\\): ${BLOCK}`));
  });
});
