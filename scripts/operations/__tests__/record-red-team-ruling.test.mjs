/** Scope-aware card, block and not-real rulings, with injected IO and retry-safe automatic filing. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState, gateRoundGrants } from '../../lib/red-team-gate.mjs';
import { planRedTeamRuling, rulableBreaks, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT } from '../record-red-team-ruling.mjs';
import { assertHumanOperator, operatorBoundComments } from '../../lib/operator-identity.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { createRecordRedTeamRulingSinks } from '../record-red-team-ruling-io.mjs';
import { cardJobKey, conflictingPendingCardJobs } from '../record-red-team-ruling.mjs';
import { redTeamRulingCommands } from '../operator-queue-red-team-ruling.mjs';
import { createBoundRecordReferralRulingSinks } from '../record-referral-ruling-bound.mjs';
import { OPERATOR_RULING_POST_EFFECT } from '../record-referral-ruling.mjs';
import { applyRedTeamGate } from '../red-team-gate-apply.mjs';

const repo = 'o/r';
const PR = 5530;
const HEAD = 'd3bee7370' + '0'.repeat(31);
// The scenarios below sit at review round 3, so they pin the gate's base cap to 3 instead of inheriting the shared default (5).
const GATE_CAP = 3;
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
// Historical cap/grant and retry fixtures explicitly exercise the restrictive policy.
const OFF = { value: { anyState: false }, sources: { anyState: 'env' } };
const read = (over = {}) => ({ scope: OFF, identity: OP, card, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
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
  it('kill switch off: refuses when the result was not parked at the round cap', () => {
    expect(() => planRedTeamRuling(read({ comments: [redTeam()] }), input())).toThrow(/not parked at the round cap/);
    expect(() => planRedTeamRuling(read({ comments: [redTeam(), bot(redTeamGateMarker(PR, HEAD, 'sent-back'))] }), input())).toThrow(/not parked at the round cap/);
  });
  it('kill switch off: refuses a round-cap record from an untrusted author', () => {
    const forged = { author: { login: 'mallory' }, body: redTeamGateMarker(PR, HEAD, 'round-cap') };
    expect(() => planRedTeamRuling(read({ comments: [redTeam(), forged] }), input())).toThrow(/not parked at the round cap/);
  });
  const standingRuling = { ok: true, id: `${repo}#6000`, author: OP.login, by: 1, maxPerPr: 3, repos: [repo],
    cardOnlyHeads: { [HEAD]: true }, uneditedComments: ['IC_auto'] };
  const sentBackAfterGrant = (lateCap = false, verifiedRuling = null) => {
    const result = redTeam();
    const { resultId } = liveResultGateState([result], PR, HEAD, repo);
    const at = '2026-10-20T23:45:00Z';
    const grant = { id: 'IC_auto', author: verifiedRuling ? { login: 'web-everything[bot]' } : OP, createdAt: at, body: buildRoundExtensionComment({
      repo, pr: PR, by: 1, actor: OP.login, channel: 'claude-code-chat', reason: 'one more round', at,
      ...(verifiedRuling ? { standingRuling: verifiedRuling.id, head: HEAD, episode: `${repo}#${PR}@${HEAD}:review:12/12` } : {}),
    }) };
    const grantIds = gateRoundGrants([grant], PR, repo, verifiedRuling).map(g => g.id);
    expect(grantIds).toHaveLength(1);
    const cap = bot(`${redTeamGateMarker(PR, HEAD, 'round-cap', resultId, [])}\n- 1 confirmed break(s) NOT sent back: cap (#1).`,
      lateCap ? '2026-10-20T23:55:00Z' : '2026-10-20T23:41:12Z');
    const sentBack = bot(`${redTeamGateMarker(PR, HEAD, 'sent-back', resultId, grantIds)}\n- 1 confirmed break(s) sent back to the fixer (#1).`,
      '2026-10-20T23:50:00Z');
    return lateCap ? [result, grant, sentBack, cap] : [result, cap, grant, sentBack];
  };
  it.each([false, true])('refuses a break returned to the fixer after a grant (late cap: %s)', lateCap => {
    const comments = sentBackAfterGrant(lateCap);
    const scope = { scope: OFF.value, ruling: 'card', citesCard: true, comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS };
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
  it.each([
    ['planner', false], ['planner', true], ['eligibility', false], ['eligibility', true],
  ])('%s refuses a break returned under a verified standing ruling (late cap: %s)', (caller, lateCap) => {
    const comments = sentBackAfterGrant(lateCap, standingRuling);
    const scope = { scope: OFF.value, ruling: 'card', citesCard: true, comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, standingRuling };
    const disposition = readRedTeamDisposition(scope);
    expect(disposition).toMatchObject({ outcome: 'sent-back', held: [] });
    expect(disposition.sendBack.map(f => f.index)).toEqual([1]);
    expect(() => caller === 'planner'
      ? planRedTeamRuling(read({ comments, standingRuling }), input())
      : rulableBreaks(scope)).toThrow(/no red-team break is held/);
  });
  it.each([
    ['human', false, null], ['human', true, null],
    ['standing ruling', false, standingRuling], ['standing ruling', true, standingRuling],
  ])('refuses a pending %s grant before automation consumes it (late cap: %s)', async (_name, lateCap, scope) => {
    const comments = sentBackAfterGrant(lateCap, scope).filter(c => !c.body.includes('outcome=sent-back'));
    const context = { scope: OFF.value, ruling: 'card', citesCard: true, comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, standingRuling: scope };
    expect(liveResultGateState(comments, PR, HEAD, repo, scope))
      .toMatchObject({ sendBackOutcome: 'round-cap', reopened: true });
    // The reader still holds the break until a gate action records who owns it.
    expect(readRedTeamDisposition(context).held.map(f => f.index)).toEqual([1]);
    const io = {
      readPr: () => ({ headRefOid: HEAD, comments, labels: ['review:accepted'] }),
      readGrantScope: () => scope,
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }),
      readRound: () => 3,
      readRoundAsOf: () => 3,
    };
    // Exercise the real gate planner: this pending grant will return #1 to the fixer.
    expect(await applyRedTeamGate({ repo, pr: PR, dryRun: true, cap: GATE_CAP }, io))
      .toMatchObject({ status: 'dry-run', reopened: true, wouldSendBack: true, cap: 4 });
    expect(() => planRedTeamRuling(read({ comments, standingRuling: scope }), input()))
      .toThrow(/pending round extension/);
    expect(() => rulableBreaks(context)).toThrow(/pending round extension/);
  });
  it.each([['human', null], ['standing ruling', standingRuling]])(
    'allows a ruling after the gate consumes a %s grant and keeps the cap', async (_name, scope) => {
      const comments = sentBackAfterGrant(false, scope).slice(0, -1);
      const context = { scope: OFF.value, ruling: 'card', citesCard: true, comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, standingRuling: scope };
      const io = {
        readPr: () => ({ headRefOid: HEAD, comments, labels: ['review:accepted'] }),
        readGrantScope: () => scope,
        readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }),
        readRound: () => 4,
        readRoundAsOf: () => 3,
        postComment: ({ body }) => comments.push(bot(body, '2026-10-21T00:00:00Z')),
      };
      expect(await applyRedTeamGate({ repo, pr: PR, cap: GATE_CAP }, io)).toMatchObject({ status: 'applied', outcome: 'round-cap' });
      expect(rulableBreaks(context).state).toMatchObject({ sendBackOutcome: 'round-cap', reopened: false });
      const plan = planRedTeamRuling(read({ comments, standingRuling: scope }), input());
      comments.push({ author: OP, createdAt: '2026-10-21T00:01:00Z', body:
        `${redTeamGateMarker(PR, HEAD, 'operator-card', plan.resultId)}\n- 1 finding(s) carded by the operator to \`${CARD}\` (#1).` });
      expect(readRedTeamDisposition(context)).toMatchObject({ held: [], sendBack: [] });
      expect(await applyRedTeamGate({ repo, pr: PR, cap: GATE_CAP }, io)).toMatchObject({ status: 'already-acted' });
      expect(readRedTeamDisposition(context)).toMatchObject({ held: [], sendBack: [] });
    });
  it.each([
    ['missing', undefined],
    ['wrong ruling', { ...standingRuling, id: `${repo}#6001` }],
    ['unverified comment', { ...standingRuling, uneditedComments: [] }],
    ['unverified head', { ...standingRuling, cardOnlyHeads: {} }],
  ])('keeps the cap with %s standing-ruling verification', (_name, scope) => {
    const comments = sentBackAfterGrant(false, standingRuling);
    expect(gateRoundGrants(comments, PR, repo, scope)).toEqual([]);
    expect(planRedTeamRuling(read({ comments, standingRuling: scope }), input()))
      .toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, indices: [1] });
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
    const p = planRedTeamRuling(read({ scope: { value: { anyState: true } }, labels: ['review:changes'] }), input());
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: HEAD, indices: [1], actor: 'chalbert', cardRef: CARD });
    expect(p.cardInput).toBeUndefined();
  });
  it('requires a cited card to be readable and the head to be readable', () => {
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


describe('automatic card filing', () => {
  const read = (over = {}) => ({ scope: OFF, identity: OP, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
  const input = (over = {}) => ({ repo, pr: PR, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });
  /** A fake PR whose thread grows as the sinks post (as the operator account), so the read-back proves the gate released the break. */
  function fake({ cardOk = true, postFails = null, liveHead = HEAD, labels = [], identity = OP, author = 'chalbert', claims, noPid = false, initial, sharedBreaks, attemptFails = false, receiptFails = false } = {}) {
    const comments = initial ? [...initial] : thread();
    const posted = [], cards = [], labelSyncs = [];
    const attempts = new Set();
    const gens = new Map(), receipts = new Set(), breakOwners = sharedBreaks ?? new Map();
    let clock = 1_000_000;
    const memClaims = {
      claim: (k) => { if (!gens.has(k)) { gens.set(k, { gen: 0, at: clock }); return { created: true, gen: 0, at: clock }; } return { created: false, ...gens.get(k) }; },
      reclaim: (k, g) => { if (gens.get(k).gen !== g) return false; gens.set(k, { gen: g + 1, at: clock }); return true; },
      spawned: (k) => receipts.has(k), markSpawned: (k) => { if (receiptFails) throw new Error('receipt write failed'); receipts.add(k); }, now: () => clock,
      attempted: (k) => attempts.has(k), markAttempt: (k) => { if (attemptFails) throw new Error('disk full'); if (attempts.has(k)) return false; attempts.add(k); return true; }, clearAttempt: (k) => attempts.delete(k),
      claimBreak: (k, job) => { if (!breakOwners.has(k)) breakOwners.set(k, job); return breakOwners.get(k); },
    };
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
      resolveIdentity: () => identity,
      claims: claims ?? memClaims,
      fileCard: (c, session) => { cards.push(c); if (!cardOk) return { ok: false, error: 'spawn failed' }; return { ok: true, session, handle: noPid ? undefined : 'pid:4242' }; },
      post: (r, n, body) => { if (postFails?.(body)) throw new Error('gh down'); posted.push(body); comments.push({ author: { login: author }, createdAt: '2026-10-20T23:55:00Z', body }); },
      warn: () => {}, syncLabels: (a) => { labelSyncs.push(a); return { add: null, remove: [] }; },
    });
    return { sinks, posted, cards, labelSyncs, comments, memClaims, advance: (ms) => { clock += ms; } };
  }
  const payloadFor = (over = {}, readOver = {}) => planRedTeamRuling(read(readOver), input(over));
  const heldAfter = (comments) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, repo }).held;

  it('plans a card for a confirmed round-cap break on the live head', () => {
    const p = planRedTeamRuling(read(), input());
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: HEAD, indices: [1], actor: 'chalbert' });
    expect(p.cardInput.digest).toContain('card it, ship the PR');
    expect(p.cardInput.scope).toContain('backlog/x.md');
  });
  it('declares an optional card and dispatches the complete automatic-card payload; preview writes nothing', () => {
    const operation = recordRedTeamRulingOperation({ readRulingContext: () => read() });
    expect(operation.input.card.required).toBe(false);
    const write = operation.steps.find(s => s.name === 'write').step;
    const verdict = payloadFor();
    expect(write.effects({ verdict, input: {} })[0].payload).toMatchObject({
      cardInput: verdict.cardInput, jobKey: verdict.jobKey, session: verdict.session,
    });
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
  });
  it('pending jobs conflict only for a human-authored intent on this exact head and result with overlapping breaks', () => {
    const p = payloadFor();
    const body = `${redTeamGateMarker(PR, HEAD, 'card-pending', p.resultId)}\nOperator card ruling pending (job ffffffffffff, break(s) #1, #2); the break stays held.`;
    const human = { author: OP, body };
    expect(conflictingPendingCardJobs([human], p)).toHaveLength(1);
    for (const comment of [bot(body), { author: { login: 'mallory' }, body },
      { ...human, body: body.replace(p.resultId, 'f'.repeat(16)) },
      { ...human, body: body.replace(HEAD, OTHER) },
      { ...human, body: body.replace('#1, #2', '#3') }]) {
      expect(conflictingPendingCardJobs([comment], p)).toEqual([]);
    }
    expect(conflictingPendingCardJobs([human], { ...p, jobKey: 'ffffffffffff' })).toEqual([]);
  });
  it('a reason POST failure keeps the break held; an exact retry records the reason and releases without respawning', () => {
    let failReason = true;
    const f = fake({ postFails: body => failReason && body.includes("The operator's reason") });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/gh down/);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    failReason = false;
    expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toMatchObject({ card: { reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
  });
  it.each(['head', 'grant'])('automatic filing rechecks before release when the %s changes during the reason POST', variant => {
    const comments = thread(), posted = [], cards = [], synced = [];
    let reasonPosted = false;
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: reasonPosted && variant === 'head' ? OTHER : HEAD, comments }),
      resolveIdentity: () => OP, readStandingRulingScope: () => null,
      claims: fake().memClaims,
      fileCard: (_input, session) => { cards.push(session); return { ok: true, session, handle: 'pid:1' }; },
      post: (_repo, _pr, body) => {
        posted.push(body);
        comments.push({ author: OP, body, createdAt: '2026-10-21T00:00:00Z' });
        if (body.includes("The operator's reason")) {
          reasonPosted = true;
          if (variant === 'grant') comments.push({ author: OP, createdAt: '2026-10-21T00:01:00Z',
            body: buildRoundExtensionComment({ repo, pr: PR, by: 1, actor: OP.login,
              channel: 'chat', reason: 'one more round', at: '2026-10-21T00:01:00Z' }) });
        }
      },
      syncLabels: args => synced.push(args),
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor()))
      .toThrow(/card queued and reason posted; no release record written/);
    expect(cards).toHaveLength(1);
    expect(posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
    expect(heldAfter(comments)).toHaveLength(1);
    expect(synced).toEqual([]);
  });
  describe('card spawn and retry', () => {
    it('card: queues the card, persists the reason then releases, and the break stops being held', () => {
      const f = fake();
      expect(heldAfter(f.comments)).toHaveLength(1);
      const p = payloadFor();
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ ruling: 'card', indices: [1] });
      expect(f.cards).toHaveLength(1);
      expect(f.posted[0]).toMatch(/outcome=card-pending result=[0-9a-f]{16} -->/);
      expect(f.posted[0]).not.toMatch(/^- /m);
      expect(f.posted[2]).toMatch(/^<!-- we:red-team-gate pr=5530 rev=d3bee7370\w+ outcome=operator-card result=[0-9a-f]{16} -->/);
      expect(f.posted[2]).toContain('filed as a follow-up card (#1)');
      expect(f.posted[1]).toContain('> card it, ship the PR');
      expect(heldAfter(f.comments)).toHaveLength(0);
    });
    it('card: a second run refuses (no duplicate card)', () => {
      const f = fake();
      f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor());
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/no red-team break is held.*nothing written/);
      expect(f.cards).toHaveLength(1);
    });
    it('card: a card that was not queued leaves only the bare intent, and the break stays held', () => {
      const f = fake({ cardOk: false });
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not queued/);
      expect(f.posted).toHaveLength(1);
      expect(f.posted[0]).toContain('outcome=card-pending');
      expect(heldAfter(f.comments)).toHaveLength(1);
    });
    it('card: the release record failing after the spawn is recovered by a re-run WITHOUT a second spawn', () => {
      let failRecord = true;
      const f = fake({ postFails: (b) => failRecord && b.includes('outcome=operator-card') });
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/gh down/);
      expect(f.cards).toHaveLength(1);
      expect(heldAfter(f.comments)).toHaveLength(1);
      failRecord = false;
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toMatchObject({ card: { reconciled: true } });
      expect(f.cards).toHaveLength(1);
      expect(f.posted.filter((b) => b.includes('outcome=card-pending'))).toHaveLength(1);
      expect(heldAfter(f.comments)).toHaveLength(0);
    });
    it('card: a crash before the spawn is retried as the SAME job once the claim is old', () => {
      const f = fake({ cardOk: false });
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not queued/);
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/another invocation holds the claim/);
      f.advance(121_000);
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not queued/);
      expect(f.cards).toHaveLength(2); // two ATTEMPTS, neither of which spawned (cardOk false); no job exists to duplicate
    });
    it('card: a failed spawn that left a log behind is NOT proof of a queued job (no confirmed child start)', () => {
      const f = fake({ noPid: true });
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/no confirmed child start/);
      expect(f.memClaims.spawned(payloadFor().jobKey)).toBe(false);
      expect(heldAfter(f.comments)).toHaveLength(1);
      f.advance(121_000);
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/may have started its landing job/);
      expect(f.cards).toHaveLength(1); // at most once: an unconfirmed start is never re-spawned
    });
    it('card: two retries on one expired claim spawn at most once (atomic re-claim)', () => {
      const f = fake();
      f.memClaims.claim(payloadFor().jobKey); // an earlier invocation claimed and died before spawning
      f.advance(121_000);
      const realReclaim = f.memClaims.reclaim;
      // the rival wins generation 1 between our observation and our takeover
      f.memClaims.reclaim = (k, g) => { realReclaim(k, g); return realReclaim(k, g); };
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/just took over/);
      expect(f.cards).toHaveLength(0);
    });
    it('file claims: generations are atomic and a receipt, not a log, proves the spawn', async () => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'claims-'));
      try {
        let t = 1000;
        const c = createFileClaims({ dir, nowMs: () => t });
        expect(c.claim('k')).toMatchObject({ created: true, gen: 0 });
        expect(c.claim('k')).toMatchObject({ created: false, gen: 0, at: 1000 });
        expect(c.reclaim('k', 0)).toBe(true);
        expect(c.reclaim('k', 0)).toBe(false);
        expect(c.claim('k')).toMatchObject({ created: false, gen: 1 });
        expect(c.spawned('k')).toBe(false);
        c.markSpawned('k', { session: 's', handle: 'pid:1' });
        expect(c.spawned('k')).toBe(true);
        expect(c.spawned('other')).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('card: the job key is stable for the same ruling and differs per break/result', () => {
      const p = payloadFor();
      expect(cardJobKey({ ...p, indices: [2, 1] })).toBe(cardJobKey({ ...p, indices: [1, 2] }));
      for (const changed of [{ indices: [2] }, { resultId: 'new-result' }, { head: OTHER }, { repo: 'other/repo' }, { pr: PR + 1 }]) {
        expect(cardJobKey({ ...p, ...changed })).not.toBe(p.jobKey);
      }
      expect(payloadFor().jobKey).toBe(p.jobKey);
      expect(payloadFor().session).toBe(`red-team-ruling-card-${payloadFor().jobKey}`);
    });
  });
  describe('audit round 3: an interrupted multi-break card filing never spawns a second filing on an overlapping retry', () => {
    const two = () => [redTeam(HEAD, [
      { summary: 'one', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: true },
      { summary: 'two', category: 'edge-case', impactIfUnfixed: 'broken', file: 'b.mjs', line: 2, confirmedByRecheck: true }]), capped()];
    it('spawn ok, release record fails, retry with --break=1 is refused; the exact retry reconciles without a respawn', () => {
      let failRecord = true;
      const f = fake({ initial: two(), postFails: (b) => failRecord && b.includes('outcome=operator-card') });
      const both = planRedTeamRuling(read({ comments: f.comments }), input({ break: '#1,#2' }));
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](both)).toThrow(/gh down/);
      expect(f.cards).toHaveLength(1);
      expect(() => planRedTeamRuling(read({ comments: f.comments }), input({ break: '1' }))).toThrow(/already pending for break\(s\) #1, #2/);
      const one = { ...both, indices: [1], findings: both.findings.slice(0, 1), jobKey: 'ffffffffffff', session: 'x' };
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](one)).toThrow(/already pending for an overlapping break/);
      failRecord = false;
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(read({ comments: f.comments }), input({ break: '#1,#2' })))).toMatchObject({ card: { reconciled: true } });
      expect(f.cards).toHaveLength(1);
    });
  });

  describe('audit round 4: concurrent overlapping card selections', () => {
    const two = () => [redTeam(HEAD, [
      { summary: 'one', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: true },
      { summary: 'two', category: 'edge-case', impactIfUnfixed: 'broken', file: 'b.mjs', line: 2, confirmedByRecheck: true }]), capped()];
    it('the second of two interleaved invocations (#1,#2 then #1) is refused before anything is written', () => {
      const shared = new Map();
      const a = fake({ initial: two(), sharedBreaks: shared });
      const b = fake({ initial: two(), sharedBreaks: shared });
      const pa = planRedTeamRuling(read({ comments: two() }), input({ break: '#1,#2' }));
      const pb = planRedTeamRuling(read({ comments: two() }), input({ break: '1' }));
      a.sinks[RED_TEAM_RULING_CARD_EFFECT](pa);
      expect(() => b.sinks[RED_TEAM_RULING_CARD_EFFECT](pb)).toThrow(/already belong to another card job/);
      expect(a.cards.length + b.cards.length).toBe(1);
      expect(b.posted).toEqual([]);
    });
    it('file claims: a break is owned by the first job, atomically', async () => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'claims-'));
      try {
        const c = createFileClaims({ dir });
        expect(c.claimBreak('b1', 'jobA')).toBe('jobA');
        expect(c.claimBreak('b1', 'jobB')).toBe('jobA');
        expect(c.claimBreak('b1', 'jobA')).toBe('jobA');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe('audit round 5: at most one spawn per card job', () => {
    it('spawn ok, receipt write fails, exact retry after the claim expires refuses instead of spawning again', () => {
      const f = fake({ receiptFails: true });
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/receipt write failed/);
      f.advance(121_000);
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/may have started its landing job/);
      expect(f.cards).toHaveLength(1);
    });
    it('an attempt marker that cannot be written spawns nothing', () => {
      const f = fake({ attemptFails: true });
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/disk full/);
      expect(f.cards).toHaveLength(0);
    });
  });

  describe('audit round 6: the attempt marker is exclusive', () => {
    it('two exact retries racing past the claim spawn once', async () => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'claims-'));
      try {
        const c = createFileClaims({ dir });
        expect(c.markAttempt('j')).toBe(true);
        expect(c.markAttempt('j')).toBe(false);
        c.clearAttempt('j');
        expect(c.markAttempt('j')).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    it('an invocation that loses the attempt race refuses without spawning', () => {
      const f = fake();
      const real = f.memClaims.markAttempt;
      f.memClaims.markAttempt = (k) => { real(k); return real(k); }; // a rival took the attempt between the check and ours
      expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/may have started its landing job/);
      expect(f.cards).toHaveLength(0);
    });
  });

});

