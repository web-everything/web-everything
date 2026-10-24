/** Cap-held card rulings: declaration and retry-safe automatic filing, with injected IO. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionStore } from '../action-store.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState, gateRoundGrants } from '../../lib/red-team-gate.mjs';
import { planRedTeamRuling, rulableBreaks, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment, RED_TEAM_RULING_CARD_EFFECT } from '../record-red-team-ruling.mjs';
import { assertHumanOperator, operatorBoundComments } from '../../lib/operator-identity.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { runCardLandingWithReceipt, createRecordRedTeamRulingSinks } from '../record-red-team-ruling-io.mjs';
import { cardJobKey, conflictingPendingCardJobs, rulingCardResource } from '../record-red-team-ruling.mjs';
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


/** Intentionally not restored from the host-local file-claims suite:
 * - 'card: two retries on one expired claim spawn at most once (atomic re-claim)':
 *   generation takeover no longer exists; dispatch fencing and concurrent rulings are covered below.
 * - 'file claims: generations are atomic and a receipt, not a log, proves the spawn':
 *   .claim generations and .spawned files no longer exist.
 * - 'invalid spawned receipt (%s) is not evidence and cannot duplicate an attempted job':
 *   .spawned parsing against a separate attempt marker no longer exists; shared-record corruption
 *   and child binding/completion validation are covered below.
 * - 'an invalid receipt with no prior attempt permits a safe re-claim but never a release from the PID alone':
 *   pre-attempt generation re-claim no longer exists; its PID-only release guard is restored below.
 * - 'two exact retries racing past the claim spawn once':
 *   this unit test exercised markAttempt/clearAttempt exclusivity, which no longer exists;
 *   the two-concurrent-rulings test retains the observable single-spawn guarantee.
 */
