/** Live existing-card reader, sink and CLI subset; all IO injected. */
import { describe, expect, it } from 'vitest';
import { renderRedTeamComment } from '../review-extra-seats.mjs';
import { CONFIRMED_BREAKS_DEFAULTS, redTeamGateMarker, readRedTeamDisposition, liveResultGateState, gateRoundGrants } from '../../lib/red-team-gate.mjs';
import { buildRoundExtensionComment } from '../../conveyor/round-extension-mark.mjs';
import { planRedTeamRuling, selectBreaks, recordRedTeamRulingOperation, buildRuleReasonComment, RED_TEAM_RULING_CARD_EFFECT } from '../record-red-team-ruling.mjs';
import { operatorBoundComments } from '../../lib/operator-identity.mjs';

import { createRecordRedTeamRulingReader, createRecordRedTeamRulingSinks } from '../record-red-team-ruling-io.mjs';

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
const CARD = 'we:backlog/x.md';
const card = { requested: CARD, ref: CARD, readable: true, reason: 'readable' };
const read = (over = {}) => ({ identity: OP, card, head: HEAD, labels: [{ name: 'review:human' }], comments: thread(), setting: CONFIRMED_BREAKS_DEFAULTS, now: '2026-10-20T20:55:00-04:00', ...over });
const input = (over = {}) => ({ repo, pr: PR, card: CARD, break: '1', ruling: 'card', actor: 'chalbert', channel: 'claude-code-chat', reason: 'card it, ship the PR', ...over });

function fake({ liveHead = HEAD, labels = [], identity = OP, author = 'chalbert', initial = thread() } = {}) {
  const comments = [...initial], posted = [], labelSyncs = [];
  const sinks = createRecordRedTeamRulingSinks({
    readThread: () => ({ headRefOid: liveHead, labels, comments: [...comments] }),
    resolveIdentity: () => identity,
    post: (r, n, body) => { posted.push(body); comments.push({ author: { login: author }, createdAt: '2026-10-20T23:55:00Z', body }); },
    warn: () => {}, syncLabels: a => { labelSyncs.push(a); return { add: null, remove: [] }; },
  });
  return { sinks, comments, posted, labelSyncs };
}
const payloadFor = (over = {}, readOver = {}) => planRedTeamRuling(read(readOver), input(over));
const heldAfter = comments => readRedTeamDisposition({ comments, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS }).held;

function extendedThread({ grantRepo = repo, grantPr = PR, author = OP, sent = true, lateCap = false } = {}) {
  const comments = thread();
  const { resultId } = liveResultGateState(comments, PR, HEAD);
  // Explicit snapshots model a cap decision made before the grant, even if its POST lands last.
  const cap = bot(`${redTeamGateMarker(PR, HEAD, 'round-cap', resultId, [])}\n- 1 confirmed break(s) NOT sent back: round cap (#1).`, '2026-10-20T23:41:12Z');
  comments[1] = cap;
  comments.push({ author, createdAt: '2026-10-20T23:45:00Z', body: buildRoundExtensionComment({
    repo: grantRepo, pr: grantPr, by: 1, actor: OP.login, channel: 'test', reason: 'one more fix round', at: '2026-10-20T23:45:00Z',
  }) });
  if (sent) {
    const ids = gateRoundGrants(operatorBoundComments(comments), PR, repo).map(g => g.id);
    comments.push(bot(`${redTeamGateMarker(PR, HEAD, 'sent-back', resultId, ids)}\n- 1 confirmed break(s) sent back to the fixer (#1).`, '2026-10-20T23:46:00Z'));
  }
  if (lateCap) {
    comments.splice(1, 1);
    comments.push({ ...cap, createdAt: '2026-10-20T23:47:00Z' });
  }
  return comments;
}