describe('operator ruling in ANY state (live #5502 shape: sent back at repair cap 11/10, operator "5502 approved")', () => {
  function fake({ initial, liveHead, labels }) {
    const comments = [...initial], posted = [], cards = [], labelCalls = [], labelSyncs = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
      readStandingRulingScope: () => null, resolveIdentity: () => OP,
      fileCard: (...args) => { cards.push(args); throw new Error('existing-card ruling must not file'); },
      post: (_repo, _pr, body) => {
        posted.push(body);
        comments.push({ author: OP, createdAt: '2026-10-21T20:30:00Z', body });
      },
      runSetLabel: (_exe, args) => { labelCalls.push(args); return '{"ok":true}'; },
      appendEvents: async () => {},
      syncLabels: args => { labelSyncs.push(args); return { add: null, remove: [] }; },
    });
    return { sinks, comments, posted, cards, labelCalls, labelSyncs };
  }
  const H = '61782334289124cd4fcb51d0bdadb6ef3c795e82';
  const P = 5502;
  const F = (line, impact, summary) => ({ summary, category: 'edge-case', impactIfUnfixed: impact, file: 'scripts/operations/coroner-pr-postmortem.mjs', line, confirmedByRecheck: true });
  const result = bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'gpt-6.1-sol', recheckStatus: 'ok', foldedVerdict: 'changes',
    findings: [F(159, 'broken', 'A carried approval hides subsequent approval loss'), F(127, 'degraded', 'Production human-clearance comments never establish the boundary'),
      F(166, 'degraded', 'Production drain-skip comments collapse every reason')] }), '2026-10-21T17:07:55Z');
  const rid = liveResultGateState([result], P, H).resultId;
  const gate = (outcome, line, at) => bot(`${redTeamGateMarker(P, H, outcome, rid)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${H.slice(0, 12)}\`:\n${line}`, at);
  const live = [result, gate('sent-back', '- 1 confirmed break(s) sent back to the fixer (#1).', '2026-10-21T17:12:20Z'),
    gate('card-queued', '- 2 finding(s) carded (#2, #3).', '2026-10-21T17:12:23Z')];
  const LABELS = ['review:changes', 'review:human', 'status:sent-back-red-team', 'review-round:11', 'red-team:blocked'].map((name) => ({ name }));
  const CARD = 'we:backlog/xvi6k7s-per-pr-delivery-postmortem-on-merge-incident-coroner-trigger.md@pr5502';
  const card = { requested: CARD, ref: CARD, readable: true, foundIn: 'pr-head', reason: 'readable' };
  const r5502 = (over = {}) => ({ identity: OP, head: H, labels: LABELS, comments: live, setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-21T16:10:00-04:00',
    card, scope: { value: { anyState: true }, sources: { anyState: 'standard' } }, ...over });
  const in5502 = (over = {}) => ({ repo, pr: P, break: '#1,#2,#3', ruling: 'card', card: CARD, actor: 'chalbert', channel: 'claude-code-chat',
    reason: 'Operator "5502 approved" in Claude Code chat 2026-10-21 ~16:05 ET (approve, card the red-team breaks)', ...over });
  const disp = (comments, anyState = true) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: P, head: H, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });

  it('before: #1 blocks (sent back), and the old cap-only rule refused the operator', () => {
    expect(disp(live).sendBack.map((f) => f.index)).toEqual([1]);
    expect(() => planRedTeamRuling(r5502({ scope: OFF }), in5502())).toThrow(/not parked at the round cap/);
  });
  it('plans a card of all three confirmed breaks to the cited existing card, bound to head + result', () => {
    const p = planRedTeamRuling(r5502(), in5502());
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: H, resultId: rid, indices: [1, 2, 3], cardRef: CARD, underChanges: true, atCap: false });
    expect(p.cardInput).toBeUndefined();
  });
  it('after the sink: the record releases #1, nothing is filed, labels resync, and a second card is refused', () => {
    const f = fake({ initial: live, liveHead: H, labels: LABELS });
    const out = f.sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(r5502(), in5502()));
    expect(out).toMatchObject({ ruling: 'card', indices: [1, 2, 3], card: { ref: CARD } });
    expect(f.cards).toEqual([]);
    expect(f.posted[1]).toMatch(new RegExp(`^<!-- we:red-team-gate pr=5502 rev=${H} outcome=operator-card result=${rid} -->`));
    expect(f.posted[1]).toContain(`- 3 finding(s) carded by the operator to \`${CARD}\` (#1, #2, #3).`);
    expect(f.posted[0]).toContain('> Operator "5502 approved"');
    const after = disp(f.comments);
    expect(after.sendBack).toEqual([]);
    expect(after.held).toEqual([]);
    expect(f.labelSyncs).toEqual([{ repo, pr: P, head: H }]);
    expect(() => planRedTeamRuling(r5502({ comments: f.comments }), in5502())).toThrow(/already ruled `card`/);
  });
  it('the same record posted by automation, or naming another result, releases nothing', () => {
    const body = `${redTeamGateMarker(P, H, 'operator-card', rid)}\n**Red-team gate** operator ruling on head \`x\`:\n- 1 finding(s) carded by the operator to \`${CARD}\` (#1).`;
    expect(disp([...live, bot(body, '2026-10-21T20:00:00Z')]).sendBack.map((x) => x.index)).toEqual([1]);
    const other = body.replace(` result=${rid}`, ' result=0123456789abcdef');
    expect(disp([...live, { author: { login: 'chalbert' }, createdAt: '2026-10-21T20:00:00Z', body: other }]).sendBack.map((x) => x.index)).toEqual([1]);
    expect(disp([...live, { author: { login: 'chalbert' }, createdAt: '2026-10-21T20:00:00Z', body }]).sendBack).toEqual([]);
  });
  it('kill switch off at the reader: an operator release never overrides a recorded send-back', () => {
    const body = `${redTeamGateMarker(P, H, 'operator-card', rid)}\n**Red-team gate** operator ruling on head \`x\`:\n- 1 finding(s) carded by the operator to \`${CARD}\` (#1).`;
    expect(disp([...live, { author: { login: 'chalbert' }, createdAt: '2026-10-21T20:00:00Z', body }], false).sendBack.map((x) => x.index)).toEqual([1]);
  });
  it('block after a card keeps blocking: the operator-block record re-holds the break', async () => {
    const f = fake({ initial: live, liveHead: H, labels: LABELS });
    f.sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(r5502(), in5502({ break: '#1' })));
    expect(disp(f.comments).sendBack).toEqual([]);
    const b = planRedTeamRuling(r5502({ comments: f.comments }), in5502({ break: '#1', ruling: 'block', card: undefined }));
    await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](b)).resolves.toMatchObject({ sentBack: true, alreadyUnderChanges: true });
    expect(f.labelCalls).toEqual([]); // already under review:changes: no second send-back
    expect(disp(f.comments).sendBack.map((x) => x.index)).toEqual([1]);
  });
  it('a new head re-evaluates: the ruling does not carry to it', () => {
    const f = fake({ initial: live, liveHead: H, labels: LABELS });
    f.sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(r5502(), in5502()));
    const N = 'a'.repeat(40);
    const next = bot(renderRedTeamComment({ pr: P, rev: N, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes', findings: [F(159, 'broken', 'still broken')] }), '2026-10-21T21:00:00Z');
    const comments = [...f.comments, next];
    expect(readRedTeamDisposition({ comments, pr: P, head: N, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } }).sendBack.map((x) => x.index)).toEqual([1]);
    expect(() => planRedTeamRuling(r5502({ head: N.slice(0, 39) + 'b', comments }), in5502())).toThrow(/no red-team result on the live head/);
  });
  it('defaults to any-state when the read context has no scope', () => {
    expect(planRedTeamRuling(r5502({ scope: undefined }), in5502())).toMatchObject({ scope: { anyState: true }, indices: [1, 2, 3] });
  });
  it('refuses unconfirmed breaks in any-state mode', () => {
    const comments = [bot(renderRedTeamComment({ pr: P, rev: H, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
      findings: [{ ...F(159, 'broken', 'unconfirmed'), confirmedByRecheck: false }] }), '2026-10-21T17:07:55Z')];
    expect(() => planRedTeamRuling(r5502({ comments }), in5502({ break: '1' }))).toThrow(/no confirmed red-team break/);
  });
  it('refusals: not-real needs --cause, --card only with card, an unreadable card, a non-operator', () => {
    expect(() => planRedTeamRuling(r5502({ card: null }), in5502({ ruling: 'not-real', card: undefined }))).toThrow(/requires --cause/);
    expect(() => planRedTeamRuling(r5502(), in5502({ ruling: 'block' }))).toThrow(/--card applies only/);
    expect(() => planRedTeamRuling(r5502({ card: null }), in5502({ ruling: 'block', card: undefined, cause: 'other' }))).toThrow(/--cause applies only/);
    expect(() => planRedTeamRuling(r5502({ card: { requested: 'x', ref: null, readable: false, reason: 'nope' } }), in5502())).toThrow(/does not resolve to a readable/);
    expect(() => planRedTeamRuling(r5502(), in5502({ actor: 'auto-policy' }))).toThrow(/registered operator login/);
    expect(() => planRedTeamRuling(r5502({ identity: { login: 'plateau-reviewer[bot]', type: 'Bot' } }), in5502())).toThrow(/not a human account/);
    expect(planRedTeamRuling(r5502({ card: null }), in5502({ ruling: 'not-real', card: undefined, cause: 'test-nit', break: '2' }))).toMatchObject({ cause: 'test-nit', indices: [2] });
  });
  it('the setting cascade: default on, file, then env kill switch, each with its source', async () => {
    const { resolveOperatorRulings } = await import('../../lib/red-team-gate.mjs');
    expect(resolveOperatorRulings({})).toMatchObject({ value: { anyState: true } });
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: false } } } }).value.anyState).toBe(false);
    const killed = resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: true } } }, env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'off' } });
    expect(killed.value.anyState).toBe(false);
    expect(JSON.stringify(killed.sources)).toContain('env');
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'banana' } }).value.anyState).toBe(true);
  });
});

