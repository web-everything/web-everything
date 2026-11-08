/**
 * @file record-referral-ruling-poster-credential.test.mjs — PR #6529 red team: the operator-ruling identity check must
 *   authenticate the SAME account that posts the ruling. `gh api user` is a classified read, so with personal-read
 *   routing on (`WE_GH_THROTTLE_PERSONAL_ROUTE=1` + the `reads` personal exception) the throttle swapped it onto the
 *   operator's personal login while `gh pr comment` (a write) kept the App token: the check passed as `chalbert` and
 *   the App posted a human-actor `not-real` ruling the gate reader accepts. The transport below reproduces that
 *   routing (a classified read goes personal unless the call pins `throttle.personalRoute: false`), and the REAL
 *   default `ghJson` + `post` of the sinks run through it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ calls: [], thread: null, identityFallback: false }));

vi.mock('../../lib/gh-throttle.mjs', async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    // The routing `resolveGhPersonalRoute` applies with the opt-in on: a classified read is swapped onto the personal
    // token unless the call pins `personalRoute: false`; a write always keeps the caller's (App) credential.
    execFileSyncThrottled: (bin, args, opts = {}) => {
      // `identityFallback`: the App shim's per-call personal fallback on a token-cache miss hits ONLY the identity read.
      const personal = (transport.identityFallback && args[0] === 'api')
        || (orig.classifyGhRead(args) && (opts.throttle?.personalRoute ?? true)
          && String(opts.env?.WE_GH_THROTTLE_PERSONAL_ROUTE ?? '1') !== '0');
      const as = personal ? 'chalbert' : 'web-everything';
      transport.calls.push({ args, as });
      if (args[0] === 'api' && args[1] === 'user') {
        return JSON.stringify(personal ? { login: 'chalbert', type: 'User' } : { login: 'web-everything', type: 'Bot' });
      }
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(transport.thread);
      if (args[0] === 'pr' && args[1] === 'comment') {
        transport.thread.comments.push({ body: args[args.indexOf('--body') + 1], author: { login: as } });
        return '';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    },
  };
});

const { mandatoryReferralReviewer, normalizeFinding, readOperatorRulings, referralFindingKey, renderReferralRecord } = await import('../../lib/jury-core.mjs');
const { openReferralFindings, planOperatorRuling, OPERATOR_RULING_POST_EFFECT } = await import('../record-referral-ruling.mjs');
const { createRecordReferralRulingReader, createRecordReferralRulingSinks } = await import('../record-referral-ruling-io.mjs');

const repo = 'o/r';
const head = 'a'.repeat(40);
const gh = (body, login = 'web-everything') => ({ body, author: { login } });
const finding = { summary: 'protected list misses edits', file: 'scripts/x.mjs', verdict: 'CONFIRMED', impactIfUnfixed: 'broken' };
const seat = 'judgeCorrectnessAdvisory';
const runId = 'review-pr-1';
const rec = { version: 1, repo, pr: 7, head, runId, reviewer: mandatoryReferralReviewer(runId), authorBody: '<!-- authored-by-actor: author -->',
  attempted: true, referrals: [{ key: referralFindingKey(seat, finding), seat, original: finding, finding: normalizeFinding(finding) }], rulings: [] };

const plan = () => planOperatorRuling({ head, ...openReferralFindings({ comments: [gh(renderReferralRecord(rec))], repo, pr: 7, head, body: rec.authorBody, cardReadable: () => false }),
  identity: { login: 'chalbert', type: 'User' }, card: null, now: '2026-11-08T06:00:00Z', clearerId: 's' },
{ repo, pr: 7, finding: 'all-open', ruling: 'not-real', actor: 'chalbert', channel: 'claude-code-chat', reason: 'not real' });

beforeEach(() => {
  transport.calls.length = 0;
  transport.identityFallback = false;
  transport.thread = { headRefOid: head, body: rec.authorBody, createdAt: '2026-11-08T00:00:00Z', comments: [gh(renderReferralRecord(rec))] };
});

describe('PR #6529: the ruling identity check uses the poster\'s credential', () => {
  it('a not-real ruling posted with the App credential is refused, even with personal-read routing on', async () => {
    const events = [];
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async (list) => { events.push(...list); } })[OPERATOR_RULING_POST_EFFECT];
    const p = plan();
    await expect(sink({ repo, pr: 7, head, body: p.body, actor: 'chalbert', channel: 'claude-code-chat',
      rulings: p.record.rulings.map((r) => ({ runId: r.runId, key: r.key, result: r.result })) }))
      .rejects.toThrow(/not a human account|posting identity/);
    expect(transport.calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'comment')).toEqual([]);
    expect(events).toEqual([]);
    expect(readOperatorRulings(transport.thread.comments).rulings).toEqual([]);
    // The check and the post share one credential: the identity read never took the personal route.
    expect(transport.calls.find((c) => c.args[0] === 'api')).toMatchObject({ as: 'web-everything' });
  });

  it('a per-call fallback that splits the check from the post is caught on read-back and the clearing row reverted', async () => {
    transport.identityFallback = true; // the check authenticates as the operator; the post still lands as the App
    const events = [];
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async (list) => { events.push(...list); } })[OPERATOR_RULING_POST_EFFECT];
    const p = plan();
    await expect(sink({ repo, pr: 7, head, body: p.body, actor: 'chalbert', channel: 'claude-code-chat',
      rulings: p.record.rulings.map((r) => ({ runId: r.runId, key: r.key, result: r.result })) }))
      .rejects.toThrow(/authored by "web-everything", not the checked poster chalbert/);
    // The not-real row was recorded first (F4 order), then reverted by a holding block row: the finding stays held.
    expect(events.map((e) => e.ruling)).toEqual(['not-real', 'block']);
  });

  it('the reader reads the planning identity with the same pinned poster credential', () => {
    const seen = [];
    const readJson = (args, opts) => {
      seen.push({ args, opts });
      return args[0] === 'api' ? { login: 'web-everything', type: 'Bot' } : structuredClone(transport.thread);
    };
    const read = createRecordReferralRulingReader({ readJson, env: {}, log: () => {}, assertFresh: () => {}, changedLines: async () => ({}) })(
      { repo, pr: 7, actor: 'chalbert' });
    expect(read.identity).toEqual({ login: 'web-everything', type: 'Bot' });
    const identityRead = seen.find((c) => c.args[0] === 'api');
    expect(identityRead.opts).toMatchObject({ throttle: { personalRoute: false }, env: { GH_REPO: repo, WE_GH_THROTTLE_PERSONAL_ROUTE: '0' } });
  });
});
