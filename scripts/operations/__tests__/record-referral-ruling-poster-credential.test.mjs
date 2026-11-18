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

const transport = vi.hoisted(() => ({ calls: [], thread: null, identityFallback: false, postAs: null, deleteFails: false, nextId: 100 }));

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
      // `gh pr view --json comments` returns ONE page (100) of the thread, as the real one does.
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ ...transport.thread, comments: transport.thread.comments.slice(0, 100) });
      if (args[0] === 'pr' && args[1] === 'comment') {
        transport.thread.comments.push({ body: args[args.indexOf('--body') + 1], author: { login: transport.postAs ?? as },
          url: `https://github.com/${repo}/pull/7#issuecomment-${transport.nextId++}` });
        return '';
      }
      // The compensating delete of a wrong-author ruling comment (`gh api --method DELETE repos/<repo>/issues/comments/<id>`).
      if (args[0] === 'api' && args.includes('DELETE')) {
        if (transport.deleteFails) throw new Error('HTTP 403: Resource not accessible');
        const id = /\/issues\/comments\/(\d+)$/.exec(args.at(-1))?.[1];
        transport.thread.comments = transport.thread.comments.filter((c) => !String(c.url ?? '').endsWith(`#issuecomment-${id}`));
        return '';
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    },
  };
});

const { buildOperatorRulingComment, validateOperatorRuling, mandatoryReferralReviewer, mandatoryReferralState, normalizeFinding, readOperatorRulings, referralFindingKey, renderReferralRecord } = await import('../../lib/jury-core.mjs');
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

const repo7 = { repo, pr: 7, head };
const gatePending = () => mandatoryReferralState(transport.thread.comments, repo7).pending;
const sinkArgs = (p) => ({ ...repo7, body: p.body, actor: 'chalbert', channel: 'claude-code-chat',
  rulings: p.record.rulings.map((r) => ({ runId: r.runId, key: r.key, result: r.result })) });