describe('any-state duplicate filing protection', () => {
  it('a NEW card is never planned for a break the gate already carded; citing an existing card still is', () => {
    const H = HEAD;
    const rid = () => liveResultGateState(thread(), PR, H).resultId;
    const carded = bot(`${redTeamGateMarker(PR, H, 'card-queued', rid())}\n**Red-team gate** x:\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z');
    expect(() => planRedTeamRuling(read({ scope: { value: { anyState: true } }, comments: thread([carded]), card: null }), input({ card: undefined }))).toThrow(/no confirmed red-team break .* left to rule `card`/);
    const ref = 'we:backlog/x.md';
    expect(planRedTeamRuling(read({ scope: { value: { anyState: true } }, comments: thread([carded]), card: { requested: ref, ref, readable: true } }), input({ card: ref }))).toMatchObject({ cardRef: ref, indices: [1] });
  });
});

describe('ruling scope binding and provenance', () => {
  it('kill switch off refuses review:changes even at the cap', () => {
    expect(() => planRedTeamRuling(read({ labels: ['review:changes'] }), input())).toThrow(/under review:changes/);
  });
  it('binds the reader scope and sources to the plan and the dispatched payload', async () => {
    const { createRecordRedTeamRulingReader } = await import('../record-red-team-ruling-io.mjs');
    const reader = createRecordRedTeamRulingReader({
      assertFresh: () => {}, readThread: () => ({ headRefOid: HEAD, labels: [], comments: thread() }),
      readStandingRulingScope: () => null, resolveIdentity: () => OP,
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), readScope: () => OFF,
      resolveCard: () => card,
    });
    const context = reader({ repo, pr: PR, card: CARD });
    expect(context.scope).toEqual(OFF);
    const verdict = planRedTeamRuling(context, input());
    expect(verdict).toMatchObject({ scope: OFF.value, scopeSources: OFF.sources });
    const operation = recordRedTeamRulingOperation({ readRulingContext: reader });
    const write = operation.steps.find(s => s.name === 'write').step;
    expect(write.effects({ verdict, input: {} })[0].payload.scope).toEqual(OFF.value);
  });
  it('the sink reapplies the bound kill switch when the PR moves to review:changes', () => {
    const posted = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: ['review:changes'], comments: thread() }),
      resolveIdentity: () => OP, readStandingRulingScope: () => null, post: (...args) => posted.push(args),
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(read(), input()))).toThrow(/under review:changes.*nothing written/);
    expect(posted).toEqual([]);
  });
});

describe('block and not-real rulings', () => {
  const read = (over = {}) => ({ identity: OP, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
  const input = (over = {}) => ({ repo, pr: PR, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });
  function fake({ cardOk = true, postFails = null, liveHead = HEAD, labels = [], identity = OP, author = 'chalbert', claims, noPid = false, initial, sharedBreaks, attemptFails = false, receiptFails = false } = {}) {
    const comments = initial ? [...initial] : thread();
    const posted = [], cards = [], labelCalls = [], labelSyncs = [];
    const attempts = new Set();
    const gens = new Map(), receipts = new Set(), breakOwners = sharedBreaks ?? new Map();
    let clock = 1_000_000;
    const memClaims = {
      claim: (k) => { if (!gens.has(k)) { gens.set(k, { gen: 0, at: clock }); return { created: true, gen: 0, at: clock }; } return { created: false, ...gens.get(k) }; },
      reclaim: (k, g) => { if (gens.get(k).gen !== g) return false; gens.set(k, { gen: g + 1, at: clock }); return true; },
      spawned: (k) => receipts.has(k), markSpawned: (k) => { if (receiptFails) throw new Error('receipt write failed'); receipts.add(k); }, now: () => clock,
      attempted: (k) => attempts.has(k), markAttempt: (k) => { if (attemptFails) throw new Error('disk full'); if (attempts.has(k)) return false; attempts.add(k); return true; }, clearAttempt: (k) => attempts.delete(k),
      claimBreak: (k, job) => { if (!breakOwners.has(k)) breakOwners.set(k, job); return breakOwners.get(k); },
    };
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
      readStandingRulingScope: () => null, resolveIdentity: () => identity,
      claims: claims ?? memClaims,
      fileCard: (c, session) => { cards.push(c); if (!cardOk) return { ok: false, error: 'spawn failed' }; return { ok: true, session, handle: noPid ? undefined : 'pid:4242' }; },
      post: (r, n, body) => { if (postFails?.(body)) throw new Error('gh down'); posted.push(body); comments.push({ author: { login: author }, createdAt: '2026-10-20T23:55:00Z', body }); },
      runSetLabel: (exe, args) => { labelCalls.push(args); return '{"ok":true}'; },
      appendEvents: async () => {}, warn: () => {}, syncLabels: (a) => { labelSyncs.push(a); return { add: null, remove: [] }; },
    });
    return { sinks, posted, cards, labelCalls, labelSyncs, comments, memClaims, advance: (ms) => { clock += ms; } };
  }
  const payloadFor = (over = {}, readOver = {}) => planRedTeamRuling(read(readOver), input(over));
  const heldAfter = (comments) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } }).held;

  it.each(['diff-only-recheck', 'stale-head-reraise', 'auto-policy-over-not-real', 'card-only-probe', 'config-prose', 'test-nit', 'other'])('accepts the shared false-finding cause %s', cause => {
    expect(payloadFor({ ruling: 'not-real', cause })).toMatchObject({ cause, effect: RED_TEAM_RULING_NOT_REAL_EFFECT });
  });
  it.each([undefined, '', 'unknown'])('refuses a missing or unknown false-finding cause %s', cause => {
    expect(() => payloadFor({ ruling: 'not-real', cause })).toThrow(/requires --cause/);
  });
  it.each([['block', undefined, RED_TEAM_RULING_BLOCK_EFFECT], ['not-real', 'other', RED_TEAM_RULING_NOT_REAL_EFFECT]])('dispatches the complete %s payload and suppresses preview writes', (ruling, cause, type) => {
    const operation = recordRedTeamRulingOperation({ readRulingContext: () => read() });
    const verdict = payloadFor({ ruling, cause });
    const write = operation.steps.find(s => s.name === 'write').step;
    expect(write.effects({ verdict, input: {} })).toMatchObject([{ type, payload: {
      ruling, cause, underChanges: false, sendBackBody: verdict.sendBackBody, indices: [1], resultId: verdict.resultId,
    } }]);
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
  });
  it('an operator-card/not-real record authored by automation never counts (read side)', () => {
    const forged = bot(`${redTeamGateMarker(PR, HEAD, 'operator-not-real', liveResultGateState(thread(), PR, HEAD).resultId)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${HEAD.slice(0, 12)}\`:\n- 1 finding(s) left advisory (#1).`);
    expect(operatorBoundComments(thread([forged]))).toHaveLength(2);
    expect(() => planRedTeamRuling(read({ scope: OFF, comments: thread([forged]) }), input())).not.toThrow(); // still held: the forged release is dropped
    const human = { ...forged, author: { login: 'chalbert' } };
    expect(operatorBoundComments(thread([human]))).toHaveLength(3);
    expect(() => planRedTeamRuling(read({ scope: OFF, comments: thread([human]) }), input())).toThrow(/no red-team break is held/);
  });
  it('plans block and not-real, and the ambiguity message lists the choices', () => {
    expect(planRedTeamRuling(read(), input({ ruling: 'block' }))).toMatchObject({ effect: RED_TEAM_RULING_BLOCK_EFFECT });
    expect(planRedTeamRuling(read(), input({ ruling: 'not-real', cause: 'other', break: 'backlog/x.md:24' }))).toMatchObject({ effect: RED_TEAM_RULING_NOT_REAL_EFFECT, indices: [1], cause: 'other' });
    const held = [{ index: 1, file: 'a', line: 1, summary: 's' }, { index: 2, file: 'a', line: 1, summary: 't' }];
    expect(() => selectBreaks(held, 'a:1')).toThrow(/ambiguous/);
    expect(selectBreaks(held, '#1,2').map((f) => f.index)).toEqual([1, 2]);
  });
  it('a result that changed on the same head after the plan writes nothing (stale write)', async () => {
    const f = fake();
    f.comments.push(redTeam(HEAD, [{ summary: 'a different break reusing #1', category: 'edge-case', impactIfUnfixed: 'broken', file: 'z.mjs', line: 9, confirmedByRecheck: true }]));
    f.comments.at(-1).createdAt = '2026-10-20T23:50:00Z';
    for (const effect of [RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT, RED_TEAM_RULING_BLOCK_EFFECT]) {
      await expect((async () => f.sinks[effect](payloadFor()))()).rejects.toThrow(/result on the live head changed/);
    }
    expect(f.cards.length + f.posted.length + f.labelCalls.length).toBe(0);
  });
  it('kill switch off: a result no longer at the round cap writes nothing', () => {
    const f = fake();
    f.comments.splice(1, 1);
    expect(() => f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }, { scope: OFF }))).toThrow(/not parked at the round cap.*nothing written/);
    expect(f.posted).toEqual([]);
  });
  it('a sink re-checks the poster: a bot identity writes nothing', () => {
    const f = fake({ identity: { login: 'web-everything[bot]', type: 'Bot' } });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not a human account/);
    expect(f.cards.length + f.posted.length).toBe(0);
  });
  it('records posted by the automation account never release the break, and the sink says so', () => {
    const f = fake({ author: 'web-everything' });
    expect(() => f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }))).toThrow(/not in the read-back as a human operator/);
  });
  it('refuses a moved head, or (kill switch off) a PR that moved to review:changes, writing nothing', () => {
    const moved = fake({ liveHead: OTHER });
    expect(() => moved.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/head moved/);
    const changes = fake({ labels: [{ name: 'review:changes' }] });
    expect(() => changes.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor({}, { scope: OFF }))).toThrow(/review:changes/);
    expect(moved.cards.length + moved.posted.length + changes.cards.length + changes.posted.length).toBe(0);
  });
  it('not-real: leaves the break advisory and clears nothing else', () => {
    const f = fake();
    f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }));
    expect(f.cards).toEqual([]);
    expect(f.posted[0]).toContain('outcome=operator-not-real');
    expect(f.posted[1]).toContain('does not clear `review:human`');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('block: sends back through review-set-label --to=changes with the operator as actor', async () => {
    const f = fake();
    await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }))).resolves.toMatchObject({ sentBack: true });
    expect(f.labelCalls[0]).toEqual(expect.arrayContaining(['5530', '--repo=o/r', '--to=changes', '--actor=chalbert', '--channel=claude-code-chat']));
    expect(f.posted[0]).toMatch(/outcome=operator-block result=[0-9a-f]{16} -->/);
    expect(f.posted[0]).toContain('sent back to the fixer (#1)');
  });
  it.each([['any-state', undefined], ['cap-only', OFF]])('block: replans from the persisted ruling after a failed send-back and applies review:changes on retry (%s)', async (_mode, scope) => {
    const comments = thread(), labels = ['review:human'], labelCalls = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [...labels], comments: [...comments] }),
      readStandingRulingScope: () => null, resolveIdentity: () => OP,
      post: (_repo, _pr, body) => comments.push({ author: OP, createdAt: '2026-10-20T23:55:00Z', body }),
      runSetLabel: (_exe, args) => {
        labelCalls.push(args);
        if (labelCalls.length === 1) throw new Error('send-back failed');
        labels.push('review:changes');
        return '{"ok":true}';
      },
      appendEvents: async () => {}, syncLabels: () => null,
    });
    const replan = () => planRedTeamRuling(read({ comments, labels, scope }), input({ ruling: 'block' }));
    await expect(sinks[RED_TEAM_RULING_BLOCK_EFFECT](replan())).rejects.toThrow(/send-back failed/);
    expect(comments.some(c => c.body.includes('outcome=operator-block'))).toBe(true);
    expect(heldAfter(comments).map(f => f.index)).toEqual([1]);
    expect(labels).not.toContain('review:changes');

    await expect(sinks[RED_TEAM_RULING_BLOCK_EFFECT](replan())).resolves.toMatchObject({ sentBack: true });
    expect(labelCalls).toHaveLength(2);
    expect(labelCalls[1]).toEqual(expect.arrayContaining(['5530', '--repo=o/r', '--to=changes', '--actor=chalbert']));
    expect(labels).toContain('review:changes');
    expect(() => replan()).toThrow(/already ruled `block`|under review:changes/);
  });
  describe('audit fixes (Codex read-only audit of 952397690)', () => {
    const H = HEAD;
    const rid = () => liveResultGateState(thread(), PR, H).resultId;
    const sentBack = () => bot(`${redTeamGateMarker(PR, H, 'sent-back', rid())}\n**Red-team gate** (setting x) on head \`x\`:\n- 1 confirmed break(s) sent back to the fixer (#1).`, '2026-10-20T23:30:00Z');
    const opLine = '- 1 finding(s) carded by the operator to `we:backlog/x.md` (#1).';
    const d = (comments, anyState = true) => readRedTeamDisposition({ comments, pr: PR, head: H, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState } });
    it('automation wrapping the operator-only card line in card-queued / sent-back releases nothing', () => {
      for (const outcome of ['card-queued', 'sent-back', 'operator-card']) {
        const forged = bot(`${redTeamGateMarker(PR, H, outcome, rid())}\n**Red-team gate** x:\n${opLine}`, '2026-10-20T23:45:00Z');
        expect(d([redTeam(), sentBack(), forged]).sendBack.map((f) => f.index)).toEqual([1]);
      }
      const human = { author: { login: 'chalbert' }, createdAt: '2026-10-20T23:45:00Z', body: `${redTeamGateMarker(PR, H, 'card-queued', rid())}\n**Red-team gate** x:\n${opLine}` };
      expect(d([redTeam(), sentBack(), human]).sendBack.map((f) => f.index)).toEqual([1]); // operator line needs an operator-* outcome too
    });
    it('kill switch off: a release still works for a break handed over at the cap (send-back then round-cap), never for a live send-back', () => {
      const op = { author: { login: 'chalbert' }, createdAt: '2026-10-21T00:00:00Z', body: `${redTeamGateMarker(PR, H, 'operator-card', rid())}\n**Red-team gate** x:\n${opLine}` };
      expect(d([redTeam(), sentBack(), op], false).sendBack.map((f) => f.index)).toEqual([1]);
      const cap = bot(`${redTeamGateMarker(PR, H, 'round-cap', rid())}\n**Red-team gate** x:\n- 1 confirmed break(s) NOT sent back: cap (#1).`, '2026-10-20T23:40:00Z');
      expect(d([redTeam(), sentBack(), cap], false).held.map((f) => f.index)).toEqual([1]);
      expect(d([redTeam(), sentBack(), cap, op], false).held).toEqual([]);
    });
    it('a NEW card is never planned for a break the gate already carded; citing an existing card still is', () => {
      const carded = bot(`${redTeamGateMarker(PR, H, 'card-queued', rid())}\n**Red-team gate** x:\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z');
      expect(() => planRedTeamRuling(read({ comments: thread([carded]) }), input())).toThrow(/no confirmed red-team break .* left to rule `card`/);
      const ref = 'we:backlog/x.md';
      expect(planRedTeamRuling(read({ comments: thread([carded]), card: { requested: ref, ref, readable: true } }), input({ card: ref }))).toMatchObject({ cardRef: ref, indices: [1] });
    });
    it('post-write proof fails on a moved head, a missing record, or a changed result', () => {
      const p = payloadFor({ ruling: 'not-real', cause: 'other' });
      for (const after of [
        { headRefOid: OTHER, labels: [], comments: [] },
        { headRefOid: H, labels: [], comments: thread() },
        { headRefOid: H, labels: [], comments: thread([redTeam(HEAD, [{ summary: 'new finding', category: 'edge-case', impactIfUnfixed: 'broken', file: 'new.mjs', line: 2, confirmedByRecheck: true }])]) },
      ]) {
        let n = 0;
        const sinks = createRecordRedTeamRulingSinks({ readThread: () => (n++ === 0 ? { headRefOid: H, labels: [], comments: thread() } : after),
          resolveIdentity: () => OP, post: () => {}, appendEvents: async () => {}, warn: () => {}, syncLabels: () => null });
        expect(() => sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](p)).toThrow(/head moved|not in the read-back|result changed/);
      }
    });
  });

  describe('audit round 2', () => {
    const rid = () => liveResultGateState(thread(), PR, HEAD).resultId;
    const d = (comments) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } });
    it('block after a clear-human ceremony re-holds the break (the ceremony no longer covers it), and the sink proves it', async () => {
      const { buildReviewedShaMarker, buildClearedHumanMarker } = await import('../../lib/review-escalation.mjs');
      // main #5803: only a human operator's own clear-human comment is a ruling, so the ceremony is posted by the operator login.
      const clearance = { ...bot(['✅ review — `review:human` cleared via the sanctioned path', '',
        'Cleared by operator via `review-set-label.mjs --to=clear-human` (gate-self).', '',
        buildReviewedShaMarker(HEAD), buildClearedHumanMarker('operator')].join('\n'), '2026-10-20T23:50:00Z'), author: { login: 'chalbert' } };
      const f = fake({ initial: thread([clearance]) });
      expect(d(f.comments).held).toEqual([]); // the ceremony ruled on the cap
      const b = planRedTeamRuling(read({ comments: f.comments }), input({ ruling: 'block' }));
      await f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](b);
      expect(d(f.comments).held.map((x) => x.index)).toEqual([1]);
    });
    it('kill switch off: no second filing for a gate-carded break re-held by a block', () => {
      const carded = bot(`${redTeamGateMarker(PR, HEAD, 'card-queued', rid())}\n**Red-team gate** x:\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z');
      const block = { author: { login: 'chalbert' }, createdAt: '2026-10-21T00:10:00Z', body: `${redTeamGateMarker(PR, HEAD, 'operator-block', rid())}\n**Red-team gate** x:\n- 1 confirmed break(s) sent back to the fixer (#1).` };
      const comments = thread([carded, block]);
      expect(d(comments).held.map((x) => x.index)).toEqual([1]);
      expect(() => planRedTeamRuling(read({ scope: OFF, comments }), input())).toThrow(/no red-team break is held/);
      const ref = 'we:backlog/x.md';
      expect(planRedTeamRuling(read({ scope: OFF, comments, card: { requested: ref, ref, readable: true } }), input({ card: ref }))).toMatchObject({ cardRef: ref });
    });
    it('a block whose record does not re-hold (posted as another account) fails its proof', async () => {
      const f = fake({ author: 'web-everything' });
      await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }))).rejects.toThrow(/not in the read-back/);
    });
  });

});

