/**
 * @file Unit proof of the review loop's write plan: keep current human clearance,
 * while retaining advisories, new findings, and the existing unknown-state fallback.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../merge-ai-prs.mjs', async importOriginal => ({
  ...await importOriginal(),
  readNetDiffAtHead: () => ({ scored: true, text: 'f'.repeat(64) }),
}));
import replay from './fixtures/review-clearance-7140.json';
import * as label from '../review-set-label.mjs';
import { createReviewPrSinks } from '../operations/review-pr-io.mjs';
import { REVIEW_EFFECTS } from '../operations/review-pr.mjs';
import { parseLatestHumanClearedSha, decideReviewGate, REVIEW_LABELS } from '../lib/review-escalation.mjs';

const input = { keepHumanClearance: true, reviews: [], currentLabels: [REVIEW_LABELS.accepted], to: 'accepted', comments: replay.comments.slice(0, 2), headSha: replay.headSha, headDiff: replay.reviewedDiff };
const post = { advisory: true, verdict: true, label: true };
const keep = { advisory: true, verdict: false, label: false };

describe('review loop same-head human clearance', () => {
  it('review loop keeps a same-head clearance', () => {
    expect(label.reviewLoopWritePlan(input)).toEqual(keep);
  });

  it('a head push invalidates the clearance', () => {
    expect(label.reviewLoopWritePlan({ ...input, headSha: 'e58066c5' })).toEqual(post);
  });

  it('a different reviewed-diff fingerprint posts accept as today', () => {
    expect(label.reviewLoopWritePlan({ ...input, headDiff: 'a'.repeat(64) })).toEqual(post);
  });

  it('a NEW finding is still posted and still ends the clearance', () => {
    const plan = label.reviewLoopWritePlan({ ...input, to: 'changes' });
    expect(plan).toEqual(post);
    const decision = label.decideSetLabel({ to: 'changes', currentLabels: [REVIEW_LABELS.accepted], findingCount: 1, reason: 'New finding' });
    expect(decision.addLabel).toBe(REVIEW_LABELS.changes);
    expect(decision.removeLabels).toContain(REVIEW_LABELS.accepted);
    // Changes revoke the acceptance through labels; the clearance parser itself is unchanged.
    expect(decideReviewGate({ escalate: true, labels: [decision.addLabel], humanClearedSha: input.headSha }).action).toBe('wait-author');
  });

  it.each([null, undefined, {}, []])('unknown clearance state (%j) posts as today', comments => {
    expect(label.reviewLoopWritePlan({ ...input, comments })).toEqual(post);
  });

  it('unreadable clearance evidence posts as today', () => {
    const comments = [{ get author() { throw new Error('unreadable author'); } }];
    expect(label.reviewLoopWritePlan({ ...input, comments })).toEqual(post);
  });

  it('a missing head cannot suppress the verdict', () => {
    expect(label.reviewLoopWritePlan({ ...input, headSha: '' })).toEqual(post);
  });

  it('an unscored diff posts as today, even if both diff markers are missing', () => {
    const comments = input.comments.map(c => ({ ...c, body: c.body.replace(/<!-- reviewed-diff: .*? -->/g, '') }));
    expect(label.reviewLoopWritePlan({ ...input, comments, headDiff: '' })).toEqual(post);
  });

  it('untrusted clearance cannot suppress the verdict', () => {
    const comments = input.comments.map(c => ({ ...c, author: { login: 'outsider' } }));
    expect(label.reviewLoopWritePlan({ ...input, comments })).toEqual(post);
  });

  it('a superseded clearance cannot suppress a later accept', () => {
    expect(label.reviewLoopWritePlan({ ...input, comments: replay.comments })).toEqual(post);
  });

  it('replays #7140 without the plain accept that ended human clearance', () => {
    expect(parseLatestHumanClearedSha(replay.comments)).toBeNull();
    expect(parseLatestHumanClearedSha(input.comments)).toBe(input.headSha);
    const plan = label.reviewLoopWritePlan(input);
    const emitted = [...input.comments, ...(plan.verdict ? replay.comments.slice(2) : [])];
    expect(plan.advisory).toBe(true);
    expect(plan.label).toBe(false);
    expect(parseLatestHumanClearedSha(emitted)).toBe(input.headSha);
  });
});


afterEach(() => vi.restoreAllMocks());

describe('runReviewLabelCli clearance suppression', () => {
  async function run({ labels = ['review:accepted'], comments = input.comments, reviews = [], flag = true,
    push = false, fingerprint = 'f'.repeat(64), pinned = false, unreadableReviews = false,
    referralAppears = false } = {}) {
    const head = 'd'.repeat(40);
    const thread = comments.map(c => ({ ...c, body: c.body.replaceAll(replay.headSha, head)
      .replaceAll(replay.reviewedDiff, fingerprint) }));
    const calls = [];
    const emitted = [];
    let reads = 0;
    let liveLabels = [...labels];
    const provider = {
      readPrState: () => ({ labels: liveLabels, comments: thread, state: 'OPEN',
        headRefName: 'lane/test', headRefOid: ++reads > 1 && push ? 'e'.repeat(40) : head }),
      readPrReviews: () => { if (unreadableReviews) throw new Error('unreadable'); return reviews; },
      readLabels: () => liveLabels,
      setLabels: (_repo, _pr, spec) => { calls.push('label'); liveLabels = [spec.addLabel]; },
      postComment: () => calls.push('verdict'),
    };
    vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    let code = 0;
    // The loop delivers its advisory independently before invoking the label CLI.
    const advisory = vi.fn();
    const sinks = createReviewPrSinks({ postComment: advisory,
      readPublishHead: () => head, publishGate: () => ({ allowed: true, headSha: head }) });
    await sinks[REVIEW_EFFECTS.ADVISORY_NOTE]({ repo: 'o/n', pr: 7140, reviewedHead: head, body: 'review advisory' });
    try {
      label.runReviewLabelCli({ argv: ['7140', '--repo=o/n', '--to=accepted',
        ...(flag ? ['--keep-human-clearance'] : []),
        ...(pinned ? [`--expect-head=${head}`, `--expect-fingerprint=${'f'.repeat(64)}`] : [])],
        provider, defaultActor: 'test', usage: 'test', buildComment: () => 'accept verdict',
        successResult: o => ({ ok: true, ...o }), refusalResult: ({ decision }) => ({ error: decision.reason }),
        emit: line => emitted.push(JSON.parse(line)),
        referralOptions: { readRuns: () => referralAppears && reads > 1
          ? [{ repo: 'o/n', pr: 7140, head, persistenceFailed: true, completedAt: 1, startedAt: 1 }] : [] },
        appendLedgerVerdict: () => { calls.push('ledger'); return { ok: true }; },
        readTrialStore: () => ({}), logTrialFn: () => calls.push('trial'),
        fileApprovalPrevention: () => { calls.push('prevention'); return { ok: true }; },
      });
    } catch (e) { if (e.exitCode === undefined) throw e; code = e.exitCode; }
    return { calls, emitted, code, liveLabels, advisory, reads };
  }

  it('delivers advisory, preserves live accepted label and writes no accept verdict or ledger', async () => {
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.advisory).toHaveBeenCalledWith('o/n', 7140, 'review advisory');
    expect(r.calls).toEqual([]);
    expect(r.liveLabels).toEqual(['review:accepted']);
    expect(r.emitted[0].skipped).toContain('current human clearance');
    expect(r.reads).toBeGreaterThan(1);
  });

  it.each([
    ['later SHA-less changes verdict', { comments: [...input.comments, { author: { login: 'outsider' }, body: '🔁 review — changes requested\n\nRecorded by outsider.\n\nFix this' }] }],
    ['later review:changes objection', { comments: [...input.comments, { body: 'Keep review:changes until fixed' }] }],
    ['formal changes review', { reviews: [{ state: 'CHANGES_REQUESTED' }] }],
    ['unreadable formal reviews', { unreadableReviews: true }],
    ['missing accepted label', { labels: [] }],
    ['pending label', { labels: ['review:pending'] }],
    ['changes label', { labels: ['review:changes'] }],
    ['flag off', { flag: false }],
    ['different fingerprint', { fingerprint: 'a'.repeat(64) }],
  ])('%s posts as today', async (_name, options) => {
    const r = await run(options);
    expect(r.code).toBe(0);
    expect(r.calls).toContain('verdict');
    expect(r.calls).toContain('label');
    expect(r.calls).toContain('ledger');
    expect(r.emitted.at(-1).skipped).toBeUndefined();
  });

  it.each([false, true])('refuses a head push before suppression (pinned=%s)', async pinned => {
    const r = await run({ push: true, pinned });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.emitted.at(-1).error).toMatch(/head/);
  });

  it('refuses a newly mandatory referral before suppression', async () => {
    const r = await run({ referralAppears: true });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.emitted.at(-1).error).toContain('mandatory referral hold');
  });
});