describe('existing-card IO', () => {
  for (const phase of ['planning', 'pre-write']) {
    it.each([
      ['authenticated grant and send-back', {}, true],
      ['cap POST arriving after send-back', { lateCap: true }, true],
      ['grant awaiting send-back', { sent: false }, false],
      ['grant for another repo', { grantRepo: 'other/repo' }, false],
      ['grant for another PR', { grantPr: PR + 1 }, false],
      ['automation-posted grant without a verified standing ruling', { author: { login: 'web-everything', type: 'Bot' } }, false],
    ])(`${phase}: %s preserves the current owner`, (_name, options, fixerOwns) => {
      const plan = payloadFor(); // Plan while the break is still cap-held.
      const comments = extendedThread(options);
      const d = readRedTeamDisposition({ comments: operatorBoundComments(comments), repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS });
      expect(d.outcome).toBe(fixerOwns ? 'sent-back' : 'round-cap');
      expect(d.held.map(f => f.index)).toEqual(fixerOwns ? [] : [1]);
      expect(d.sendBack.map(f => f.index)).toEqual(fixerOwns ? [1] : []);
      const f = fake({ initial: comments });
      const act = phase === 'planning' ? () => payloadFor({}, { comments }) : () => f.sinks[RED_TEAM_RULING_CARD_EFFECT](plan);
      if (fixerOwns) {
        expect(act).toThrow(phase === 'planning' ? /no red-team break is held/ : /no red-team break is held.*nothing written/);
        expect(f.posted).toEqual([]);
        expect(f.labelSyncs).toEqual([]);
        expect(readRedTeamDisposition({ comments: operatorBoundComments(f.comments), repo, pr: PR, head: HEAD, setting: CONFIRMED_BREAKS_DEFAULTS }).sendBack.map(f => f.index)).toEqual([1]);
      } else {
        expect(act()).toMatchObject({ indices: [1] });
        expect(f.posted).toHaveLength(phase === 'planning' ? 0 : 2);
      }
    });
  }
  it('a sink re-checks the poster: a bot identity writes nothing', () => {
    const f = fake({ identity: { login: 'web-everything[bot]', type: 'Bot' } });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not a human account/);
    expect(f.posted.length).toBe(0);
  });
  it('a cited-card record releases the held break, records the reason, resyncs, and refuses a duplicate', () => {
    const f = fake({ labels: ['review:changes'] });
    const out = f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor());
    expect(out).toMatchObject({ ruling: 'card', indices: [1], card: { ref: CARD } });
    expect(f.posted).toHaveLength(2);
    expect(f.posted[0]).toContain(`outcome=operator-card result=${liveResultGateState(thread(), PR, HEAD).resultId}`);
    expect(f.posted[0]).toContain(`- 1 finding(s) carded by the operator to \`${CARD}\` (#1).`);
    expect(f.posted[1]).toContain('> card it, ship the PR');
    expect(heldAfter(f.comments)).toEqual([]);
    expect(f.labelSyncs).toEqual([{ repo, pr: PR, head: HEAD }]);
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/no red-team break is held/);
    expect(f.posted).toHaveLength(2);
  });
  it('a moved head or lost cap writes nothing; review:changes with the cap remains permitted', () => {
    const moved = fake({ liveHead: OTHER });
    expect(() => moved.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/head moved/);
    const noCap = fake({ initial: [redTeam()] });
    expect(() => noCap.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not parked at the round cap.*nothing written/);
    expect([...moved.posted, ...noCap.posted]).toEqual([]);
  });
  it('a result that changed on the same head writes nothing', () => {
    const f = fake();
    f.comments.push(redTeam(HEAD, [{ summary: 'a different break reusing #1', category: 'edge-case', impactIfUnfixed: 'broken', file: 'z.mjs', line: 9, confirmedByRecheck: true }]));
    f.comments.at(-1).createdAt = '2026-10-20T23:50:00Z';
    f.comments.push({ ...capped(), createdAt: '2026-10-20T23:51:00Z' });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/result on the live head changed/);
    expect(f.posted).toEqual([]);
  });
  it('records posted by automation fail read-back proof', () => {
    const f = fake({ author: 'web-everything' });
    expect(() => f.sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/not in the read-back as a human operator/);
    expect(heldAfter(f.comments)).toHaveLength(1);
  });
  it('post-write proof fails on a moved head, a missing record, or a changed result', () => {
    const next = redTeam(HEAD, [{ summary: 'new break', category: 'edge-case', impactIfUnfixed: 'broken', confirmedByRecheck: true }]);
    next.createdAt = '2026-10-20T23:59:00Z';
    for (const after of [
      { headRefOid: OTHER, comments: [] },
      { headRefOid: HEAD, comments: thread() },
      { headRefOid: HEAD, comments: [...thread(), next] },
    ]) {
      let n = 0;
      const sinks = createRecordRedTeamRulingSinks({ readThread: () => n++ === 0 ? { headRefOid: HEAD, comments: thread() } : after,
        resolveIdentity: () => OP, post: () => {}, warn: () => {}, syncLabels: () => null });
      expect(() => sinks[RED_TEAM_RULING_CARD_EFFECT](payloadFor())).toThrow(/head moved|not in the read-back|result changed/);
    }
  });
  it('the reader pins the live head, labels, complete thread, setting, identity and resolved card', () => {
    const resolutions = [], reads = [];
    const r = createRecordRedTeamRulingReader({ assertFresh: () => {}, resolveIdentity: () => OP,
      readThread: a => { reads.push(a); return { headRefOid: HEAD.toUpperCase(), labels: ['review:changes'], comments: thread() }; },
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), now: () => 'T',
      resolveCard: (ref, context) => { resolutions.push([ref, context]); return card; } })({ repo, pr: PR, card: CARD });
    expect(r).toMatchObject({ head: HEAD, labels: ['review:changes'], comments: thread(), now: 'T', setting: CONFIRMED_BREAKS_DEFAULTS, identity: OP, card });
    expect(reads).toEqual([{ repo, pr: PR }]);
    expect(resolutions).toEqual([[CARD, { repo, pr: PR, head: HEAD }]]);
  });
});

