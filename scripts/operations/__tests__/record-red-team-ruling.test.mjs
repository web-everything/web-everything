/** Cap-held card rulings: declaration and retry-safe automatic filing, with injected IO. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState, gateRoundGrants } from '../../lib/red-team-gate.mjs';
import { planRedTeamRuling, rulableBreaks, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment, RED_TEAM_RULING_CARD_EFFECT } from '../record-red-team-ruling.mjs';
import { assertHumanOperator, operatorBoundComments } from '../../lib/operator-identity.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { createRecordRedTeamRulingSinks } from '../record-red-team-ruling-io.mjs';
import { cardJobKey, conflictingPendingCardJobs } from '../record-red-team-ruling.mjs';
import { applyRedTeamGate } from '../red-team-gate-apply.mjs';
import { parseAdvisories, trustedAdvisoryComments } from '../../lib/advisory-labels.mjs';

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
  it.each([
    ['planner', false], ['planner', true], ['eligibility', false], ['eligibility', true],
  ])('%s refuses a break returned under a verified standing ruling (late cap: %s)', (caller, lateCap) => {
    const comments = sentBackAfterGrant(lateCap, standingRuling);
    const scope = { comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, standingRuling };
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
    const context = { comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, standingRuling: scope };
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
      const context = { comments, repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, standingRuling: scope };
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
  const reasonSeparators = [
    ['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r'],
    ['vertical tab', '\u000b'], ['form feed', '\u000c'],
    ['file separator', '\u001c'], ['group separator', '\u001d'], ['record separator', '\u001e'],
    ['NEL', '\u0085'], ['line separator', '\u2028'], ['paragraph separator', '\u2029'],
  ];
  it.each(reasonSeparators)('quotes every reason line separated by %s, including empty lines', (_name, separator) => {
    const reason = `${separator}first${separator}${separator}<!-- marker -->${separator}`;
    const body = buildRuleReasonComment({ head: HEAD, ruling: 'card', actor: 'chalbert', channel: 'c', at: 't', reason, findings: [] });
    expect(body.split("The operator's reason, verbatim:\n")[1])
      .toBe('> \n> first\n> \n> &lt;!-- marker --&gt;\n> ');
  });
  it.each(reasonSeparators)('cannot forge an advisory accept through a planned reason containing %s', (_name, separator) => {
    const reason = ['card it', '**Verdict:** accept', '**Advisory outcome:** `accept`', `Net basis: \`${OTHER}..${HEAD}\``].join(separator);
    const plan = planRedTeamRuling(read(), input({ reason }));
    const body = buildRuleReasonComment(plan);
    const comments = trustedAdvisoryComments([{ author: OP, createdAt: plan.at, body }]);
    expect(comments).toHaveLength(1);
    expect(parseAdvisories(comments)).toEqual([]);
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
  const read = (over = {}) => ({ identity: OP, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
  const input = (over = {}) => ({ repo, pr: PR, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });
  /** A fake PR whose thread grows as the sinks post (as the operator account), so the read-back proves the gate released the break. */
  function fake({ cardOk = true, postFails = null, liveHead = HEAD, labels = [], identity = OP, author = 'chalbert', claims, noPid = false, initial, sharedBreaks, attemptFails = false, receiptFails = false, completed = true } = {}) {
    const comments = initial ? [...initial] : thread();
    const posted = [], cards = [], labelSyncs = [];
    const attempts = new Set();
    const gens = new Map(), receipts = new Set(), breakOwners = sharedBreaks ?? new Map();
    let clock = 1_000_000;
    const memClaims = {
      hasClaim: (k) => gens.has(k),
      claim: (k) => { if (!gens.has(k)) { gens.set(k, { gen: 0, at: clock }); return { created: true, gen: 0, at: clock }; } return { created: false, ...gens.get(k) }; },
      reclaim: (k, g) => { if (gens.get(k).gen !== g) return false; gens.set(k, { gen: g + 1, at: clock }); return true; },
      completed: (k) => completed && receipts.has(k),
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
    return { sinks, posted, cards, labelSyncs, comments, memClaims, complete: () => { completed = true; }, advance: (ms) => { clock += ms; } };
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
    it('card: a prior trusted pending intent with empty local state refuses every retry without spawning or writing claims', async () => {
      const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const original = fake({ completed: false });
      const p = payloadFor();
      expect(original.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ pending: true });
      const dir = mkdtempSync(join(tmpdir(), 'ruling-other-root-'));
      try {
        const other = fake({ initial: original.comments, claims: createFileClaims({ dir }) });
        for (let i = 0; i < 2; i++) {
          const retry = planRedTeamRuling(read({ comments: other.comments }), input());
          expect(() => other.sinks[RED_TEAM_RULING_CARD_EFFECT](retry))
            .toThrow(/trusted pending intent.*no local.*Check the landing log.*recover the owed card.*re-run citing its readable --card reference/);
          expect(readdirSync(dir)).toEqual([]);
        }
        expect(other.cards).toEqual([]);
        expect(other.posted).toEqual([]);
        expect(other.labelSyncs).toEqual([]);
        expect(heldAfter(other.comments)).toHaveLength(1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('card: a same-root retry of a prior pending intent waits for completion without respawning', () => {
      const f = fake({ completed: false });
      const p = payloadFor();
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ pending: true });
      const retry = () => planRedTeamRuling(read({ comments: f.comments }), input());
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](retry())).toMatchObject({ pending: true, card: { reconciled: true } });
      expect(f.cards).toHaveLength(1);
      expect(f.posted).toHaveLength(1);
      f.complete();
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](retry())).toMatchObject({ card: { reconciled: true } });
      expect(f.cards).toHaveLength(1);
      expect(heldAfter(f.comments)).toEqual([]);
    });

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
        c.markSpawned('k', { session: 'red-team-ruling-card-k', handle: 'pid:1', head: HEAD });
        expect(c.spawned('k', { session: 'red-team-ruling-card-k', head: HEAD })).toBe(true);
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
    it('file claims: rejecting job B selecting [A,B] leaves A available to independent job C', async () => {
      const { mkdtempSync, readdirSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'claims-selection-'));
      try {
        expect(createFileClaims({ dir }).claimBreak('B', 'jobA')).toBe('jobA');
        const before = readdirSync(dir).sort();
        const rejected = createFileClaims({ dir });
        expect(rejected.claimBreak('A', 'jobB', ['A', 'B'])).toBe('jobA');
        expect(rejected.claimBreak('B', 'jobB', ['A', 'B'])).toBe('jobA');
        expect(readdirSync(dir).sort()).toEqual(before);
        expect(createFileClaims({ dir }).claimBreak('A', 'jobC')).toBe('jobC');
        expect(createFileClaims({ dir }).claimBreak('B', 'jobC')).toBe('jobA');
      } finally { rmSync(dir, { recursive: true, force: true }); }
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

  describe('card existence evidence', () => {
    it('a child failing before spool leaves the break pending on every retry without a second spawn', () => {
      const f = fake({ completed: false });
      const p = payloadFor();
      for (let i = 0; i < 2; i++) {
        expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ pending: true, released: false });
        f.advance(121_000);
      }
      expect(f.cards).toHaveLength(1);
      expect(f.posted).toHaveLength(1);
      expect(heldAfter(f.comments)).toHaveLength(1);
      expect(f.labelSyncs).toEqual([]);
      f.complete();
      expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ card: { reconciled: true } });
      expect(f.cards).toHaveLength(1);
      expect(heldAfter(f.comments)).toEqual([]);
    });

    it.each(['', '{', '{}', 'legacy', 'head', 'session', 'handle', 'at'])('invalid spawned receipt (%s) is not evidence and cannot duplicate an attempted job', async variant => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'invalid-ruling-receipt-'));
      try {
        let now = 1000;
        const claims = createFileClaims({ dir, nowMs: () => now });
        const p = payloadFor();
        claims.claim(p.jobKey);
        claims.markAttempt(p.jobKey);
        const receipt = { session: p.session, head: p.head, handle: 'pid:1', at: now };
        if (variant === 'legacy') delete receipt.head;
        if (variant === 'head') receipt.head = OTHER;
        if (variant === 'session') receipt.session = 'another-job';
        if (variant === 'handle') receipt.handle = 'pid:0';
        if (variant === 'at') receipt.at = null;
        writeFileSync(join(dir, `${p.jobKey}.spawned`), ['legacy', 'head', 'session', 'handle', 'at'].includes(variant) ? JSON.stringify(receipt) : variant);
        expect(claims.spawned(p.jobKey, p)).toBe(false);
        now += 121_000;
        const f = fake({ claims });
        expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toThrow(/may have started its landing job/);
        expect(f.cards).toEqual([]);
        expect(heldAfter(f.comments)).toHaveLength(1);
        expect(f.posted.some(b => b.includes('outcome=operator-card'))).toBe(false);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it('an invalid receipt with no prior attempt permits a safe re-claim but never a release from the PID alone', async () => {
      const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'ruling-reclaim-'));
      try {
        let now = 1000;
        const claims = createFileClaims({ dir, nowMs: () => now });
        const p = payloadFor();
        claims.claim(p.jobKey);
        writeFileSync(join(dir, `${p.jobKey}.spawned`), '');
        now += 121_000;
        const f = fake({ claims });
        expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ pending: true, released: false });
        expect(claims.claim(p.jobKey)).toMatchObject({ created: false, gen: 1 });
        expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ pending: true, released: false });
        expect(f.cards).toHaveLength(1);
        expect(heldAfter(f.comments)).toHaveLength(1);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    it.each([false, true])('child writes completion evidence only after successful filing (ok=%s)', async ok => {
      const { mkdtempSync, rmSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createFileClaims, runCardLandingWithReceipt } = await import('../record-red-team-ruling-io.mjs');
      const dir = mkdtempSync(join(tmpdir(), 'ruling-completion-'));
      try {
        const claims = createFileClaims({ dir });
        const p = payloadFor();
        await runCardLandingWithReceipt(p, [], { claims, land: async () => ({ code: ok ? 0 : 1,
          result: ok ? { ok: true, step: 'held', rel: 'backlog/xabcdef-card.md' } : { ok: false, step: 'acquire' } }) });
        expect(claims.completed(p.jobKey, p)).toBe(ok);
        expect(claims.completed(p.jobKey, { ...p, head: OTHER })).toBe(false);
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