describe('operator queue commands', () => {
  it('the queue suggestions name the declared operation', () => {
    const c = redTeamRulingCommands(repo, PR);
    expect(c.card).toContain('run.mjs record-red-team-ruling --pr=5530 --repo=o/r');
    expect(Object.values(c).join(' ')).not.toContain('clear-human');
    expect(Object.keys(c).sort()).toEqual(['block', 'card', 'notReal']);
  });
});

describe('bound referral identity', () => {
  it('record-referral-ruling, bound: a bot or mismatched poster is refused before anything is read or posted', async () => {
    const payload = { repo, pr: 7, head: HEAD, body: 'b', actor: 'chalbert', channel: 'c', rulings: [] };
    const readJson = () => { throw new Error('inner reached'); };
    const mk = (identity) => createBoundRecordReferralRulingSinks({ resolveIdentity: () => identity, readJson, post: () => { throw new Error('posted'); } })[OPERATOR_RULING_POST_EFFECT];
    await expect(mk({ login: 'web-everything[bot]', type: 'Bot' })(payload)).rejects.toThrow(/not a human account/);
    await expect(mk({ login: 'mallory', type: 'User' })(payload)).rejects.toThrow(/not a registered operator/);
    await expect(mk(OP)({ ...payload, actor: 'someone-else' })).rejects.toThrow(/does not match the authenticated poster/);
    await expect(mk(OP)(payload)).rejects.toThrow(/inner reached/);
    await expect(mk({ login: 'web-everything[bot]', type: 'Bot' })({ ...payload, actor: 'auto-policy' })).rejects.toThrow(/inner reached/);
  });
});
