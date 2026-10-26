/** Cap-held card rulings: declaration and retry-safe automatic filing, with injected IO. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createActionStore } from '../action-store.mjs';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, operatorRulingsOnLiveResult, redTeamGateMarker, readRedTeamDisposition, readOperatorRulings, liveResultGateState, gateRoundGrants } from '../../lib/red-team-gate.mjs';
import { assertRulingCardInputFits, planRedTeamRuling, rulableBreaks, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT } from '../record-red-team-ruling.mjs';
import { assertHumanOperator, operatorBoundComments } from '../../lib/operator-identity.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { runCardLandingWithReceipt, createRecordRedTeamRulingSinks, spawnStableCardJob } from '../record-red-team-ruling-io.mjs';
import { cardJobKey, conflictingPendingCardJobs, rulingCardResource } from '../record-red-team-ruling.mjs';
import { applyRedTeamGate } from '../red-team-gate-apply.mjs';
import { parseAdvisories, trustedAdvisoryComments } from '../../lib/advisory-labels.mjs';
import { parseLandPreventionCardArgv, runLandPreventionCardCli } from '../land-prevention-card.mjs';
import { parseFilingItems, planDedupe } from '../../lib/card-dedupe.mjs';

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
    env = {}, runGit, readOnPr, readScope = () => OFF, resolveCard = runGit ? undefined : ref => ({ ref, readable: true }) } = {}) {
    const comments = [...initial], posted = [], cards = [], labelSyncs = [];
    const actions = createActionStore({ root: coordinationRoot });
    const realTransition = actions.transition;
    if (transitionFails) actions.transition = (...args) => transitionFails(...args) || realTransition(...args);
    const sinks = createRecordRedTeamRulingSinks({ coordinationRoot, actions, env, runGit, readOnPr, readScope, resolveCard,
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
  const landingArgv = p => {
    let captured;
    spawnStableCardJob(p.cardInput, p.session, {}, {
      resolveSettingsEnv: () => null,
      spawnDetached: argv => { captured = argv.slice(3); return { pid: 4242 }; },
    });
    return captured;
  };
  it('refuses twelve oversized findings before an intent or child can be created', () => {
    const findings = Array.from({ length: 12 }, (_, i) => ({
      summary: `UNIQUE_BREAK_${i + 1} ${'s'.repeat(580)}`, scenario: 'c'.repeat(600),
      file: `scripts/break-${i + 1}.mjs`, line: 1, category: 'edge-case',
      impactIfUnfixed: 'broken', confirmedByRecheck: true,
    }));
    expect(() => payloadFor({ break: findings.map((_, i) => i + 1).join(',') }, [redTeam(HEAD, findings), capped()]))
      .toThrow(/landing.*digest.*limit.*smaller.*--card/i);
  });
  it('refuses automatic no-file findings before dispatch and permits the explicit --card recovery', () => {
    const comments = [redTeam(HEAD, [{ summary: 'No-file confirmed break', scenario: 'repository-wide failure',
      file: null, line: null, category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }]), capped()];
    expect(() => payloadFor({}, comments)).toThrow(/landing scope.*empty.*--card/);
    expect(planRedTeamRuling(read({ comments }), input({ repo }))).toMatchObject({ cardRef: CARD, indices: [1] });
  });
  it.each([
    ['digest', 'x'.repeat(8001)], ['scope', 'we:a,'.repeat(401)],
    ['digest', '[['.repeat(2700)], ['digest', '<!--'.repeat(1200)],
  ])('refuses landing truncation of %s after sanitization', (field, text) => {
    expect(() => assertRulingCardInputFits({ digest: 'one finding', scope: 'we:a.mjs', [field]: text }))
      .toThrow(/landing.*limit.*smaller.*--card/i);
  });
  it('preserves a digest exactly at the landing limit through the spawn adapter and parser', () => {
    const p = payloadFor();
    p.cardInput.digest = 'x'.repeat(8000);
    expect(parseLandPreventionCardArgv(landingArgv(p)).digest).toBe(p.cardInput.digest);
  });
  it.each(['done', 'held', 'batched', 'mentioned'].flatMap(step =>
    ['present', 'removed during reason', 'landed on main'].map(evidence => ({ step, evidence }))))(
    'dedupe rechecks every backing card for a $step receipt ($evidence), including retries', async ({ step, evidence }) => {
    const initial = two(), p = payloadFor({ break: '1,2' }, initial), lane = root();
    const existing = { id: 'xoldone', status: 'open', rel: 'backlog/xoldone-card.md', host: { pr: 111 },
      items: parseFilingItems(p.cardInput.digest).slice(0, step === 'mentioned' ? 2 : 1) };
    const dedupe = input => planDedupe({ input, cards: [existing], policy: { dedupe: true, similarity: 1 } });
    expect(dedupe(p.cardInput).action).toBe(step === 'mentioned' ? 'mention' : 'partial');
    let existingReadable = true;
    const f = fake({ initial, changeAfterReason: () => { if (evidence === 'removed during reason') existingReadable = false; },
      resolveCard: ref => ({ ref, readable: !ref.includes('xoldone')
        || (existingReadable && !(evidence === 'landed on main' && ref.endsWith('@pr111'))) }) });
    f.act(p);
    const filedDigests = [];
    const landed = await runCardLandingWithReceipt(f.cards[0], landingArgv(p), {
      actions: f.actions, dedupe,
      land: (args, deps = {}) => runLandPreventionCardCli(args, {
        ...deps, dedupe: deps.dedupe ?? dedupe, write: () => {}, writeErr: () => {},
        pendingDir: join(lane, 'pending'), mkTmp: () => lane, rmTmp: () => {}, writeFile: () => {},
        readFile: () => '---\nstatus: open\n---\n# Card\n',
        batch: async () => step === 'done' ? { disabled: true } : step === 'batched' ? { batched: true, batchRef: 'batch' } : { reason: 'paused' },
        loadPreventionBatchSettings: () => ({ batchLeaseWaitMinutes: 0 }),
        exec: (_cmd, args) => {
          if (args.includes('acquire')) return JSON.stringify({ lane: 1, path: lane });
          if (args.includes('file-item')) {
            filedDigests.push(args.find(a => a.startsWith('--digest=')).slice(9));
            return JSON.stringify({ verdict: { rel: result.rel } });
          }
          if (args.includes('open-pr')) return JSON.stringify({ findings: { submit: { effects: [{ result: { outcome: 'opened', pr: 222 } }] } } });
          if (args.includes('verify')) return JSON.stringify({ verdict: { ok: true } });
          return '';
        },
      }),
    });
    expect(landed).toMatchObject({ code: 0, result: { step, rel: step === 'mentioned' ? null : result.rel } });
    expect(filedDigests).toHaveLength(step === 'mentioned' ? 0 : 1);
    if (step !== 'mentioned') {
      expect(filedDigests[0]).not.toContain('we:a.mjs');
      expect(filedDigests[0]).toContain('we:b.mjs');
    }
    if (evidence === 'removed during reason') {
      for (let retry = 0; retry < 2; retry++) expect(() => f.act(p)).toThrow(/no release record written/);
      expect(heldAfter(f.comments)).toHaveLength(2);
    } else {
      expect(f.act(p)).toMatchObject({ card: { reconciled: true } });
      expect(heldAfter(f.comments)).toEqual([]);
    }
    expect(f.cards).toHaveLength(1);
  });
  it.each(['done', 'held', 'batched'])('legacy %s receipts with unknown dedupe coverage stay held without respawning', async step => {
    const f = fake(), p = payloadFor(); f.act(p);
    await f.complete({ code: 0, result: { ...result, step } });
    const row = f.actions.read(rulingCardResource(p), 1);
    delete row.evidence.backingCards;
    delete row.evidence.dedupeMatches;
    writeFileSync(f.actions.pathFor(row.resource, row.attempt), JSON.stringify(row));
    expect(() => f.act(p)).toThrow(/no release record written.*recover the owed card/);
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it.each([
    { backingCards: [], dedupeMatches: 1 },
    { backingCards: [{ rel: 'backlog/xoldone-card.md', pr: '111' }], dedupeMatches: 1 },
    { backingCards: [{ rel: '../bad.md', pr: 111 }], dedupeMatches: 1 },
  ])('incomplete or malformed backing-card inventory cannot release: %j', async inventory => {
    const f = fake(), p = payloadFor(); f.act(p); await f.complete();
    const row = f.actions.read(rulingCardResource(p), 1);
    Object.assign(row.evidence, inventory);
    writeFileSync(f.actions.pathFor(row.resource, row.attempt), JSON.stringify(row));
    expect(() => f.act(p)).toThrow(/no release record written/);
    expect(heldAfter(f.comments)).toHaveLength(1);
    expect(f.cards).toHaveLength(1);
  });
  it('spawnStableCardJob passes the receipt binding and overrides the random session in detached argv', () => {
    const p = payloadFor(), calls = [];
    const binding = { resource: rulingCardResource(p), attempt: 1, ownerToken: 'owner',
      jobKey: p.jobKey, head: p.head, session: p.session, coordinationRoot: root() };
    expect(spawnStableCardJob(p.cardInput, p.session, binding, {
      resolveSettingsEnv: () => null,
      spawnDetached: (argv, options) => { calls.push({ argv, options }); return { pid: 4242 }; },
    })).toMatchObject({ ok: true, session: p.session, handle: 'pid:4242' });
    expect(calls).toHaveLength(1);
    const { argv, options } = calls[0];
    expect(argv[0]).toMatch(/record-red-team-ruling-io\.mjs$/);
    expect(argv.slice(1, 3)).toEqual(['--land-card-receipt', JSON.stringify(binding)]);
    expect(argv.filter(arg => arg.startsWith('--session='))).toEqual([`--session=${p.session}`]);
    expect(argv).toContain(`--digest=${p.cardInput.digest}`);
    expect(options.logPath).toContain(p.session);
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
  it('automatic card: disabling anyState restores a sent-back break after the real sink completes without a cap', async () => {
    const initial = [redTeam()];
    const resultId = liveResultGateState(initial, PR, HEAD).resultId;
    initial.push(bot(`${redTeamGateMarker(PR, HEAD, 'sent-back', resultId)}\n- 1 confirmed break(s) sent back to the fixer (#1).`, '2026-10-20T23:41:12Z'));
    const f = fake({ initial, readScope: () => ({ value: { anyState: true } }) });
    const plan = () => planRedTeamRuling(read({ comments: f.comments, card: null, scope: { value: { anyState: true } } }), input({ repo, card: undefined }));
    expect(f.act(plan())).toMatchObject({ pending: true, released: false });
    await f.complete();
    expect(f.act(plan())).toMatchObject({ card: { ref: `we:${result.rel}` } });
    expect(f.cards).toHaveLength(1);
    expect(f.posted[2]).toContain(`outcome=operator-card result=${resultId}`);
    expect(f.posted[2]).toContain('filed as a follow-up card (#1) — landing job');
    const disposition = operatorRulings => readRedTeamDisposition({ comments: operatorBoundComments(f.comments), repo, pr: PR, head: HEAD,
      setting: CONFIRMED_BREAKS_DEFAULTS, env: {}, operatorRulings });
    expect(disposition({ anyState: true })).toMatchObject({ sendBack: [], held: [] });
    expect(disposition({ anyState: false }).sendBack.map(f => f.index)).toEqual([1]);
    expect(disposition().sendBack.map(f => f.index)).toEqual([1]);
    expect(disposition({ anyState: false }).held).toEqual([]);
  });
  it('automatic card retry honors a live opt-out after child completion without posting a release', async () => {
    let anyState = true;
    const f = fake({ initial: [redTeam()], readScope: () => ({ value: { anyState } }) });
    const p = planRedTeamRuling(read({ comments: f.comments, card: null, scope: { value: { anyState: true } } }),
      input({ repo, card: undefined }));
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    await f.complete();
    anyState = false;
    expect(() => f.act(p)).toThrow(/not parked at the round cap.*nothing written/);
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toContain('outcome=card-pending');
  });
  it('automatic card release rechecks scope after posting the reason', async () => {
    let anyState = true;
    const f = fake({ initial: [redTeam()], readScope: () => ({ value: { anyState } }),
      changeAfterReason: () => { anyState = false; } });
    const p = planRedTeamRuling(read({ comments: f.comments, card: null, scope: { value: { anyState: true } } }),
      input({ repo, card: undefined }));
    f.act(p);
    await f.complete();
    expect(() => f.act(p)).toThrow(/not parked at the round cap.*card queued and reason posted; no release record written/);
    expect(f.posted).toHaveLength(2);
    expect(f.posted.every(body => !body.includes('outcome=operator-card'))).toBe(true);
  });
  it('an opt-out while posting the pending intent fences dispatch and leaves the claim retryable', () => {
    let anyState = true;
    const f = fake({ initial: [redTeam()], readScope: () => ({ value: { anyState } }),
      postFails: body => { if (body.includes('outcome=card-pending')) anyState = false; return false; } });
    const p = planRedTeamRuling(read({ comments: f.comments, card: null, scope: { value: { anyState: true } } }),
      input({ repo, card: undefined }));
    expect(() => f.act(p)).toThrow(/not parked at the round cap.*no card job started/);
    expect(f.cards).toEqual([]);
    expect(f.actions.attempts(rulingCardResource(p)).at(-1)).toMatchObject({ state: 'terminal', outcome: 'not-started' });
    anyState = true;
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    expect(f.posted).toHaveLength(1);
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
        patch: { outcome: 'settled', evidence: { ...r.evidence, at: Date.now(), result, backingCards: [], dedupeMatches: 0,
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
  it.each(['busy', 'stale-rev'])('an exact retry recovers an intent after a %s dispatch fence failure and spawns once', async reason => {
    let fail = true;
    const f = fake({ transitionFails: (_r, _a, opts) => fail && opts.to === 'dispatching' && { ok: false, reason } });
    const p = payloadFor();
    expect(() => f.act(p)).toThrow(/transition refused/);
    const before = f.actions.read(rulingCardResource(p), 1);
    expect(before).toMatchObject({ state: 'intent' });
    expect(f.actions.attempts(rulingCardResource(p, 'break'))).toHaveLength(1);
    expect(f.cards).toEqual([]); expect(f.posted).toEqual([]);
    fail = false;
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.actions.read(rulingCardResource(p), 1)).toMatchObject({ state: 'observed', ownerToken: before.ownerToken });
    expect(f.act(p)).toMatchObject({ pending: true, released: false });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toHaveLength(1);
    await f.complete();
    expect(f.act(p)).toMatchObject({ card: { ref: `we:${result.rel}`, reconciled: true } });
    expect(f.cards).toHaveLength(1);
    expect(heldAfter(f.comments)).toEqual([]);
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
  // Every step accepted by cardLandingExists needs an explicit release/hold contract.
  // Batched cards have no PR reference yet: keep the break held until main resolves them.
  it.each([
    { step: 'held' }, { step: 'batched' }, { step: 'done' },
    { step: 'mentioned', mentions: 1 }, { step: 'done', mentions: 1 },
  ].flatMap(landing => ['present', 'missing', 'removed during reason', 'spooled'].map(evidence => ({ ...landing, evidence }))))(
    'landing step $step (mentions: $mentions) revalidates $evidence card evidence before release', async ({ step, mentions, evidence }) => {
      const stateDir = root();
      if (evidence === 'spooled') {
        mkdirSync(join(stateDir, 'pending-prevention'));
        writeFileSync(join(stateDir, 'pending-prevention', 'xabcdef.json'), JSON.stringify({
          cardId: 'xabcdef', rel: result.rel, content: '---\nstatus: open\n---\n# Follow-up\n',
        }));
      }
      let readable = evidence !== 'missing';
      if (evidence === 'spooled') readable = false;
      const f = fake({ env: { WE_CARD_BATCH_STATE_DIR: stateDir }, resolveCard: ref => ({ ref, readable }),
        changeAfterReason: () => { if (evidence === 'removed during reason') readable = false; } });
      const p = payloadFor();
      expect(f.act(p)).toMatchObject({ pending: true, released: false });
      const receipt = mentions
        ? { ok: true, step, mentions, rel: null }
        : { ...result, step, pr: null };
      await f.complete({ code: 0, result: receipt });
      const completed = f.actions.read(rulingCardResource(p), 1);
      expect(completed).toMatchObject({ state: 'terminal', outcome: 'settled', evidence: { result: receipt } });

      if (!mentions && (evidence === 'present' || (step === 'held' && evidence === 'spooled'))) {
        expect(f.act(p)).toMatchObject({ card: { reconciled: true, ref: `we:${result.rel}` } });
        expect(heldAfter(f.comments)).toEqual([]);
        expect(f.labelSyncs).toHaveLength(1);
      } else {
        for (let retry = 0; retry < 2; retry++) expect(() => f.act(p)).toThrow(/no release record written.*recover the owed card/);
        expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
        expect(heldAfter(f.comments)).toHaveLength(1);
        expect(f.labelSyncs).toEqual([]);
        if (step === 'batched' && evidence === 'missing') {
          // The batch has since landed. Reuse the receipt rather than filing another card.
          readable = true;
          expect(f.act(p)).toMatchObject({ card: { reconciled: true, ref: `we:${result.rel}` } });
          expect(heldAfter(f.comments)).toEqual([]);
          expect(f.labelSyncs).toHaveLength(1);
        }
      }
      expect(f.cards).toHaveLength(1);
      expect(f.actions.attempts(rulingCardResource(p))).toEqual([completed]);
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
    expect(refs).toEqual([`we:${result.rel}@pr123`, `we:${result.rel}@pr123`, ...(!readable ? [`we:${result.rel}`] : [])]);
    expect(f.cards).toHaveLength(1);
  });
  it.each([
    ['renumbered', true], ['quoted bornAs', true], ['CRLF', true], ['PR read throws', true],
    ['original on main', true], ['missing', false], ['wrong bornAs', false],
    ['bornAs only in body', false], ['malformed', false], ['fetch fails', false],
    ['vanished after failed POST', false, true], ['refresh fails after failed POST', false, true],
  ])('persisted landing receipt follows published card identity after JIT numbering (%s)', async (variant, released, initiallyReadable = released) => {
    const calls = [], prReads = [];
    let failRecord = true, retrying = false;
    const original = 'xabcdef-card.md', numbered = '6000-card.md';
    const content = variant === 'malformed' ? '# Not a card\nbornAs: xabcdef\n'
      : variant === 'bornAs only in body' ? '---\nstatus: open\n---\nbornAs: xabcdef\n'
      : `---\nbornAs: ${variant === 'wrong bornAs' ? 'xbcdefg' : variant === 'quoted bornAs' ? '"xabcdef"' : 'xabcdef'}\nstatus: open\n---\n# Follow-up\n`;
    const f = fake({ runGit: args => {
      calls.push(args);
      if (variant === 'fetch fails' || (retrying && variant === 'refresh fails after failed POST')) throw new Error('main unavailable');
      if (args[0] === 'fetch') return '';
      if (retrying && variant === 'vanished after failed POST') {
        if (args[0] === 'ls-tree') return '';
        throw new Error('card removed from main');
      }
      if (args[0] === 'ls-tree') return variant === 'missing' ? '' : numbered;
      if (args[0] === 'show') {
        const file = args[1].slice('origin/main:backlog/'.length);
        if ((file === original && variant === 'original on main') || (file === numbered && variant !== 'missing')) {
          return variant === 'CRLF' ? content.replace(/\n/g, '\r\n') : content;
        }
        throw new Error('card absent');
      }
      throw new Error(`unexpected git arguments: ${JSON.stringify(args)}`);
    }, readOnPr: (file, pr) => {
      prReads.push([file, pr]);
      if (variant === 'PR read throws') throw new Error('old path absent on numbered PR head');
      return null;
    }, postFails: body => failRecord && body.includes('outcome=operator-card') });
    const p = payloadFor(); f.act(p);
    await f.complete({ code: 0, result: { ...result, step: 'done', pr: 123 } });
    const completed = f.actions.read(rulingCardResource(p), 1);
    if (initiallyReadable) expect(() => f.act(p)).toThrow(/gh down/);
    failRecord = false; retrying = true;
    const retry = () => f.act(payloadFor({}, f.comments));
    if (released) {
      expect(retry()).toMatchObject({ card: { reconciled: true, ref: `we:${result.rel}` } });
      expect(heldAfter(f.comments)).toEqual([]);
      expect(f.labelSyncs).toHaveLength(1);
    } else {
      expect(retry).toThrow(/evidence no longer resolves.*no release record written/);
      expect(heldAfter(f.comments)).toHaveLength(1);
      expect(f.posted.some(body => body.includes('outcome=operator-card'))).toBe(false);
      expect(f.labelSyncs).toEqual([]);
    }
    expect(prReads).toEqual(Array(initiallyReadable ? 2 : 1).fill([original, '123']));
    expect(calls.filter(args => args[0] === 'fetch')).toHaveLength(initiallyReadable ? 2 : 1);
    expect(f.cards).toHaveLength(1);
    expect(f.actions.attempts(rulingCardResource(p))).toEqual([completed]);
  });
  it('a throwing exact receipt resolver still validates main before release', async () => {
    const refs = [];
    const f = fake({ resolveCard: ref => {
      refs.push(ref);
      if (ref.endsWith('@pr123')) throw new Error('PR source unavailable');
      return { ref, readable: true };
    } });
    const p = payloadFor(); f.act(p);
    await f.complete({ code: 0, result: { ...result, step: 'done', pr: 123 } });
    expect(f.act(p)).toMatchObject({ card: { reconciled: true } });
    expect(refs).toEqual([`we:${result.rel}@pr123`, `we:${result.rel}`]);
    expect(heldAfter(f.comments)).toEqual([]);
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
        patch: { outcome: 'settled', evidence: { ...r.evidence, at: Date.now(), result: { ...result, step: 'done' }, backingCards: [], dedupeMatches: 0,
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

const OFF = { value: { anyState: false }, sources: { anyState: 'env' } };

describe('operator ruling in ANY state (live #5502 shape: sent back at repair cap 11/10, operator "5502 approved")', () => {
  function fake({ initial, liveHead, labels }) {
    const comments = [...initial], posted = [], cards = [], labelCalls = [], labelSyncs = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
      readScope: () => ({ value: { anyState: true } }),
      readStandingRulingScope: () => null, resolveIdentity: () => OP,
      resolveCard: ref => ({ ref, readable: true }),
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
    card, scope: { value: { anyState: true }, sources: { anyState: 'tool' } }, ...over });
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
  it('a later round-cap supersedes the operator card and permits ruling the held finding again', () => {
    const f = fake({ initial: live, liveHead: H, labels: LABELS });
    f.sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(r5502(), in5502()));
    expect(() => planRedTeamRuling(r5502({ comments: f.comments }), in5502())).toThrow(/already ruled `card`/);
    f.comments.push(gate('round-cap', '- 1 confirmed break(s) NOT sent back: cap (#1).', '2026-10-21T21:00:00Z'));
    expect(disp(f.comments).held.map(f => f.index)).toEqual([1]);
    expect(disp(f.comments).sendBack).toEqual([]);
    expect(operatorRulingsOnLiveResult(f.comments, P, H).ruled.get(1)).toEqual(['card']);
    const p = planRedTeamRuling(r5502({ comments: f.comments }), in5502({ break: '1' }));
    expect(p).toMatchObject({ resultId: rid, indices: [1], cardRef: CARD, atCap: true });
    expect(p.cardInput).toBeUndefined();
    // Holding again permits a release to an existing card, never filing a duplicate card.
    expect(() => planRedTeamRuling(r5502({ comments: f.comments, card: null }), in5502({ card: undefined, break: '1' })))
      .toThrow(/no confirmed red-team break .* left to rule `card`/);
    expect(() => planRedTeamRuling(r5502({ comments: f.comments }), in5502({ break: '2' })))
      .toThrow(/#2 is not a break confirmed and not already ruled/);
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
  it('defaults to cap-only when the read context has no scope', () => {
    expect(() => planRedTeamRuling(r5502({ scope: undefined }), in5502())).toThrow(/not parked at the round cap/);
    expect(planRedTeamRuling(read(), input())).toMatchObject({ scope: { anyState: false }, indices: [1] });
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
  it('the setting cascade: default off, file and env opt in, each with its source', async () => {
    const { resolveOperatorRulings } = await import('../../lib/red-team-gate.mjs');
    expect(resolveOperatorRulings({})).toMatchObject({ value: { anyState: false } });
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: false } } } }).value.anyState).toBe(false);
    const killed = resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: true } } }, env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'off' } });
    expect(killed.value.anyState).toBe(false);
    expect(JSON.stringify(killed.sources)).toContain('env');
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'banana' } }).value.anyState).toBe(false);
    expect(resolveOperatorRulings({ file: { redTeam: { operatorRulings: { anyState: true } } } }).value.anyState).toBe(true);
    expect(resolveOperatorRulings({ env: { WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE: 'true' } }))
      .toMatchObject({ value: { anyState: true }, sources: { anyState: 'env' } });
  });
});

describe('any-state duplicate filing protection', () => {
  it.each(['gate', 'operator'])('cap-only refuses a new card for a previously carded finding held again (%s)', author => {
    const resultId = liveResultGateState(thread(), PR, HEAD).resultId;
    const prior = author === 'gate'
      ? bot(`${redTeamGateMarker(PR, HEAD, 'card-queued', resultId)}\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z')
      : { author: OP, createdAt: '2026-10-20T23:50:00Z',
        body: `${redTeamGateMarker(PR, HEAD, 'operator-card', resultId)}\n- 1 finding(s) carded by the operator to \`${CARD}\` (#1).` };
    const comments = thread([prior,
      bot(`${redTeamGateMarker(PR, HEAD, 'round-cap', resultId)}\n- 1 confirmed break(s) NOT sent back: cap (#1).`, '2026-10-21T00:01:00Z')]);
    // Keep every other refusal inert: same result, held at the cap, existing-card ruling allowed.
    expect(readRedTeamDisposition({ comments, repo, pr: PR, head: HEAD,
      setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: OFF.value }).held.map(f => f.index)).toEqual([1]);
    expect(operatorRulingsOnLiveResult(comments, PR, HEAD).carded.has(1)).toBe(true);
    expect(planRedTeamRuling(read({ comments, scope: OFF }), input()))
      .toMatchObject({ indices: [1], cardRef: CARD, scope: OFF.value, resultId });
    expect(() => planRedTeamRuling(read({ comments, scope: OFF, card: null }), input({ card: undefined })))
      .toThrow(/no red-team break is held/);
  });
  it.each([false, true])('a prior operator card neither releases nor prevents ruling on an identical repost (anyState: %s)', anyState => {
    const scope = { value: { anyState } };
    const resultId = liveResultGateState(thread(), PR, HEAD).resultId;
    const prior = { author: OP, createdAt: '2026-10-20T23:50:00Z',
      body: `${redTeamGateMarker(PR, HEAD, 'operator-card', resultId)}\n- 1 finding(s) carded by the operator to \`${CARD}\` (#1).` };
    const comments = thread([prior]);
    const disposition = () => readRedTeamDisposition({ comments, pr: PR, head: HEAD,
      setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: scope.value });
    expect(disposition().held).toEqual([]);
    expect(operatorRulingsOnLiveResult(comments, PR, HEAD).ruled.get(1)).toEqual(['card']);
    comments.push({ ...redTeam(), createdAt: '2026-10-21T00:00:00Z' },
      bot(redTeamGateMarker(PR, HEAD, 'round-cap', resultId), '2026-10-21T00:01:00Z'));
    expect(liveResultGateState(comments, PR, HEAD).resultId).toBe(resultId);
    expect(disposition().held.map(f => f.index)).toEqual([1]);
    const dedup = operatorRulingsOnLiveResult(comments, PR, HEAD);
    expect([...dedup.ruled]).toEqual([]);
    expect([...dedup.carded]).toEqual([]);
    expect(planRedTeamRuling(read({ comments, scope }), input())).toMatchObject({ indices: [1], cardRef: CARD, resultId });
    expect(planRedTeamRuling(read({ comments, scope, card: null }), input({ card: undefined })))
      .toMatchObject({ indices: [1], resultId });
    comments.push({ ...prior, createdAt: '2026-10-21T00:02:00Z' });
    expect(disposition().held).toEqual([]);
    expect(operatorRulingsOnLiveResult(comments, PR, HEAD).ruled.get(1)).toEqual(['card']);
    expect(() => planRedTeamRuling(read({ comments, scope }), input()))
      .toThrow(anyState ? /already ruled `card`/ : /no red-team break is held/);
  });
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
  it.each(['environment', 'settings file'])('the sink re-reads a real %s opt-out after preview', source => {
    const root = mkdtempSync(join(tmpdir(), 'ruling-scope-'));
    try {
      const path = join(root, 'red-team.json');
      writeFileSync(path, JSON.stringify({ redTeam: { operatorRulings: { anyState: true } } }));
      const env = {};
      const readScope = () => readOperatorRulings({ path, env });
      const comments = [redTeam()];
      const payload = planRedTeamRuling(read({ comments, scope: readScope() }), input());
      expect(payload.scope.anyState).toBe(true);
      if (source === 'environment') env.WE_RED_TEAM_OPERATOR_RULINGS_ANY_STATE = 'false';
      else writeFileSync(path, JSON.stringify({ redTeam: { operatorRulings: { anyState: false } } }));
      const posted = [];
      const sinks = createRecordRedTeamRulingSinks({ readScope,
        readThread: () => ({ headRefOid: HEAD, labels: [], comments }),
        resolveIdentity: () => OP, readStandingRulingScope: () => null,
        resolveCard: () => card, post: (...args) => posted.push(args),
      });
      expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](payload)).toThrow(/not parked at the round cap.*nothing written/);
      expect(posted).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])('live opt-out refuses an any-state payload before writing (automatic card: %s)', automatic => {
    const comments = [redTeam()];
    const payload = planRedTeamRuling(read({ comments, scope: { value: { anyState: true } },
      card: automatic ? null : card }), input({ card: automatic ? undefined : CARD }));
    const posted = [], cards = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [], comments }),
      readScope: () => OFF, resolveIdentity: () => OP, readStandingRulingScope: () => null,
      resolveCard: () => card, post: (...args) => posted.push(args),
      fileCard: (...args) => { cards.push(args); throw new Error('must not dispatch'); },
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](payload)).toThrow(/not parked at the round cap.*nothing written/);
    expect(posted).toEqual([]);
    expect(cards).toEqual([]);
  });
  it.each(['reason', 'card read'])('live opt-out during %s refuses the existing-card release record', phase => {
    const comments = [redTeam()], posted = [];
    let liveScope = { value: { anyState: true } };
    const payload = planRedTeamRuling(read({ comments, scope: liveScope }), input());
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [], comments }),
      readScope: () => liveScope, resolveIdentity: () => OP, readStandingRulingScope: () => null,
      resolveCard: () => { if (phase === 'card read') liveScope = OFF; return card; },
      post: (_repo, _pr, body) => {
        posted.push(body); comments.push({ author: OP, body });
        if (phase === 'reason') liveScope = OFF;
      },
      syncLabels: () => { throw new Error('must not sync'); },
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](payload))
      .toThrow(/not parked at the round cap.*reason posted; no release record written/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toContain("The operator's reason");
  });
  it('live opt-out still permits a cap-eligible existing-card ruling', () => {
    const comments = thread(), posted = [];
    const payload = planRedTeamRuling(read({ comments, scope: { value: { anyState: true } } }), input());
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [], comments }), readScope: () => OFF,
      resolveIdentity: () => OP, readStandingRulingScope: () => null, resolveCard: () => card,
      post: (_repo, _pr, body) => { posted.push(body); comments.push({ author: OP, body }); }, syncLabels: () => null,
    });
    expect(sinks[RED_TEAM_RULING_CARD_EFFECT](payload)).toMatchObject({ indices: [1], card: { ref: CARD } });
    expect(posted).toHaveLength(2);
  });
  it('read-back uses live scope if the opt-out happens while posting the release', () => {
    const comments = [redTeam()], posted = [];
    let liveScope = { value: { anyState: true } };
    const payload = planRedTeamRuling(read({ comments, scope: liveScope }), input());
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [], comments }), readScope: () => liveScope,
      resolveIdentity: () => OP, readStandingRulingScope: () => null, resolveCard: () => card,
      post: (_repo, _pr, body) => {
        posted.push(body); comments.push({ author: OP, body });
        if (body.includes('outcome=operator-card')) liveScope = OFF;
      }, syncLabels: () => { throw new Error('must not sync'); },
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](payload)).toThrow(/record was posted but the gate still holds break/);
    expect(posted).toHaveLength(2);
  });
  it('live opt-in cannot widen a planned cap-only ruling', () => {
    const posted = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [], comments: [redTeam()] }),
      readScope: () => ({ value: { anyState: true } }),
      resolveIdentity: () => OP, readStandingRulingScope: () => null, post: (...args) => posted.push(args),
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(read(), input())))
      .toThrow(/not parked at the round cap.*nothing written/);
    expect(posted).toEqual([]);
  });
  it('default cap-only policy permits review:changes with a trusted cap', () => {
    expect(planRedTeamRuling(read({ labels: ['review:changes'] }), input())).toMatchObject({ scope: { anyState: false }, indices: [1] });
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
  it('the sink reapplies the bound cap-only policy when the cap disappears', () => {
    const posted = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: ['review:changes'], comments: [redTeam()] }),
      resolveIdentity: () => OP, readStandingRulingScope: () => null, post: (...args) => posted.push(args),
    });
    expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](planRedTeamRuling(read(), input()))).toThrow(/not parked at the round cap.*nothing written/);
    expect(posted).toEqual([]);
  });
});

describe('block and not-real rulings', () => {
  const read = (over = {}) => ({ scope: { value: { anyState: true } }, identity: OP, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
  const input = (over = {}) => ({ repo, pr: PR, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });
  function fake({ cardOk = true, postFails = null, liveHead = HEAD, labels = [], identity = OP, author = 'chalbert', claims, noPid = false, initial, sharedBreaks, attemptFails = false, receiptFails = false, ledgerFails = false } = {}) {
    const comments = initial ? [...initial] : thread();
    const posted = [], cards = [], labelCalls = [], labelSyncs = [], events = [], warnings = [];
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
      readScope: () => ({ value: { anyState: true } }),
      readStandingRulingScope: () => null, resolveIdentity: () => identity,
      claims: claims ?? memClaims,
      fileCard: (c, session) => { cards.push(c); if (!cardOk) return { ok: false, error: 'spawn failed' }; return { ok: true, session, handle: noPid ? undefined : 'pid:4242' }; },
      post: (r, n, body) => { if (postFails?.(body)) throw new Error('gh down'); posted.push(body); comments.push({ author: { login: author }, createdAt: '2026-10-20T23:55:00Z', body }); },
      runSetLabel: (exe, args) => { labelCalls.push(args); return '{"ok":true}'; },
      appendEvents: async rows => { if (ledgerFails) throw new Error('ledger unavailable'); events.push(...rows); }, warn: m => warnings.push(m), syncLabels: (a) => { labelSyncs.push(a); return { add: null, remove: [] }; },
    });
    return { sinks, posted, cards, labelCalls, labelSyncs, events, warnings, comments, memClaims, advance: (ms) => { clock += ms; } };
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
  it('kill switch off: a result no longer at the round cap writes nothing', async () => {
    const f = fake();
    f.comments.splice(1, 1);
    await expect(f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }, { scope: OFF }))).rejects.toThrow(/not parked at the round cap.*nothing written/);
    expect(f.posted).toEqual([]);
  });
  it('a sink re-checks the poster: a bot identity writes nothing', () => {
    const f = fake({ identity: { login: 'web-everything[bot]', type: 'Bot' } });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not a human account/);
    expect(f.cards.length + f.posted.length).toBe(0);
  });
  it('records posted by the automation account never release the break, and the sink says so', async () => {
    const f = fake({ author: 'web-everything' });
    await expect(f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }))).rejects.toThrow(/not in the read-back as a human operator/);
  });
  it('refuses a moved head or a missing trusted cap, writing nothing', () => {
    const moved = fake({ liveHead: OTHER });
    expect(() => moved.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/head moved/);
    const changes = fake({ labels: [{ name: 'review:changes' }], initial: [redTeam()] });
    expect(() => changes.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor({}, { scope: OFF }))).toThrow(/not parked at the round cap/);
    expect(moved.cards.length + moved.posted.length + changes.cards.length + changes.posted.length).toBe(0);
  });
  it.each(['block', 'not-real'])('%s defaults to cap-only and refuses a pending extension', ruling => {
    const args = { ruling, ...(ruling === 'not-real' ? { cause: 'other' } : {}) };
    expect(() => payloadFor(args, { scope: undefined, comments: [redTeam()] })).toThrow(/not parked at the round cap/);
    const grant = { author: OP, createdAt: '2026-10-20T23:50:00Z', body: buildRoundExtensionComment({
      repo, pr: PR, by: 1, actor: OP.login, channel: 'chat', reason: 'one more round', at: '2026-10-20T23:50:00Z',
    }) };
    expect(() => payloadFor(args, { scope: undefined, comments: thread([grant]) })).toThrow(/pending round extension/);
  });
  it('not-real: a failed ledger append reports an error and leaves the hold intact without a release', async () => {
    const f = fake({ ledgerFails: true });
    await expect((async () => f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' })))())
      .rejects.toThrow(/ledger-write-miss.*ledger unavailable/);
    expect(heldAfter(f.comments).map(f => f.index)).toEqual([1]);
    expect(f.posted.some(body => body.includes('outcome=operator-not-real'))).toBe(false);
    expect(f.labelCalls).toEqual([]);
    expect(f.labelSyncs).toEqual([]);
  });
  it.each([{ labels: [] }, { labels: ['review:changes'] }])('block: a failed ledger append preserves the hold and reports the miss (labels=%j)', async ({ labels }) => {
    const f = fake({ ledgerFails: true, labels });
    await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' })))
      .resolves.toMatchObject({ sentBack: true, ledgerWriteMiss: true });
    expect(heldAfter(f.comments).map(f => f.index)).toEqual([1]);
    expect(f.warnings).toEqual([expect.stringMatching(/ledger-write-miss.*ledger unavailable/)]);
    expect(f.posted.some(body => body.includes('outcome=operator-not-real'))).toBe(false);
    expect(f.labelCalls).toHaveLength(labels.length ? 0 : 1);
  });
  it('not-real: a failed reason POST leaves the break held', async () => {
    const f = fake({ postFails: body => body.includes('Operator ruling on') });
    await expect(f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }))).rejects.toThrow(/gh down/);
    expect(f.posted).toEqual([]);
    expect(heldAfter(f.comments).map(f => f.index)).toEqual([1]);
  });
  it('not-real: a head change during the reason POST prevents release', async () => {
    const comments = thread(), posted = [];
    let liveHead = HEAD;
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: liveHead, labels: [], comments }),
      readStandingRulingScope: () => null, resolveIdentity: () => OP,
      post: (_repo, _pr, body) => { posted.push(body); liveHead = OTHER; },
    });
    await expect(sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }))).rejects.toThrow(/head moved.*no release record written/);
    expect(posted).toHaveLength(1);
    expect(posted[0]).not.toContain('<!-- we:red-team-gate');
  });
  it('not-real: leaves the break advisory and clears nothing else', async () => {
    const f = fake();
    await f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real', cause: 'other' }));
    expect(f.cards).toEqual([]);
    expect(f.events).toEqual([expect.objectContaining({ type: 'ruling', repo, pr: PR, ruling: 'not-real',
      findingKey: `red-team:${HEAD}:${payloadFor({ ruling: 'not-real', cause: 'other' }).resultId}:1`,
      source: 'record-red-team-ruling', actor: expect.objectContaining({ declared: 'chalbert', channel: 'claude-code-chat' }) })]);
    expect(f.posted[1]).toContain('outcome=operator-not-real');
    expect(f.posted[0]).toContain('does not clear `review:human`');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('block: sends back through review-set-label --to=changes with the operator as actor', async () => {
    const f = fake();
    await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }))).resolves.toMatchObject({ sentBack: true });
    expect(f.labelCalls[0]).toEqual(expect.arrayContaining(['5530', '--repo=o/r', '--to=changes', '--actor=chalbert', '--channel=claude-code-chat']));
    expect(f.posted[0]).toMatch(/outcome=operator-block result=[0-9a-f]{16} -->/);
    expect(f.posted[0]).toContain('sent back to the fixer (#1)');
  });
  it.each([[true, 1], [true, 2], [false, 1], [false, 2]])('block: rejects proof when only one of two selected findings is held or sent back (capped=%s, advisory=#%s)', async (atCap, advisoryIndex) => {
    const comments = [redTeam(HEAD, [1, 2].map(index => ({ summary: `Confirmed break ${index}`, category: 'edge-case',
      impactIfUnfixed: 'broken', file: 'backlog/x.md', line: 24 + index, confirmedByRecheck: true }))), ...(atCap ? [capped()] : [])];
    const labels = ['review:changes'];
    const p = payloadFor({ ruling: 'block', break: '1,2' }, { comments, labels });
    expect(p.indices).toEqual([1, 2]);
    const disposition = () => readRedTeamDisposition({ comments: operatorBoundComments(comments), repo, pr: PR,
      head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } });
    expect(disposition()[atCap ? 'held' : 'sendBack'].map(f => f.index)).toEqual([1, 2]);
    const posted = [], labelCalls = [], events = [], syncs = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [...labels], comments: [...comments] }),
      readScope: () => ({ value: { anyState: true } }), readStandingRulingScope: () => null, resolveIdentity: () => OP,
      post: (_repo, _pr, body) => {
        posted.push(body);
        comments.push({ author: OP, createdAt: '2026-10-20T23:55:00Z', body });
        // A concurrent operator release wins for just one finding before the block's read-back.
        // Keep the block record intact so only the per-finding coverage proof can reject it.
        if (posted.length === 2) comments.push({ author: OP, createdAt: '2026-10-20T23:56:00Z',
          body: `${redTeamGateMarker(PR, HEAD, 'operator-not-real', p.resultId)}\n**Red-team gate** operator ruling:\n- 1 finding(s) left advisory (#${advisoryIndex}).` });
      },
      runSetLabel: (_exe, args) => { labelCalls.push(args); return '{"ok":true}'; },
      appendEvents: async rows => { events.push(...rows); }, syncLabels: args => { syncs.push(args); },
    });
    await expect(sinks[RED_TEAM_RULING_BLOCK_EFFECT](p)).rejects.toThrow(`the gate does not hold break(s) #${advisoryIndex};`);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toContain('sent back to the fixer (#1, #2)');
    expect(disposition()[atCap ? 'held' : 'sendBack'].map(f => f.index)).toEqual([3 - advisoryIndex]);
    expect(disposition()[atCap ? 'sendBack' : 'held']).toEqual([]);
    expect(operatorRulingsOnLiveResult(operatorBoundComments(comments), PR, HEAD).ruled.get(advisoryIndex).at(-1)).toBe('advisory');
    expect(labelCalls).toEqual([]);
    expect(events).toEqual([]);
    expect(syncs).toEqual([]);
  });
  it('block: can block again after applyRedTeamGate files the finding as card-queued', async () => {
    const comments = [redTeam(HEAD, [{ summary: 'Degraded recovery', category: 'edge-case',
      impactIfUnfixed: 'degraded', file: 'backlog/x.md', line: 24, confirmedByRecheck: true }])];
    const labels = ['review:changes'];
    let tick = 0;
    const post = (author, body) => comments.push({ author, body, createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, tick++)).toISOString() });
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [...labels], comments: [...comments] }),
      readScope: () => ({ value: { anyState: true } }), readStandingRulingScope: () => null,
      resolveIdentity: () => OP, post: (_repo, _pr, body) => post(OP, body),
      appendEvents: async () => {}, syncLabels: () => null,
    });
    const replan = () => planRedTeamRuling(read({ comments, labels }), input({ ruling: 'block' }));
    await expect(sinks[RED_TEAM_RULING_BLOCK_EFFECT](replan())).resolves.toMatchObject({ sentBack: true });
    expect(() => replan()).toThrow(/already ruled `block`/);
    await expect(applyRedTeamGate({ repo, pr: PR }, {
      readPr: () => ({ headRefOid: HEAD, labels, comments }),
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }),
      fileCard: () => ({ ok: true, session: 'gate-card' }),
      postComment: ({ body }) => post({ login: 'web-everything' }, body),
    })).resolves.toMatchObject({ status: 'applied', cardMarker: 'posted' });
    expect(comments.some(c => c.body.includes('outcome=card-queued'))).toBe(true);
    expect(readRedTeamDisposition({ comments: operatorBoundComments(comments), repo, pr: PR, head: HEAD,
      setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } })).toMatchObject({ held: [], sendBack: [] });
    await expect(sinks[RED_TEAM_RULING_BLOCK_EFFECT](replan())).resolves.toMatchObject({ sentBack: true });
    expect(readRedTeamDisposition({ comments: operatorBoundComments(comments), repo, pr: PR, head: HEAD,
      setting: CONFIRMED_BREAKS_DEFAULTS, operatorRulings: { anyState: true } }).sendBack.map(f => f.index)).toEqual([1]);
  });
  it.each([[1, true], [2, true], [2, false]])('block: restores review:changes when labels change during POST %s (restore succeeds=%s)', async (changeOnPost, restoreSucceeds) => {
    const comments = thread(), labelCalls = [];
    let labels = ['review:changes'], posts = 0;
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [...labels], comments: [...comments] }),
      readScope: () => ({ value: { anyState: true } }), readStandingRulingScope: () => null,
      resolveIdentity: () => OP,
      post: (_repo, _pr, body) => {
        comments.push({ author: OP, createdAt: '2026-10-20T23:55:00Z', body });
        if (++posts === changeOnPost) labels = ['review:accepted'];
      },
      runSetLabel: (_exe, args) => {
        labelCalls.push(args);
        if (!restoreSucceeds) return '{"ok":false,"error":"restoration failed"}';
        labels = ['review:changes'];
        return '{"ok":true}';
      },
      appendEvents: async () => {}, syncLabels: () => null,
    });
    const pending = sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }, { labels }));
    if (!restoreSucceeds) {
      await expect(pending).rejects.toThrow('restoration failed');
      expect(labelCalls).toHaveLength(1);
      expect(labels).toEqual(['review:accepted']);
      expect(heldAfter(comments).map(f => f.index)).toEqual([1]);
      return;
    }
    const result = await pending;
    expect(labelCalls).toHaveLength(1);
    expect(labelCalls[0]).toContain('--to=changes');
    expect(labels).toEqual(['review:changes']);
    expect(result).toMatchObject({ sentBack: true });
    expect(result.alreadyUnderChanges).toBeUndefined();
  });
  it.each([{ labels: [] }, { labels: ['review:changes'] }])('block: records the send-back in the ledger for labels=%j', async ({ labels }) => {
    const f = fake({ labels });
    await f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }));
    expect(f.events).toEqual([expect.objectContaining({ type: 'send-back', repo, pr: PR,
      cause: 'block-ruling', source: 'record-red-team-ruling', actor: expect.objectContaining({ declared: 'chalbert' }) })]);
  });
  it.each([['any-state', { value: { anyState: true } }], ['cap-only', OFF]])('block: replans from the persisted ruling after a failed send-back and applies review:changes on retry (%s)', async (_mode, scope) => {
    const comments = thread(), labels = ['review:human'], labelCalls = [];
    const sinks = createRecordRedTeamRulingSinks({
      readThread: () => ({ headRefOid: HEAD, labels: [...labels], comments: [...comments] }),
      readScope: () => scope,
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
      expect(() => planRedTeamRuling(read({ comments: thread([carded]), card: null }), input())).toThrow(/no confirmed red-team break .* left to rule `card`/);
      const ref = 'we:backlog/x.md';
      expect(planRedTeamRuling(read({ comments: thread([carded]), card: { requested: ref, ref, readable: true } }), input({ card: ref }))).toMatchObject({ cardRef: ref, indices: [1] });
    });
    it('post-write proof fails on a moved head, a missing record, or a changed result', async () => {
      const p = payloadFor({ ruling: 'not-real', cause: 'other' });
      for (const after of [
        { headRefOid: OTHER, labels: [], comments: [] },
        { headRefOid: H, labels: [], comments: thread() },
        { headRefOid: H, labels: [], comments: thread([redTeam(HEAD, [{ summary: 'new finding', category: 'edge-case', impactIfUnfixed: 'broken', file: 'new.mjs', line: 2, confirmedByRecheck: true }])]) },
      ]) {
        let n = 0;
        const sinks = createRecordRedTeamRulingSinks({ readThread: () => (n++ < 3 ? { headRefOid: H, labels: [], comments: thread() } : after),
          resolveIdentity: () => OP, post: () => {}, appendEvents: async () => {}, warn: () => {}, syncLabels: () => null });
        await expect(sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](p)).rejects.toThrow(/head moved|not in the read-back|result changed/);
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
