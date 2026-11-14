/**
 * Live #6732 (2026-11-14): an operator send-back, then four fix rounds that each pushed a real fix and ended their turn
 * on a verify wait, so no `## Fix evidence` comment ever carried the marker. The orphan guard re-dispatched a fixer
 * every time. The launcher now posts the evidence itself, only for a moved head whose CI `test` check is green.
 */
import { describe, expect, it, vi } from 'vitest';
import { planOrphanFixRound, runOrphanFixRoundPass } from '../orphan-fix-round.mjs';
import { FIX_BEGIN_MARKER, FIX_END_MARKER } from '../fix-procedure.mjs';
import { CHANGES_VERDICT_PREFIX } from '../../review-set-label.mjs';
import { openOperatorSendBacks, renderOperatorSendBackReviewBlock } from '../../lib/operator-send-backs.mjs';

const BOT = { login: 'web-everything' };
const c = (createdAt, body, author = BOT, extra = {}) => ({ createdAt, includesCreatedEdit: false, body, author, ...extra });
const NOW = Date.parse('2026-11-14T12:00:00Z');
const OLD = '8dbb6ad552c1e3e81a83697cf0cc4d5c5360005c', MID = '4d88cc44ff0000000000000000000000000000aa', TIP = '1efa95327d6186a88fe46dca3c2a604cdfa50401';
const VERDICT = c('2026-11-13T19:57:43Z', `${CHANGES_VERDICT_PREFIX}\n\nRecorded by agent.\n\nNet basis: \`0c6c1fb5caf43602aeff444ed5731b4c39e1c1ec..${OLD}\``);
const SEND_BACK = c('2026-11-13T21:12:31Z', '🔁 review — changes requested\n\nRecorded by chalbert via babysitter.\n\nTwo red-team breaks at head 8dbb6ad5. Fix exactly these:\n\n1. plan.mjs:538 keep the audit hold.\n2. plan.mjs:793 carry pinnedFrom.',
  { login: 'chalbert' }, { id: 'IC_kwDOsendback', url: 'https://github.com/web-everything/web-everything/pull/6732#issuecomment-6865040314' });
const begin = (sha, at) => c(at, `${FIX_BEGIN_MARKER}\n\n**Who:** \`fix-6732\`\n**Why:** conveyor fix\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\``);
const end = (sha, at) => c(at, `${FIX_END_MARKER}\n\n\`fix-6732\` released the fix claim at \`${sha.slice(0, 9)}\`.`);
const test = state => ({ name: 'test', conclusion: state, status: 'COMPLETED' });
const pr = (comments, extra = {}) => ({ number: 6732, labels: [{ name: 'review:changes' }], headRefOid: TIP, isDraft: false,
  statusCheckRollup: [test('SUCCESS')], comments, ...extra });
const thread = (endSha = TIP, beginSha = OLD) => [VERDICT, SEND_BACK, begin(beginSha, '2026-11-14T09:30:27Z'), end(endSha, '2026-11-14T11:03:37Z')];

describe('launcher-owned fix evidence for an operator send-back (#6732)', () => {
  it('re-arms with a launcher evidence comment when the round moved the head and test is green', () => {
    const plan = planOrphanFixRound({ pr: pr(thread()), nowMs: NOW });
    expect(plan.decision).toBe('rearm');
    expect(plan.evidence.body).toMatch(/^## Fix evidence\n/);
    expect(plan.evidence.body).toContain(`Head: \`${TIP}\``);
    expect(plan.evidence.body).toContain('<!-- addresses-operator-send-back: IC_kwDOsendback -->');
    expect(plan.evidence.body).toMatch(/test.*SUCCESS/);
    expect(plan.evidence.body).toContain(`${OLD.slice(0, 9)}..${TIP.slice(0, 9)}`);
  });

  it('the posted comment resolves the send-back through the unchanged reader, and the review block still lists it before', () => {
    const comments = thread();
    expect(renderOperatorSendBackReviewBlock(openOperatorSendBacks({ headRefOid: TIP, comments }))).toContain('must NOT accept');
    const { evidence } = planOrphanFixRound({ pr: pr(comments), nowMs: NOW });
    const posted = c('2026-11-14T12:01:00Z', evidence.body);
    expect(openOperatorSendBacks({ headRefOid: TIP, comments: [...comments, posted] })).toEqual([]);
  });

  it('never on an empty round (head did not move since fix-begin)', () => {
    const plan = planOrphanFixRound({ pr: pr(thread(OLD), { headRefOid: OLD }), nowMs: NOW });
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it.each([
    ['test failed', [test('FAILURE')]],
    ['test still running', [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }]],
    ['no test check at all', []],
    ['rollup unreadable', undefined],
  ])('never before a green verify: %s', (_, rollup) => {
    const plan = planOrphanFixRound({ pr: pr(thread(), { statusCheckRollup: rollup }), nowMs: NOW });
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it('never when the verified head is not the head the round ended on', () => {
    const plan = planOrphanFixRound({ pr: pr(thread(MID)), nowMs: NOW });
    expect(plan.decision).toBe('redispatch');
  });

  it('never when no operator send-back is open', () => {
    const plan = planOrphanFixRound({ pr: pr([VERDICT, begin(OLD, '2026-11-14T09:30:27Z'), end(TIP, '2026-11-14T11:03:37Z')]), nowMs: NOW });
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it('after the evidence is posted, a retry re-arms instead of re-dispatching another fixer', () => {
    const { evidence } = planOrphanFixRound({ pr: pr(thread()), nowMs: NOW });
    const plan = planOrphanFixRound({ pr: pr([...thread(), c('2026-11-14T12:01:00Z', evidence.body)]), nowMs: NOW });
    expect(plan.decision).toBe('rearm');
    expect(plan.evidence).toBeUndefined();
  });

  it('the pass posts the evidence first, then re-arms; a failed post re-arms nothing', async () => {
    const order = [];
    const seams = over => ({
      repos: [{ key: 'we', slug: 'web-everything/web-everything' }], nowMs: NOW, env: {},
      listBounced: () => [pr([])], readComments: async () => thread(), isOwned: async () => false,
      rearm: vi.fn(async () => { order.push('rearm'); return { ok: true }; }), redispatch: vi.fn(async () => ({ ok: true })),
      escalate: vi.fn(async () => ({ ok: true })),
      postComment: vi.fn(({ body }) => { order.push(body.startsWith('## Fix evidence') ? 'evidence' : 'marker'); }), ...over,
    });
    const ok = await runOrphanFixRoundPass(seams());
    expect(order).toEqual(['evidence', 'rearm', 'marker']);
    expect(ok.rows[0].result).toBe('re-armed');
    const failing = seams({ postComment: vi.fn(() => { throw new Error('gh down'); }) });
    const r = await runOrphanFixRoundPass(failing);
    expect(failing.rearm).not.toHaveBeenCalled();
    expect(r.rows[0].result).toMatch(/not-done|error/);
  });
});
