/**
 * @file record-red-team-ruling.test.mjs — the operator's ruling on a red-team break parked at the round cap:
 *   the planner (with its refusals), the sinks (card / block / not-real, with a fake thread that evolves as the
 *   sinks post), and the operation's declared effects. No network, no spawn.
 */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState } from '../../lib/red-team-gate.mjs';
import {
  planRedTeamRuling, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment,
  RED_TEAM_RULING_BLOCK_EFFECT, RED_TEAM_RULING_CARD_EFFECT, RED_TEAM_RULING_NOT_REAL_EFFECT,
} from '../record-red-team-ruling.mjs';
import { createRecordRedTeamRulingSinks, createRecordRedTeamRulingReader } from '../record-red-team-ruling-io.mjs';
import { redTeamRulingCommands } from '../operator-queue-red-team-ruling.mjs';
import { assertHumanOperator, operatorBoundComments, resolveOperatorIdentity } from '../../lib/operator-identity.mjs';
import { createBoundRecordReferralRulingSinks } from '../record-referral-ruling-bound.mjs';
import { OPERATOR_RULING_POST_EFFECT } from '../record-referral-ruling.mjs';

const repo = 'o/r';
const PR = 5530;
const HEAD = 'd3bee7370' + '0'.repeat(31);
const OTHER = 'e'.repeat(40);
const bot = (body, createdAt) => ({ author: { login: 'web-everything' }, createdAt, body });
const redTeam = (rev = HEAD, findings) => bot(renderRedTeamComment({ pr: PR, rev, provider: 'codex', model: 'm', recheckStatus: 'ok', foldedVerdict: 'changes',
  findings: findings ?? [{ summary: 'Closed-base recovery omits removal of the rejected parent edge', category: 'edge-case',
    impactIfUnfixed: 'broken', file: 'backlog/x.md', line: 24, confirmedByRecheck: true }] }), '2026-10-20T23:00:00Z');