describe('standalone CLI', () => {
  it.each([true, false])('runs the real CLI with preview=%s and the existing-card sink', async preview => {
    const { main } = await import('../record-red-team-ruling-cli.mjs');
    const { createMemoryRunStore } = await import('../run-store.mjs');
    const { createMemoryCallLogStore } = await import('../call-log-store.mjs');
    const f = fake({ labels: ['review:changes'] });
    const entry = () => ({ declaration: recordRedTeamRulingOperation({ readRulingContext: createRecordRedTeamRulingReader({
      assertFresh: () => {}, readThread: () => ({ headRefOid: HEAD, labels: ['review:changes'], comments: f.comments }),
      readSetting: () => ({ value: CONFIRMED_BREAKS_DEFAULTS }), resolveIdentity: () => OP, resolveCard: () => card, now: () => 'T',
    }) }), sinks: f.sinks });
    const chunks = [];
    const { vi } = await import('vitest');
    const spy = vi.spyOn(await import('../../lib/write-all-sync.mjs'), 'writeAllSync').mockImplementation((_fd, t) => chunks.push(String(t)));
    try {
      const code = await main(['--pr=5530', '--repo=o/r', '--break=1', '--ruling=card', `--card=${CARD}`, '--actor=chalbert', '--channel=chat', '--reason=ok', ...(preview ? ['--preview'] : [])],
        { entry, stores: { store: createMemoryRunStore(), callLog: createMemoryCallLogStore() } });
      expect(code).toBe(0);
    } finally { spy.mockRestore(); }
    expect(chunks.join('')).not.toMatch(/uses no judge/);
    if (!preview) expect(chunks.join('')).toContain('1 effect(s) applied.');
    expect(f.posted).toHaveLength(preview ? 0 : 2);
    expect(heldAfter(f.comments)).toHaveLength(preview ? 1 : 0);
    expect(f.labelSyncs).toHaveLength(preview ? 0 : 1);
  });
});