beforeEach(() => {
  transport.calls.length = 0;
  transport.identityFallback = false;
  transport.postAs = null;
  transport.deleteFails = false;
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
    // Round 2 red team: the COMMENT-based gate must stay held too. The App-authored ruling comment is trusted by the
    // gate reader, so the sink deletes it and confirms it is gone; the finding is still pending.
    expect(readOperatorRulings(transport.thread.comments).rulings).toEqual([]);
    expect(gatePending()).toEqual([rec.referrals[0].key]);
    expect(transport.calls.filter((c) => c.args[0] === 'api' && c.args.includes('DELETE'))).toHaveLength(1);
  });

  it('a post that throws after the comment landed (lost reply) still removes the wrong-author comment', async () => {
    transport.identityFallback = true;
    const events = [];
    const post = (r, pr, body) => {
      transport.thread.comments.push({ body, author: { login: 'web-everything' }, url: `https://github.com/${r}/pull/${pr}#issuecomment-${transport.nextId++}` });
      throw new Error('gh: request timed out');
    };
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, post, appendEvents: async (list) => { events.push(...list); } })[OPERATOR_RULING_POST_EFFECT];
    await expect(sink(sinkArgs(plan()))).rejects.toThrow(/request timed out[\s\S]*removed/);
    expect(events.map((e) => e.ruling)).toEqual(['not-real', 'block']);
    expect(readOperatorRulings(transport.thread.comments).rulings).toEqual([]);
    expect(gatePending()).toEqual([rec.referrals[0].key]);
  });

  it('a wrong-author comment that cannot be deleted is named LIVE in the error, and the ledger is still reverted', async () => {
    transport.identityFallback = true;
    transport.deleteFails = true;
    const events = [];
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async (list) => { events.push(...list); } })[OPERATOR_RULING_POST_EFFECT];
    const error = await sink(sinkArgs(plan())).then(() => null, (e) => e);
    expect(events.map((e) => e.ruling)).toEqual(['not-real', 'block']);
    // Round 3 red team: a failed cleanup must not leave the unauthorized ruling effective. The App-authored copy of a
    // human-actor ruling stays on the thread, and the gate reader ignores it, so the referral is still pending.
    expect(transport.thread.comments.filter((c) => c.author.login === 'web-everything' && c.body.includes('Operator ruling'))).toHaveLength(1);
    expect(readOperatorRulings(transport.thread.comments).rulings).toEqual([]);
    expect(gatePending()).toEqual([rec.referrals[0].key]);
    expect(String(error?.message)).toMatch(/issuecomment-\d+ is still on the thread/);
  });

  it('a stray left by a failed cleanup does not block the operator\'s own re-run: the re-posted ruling clears', async () => {
    transport.identityFallback = true;
    transport.deleteFails = true;
    const first = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async () => {} })[OPERATOR_RULING_POST_EFFECT];
    const p = plan();
    await expect(first(sinkArgs(p))).rejects.toThrow(/still on the thread/);
    // The operator re-runs with the credential fixed; the stray (same body) is still there, so the sink re-posts nothing
    // and refuses again: the operator posts it under their own login (a fresh `at` makes a new body).
    transport.postAs = 'chalbert';
    transport.deleteFails = false;
    const again = planOperatorRuling({ head, ...openReferralFindings({ comments: transport.thread.comments, repo, pr: 7, head, body: rec.authorBody, cardReadable: () => false }),
      identity: { login: 'chalbert', type: 'User' }, card: null, now: '2026-11-08T07:00:00Z', clearerId: 's' },
    { repo, pr: 7, finding: 'all-open', ruling: 'not-real', actor: 'chalbert', channel: 'claude-code-chat', reason: 'not real' });
    const second = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async () => {} })[OPERATOR_RULING_POST_EFFECT];
    await expect(second(sinkArgs(again))).resolves.toMatchObject({ posted: true });
    expect(gatePending()).toEqual([]);
  });

  it('on a thread past one page the wrong-author comment is found through the complete reader and deleted', async () => {
    transport.identityFallback = true;
    for (let i = 0; i < 100; i++) transport.thread.comments.push(gh(`filler ${i}`, 'someone'));
    const events = [];
    const readAllComments = () => structuredClone(transport.thread.comments);
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, readAllComments, appendEvents: async (list) => { events.push(...list); } })[OPERATOR_RULING_POST_EFFECT];
    await expect(sink(sinkArgs(plan()))).rejects.toThrow(/removed the wrong-author ruling comment/);
    expect(events.map((e) => e.ruling)).toEqual(['not-real', 'block']);
    expect(readOperatorRulings(transport.thread.comments).rulings).toEqual([]);
    expect(gatePending()).toEqual([rec.referrals[0].key]);
  });

  it('a long thread whose complete read fails is reported as possibly LIVE, never as "no stray"', async () => {
    transport.identityFallback = true;
    for (let i = 0; i < 100; i++) transport.thread.comments.push(gh(`filler ${i}`, 'someone'));
    const readAllComments = () => { throw new Error('comment count proof failed'); };
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, readAllComments, appendEvents: async () => {} })[OPERATOR_RULING_POST_EFFECT];
    await expect(sink(sinkArgs(plan()))).rejects.toThrow(/could not re-read the thread[\s\S]*may still be on the thread/);
  });

  it('the poster stamp binds the author: only that operator may post it; it can name no one else', () => {
    const p = plan();
    expect(p.record.poster).toBe('chalbert');
    expect(readOperatorRulings([gh(p.body, 'chalbert')]).rulings).toHaveLength(1);
    expect(readOperatorRulings([gh(p.body, 'CHALBERT')]).rulings).toHaveLength(1);
    // An automation copy is not a ruling at all (null), not a malformed hold that would block the operator's re-run.
    expect(readOperatorRulings([gh(p.body, 'web-everything')])).toEqual({ rulings: [], malformed: false });
    expect(validateOperatorRuling({ ...p.record, poster: 'web-everything' })).toBe(false);
    expect(validateOperatorRuling({ ...p.record, poster: 'Chalbert' })).toBe(false);
    expect(validateOperatorRuling({ ...p.record, actor: 'auto-policy', poster: 'auto-policy', rulings: p.record.rulings.map((r) => ({ ...r, result: 'block', lens: undefined })) })).toBe(false);
    // A legacy (unstamped) record keeps the trusted-author rule only when GitHub dated it before poster stamping
    // shipped (PR #5925: automation-posted operator rulings recorded before the stamp).
    const { poster, ...legacy } = p.record;
    expect(poster).toBe('chalbert');
    expect(readOperatorRulings([{ ...gh(buildOperatorRulingComment(legacy), 'web-everything'), createdAt: '2026-10-01T00:00:00Z', includesCreatedEdit: false }]).rulings).toHaveLength(1);
  });

  describe('PR #6529 red team (result 5acf690a8e9b87a6): omitting poster cannot bypass the author binding', () => {
    const CUTOFF = '2026-11-08T12:22:33Z';
    const record = (results) => ({ version: 1, repo, pr: 7, head, actor: 'chalbert', channel: 'claude-code-chat', reason: 'unstamped copy',
      at: '2026-11-09T10:00:00Z', clearerId: 's',
      rulings: results.map((result, i) => ({ runId, key: `${rec.referrals[0].key}${i ? `#${i}` : ''}`, result, ...(result === 'card' ? { card: 'we:backlog/1234-x.md' } : {}) })) });
    const at = (body, login, when) => ({ ...gh(body, login), ...(when === undefined ? {} : { createdAt: when }) });
    const results = (comments) => readOperatorRulings(comments).rulings.map((r) => r.result);

    it('the red-team shape — actor chalbert, not-real, no poster, bot author, fresh createdAt — is no ruling', () => {
      const body = buildOperatorRulingComment(record(['not-real']));
      expect(readOperatorRulings([at(body, 'web-everything', '2026-11-09T11:00:00Z')])).toEqual({ rulings: [], malformed: false });
      // Nor does it clear the comment gate.
      const thread = [gh(renderReferralRecord(rec)), at(body, 'web-everything', '2026-11-09T11:00:00Z')];
      expect(mandatoryReferralState(thread, repo7).pending).toEqual([rec.referrals[0].key]);
    });

    it.each([
      ['after the cutoff', '2026-11-09T11:00:00Z'],
      ['exactly at the cutoff', CUTOFF],
      ['with no createdAt', undefined],
      ['with an unparseable createdAt', 'not-a-date'],
    ])('an unstamped automation copy dated %s keeps only its block rows', (_label, when) => {
      const body = buildOperatorRulingComment(record(['not-real', 'block', 'card']));
      expect(results([at(body, 'web-everything', when)])).toEqual(['block']);
      expect(readOperatorRulings([at(buildOperatorRulingComment(record(['card'])), 'web-everything', when)])).toEqual({ rulings: [], malformed: false });
    });

    // The creation-date half on its own: a full edit proof never rescues a comment GitHub dated at/after the cutoff.
    it.each([
      ['after the cutoff', '2026-11-09T11:00:00Z'],
      ['exactly at the cutoff', CUTOFF],
      ['missing', undefined],
    ])('an unedited automation copy whose createdAt is %s keeps only its block rows', (_label, when) => {
      const body = buildOperatorRulingComment(record(['not-real', 'block', 'card']));
      expect(results([{ ...at(body, 'web-everything', when), includesCreatedEdit: false, updatedAt: '2026-10-01T00:00:00Z' }])).toEqual(['block']);
    });

    it('the REST spellings created_at / updated_at are read the same way', () => {
      const body = buildOperatorRulingComment(record(['not-real', 'block']));
      expect(results([{ ...gh(body, 'web-everything'), created_at: '2026-11-09T11:00:00Z', updated_at: '2026-11-09T11:00:00Z' }])).toEqual(['block']);
      expect(results([{ ...gh(body, 'web-everything'), created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }])).toEqual(['not-real', 'block']);
    });

    it('an unstamped, unedited automation copy dated before the cutoff keeps every row (legacy PR #5925)', () => {
      const body = buildOperatorRulingComment(record(['not-real', 'block', 'card']));
      expect(results([{ ...at(body, 'web-everything', '2026-11-08T12:22:32Z'), includesCreatedEdit: false }])).toEqual(['not-real', 'block', 'card']);
      expect(results([{ ...at(body, 'web-everything', '2026-11-08T12:22:32Z'), updatedAt: '2026-11-08T12:22:32Z' }])).toEqual(['not-real', 'block', 'card']);
    });

    // GitHub keeps created_at when a comment is edited: an old automation comment rewritten into a fresh unstamped
    // clearing ruling must not borrow its creation date.
    it.each([
      ['edited (GraphQL includesCreatedEdit)', { includesCreatedEdit: true }],
      ['edited after the cutoff (REST updated_at)', { updated_at: '2026-11-09T11:00:00Z' }],
      ['edited exactly at the cutoff', { updatedAt: CUTOFF }],
      ['with no edit metadata', {}],
      ['with an unparseable updated_at', { updated_at: 'never' }],
    ])('a pre-cutoff automation copy %s keeps only its block rows', (_label, meta) => {
      const body = buildOperatorRulingComment(record(['not-real', 'block', 'card']));
      expect(results([{ ...at(body, 'web-everything', '2026-10-01T00:00:00Z'), ...meta }])).toEqual(['block']);
    });

    it('an unstamped ruling authored by an operator stays valid whatever its date', () => {
      const body = buildOperatorRulingComment(record(['not-real', 'card']));
      for (const when of ['2026-11-09T11:00:00Z', undefined]) expect(results([at(body, 'chalbert', when)])).toEqual(['not-real', 'card']);
    });
  });

  it('a re-block split onto the App still holds: it withdraws the earlier operator not-real, in the comment gate and the ledger', async () => {
    // The operator's own not-real clears the finding first.
    transport.identityFallback = true;
    transport.postAs = 'chalbert';
    const ok = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async () => {} })[OPERATOR_RULING_POST_EFFECT];
    await ok(sinkArgs(plan()));
    expect(gatePending()).toEqual([]);
    // Then a block that withdraws it lands under the App (credential split): the sink refuses, but the hold must stand.
    transport.postAs = null;
    const events = [];
    const record = { version: 1, repo, pr: 7, head, rulings: [{ runId, key: rec.referrals[0].key, result: 'block' }],
      actor: 'chalbert', channel: 'claude-code-chat', reason: 'withdraw', at: '2026-11-08T08:00:00Z', clearerId: 's', poster: 'chalbert' };
    const block = { record, body: buildOperatorRulingComment(record) };
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async (list) => { events.push(...list); } })[OPERATOR_RULING_POST_EFFECT];
    await expect(sink(sinkArgs(block))).rejects.toThrow(/authored by "web-everything"/);
    expect(events.map((e) => e.ruling)).toEqual(['block']);
    expect(mandatoryReferralState(transport.thread.comments, repo7).blocked).toEqual([rec.referrals[0].key]);
    // The App copy is read as holding only: its rows are blocks; a clearing row in such a copy would be dropped.
    const appCopy = transport.thread.comments.at(-1);
    expect(appCopy.author.login).toBe('web-everything');
    expect(readOperatorRulings([appCopy]).rulings.map((r) => r.result)).toEqual(['block']);
  });

  it('a ruling authored by the checked operator in different letter case is kept, not deleted', async () => {
    transport.identityFallback = true;
    transport.postAs = 'Chalbert';
    const sink = createRecordReferralRulingSinks({ env: {}, warn: () => {}, appendEvents: async () => {} })[OPERATOR_RULING_POST_EFFECT];
    await expect(sink(sinkArgs(plan()))).resolves.toMatchObject({ posted: true });
    expect(transport.calls.filter((c) => c.args.includes('DELETE'))).toEqual([]);
    expect(readOperatorRulings(transport.thread.comments).rulings).toHaveLength(1);
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