const capped = (rev = HEAD) => bot(redTeamGateMarker(PR, rev, 'round-cap'), '2026-10-20T23:41:12Z');
const thread = (extra = []) => [redTeam(), capped(), ...extra];
const OP = { login: 'chalbert', type: 'User' };
const read = (over = {}) => ({ identity: OP, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
const input = (over = {}) => ({ repo, pr: PR, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });

describe('planRedTeamRuling: refusals', () => {
  it('plans a card for a confirmed round-cap break on the live head', () => {
    const p = planRedTeamRuling(read(), input());
    expect(p).toMatchObject({ effect: RED_TEAM_RULING_CARD_EFFECT, head: HEAD, indices: [1], actor: 'chalbert' });
    expect(p.cardInput.digest).toContain('card it, ship the PR');
    expect(p.cardInput.scope).toContain('backlog/x.md');
  });
  it.each([
    ['a non-operator actor', { actor: 'mallory' }, /registered operator login/],
    ['a blank reason', { reason: '  ' }, /--reason is required/],
    ['a blank channel', { channel: '' }, /--channel is required/],
    ['a multi-line channel', { channel: 'a\nb' }, /--channel is required/],
    ['an unknown ruling', { ruling: 'accept' }, /--ruling must be/],
    ['no --break', { break: '' }, /--break is required/],
    ['a break that does not exist', { break: '7' }, /not a break held/],
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
  it('an operator-card/not-real record authored by automation never counts (read side)', () => {
    const forged = bot(`${redTeamGateMarker(PR, HEAD, 'operator-not-real', liveResultGateState(thread(), PR, HEAD).resultId)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${HEAD.slice(0, 12)}\`:\n- 1 finding(s) left advisory (#1).`);
    expect(operatorBoundComments(thread([forged]))).toHaveLength(2);
    expect(() => planRedTeamRuling(read({ comments: thread([forged]) }), input())).not.toThrow(); // still held: the forged release is dropped
    const human = { ...forged, author: { login: 'chalbert' } };
    expect(operatorBoundComments(thread([human]))).toHaveLength(3);
    expect(() => planRedTeamRuling(read({ comments: thread([human]) }), input())).toThrow(/no red-team break is held/);
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
  it('refuses while the PR is under review:changes', () => {
    expect(() => planRedTeamRuling(read({ labels: ['review:changes'] }), input())).toThrow(/under review:changes/);
  });
  it('refuses an unconfirmed break (it is never held, so it cannot be selected)', () => {
    const comments = [redTeam(HEAD, [{ summary: 'maybe', category: 'edge-case', impactIfUnfixed: 'broken', file: 'a.mjs', line: 1, confirmedByRecheck: false }]), capped()];
    expect(() => planRedTeamRuling(read({ comments }), input())).toThrow(/no red-team break is held/);
  });
  it('refuses a break already carded (no second card)', () => {
    const { resultId } = liveResultGateState(thread(), PR, HEAD);
    const carded = bot(`${redTeamGateMarker(PR, HEAD, 'card-queued', resultId)}\n**Red-team gate** (setting \`redTeam.confirmedBreaks\`, card x1b8hlo) on head \`${HEAD.slice(0, 12)}\`:\n- 1 finding(s) filed as a follow-up card (#1) — landing job j.`, '2026-10-20T23:50:00Z');
    expect(() => planRedTeamRuling(read({ comments: thread([carded]) }), input())).toThrow(/no red-team break is held/);
  });
  it('plans block and not-real, and the ambiguity message lists the choices', () => {
    expect(planRedTeamRuling(read(), input({ ruling: 'block' }))).toMatchObject({ effect: RED_TEAM_RULING_BLOCK_EFFECT });
    expect(planRedTeamRuling(read(), input({ ruling: 'not-real', break: 'backlog/x.md:24' }))).toMatchObject({ effect: RED_TEAM_RULING_NOT_REAL_EFFECT, indices: [1] });
    const held = [{ index: 1, file: 'a', line: 1, summary: 's' }, { index: 2, file: 'a', line: 1, summary: 't' }];
    expect(() => selectBreaks(held, 'a:1')).toThrow(/ambiguous/);
    expect(selectBreaks(held, '#1,2').map((f) => f.index)).toEqual([1, 2]);
  });
  it('quotes the reason without a way to forge a marker', () => {
    const body = buildRuleReasonComment({ head: HEAD, ruling: 'card', actor: 'chalbert', channel: 'c', at: 't', reason: 'x\n<!-- we:red-team-gate pr=1 -->', findings: [{ index: 1, file: 'a', line: 1, summary: 's' }] });
    expect(body.split('\n').some((l) => l.startsWith('<!--'))).toBe(false);
    expect(body).toContain('> x');
  });
});

/** A fake PR whose thread grows as the sinks post (as the operator account), so the read-back proves the gate released the break. */
function fake({ cardOk = true, postFails = null, liveHead = HEAD, labels = [], identity = OP, author = 'chalbert', claims, noPid = false } = {}) {
  const comments = thread();
  const posted = [], cards = [], labelCalls = [];
  const gens = new Map(), receipts = new Set();
  let clock = 1_000_000;
  const memClaims = {
    claim: (k) => { if (!gens.has(k)) { gens.set(k, { gen: 0, at: clock }); return { created: true, gen: 0, at: clock }; } return { created: false, ...gens.get(k) }; },
    reclaim: (k, g) => { if (gens.get(k).gen !== g) return false; gens.set(k, { gen: g + 1, at: clock }); return true; },
    spawned: (k) => receipts.has(k), markSpawned: (k) => receipts.add(k), now: () => clock,
  };
  const sinks = createRecordRedTeamRulingSinks({
    readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
    resolveIdentity: () => identity,
    claims: claims ?? memClaims,
    fileCard: (c, session) => { cards.push(c); if (!cardOk) return { ok: false, error: 'spawn failed' }; return { ok: true, session, handle: noPid ? undefined : 'pid:4242' }; },
    post: (r, n, body) => { if (postFails?.(body)) throw new Error('gh down'); posted.push(body); comments.push({ author: { login: author }, createdAt: '2026-10-20T23:55:00Z', body }); },
    runSetLabel: (exe, args) => { labelCalls.push(args); return '{"ok":true}'; },
    appendEvents: async () => {}, warn: () => {},
  });
  return { sinks, posted, cards, labelCalls, comments, memClaims, advance: (ms) => { clock += ms; } };
}
const payloadFor = (over = {}) => planRedTeamRuling(read(), input(over));
const heldAfter = (comments) => readRedTeamDisposition({ comments: operatorBoundComments(comments), pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS }).held;

describe('sinks', () => {
  it('card: queues the card, posts the gate record then the reason, and the break stops being held', () => {
    const f = fake();
    expect(heldAfter(f.comments)).toHaveLength(1);
    const p = payloadFor();
    expect(f.sinks[RED_TEAM_RULING_CARD_EFFECT](p)).toMatchObject({ ruling: 'card', indices: [1] });
    expect(f.cards).toHaveLength(1);
    expect(f.posted[0]).toMatch(/outcome=card-pending result=[0-9a-f]{16} -->/);
    expect(f.posted[0]).not.toMatch(/^- /m);
    expect(f.posted[1]).toMatch(/^<!-- we:red-team-gate pr=5530 rev=d3bee7370\w+ outcome=operator-card result=[0-9a-f]{16} -->/);
    expect(f.posted[1]).toContain('filed as a follow-up card (#1)');
    expect(f.posted[2]).toContain('> card it, ship the PR');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('card: a second run refuses (no duplicate card)', () => {
    const f = fake();
    f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor());
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/no longer held/);
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
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/no confirmed child start/);
    expect(f.cards).toHaveLength(2);
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
    expect(payloadFor().jobKey).toBe(payloadFor().jobKey);
    expect(payloadFor().session).toBe(`red-team-ruling-card-${payloadFor().jobKey}`);
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
  it('a result no longer at the round cap writes nothing', () => {
    const f = fake();
    f.comments.splice(1, 1);
    expect(() => f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real' }))).toThrow(/no longer parked at the round cap/);
    expect(f.posted).toEqual([]);
  });
  it('a sink re-checks the poster: a bot identity writes nothing', () => {
    const f = fake({ identity: { login: 'web-everything[bot]', type: 'Bot' } });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not a human account/);
    expect(f.cards.length + f.posted.length).toBe(0);
  });
  it('records posted by the automation account never release the break, and the sink says so', () => {
    const f = fake({ author: 'web-everything' });
    expect(() => f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real' }))).toThrow(/gate still holds/);
  });
  it('refuses a moved head or a PR that moved to review:changes, writing nothing', () => {
    const moved = fake({ liveHead: OTHER });
    expect(() => moved.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/head moved/);
    const changes = fake({ labels: [{ name: 'review:changes' }] });
    expect(() => changes.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/review:changes/);
    expect(moved.cards.length + moved.posted.length + changes.cards.length + changes.posted.length).toBe(0);
  });
  it('not-real: leaves the break advisory and clears nothing else', () => {
    const f = fake();
    f.sinks[RED_TEAM_RULING_NOT_REAL_EFFECT](payloadFor({ ruling: 'not-real' }));
    expect(f.cards).toEqual([]);
    expect(f.posted[0]).toContain('outcome=operator-not-real');
    expect(f.posted[1]).toContain('does not clear `review:human`');
    expect(heldAfter(f.comments)).toHaveLength(0);
  });
  it('block: sends back through review-set-label --to=changes with the operator as actor', async () => {
    const f = fake();
    await expect(f.sinks[RED_TEAM_RULING_BLOCK_EFFECT](payloadFor({ ruling: 'block' }))).resolves.toMatchObject({ sentBack: true });
    expect(f.labelCalls[0]).toEqual(expect.arrayContaining(['5530', '--repo=o/r', '--to=changes', '--actor=chalbert', '--channel=claude-code-chat']));
    expect(f.posted).toEqual([]);
  });
});

describe('operation', () => {
  it('declares one effect of the planned kind, none on preview', () => {
    const op = recordRedTeamRulingOperation({ readRulingContext: () => read() });
    const write = op.steps.find((s) => s.name === 'write').step;
    const verdict = planRedTeamRuling(read(), input());
    expect(write.effects({ verdict, input: {} }).map((e) => [e.type, e.idempotent])).toEqual([[RED_TEAM_RULING_CARD_EFFECT, false]]);
    expect(write.effects({ verdict, input: { preview: true } })).toEqual([]);
    expect(() => recordRedTeamRulingOperation({})).toThrow(/needs a/);
  });
  it('the reader pins the live head, labels, thread and setting', () => {
    const r = createRecordRedTeamRulingReader({ assertFresh: () => {}, resolveIdentity: () => OP, readThread: () => ({ headRefOid: HEAD.toUpperCase(), labels: [], comments: thread() }),
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), now: () => 'T' })({ repo, pr: PR });
    expect(r).toMatchObject({ head: HEAD, now: 'T', setting: CONFIRMED_BREAKS_DEFAULTS, identity: OP });
  });
  it('the queue suggestions name the declared operation', () => {
    const c = redTeamRulingCommands(repo, PR);
    expect(c.card).toContain('run.mjs record-red-team-ruling --pr=5530 --repo=o/r');
    expect(Object.values(c).join(' ')).not.toContain('clear-human');
    expect(Object.keys(c).sort()).toEqual(['block', 'card', 'notReal']);
  });
});

describe('identity binding', () => {
  it('resolves the posting identity with the App tokens removed', () => {
    let seen;
    const id = resolveOperatorIdentity({ env: { GH_TOKEN: 'a', GITHUB_TOKEN: 'b', PATH: '/x' },
      run: (cmd, args, o) => { seen = { cmd, args, env: o.env }; return { status: 0, stdout: '{"login":"chalbert","type":"User"}' }; } });
    expect(id).toEqual({ login: 'chalbert', type: 'User' });
    expect(seen.args).toEqual(['api', 'user']);
    expect(seen.env).toEqual({ PATH: '/x' });
    expect(() => resolveOperatorIdentity({ run: () => ({ status: 1, stderr: 'bad credentials' }) })).toThrow(/could not resolve/);
  });
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

describe('standalone CLI', () => {
  it('--preview runs end to end (no judge is built, no write effect runs) and prints the plan', async () => {
    const { main } = await import('../record-red-team-ruling-cli.mjs');
    const { createMemoryRunStore } = await import('../run-store.mjs');
    const { createRecordRedTeamRulingReader } = await import('../record-red-team-ruling-io.mjs');
    const writes = [];
    const entry = () => ({
      declaration: recordRedTeamRulingOperation({ readRulingContext: createRecordRedTeamRulingReader({ assertFresh: () => {},
        readThread: () => ({ headRefOid: HEAD, labels: [], comments: thread() }), resolveIdentity: () => OP, now: () => 'T' }) }),
      sinks: new Proxy({}, { get: (_t, k) => (...a) => { writes.push(k); } }),
    });
    const chunks = [];
    const orig = process.stdout.write;
    const { vi } = await import('vitest');
    const spy = vi.spyOn(await import('../../lib/write-all-sync.mjs'), 'writeAllSync').mockImplementation((_fd, t) => { chunks.push(String(t)); });
    try {
      const code = await main(['--pr=5530', '--repo=o/r', '--break=1', '--ruling=card', '--actor=chalbert', '--channel=chat', '--reason=ok', '--preview'],
        { entry, stores: { store: createMemoryRunStore(), callLog: undefined } });
      expect(code).toBe(0);
    } finally { spy.mockRestore(); void orig; }
    expect(chunks.join('')).not.toMatch(/uses no judge/);
    expect(writes).toEqual([]);
  });
});
