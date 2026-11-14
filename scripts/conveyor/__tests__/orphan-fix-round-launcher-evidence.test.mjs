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
const SEND_BACK = c('2026-11-13T21:12:31Z', '🔁 review — changes requested\n\nRecorded by chalbert via babysitter.\n\nTwo red-team breaks at head 8dbb6ad5. Fix exactly these:\n\n1. scripts/lib/daemon-rebuild/plan.mjs:538 keep the audit hold.\n2. scripts/lib/daemon-rebuild/plan.mjs:793 carry pinnedFrom.',
  { login: 'chalbert' }, { id: 'IC_kwDOsendback', url: 'https://github.com/web-everything/web-everything/pull/6732#issuecomment-6865040314' });
const begin = (sha, at) => c(at, `${FIX_BEGIN_MARKER}\n\n**Who:** \`fix-6732\`\n**Why:** conveyor fix\n**Branch:** \`lane/x\` at \`${sha.slice(0, 9)}\``);
const end = (sha, at) => c(at, `${FIX_END_MARKER}\n\n\`fix-6732\` released the fix claim at \`${sha.slice(0, 9)}\`.`);
const test = state => ({ name: 'test', conclusion: state, status: 'COMPLETED' });
const pr = (comments, extra = {}) => ({ number: 6732, labels: [{ name: 'review:changes' }], headRefOid: TIP, isDraft: false,
  statusCheckRollup: [test('SUCCESS')], comments, ...extra });
const CHANGED = ['scripts/lib/daemon-rebuild/plan.mjs', 'scripts/lib/__tests__/daemon-rebuild-audited-tip.test.mjs'];
const changedFiles = vi.fn(() => CHANGED);
const lineCount = vi.fn(() => 900);
const run = (p, extra = {}) => planOrphanFixRound({ pr: p, nowMs: NOW, changedFiles, lineCount, ...extra });
const thread = (endSha = TIP, beginSha = OLD) => [VERDICT, SEND_BACK, begin(beginSha, '2026-11-14T09:30:27Z'), end(endSha, '2026-11-14T11:03:37Z')];