describe('automatic card filing with shared durable claims', () => {
  const repo = 'web-everything/web-everything';
  const roots = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  const root = () => { const dir = mkdtempSync(join(tmpdir(), 'ruling-coordination-')); roots.push(dir); return dir; };
  const two = () => [redTeam(HEAD, [
    { summary: 'one', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: true },
    { summary: 'two', category: 'edge-case', impactIfUnfixed: 'broken', file: 'b.mjs', line: 2, confirmedByRecheck: true },
  ]), capped()];
  const payloadFor = (over = {}, comments = thread()) => planRedTeamRuling(read({ comments, card: null }), input({ repo, card: undefined, ...over }));
  const heldAfter = comments => readRedTeamDisposition({ comments: operatorBoundComments(comments), repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS }).held;
  const result = { ok: true, step: 'held', rel: 'backlog/xabcdef-card.md' };
  function fake({ coordinationRoot = root(), initial = thread(), fileCard, postFails, changeAfterReason,
    cardOk = true, noPid = false, transitionFails, liveHead = () => HEAD,
    env = {}, resolveCard = ref => ({ ref, readable: true }) } = {}) {
    const comments = [...initial], posted = [], cards = [], labelSyncs = [];
    const actions = createActionStore({ root: coordinationRoot });
    const realTransition = actions.transition;
    if (transitionFails) actions.transition = (...args) => transitionFails(...args) || realTransition(...args);
    const sinks = createRecordRedTeamRulingSinks({ coordinationRoot, actions, env, resolveCard,
      readThread: () => ({ headRefOid: liveHead(), labels: [], comments: [...comments] }),
      resolveIdentity: () => OP, readStandingRulingScope: () => null,
      fileCard: (input, session, binding) => {
        cards.push(binding);
        if (fileCard) return fileCard(input, session, binding);
        return cardOk ? { ok: true, session, handle: noPid ? undefined : 'pid:4242' } : { ok: false, error: 'spawn failed' };
      },
      post: (_r, _p, body) => {
        if (postFails?.(body)) throw new Error('gh down');
        posted.push(body); comments.push({ author: OP, body, createdAt: '2026-10-20T23:55:00Z' });
        if (body.includes("The operator's reason")) changeAfterReason?.(comments);
      },
      warn: () => {}, syncLabels: a => labelSyncs.push(a),
    });
    return { actions, cards, comments, posted, labelSyncs, coordinationRoot,
      act: p => sinks[RED_TEAM_RULING_CARD_EFFECT](p),
      complete: (landing = { code: 0, result }, binding = cards[0]) => runCardLandingWithReceipt(binding, [], {
        actions, land: async () => landing,
      }),
    };
  }

  it('declares an optional card and dispatches the complete automatic-card payload; preview writes nothing', () => {
    const operation = recordRedTeamRulingOperation({ readRulingContext: () => read({ card: null }) });
    expect(operation.input.card.required).toBe(false);
    const write = operation.steps.find(s => s.name === 'write').step;
    const verdict = payloadFor();
    expect(write.effects({ verdict, input: {} })[0].payload).toMatchObject({ cardInput: verdict.cardInput, jobKey: verdict.jobKey, session: verdict.session });
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
  });
  it('plans a card for a confirmed round-cap break on the live head', () => {
    const p = payloadFor();
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: HEAD, indices: [1], actor: 'chalbert' });
    expect(p.cardInput.digest).toContain('card it, ship the PR');
    expect(p.cardInput.scope).toContain('backlog/x.md');
  });
  it('card: the job key is stable for the same ruling and differs per break/result', () => {
    const p = payloadFor();
    expect(cardJobKey({ ...p, indices: [2, 1] })).toBe(cardJobKey({ ...p, indices: [1, 2] }));
    expect(rulingCardResource(p)).toMatch(/#item:rtr-5530-[a-f0-9]{12}-[a-f0-9]{12}$/);
    for (const changed of [{ indices: [2] }, { resultId: 'new-result' }, { head: OTHER }, { repo: 'frontier-ui/frontierui' }, { pr: PR + 1 }]) {
      expect(cardJobKey({ ...p, ...changed })).not.toBe(p.jobKey);
      const q = { ...p, ...changed }; q.jobKey = cardJobKey(q);
      expect(rulingCardResource(q)).not.toBe(rulingCardResource(p));
    }
    expect(payloadFor().jobKey).toBe(p.jobKey);
    expect(payloadFor().session).toBe(`red-team-ruling-card-${p.jobKey}`);
  });
  it('card: a same-root retry of a prior pending intent waits for completion without respawning', async () => {
    const f = fake(), p = payloadFor();
    expect(f.act(p)).toMatchObject({ pending: true });
    const retry = () => payloadFor({}, f.comments);
    expect(f.act(retry())).toMatchObject({ pending: true, card: { reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    await f.complete();
    expect(f.act(retry())).toMatchObject({ card: { reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
  });
  it('card: queues the card, persists the reason then releases, and the break stops being held', async () => {
    const f = fake(), p = payloadFor();
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.act(p)).toMatchObject({ ruling: 'card', indices: [1], pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatch(/outcome=card-pending result=[0-9a-f]{16} -->/);
    expect(f.posted[0]).not.toMatch(/^- /m);
    expect(heldAfter(f.comments)).toHaveLength(1);
    await f.complete();
    expect(f.act(p)).toMatchObject({ ruling: 'card', indices: [1], card: { ref: `we:${result.rel}` } });
    expect(f.posted).toHaveLength(3);
    expect(f.posted[2]).toMatch(/^<!-- we:red-team-gate pr=5530 rev=d3bee7370\w+ outcome=operator-card result=[0-9a-f]{16} -->/);
    expect(f.posted[2]).toContain('filed as a follow-up card (#1)');
    expect(f.posted[1]).toContain('> card it, ship the PR');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('card: a second run refuses (no duplicate card)', async () => {
    const f = fake(), p = payloadFor();
    f.act(p); await f.complete(); f.act(p);
    expect(() => f.act(p)).toThrow(/no red-team break is held.*nothing written/);
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(3);
  });
  it('card: a card that was not queued leaves only the bare intent, and the break stays held', () => {
    const f = fake({ cardOk: false });
    expect(() => f.act(payloadFor())).toThrow(/not queued/);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toContain('outcome=card-pending');
    expect(f.posted[0]).not.toMatch(/^- /m);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
  });
  it('spawn ok, release record fails, retry with --break=1 is refused; the exact retry reconciles without a respawn', async () => {
    let failRecord = true;
    const f = fake({ initial: two(), postFails: b => failRecord && b.includes('outcome=operator-card') });
    const both = payloadFor({ break: '#1,#2' }, f.comments);
    f.act(both); await f.complete();
    expect(() => f.act(both)).toThrow(/gh down/);
    expect(f.cards).toHaveLength(1);
    expect(() => payloadFor({ break: '1' }, f.comments)).toThrow(/already pending for break\(s\) #1, #2/);
    const one = { ...both, indices: [1], findings: both.findings.slice(0, 1), jobKey: 'ffffffffffff', session: 'x' };
    expect(() => f.act(one)).toThrow(/already pending for an overlapping break/);
    failRecord = false;
    expect(f.act(payloadFor({ break: '#1,#2' }, f.comments))).toMatchObject({ card: { reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
  });
  it('the second of two interleaved invocations (#1,#2 then #1) is refused before anything is written', () => {
    const coordinationRoot = root(), initial = two();
    const a = fake({ coordinationRoot, initial }), b = fake({ coordinationRoot, initial });
    const pa = payloadFor({ break: '#1,#2' }, initial), pb = payloadFor({ break: '1' }, initial);
    a.act(pa);
    expect(() => b.act(pb)).toThrow(/already belong to another card job/);
    expect(a.cards.length + b.cards.length).toBe(1);
    expect(b.posted).toEqual([]);
  });
  it('action-store claims: a break is owned by the first job, atomically', () => {
    const coordinationRoot = root(), p = payloadFor();
    const a = createActionStore({ root: coordinationRoot }), b = createActionStore({ root: coordinationRoot });
    const resource = rulingCardResource(p, 'break');
    const first = a.claim({ resource, kind: 'red-team-ruling-break', owner: 'jobA', evidence: { jobKey: p.jobKey } });
    expect(first.ok).toBe(true);
    const second = b.claim({ resource, kind: 'red-team-ruling-break', owner: 'jobB', evidence: { jobKey: 'other' } });
    expect(second.ok).toBe(false);
    expect(second.record).toEqual(first.record);
    expect(a.claim({ resource, kind: 'red-team-ruling-break', owner: 'jobA' })).toMatchObject({ ok: false, record: first.record });
    expect(a.attempts(resource)).toEqual([first.record]);
  });
  it('a child failing before spool leaves the break pending on every retry without a second spawn', async () => {
    const f = fake(), p = payloadFor();
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    await f.complete({ code: 1, result: { ok: false, step: 'acquire' } });
    const path = f.actions.pathFor(rulingCardResource(p), 1);
    const row = JSON.parse(readFileSync(path, 'utf8')); row.heartbeatAt = 0; writeFileSync(path, JSON.stringify(row));
    for (let i = 0; i < 2; i++) expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
    await f.complete();
    expect(f.act(p)).toMatchObject({ card: { reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
  });
  it('an invalid receipt never permits a release from the PID alone', () => {
    const f = fake(), p = payloadFor();
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    const path = f.actions.pathFor(rulingCardResource(p), 1);
    const row = JSON.parse(readFileSync(path, 'utf8'));
    expect(row.evidence.card.handle).toBe('pid:4242');
    // A PID and a malformed child receipt are insufficient evidence that a card exists.
    row.evidence.result = {}; row.evidence.at = null; row.heartbeatAt = 0;
    writeFileSync(path, JSON.stringify(row));
    for (let i = 0; i < 2; i++) expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
  });
  it.each([false, true])('child writes completion evidence only after successful filing (ok=%s)', async ok => {
    const f = fake(), p = payloadFor(); f.act(p);
    await f.complete({ code: ok ? 0 : 1, result: ok ? result : { ok: false, step: 'acquire' } });
    const row = f.actions.read(rulingCardResource(p), 1);
    expect(row.state).toBe(ok ? 'terminal' : 'observed');
    expect(row.outcome).toBe(ok ? 'settled' : null);
    if (ok) expect(row.evidence).toMatchObject({ head: p.head, jobKey: p.jobKey, session: p.session,
      result, card: { ref: `we:${result.rel}` } });
    else expect(row.evidence.result).toBeUndefined();
    expect(() => f.act({ ...p, head: OTHER })).toThrow(/head moved/);
    expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it('two concurrent rulings share one spawn, wait for its reference, then reuse the winner card', async () => {
    const coordinationRoot = root(), p = payloadFor();
    const b = fake({ coordinationRoot });
    let interleaved;
    const a = fake({ coordinationRoot, fileCard: (_i, session) => {
      interleaved = b.act(p); // Rival arrives while the owner is inside its spawn, before its observed write.
      return { ok: true, session, handle: 'pid:1' };
    } });
    const [first, second] = await Promise.all([Promise.resolve().then(() => a.act(p)), Promise.resolve().then(() => b.act(p))]);
    expect([first, second, interleaved].every(x => x.pending && x.released === false)).toBe(true);
    expect(second.card.session).toBe(first.card.session);
    expect(a.cards.length + b.cards.length).toBe(1);
    expect(b.posted).toEqual([]);
    await a.complete();
    const winner = a.act(p), loser = b.act(p);
    expect(winner.card.ref).toBe(`we:${result.rel}`);
    expect(loser.card).toMatchObject({ ref: winner.card.ref, session: winner.card.session, reconciled: true });
    expect(a.cards.length + b.cards.length).toBe(1);
    const rows = a.actions.attempts(rulingCardResource(p));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'terminal', outcome: 'settled', evidence: { card: { ref: winner.card.ref } } });
    expect(rows[0].history.map(h => h.state)).toEqual(['intent', 'dispatching', 'observed', 'terminal']);
  });
  it('child completion reconciles a parent observed write between readBound and transition, settling without another spawn', async () => {
    // Delay parent bookkeeping so the successfully started child's completion reads dispatching.
    const f = fake({ transitionFails: (_r, _a, o) => o.to === 'observed' && { ok: false, reason: 'busy' } }), p = payloadFor();
    expect(() => f.act(p)).toThrow(/transition refused/);
    const parent = createActionStore({ root: f.coordinationRoot });
    let interleaved = 0;
    f.actions.transition = (resource, attempt, opts) => {
      if (opts.from === 'dispatching' && opts.to === 'observed') {
        interleaved++;
        expect(parent.transition(resource, attempt, { ...opts,
          patch: { handle: p.session, evidence: { ...parent.read(resource, attempt).evidence,
            card: { session: p.session, handle: 'pid:4242' } } } }).ok).toBe(true);
      }
      return parent.transition(resource, attempt, opts); // Child's original revision is now stale.
    };
    await expect(f.complete()).resolves.toMatchObject({ code: 0 });
    expect(interleaved).toBe(1);
    expect(parent.read(rulingCardResource(p), 1)).toMatchObject({ state: 'terminal', outcome: 'settled',
      evidence: { card: { ref: `we:${result.rel}` }, result } });
    expect(f.act(p).card).toMatchObject({ ref: `we:${result.rel}`, reconciled: true });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
  });
  it.each(['head', 'handle'])('a competing observed write with mismatched %s fails closed', async field => {
    const f = fake({ transitionFails: (_r, _a, o) => o.to === 'observed' && { ok: false, reason: 'busy' } }), p = payloadFor();
    expect(() => f.act(p)).toThrow(/transition refused/);
    const parent = createActionStore({ root: f.coordinationRoot });
    f.actions.transition = (resource, attempt, opts) => {
      if (opts.to === 'observed') {
        const evidence = { ...parent.read(resource, attempt).evidence };
        if (field === 'head') evidence.head = OTHER;
        expect(parent.transition(resource, attempt, { ...opts,
          patch: { handle: field === 'handle' ? 'another-session' : p.session, evidence } }).ok).toBe(true);
      }
      return parent.transition(resource, attempt, opts);
    };
    await expect(f.complete()).rejects.toThrow(/transition refused.*inspect the shared coordination record/);
    expect(parent.read(rulingCardResource(p), 1).state).toBe('observed');
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it('completion racing the claim pre-read never dispatches a newly allocated attempt', () => {
    const f = fake(), p = payloadFor(); f.act(p);
    const original = f.actions.claim;
    f.actions.claim = request => {
      const r = f.actions.read(rulingCardResource(p), 1);
      expect(f.actions.transition(r.resource, r.attempt, { token: r.ownerToken, rev: r.rev, from: 'observed', to: 'terminal',
        patch: { outcome: 'settled', evidence: { ...r.evidence, at: Date.now(), result,
          card: { session: p.session, ref: `we:${result.rel}` } } } }).ok).toBe(true);
      return original(request);
    };
    expect(f.act(p).card).toMatchObject({ ref: `we:${result.rel}`, reconciled: true });
    expect(f.cards).toHaveLength(1);
    expect(f.actions.attempts(rulingCardResource(p)).map(r => r.outcome)).toEqual(['settled', 'not-started']);
  });
  it('different break keys produce separate cards under one coordination root', async () => {
    const coordinationRoot = root(), initial = two();
    const a = fake({ coordinationRoot, initial }), b = fake({ coordinationRoot, initial });
    const pa = payloadFor({ break: '1' }, initial), pb = payloadFor({ break: '2' }, initial);
    const [first, second] = await Promise.all([Promise.resolve().then(() => a.act(pa)), Promise.resolve().then(() => b.act(pb))]);
    expect(first.card.session).not.toBe(second.card.session);
    expect(a.cards.length + b.cards.length).toBe(2);
    await a.complete(); await b.complete({ code: 0, result: { ...result, rel: 'backlog/xbcdefg-other.md' } });
    expect(a.act(pa).card.ref).not.toBe(b.act(pb).card.ref);
  });
  it('action-store claims: rejecting job B selecting [A,B] leaves A available to independent job C', () => {
    const coordinationRoot = root(), initial = two();
    const a = fake({ coordinationRoot, initial }), b = fake({ coordinationRoot, initial }), c = fake({ coordinationRoot, initial });
    const pa = payloadFor({ break: '2' }, initial);
    a.act(pa);
    const owned = a.actions.attempts(rulingCardResource(pa, 'break'));
    expect(() => b.act(payloadFor({ break: '1,2' }, initial))).toThrow(/already belong to another card job/);
    expect(b.cards).toEqual([]); expect(b.posted).toEqual([]);
    expect(b.actions.attempts(rulingCardResource(pa, 'break'))).toEqual(owned);
    expect(c.act(payloadFor({ break: '1' }, initial))).toMatchObject({ pending: true });
    expect(a.cards.length + b.cards.length + c.cards.length).toBe(2);
  });
  it('card: a prior trusted pending intent with empty shared state refuses every retry without spawning or writing claims', () => {
    const a = fake(), p = payloadFor(); a.act(p);
    const b = fake({ initial: a.comments });
    for (let i = 0; i < 2; i++) {
      expect(() => b.act(payloadFor({}, b.comments))).toThrow(/trusted pending intent.*no shared claim.*inspect the landing log.*recover the owed card.*cite its readable --card reference/);
      expect(b.actions.list()).toEqual([]);
    }
    expect(b.cards).toEqual([]); expect(b.posted).toEqual([]);
    expect(b.actions.attempts(rulingCardResource(p))).toEqual([]);
    expect(b.labelSyncs).toEqual([]);
    expect(heldAfter(b.comments)).toHaveLength(1);
  });
  it.each([false, true])('unconfirmed start (missing PID: %s) never respawns after lease expiry', noPid => {
    const f = fake({ noPid, fileCard: noPid ? undefined : () => { throw new Error('ambiguous spawn failure'); } }), p = payloadFor();
    expect(() => f.act(p)).toThrow(noPid ? /no confirmed child start/ : /ambiguous spawn failure/);
    expect(f.actions.read(rulingCardResource(p), 1)).toMatchObject({ state: 'dispatching', evidence: { session: p.session } });
    expect(f.actions.read(rulingCardResource(p), 1).evidence.card).toBeUndefined();
    const path = f.actions.pathFor(rulingCardResource(p), 1);
    const row = JSON.parse(readFileSync(path, 'utf8')); row.heartbeatAt = 0; writeFileSync(path, JSON.stringify(row));
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1); expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it('card: a failed spawn that left a log behind is NOT proof of a queued job (no confirmed child start)', () => {
    const logPath = join(root(), 'landing.log');
    const f = fake({ fileCard: (_input, session) => {
      writeFileSync(logPath, 'log opened before child start was confirmed\n');
      return { ok: true, session, logPath }; // No PID: the log alone cannot prove a child started.
    } }), p = payloadFor();
    expect(() => f.act(p)).toThrow(/no confirmed child start.*inspect the landing log.*readable --card reference/);
    expect(readFileSync(logPath, 'utf8')).toContain('before child start was confirmed');
    const resource = rulingCardResource(p);
    const before = f.actions.read(resource, 1);
    expect(before).toMatchObject({ state: 'dispatching', evidence: { head: HEAD, jobKey: p.jobKey, session: p.session } });
    expect(before.handle).toBeNull();
    expect(before.evidence.card).toBeUndefined();
    expect(heldAfter(f.comments)).toHaveLength(1);
    const path = f.actions.pathFor(resource, 1);
    writeFileSync(path, JSON.stringify({ ...before, heartbeatAt: 0 }));
    for (let i = 0; i < 2; i++) {
      expect(f.act(payloadFor({}, f.comments))).toMatchObject({ pending: true, released: false,
        message: expect.stringMatching(/inspect the landing log.*recover the owed card.*readable --card reference/) });
      expect(heldAfter(f.comments)).toHaveLength(1);
    }
    expect(f.cards).toHaveLength(1);
    expect(f.actions.attempts(resource)).toEqual([{ ...before, heartbeatAt: 0 }]);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toContain('outcome=card-pending');
    expect(f.posted[0]).not.toMatch(/^- /m);
    expect(f.labelSyncs).toEqual([]);
  });
  it.each([false, true])('failed pending-intent POST retries and spawns exactly once (published before failure: %s)', async published => {
    let fail = true;
    const f = fake({ postFails: body => {
      if (!fail || !body.includes('outcome=card-pending')) return false;
      if (published) f.comments.push({ author: OP, body, createdAt: '2026-10-20T23:55:00Z' });
      return true;
    } }), p = payloadFor();
    expect(() => f.act(p)).toThrow(/gh down/);
    expect(f.cards).toHaveLength(0);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.actions.read(rulingCardResource(p), 1)).toMatchObject({ state: 'terminal', outcome: 'not-started' });
    fail = false;
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    await f.complete();
    expect(f.act(p).card).toMatchObject({ ref: `we:${result.rel}`, reconciled: true });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
    expect(f.actions.attempts(rulingCardResource(p)).map(r => r.outcome)).toEqual(['not-started', 'settled']);
    expect(f.comments.filter(c => c.body.includes('outcome=card-pending'))).toHaveLength(1);
  });
  // The old claim-age wait is gone: a definitive non-start is immediately retryable.
  it('card: a crash before the spawn is retried as the SAME job (action-store not-started)', () => {
    const f = fake({ cardOk: false }), p = payloadFor();
    expect(() => f.act(p)).toThrow(/not queued/);
    expect(() => f.act(p)).toThrow(/not queued/);
    expect(f.cards).toHaveLength(2);
    expect(f.cards.map(c => ({ jobKey: c.jobKey, session: c.session }))).toEqual([
      { jobKey: p.jobKey, session: p.session }, { jobKey: p.jobKey, session: p.session },
    ]);
    expect(f.posted).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it('a dispatch fence that cannot be written spawns nothing', () => {
    const f = fake({ transitionFails: () => ({ ok: false, reason: 'busy' }) });
    expect(() => f.act(payloadFor())).toThrow(/transition refused/);
    expect(f.cards).toEqual([]); expect(f.posted).toEqual([]);
  });
  it('spawn ok, observed receipt write fails, exact retry after the lease expires refuses to respawn', () => {
    const f = fake({ transitionFails: (_r, _a, o) => o.to === 'observed' && { ok: false, reason: 'busy' } }), p = payloadFor();
    expect(() => f.act(p)).toThrow(/transition refused/);
    const path = f.actions.pathFor(rulingCardResource(p), 1);
    const row = JSON.parse(readFileSync(path, 'utf8')); row.heartbeatAt = 0; writeFileSync(path, JSON.stringify(row));
    for (let i = 0; i < 2; i++) expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
  });
  it('an invocation that loses the dispatch fence race refuses without spawning', () => {
    const f = fake(), realTransition = f.actions.transition;
    f.actions.transition = (resource, attempt, opts) => {
      if (opts.to === 'dispatching') expect(realTransition(resource, attempt, opts).ok).toBe(true);
      return realTransition(resource, attempt, opts); // Rival already consumed this revision.
    };
    expect(() => f.act(payloadFor())).toThrow(/transition refused/);
    expect(f.cards).toHaveLength(0);
    expect(f.posted).toEqual([]);
    expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it.each([
    { code: 1, result: { ok: false, step: 'acquire' } },
    { code: 0, result: { ok: true, step: 'held' } },
    { code: 0, result: { ok: true, step: 'done', rel: '../bad.md', mentions: 0 } },
    { code: 0, result: { ok: true, step: 'mentioned', mentions: 0 } },
  ])('incomplete landing evidence keeps every retry held: %j', async landing => {
    const f = fake(), p = payloadFor(); f.act(p); await f.complete(landing);
    for (let i = 0; i < 2; i++) expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1); expect(f.posted).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]); expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it.each(['head', 'session', 'ownerToken', 'jobKey'])('rejects a receipt with the wrong %s before landing', async field => {
    const f = fake(); f.act(payloadFor()); let calls = 0;
    await expect(runCardLandingWithReceipt({ ...f.cards[0], [field]: 'wrong' }, [], { actions: f.actions,
      land: async () => { calls++; return { code: 0, result }; } })).rejects.toThrow(/does not match/);
    expect(calls).toBe(0);
  });
  it.each(['head', 'session', 'jobKey', 'at', 'result', 'card'])('invalid persisted completion %s cannot release or respawn', async field => {
    const f = fake(), p = payloadFor(); f.act(p); await f.complete();
    const path = f.actions.pathFor(rulingCardResource(p), 1), row = JSON.parse(readFileSync(path, 'utf8'));
    row.evidence[field] = field === 'at' ? -1 : 'wrong'; writeFileSync(path, JSON.stringify(row));
    if (['head', 'session', 'jobKey'].includes(field)) expect(() => f.act(p)).toThrow(/binding is unreadable/);
    else expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1); expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it('unreadable shared records fail closed without a second spawn', () => {
    const f = fake(), p = payloadFor(); f.act(p);
    writeFileSync(f.actions.pathFor(rulingCardResource(p), 1), '{');
    expect(() => f.act(p)).toThrow(/Coordination unavailable/);
    expect(f.cards).toHaveLength(1);
  });
  it('a reason POST failure keeps the break held; an exact retry records the reason and releases without respawning', async () => {
    let failReason = true;
    const f = fake({ postFails: body => failReason && body.includes("The operator's reason") }), p = payloadFor();
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    await f.complete();
    const completed = f.actions.read(rulingCardResource(p), 1);
    expect(completed).toMatchObject({ state: 'terminal', outcome: 'settled' });
    expect(() => f.act(p)).toThrow(/gh down/);
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toContain('outcome=card-pending');
    expect(f.posted[0]).not.toMatch(/^- /m);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
    expect(f.actions.read(rulingCardResource(p), 1)).toEqual(completed);
    failReason = false;
    expect(f.act(payloadFor({}, f.comments))).toMatchObject({ card: { ref: `we:${result.rel}`, reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(f.actions.attempts(rulingCardResource(p))).toEqual([completed]);
    expect(f.posted).toHaveLength(3);
    expect(f.posted[1]).toContain("The operator's reason");
    expect(f.posted[1]).toContain('> card it, ship the PR');
    expect(f.posted[2]).toMatch(/^<!-- we:red-team-gate pr=5530 rev=d3bee7370\w+ outcome=operator-card result=[0-9a-f]{16} -->/);
    expect(f.posted[2]).toContain('filed as a follow-up card (#1)');
    expect(f.posted.filter(body => body.includes('outcome=card-pending'))).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
    expect(f.labelSyncs).toHaveLength(1);
  });
  it('card: the release record failing after the spawn is recovered by a re-run WITHOUT a second spawn', async () => {
    let failRecord = true;
    const f = fake({ postFails: body => failRecord && body.includes('outcome=operator-card') }), p = payloadFor();
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    await f.complete();
    const completed = f.actions.read(rulingCardResource(p), 1);
    expect(completed).toMatchObject({ state: 'terminal', outcome: 'settled' });
    expect(() => f.act(p)).toThrow(/gh down/);
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(2);
    expect(f.posted[0]).toContain('outcome=card-pending');
    expect(f.posted[0]).not.toMatch(/^- /m);
    expect(f.posted[1]).toContain("The operator's reason");
    expect(f.posted[1]).toContain('> card it, ship the PR');
    expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
    expect(f.actions.read(rulingCardResource(p), 1)).toEqual(completed);
    failRecord = false;
    expect(f.act(payloadFor({}, f.comments))).toMatchObject({ card: { ref: `we:${result.rel}`, reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(f.actions.attempts(rulingCardResource(p))).toEqual([completed]);
    expect(f.posted).toHaveLength(4);
    expect(f.posted[2]).toBe(f.posted[1]);
    expect(f.posted[3]).toMatch(/^<!-- we:red-team-gate pr=5530 rev=d3bee7370\w+ outcome=operator-card result=[0-9a-f]{16} -->/);
    expect(f.posted[3]).toContain('filed as a follow-up card (#1)');
    expect(f.posted.filter(body => body.includes('outcome=card-pending'))).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
    expect(f.labelSyncs).toHaveLength(1);
  });
  it.each(['present', 'missing', 'malformed', 'wrong card'])('persisted completion retry rereads %s spool evidence before release', async evidence => {
    const stateDir = root(), pending = join(stateDir, 'pending-prevention');
    mkdirSync(pending);
    const spoolPath = join(pending, 'xabcdef.json');
    const spool = { cardId: 'xabcdef', rel: result.rel, content: '---\nstatus: open\n---\n# Follow-up\n' };
    writeFileSync(spoolPath, JSON.stringify(spool));
    let failRecord = true;
    const f = fake({ env: { WE_CARD_BATCH_STATE_DIR: stateDir }, resolveCard: ref => ({ ref, readable: false }),
      postFails: body => failRecord && body.includes('outcome=operator-card') });
    const p = payloadFor(); f.act(p); await f.complete();
    const completed = f.actions.read(rulingCardResource(p), 1);
    expect(() => f.act(p)).toThrow(/gh down/);
    failRecord = false;
    if (evidence === 'missing') unlinkSync(spoolPath);
    if (evidence === 'malformed') writeFileSync(spoolPath, '{');
    if (evidence === 'wrong card') writeFileSync(spoolPath, JSON.stringify({ ...spool, rel: 'backlog/xbcdefg-other.md' }));
    const retry = () => f.act(payloadFor({}, f.comments));
    if (evidence === 'present') {
      expect(retry()).toMatchObject({ card: { reconciled: true, ref: `we:${result.rel}` } });
      expect(heldAfter(f.comments)).toEqual([]);
      expect(f.labelSyncs).toHaveLength(1);
    } else {
      expect(retry).toThrow(/evidence no longer resolves.*no release record written.*recover the owed card/);
      expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
      expect(heldAfter(f.comments)).toHaveLength(1);
      expect(f.labelSyncs).toEqual([]);
    }
    expect(f.cards).toHaveLength(1);
    expect(f.actions.attempts(rulingCardResource(p))).toEqual([completed]);
  });
  it.each(['present', 'closed', 'unreadable', 'different ref'])('persisted completion retry re-resolves the exact PR card (%s)', async evidence => {
    let readable = true, failRecord = true;
    const refs = [];
    const f = fake({ resolveCard: ref => {
      refs.push(ref);
      if (!readable && evidence === 'unreadable') throw new Error('card source unavailable');
      return { ref: !readable && evidence === 'different ref' ? 'we:backlog/other.md' : ref,
        readable: readable || evidence === 'different ref' };
    }, postFails: body => failRecord && body.includes('outcome=operator-card') });
    const p = payloadFor(); f.act(p);
    await f.complete({ code: 0, result: { ...result, step: 'done', pr: 123 } });
    expect(() => f.act(p)).toThrow(/gh down/);
    failRecord = false; readable = evidence === 'present';
    const retry = () => f.act(payloadFor({}, f.comments));
    if (readable) {
      expect(retry()).toMatchObject({ card: { reconciled: true } });
      expect(heldAfter(f.comments)).toEqual([]);
    } else {
      expect(retry).toThrow(/no release record written/);
      expect(heldAfter(f.comments)).toHaveLength(1);
      expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
    }
    expect(refs).toEqual([`we:${result.rel}@pr123`, `we:${result.rel}@pr123`]);
    expect(f.cards).toHaveLength(1);
  });
  it('refuses evidence removed during the reason POST immediately before release', async () => {
    let readable = true;
    const f = fake({ resolveCard: ref => ({ ref, readable }), changeAfterReason: () => { readable = false; } });
    const p = payloadFor(); f.act(p); await f.complete();
    expect(() => f.act(p)).toThrow(/no release record written/);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
  });
  it('a loser reusing a completion that raced its claim refuses vanished backing evidence', () => {
    const f = fake({ resolveCard: ref => ({ ref, readable: false }) }), p = payloadFor(); f.act(p);
    const claim = f.actions.claim;
    f.actions.claim = request => {
      const r = f.actions.read(rulingCardResource(p), 1);
      expect(f.actions.transition(r.resource, r.attempt, { token: r.ownerToken, rev: r.rev, from: 'observed', to: 'terminal',
        patch: { outcome: 'settled', evidence: { ...r.evidence, at: Date.now(), result: { ...result, step: 'done' },
          card: { session: p.session, ref: `we:${result.rel}` } } } }).ok).toBe(true);
      return claim(request);
    };
    expect(() => f.act(p)).toThrow(/evidence no longer resolves.*no release record written/);
    expect(f.actions.attempts(rulingCardResource(p)).map(r => r.outcome)).toEqual(['settled', 'not-started']);
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
  });
  it('a persisted mention count without a resolvable card reference cannot release', async () => {
    const f = fake(), p = payloadFor(); f.act(p);
    await f.complete({ code: 0, result: { ok: true, step: 'mentioned', mentions: 1 } });
    expect(f.actions.read(rulingCardResource(p), 1)).toMatchObject({ state: 'terminal', outcome: 'settled' });
    expect(() => f.act(p)).toThrow(/no release record written.*cite its readable --card reference/);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.cards).toHaveLength(1);
  });
  it.each(['head', 'grant'])('automatic filing rechecks before release when the %s changes during the reason POST', async variant => {
    let head = HEAD;
    const f = fake({ liveHead: () => head, changeAfterReason: comments => {
      if (variant === 'head') head = OTHER;
      else comments.push({ author: OP, createdAt: '2026-10-21T00:01:00Z',
        body: buildRoundExtensionComment({ repo, pr: PR, by: 1, actor: OP.login, channel: 'chat', reason: 'one more', at: '2026-10-21T00:01:00Z' }) });
    } });
    const p = payloadFor(); f.act(p); await f.complete();
    expect(() => f.act(p)).toThrow(/card queued and reason posted; no release record written/);
    expect(f.cards).toHaveLength(1);
    expect(f.posted.some(b => b.includes('outcome=operator-card'))).toBe(false);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.labelSyncs).toEqual([]);
  });
  it('pending jobs conflict only for a human-authored intent on this exact head and result with overlapping breaks', () => {
    const p = payloadFor();
    const body = `${redTeamGateMarker(PR, HEAD, 'card-pending', p.resultId)}\nOperator card ruling pending (job ffffffffffff, break(s) #1, #2); the break stays held.`;
    const human = { author: OP, body };
    expect(conflictingPendingCardJobs([human], p)).toHaveLength(1);
    for (const c of [bot(body), { author: { login: 'mallory' }, body },
      { ...human, body: body.replace(p.resultId, 'f'.repeat(16)) },
      { ...human, body: body.replace(HEAD, OTHER) }, { ...human, body: body.replace('#1, #2', '#3') }]) {
      expect(conflictingPendingCardJobs([c], p)).toEqual([]);
    }
    expect(conflictingPendingCardJobs([human], { ...p, jobKey: 'ffffffffffff' })).toEqual([]);
  });
});