describe('launcher-owned fix evidence for an operator send-back (#6732)', () => {
  it('re-arms with a launcher evidence comment when the round moved the head and test is green', () => {
    const plan = run(pr(thread()));
    expect(plan.decision).toBe('rearm');
    expect(plan.evidence.body).toMatch(/^## Fix evidence\n/);
    expect(plan.evidence.body).toContain(`Head: \`${TIP}\``);
    expect(plan.evidence.body).toContain('<!-- addresses-operator-send-back: IC_kwDOsendback -->');
    expect(plan.evidence.body).toMatch(/test.*SUCCESS/);
    expect(plan.evidence.body).toContain('- send-back IC_kwDOsendback item 1: scripts/lib/daemon-rebuild/plan.mjs:538');
    expect(plan.evidence.body).toContain('- send-back IC_kwDOsendback item 2: scripts/lib/daemon-rebuild/plan.mjs:793');
    expect(changedFiles).toHaveBeenCalledWith(OLD.slice(0, 9), TIP.slice(0, 9));
    expect(plan.evidence.body).toContain(`${OLD.slice(0, 9)}..${TIP.slice(0, 9)}`);
  });

  it('the posted comment resolves the send-back through the unchanged reader, and the review block still lists it before', () => {
    const comments = thread();
    expect(renderOperatorSendBackReviewBlock(openOperatorSendBacks({ headRefOid: TIP, comments }))).toContain('must NOT accept');
    const { evidence } = run(pr(comments));
    const posted = c('2026-11-14T12:01:00Z', evidence.body);
    expect(openOperatorSendBacks({ headRefOid: TIP, comments: [...comments, posted] })).toEqual([]);
  });

  it('never on an empty round (head did not move since fix-begin)', () => {
    const plan = run(pr(thread(OLD), { headRefOid: OLD }));
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it.each([
    ['test failed', [test('FAILURE')]],
    ['test still running', [{ name: 'test', status: 'IN_PROGRESS', conclusion: '' }]],
    ['no test check at all', []],
    ['rollup unreadable', undefined],
  ])('never before a green verify: %s', (_, rollup) => {
    const plan = run(pr(thread(), { statusCheckRollup: rollup }));
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it('never when the verified head is not the head the round ended on', () => {
    const plan = run(pr(thread(MID)));
    expect(plan.decision).toBe('redispatch');
  });

  it('never claims an item whose cited file the round did not change (the review obligation stays)', () => {
    for (const files of [['README.md'], ['scripts/lib/daemon-rebuild/plan.mjs'].slice(0, 0), null]) {
      const plan = run(pr(thread()), { changedFiles: () => files });
      expect(plan.decision).toBe('redispatch');
      expect(plan.evidence).toBeUndefined();
    }
    const half = run(pr(thread()), { changedFiles: () => ['scripts/lib/daemon-rebuild/plan.mjs'] });
    expect(half.decision).toBe('rearm');
    const second = SEND_BACK.body.replace('scripts/lib/daemon-rebuild/plan.mjs:793', 'scripts/lib/other.mjs:9');
    const split = run(pr([VERDICT, { ...SEND_BACK, body: second }, ...thread().slice(2)]), { changedFiles: () => ['scripts/lib/daemon-rebuild/plan.mjs'] });
    expect(split.decision).toBe('redispatch');
  });

  it('never cites a line that does not exist in the file at the verified head', () => {
    for (const count of [() => 500, () => { throw new Error('gone'); }, () => null]) {
      const plan = run(pr(thread()), { lineCount: count });
      expect(plan.decision).toBe('redispatch');
      expect(plan.evidence).toBeUndefined();
    }
    expect(lineCount).toHaveBeenCalledWith({ path: 'scripts/lib/daemon-rebuild/plan.mjs', head: TIP });
  });

  it('an unrelated launcher-style comment never counts: stale round, other head, or red test', () => {
    const forged = (at, head = TIP) => c(at, `## Fix evidence\n\nHead: \`${head}\`\n<!-- addresses-operator-send-back: IC_other -->\nx`);
    const base = thread();
    const noop = { changedFiles: () => [] };
    expect(run(pr([...base, forged('2026-11-14T11:30:00Z')]), noop).decision).toBe('rearm');
    expect(run(pr([VERDICT, forged('2026-11-14T08:00:00Z'), ...base.slice(1)]), noop).decision).toBe('redispatch');
    expect(run(pr([...base, forged('2026-11-14T11:30:00Z', OLD)]), noop).decision).toBe('redispatch');
    expect(run(pr([...base, forged('2026-11-14T11:30:00Z')], { statusCheckRollup: [test('FAILURE')] }), noop).decision).toBe('redispatch');
  });

  it('never without a changed-files reader or for a request without a citable file', () => {
    expect(planOrphanFixRound({ pr: pr(thread()), nowMs: NOW }).decision).toBe('redispatch');
    const vague = { ...SEND_BACK, body: '🔁 review — changes requested\n\nRecorded by chalbert via babysitter.\n\nPlease make it better.' };
    expect(run(pr([VERDICT, vague, ...thread().slice(2)])).decision).toBe('redispatch');
  });

  it('never for a send-back posted after the round began (the fixer never saw it)', () => {
    const late = { ...SEND_BACK, createdAt: '2026-11-14T10:00:00Z' };
    const plan = run(pr([VERDICT, begin(OLD, '2026-11-14T09:30:27Z'), late, end(TIP, '2026-11-14T11:03:37Z')]));
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it('never when no operator send-back is open', () => {
    const plan = run(pr([VERDICT, begin(OLD, '2026-11-14T09:30:27Z'), end(TIP, '2026-11-14T11:03:37Z')]));
    expect(plan.decision).toBe('redispatch');
    expect(plan.evidence).toBeUndefined();
  });

  it('after the evidence is posted, a retry re-arms instead of re-dispatching another fixer', () => {
    const { evidence } = run(pr(thread()));
    const plan = run(pr([...thread(), c('2026-11-14T12:01:00Z', evidence.body)]));
    expect(plan.decision).toBe('rearm');
    expect(plan.evidence).toBeUndefined();
  });

  it('the pass posts the evidence first, then re-arms; a failed post re-arms nothing', async () => {
    const order = [];
    const seams = over => ({
      repos: [{ key: 'we', slug: 'web-everything/web-everything' }], nowMs: NOW, env: {},
      listBounced: () => [pr([])], readComments: async () => thread(), changedFiles, lineCount, isOwned: async () => false,
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
