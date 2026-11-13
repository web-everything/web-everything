import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createActionStore } from '../../operations/action-store.mjs';
import { carryRedTeamAcrossRestamp } from '../red-team-restamp-carry.mjs';
import { redTeamMarker, redTeamForHead, redTeamResultId, redTeamGateMarker, liveResultGateState, parseRedTeamComment } from '../red-team-gate.mjs';
import { parseVerdictCarriedMarker, buildVerdictCarriedMarker } from '../rebase-verdict-carry.mjs';
import { syncRedTeamStatusLabels, planRedTeamStatusLabels } from '../red-team-status-labels.mjs';

vi.mock('../red-team-status-labels.mjs', async original => ({ ...await original(), syncRedTeamStatusLabels: vi.fn() }));
const pr = 42, repo = 'web-everything/web-everything', fromSha = 'a'.repeat(40), toSha = 'b'.repeat(40), id = 'c'.repeat(40);
const trusted = body => ({ body, author: { login: 'chalbert' } });
const clean = sha => trusted(`${redTeamMarker(pr, sha)}\nNo confirmed breaks.`);
const broken = sha => `${redTeamMarker(pr, sha)}\n1. [**confirmed**] (correctness, high) \`scripts/x.mjs:1\` — Drops the result`;
function carriedBreak({ gates = true, prose = 'Review verdict carried across an identical contribution.' } = {}) {
  const body = broken(fromSha), resultId = redTeamResultId(parseRedTeamComment(body));
  return trusted([
    ...(gates ? [redTeamGateMarker(pr, fromSha, 'sent-back', resultId)] : []),
    buildVerdictCarriedMarker({ fromSha: 'd'.repeat(40), toSha: fromSha, patchId: id }),
    prose, body,
  ].join('\n'));
}
let roots = [];
function fixture(over = {}) {
  const coordinationRoot = mkdtempSync(join(tmpdir(), 'restamp-carry-'));
  roots.push(coordinationRoot);
  const io = { pr, repo, fromSha, toSha, comments: [clean(fromSha)],
    coordinationRoot,
    env: { WE_REVIEW_CARRY_ACROSS_REBASE: 'on' }, log: vi.fn(), post: vi.fn(),
    // Exercise the unmodified contributionPatchId, including different merge bases after main moves.
    exec: vi.fn((cmd, args, opts) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'merge-base') return args[2] === fromSha ? 'd'.repeat(40) : 'e'.repeat(40);
      if (args[0] === 'diff') return 'same contribution';
      if (args[0] === 'patch-id') { expect(opts.input).toBe('same contribution'); return id; }
      throw Error('unexpected git call');
    }), ...over };
  io.readComments ??= vi.fn(() => io.comments);
  return io;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots = []; });
describe('red team across a drain restamp', () => {
  it('carries a clean result with identical patch IDs after a main merge and syncs labels after posting', () => {
    const io = fixture();
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
    const body = io.post.mock.calls[0][0].body;
    expect(body).toContain(redTeamMarker(pr, toSha));
    expect(body).not.toContain(redTeamMarker(pr, fromSha));
    expect(parseVerdictCarriedMarker(body)).toEqual({ fromSha, toSha, patchId: id });
    expect(syncRedTeamStatusLabels).toHaveBeenCalledWith(expect.objectContaining({ repo, pr, head: toSha }));
    expect(syncRedTeamStatusLabels.mock.invocationCallOrder[0]).toBeGreaterThan(io.post.mock.invocationCallOrder[0]);
    expect(planRedTeamStatusLabels({ repo, pr, head: toSha, comments: [trusted(body)], env: {} }).add).toBe('red-team:clear');
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('carryAcrossRebase=on (env)'));
  });
  it.each(['different', 'old unreadable', 'new unreadable'])('fails closed for %s patch ID', mode => {
    const io = fixture(); let n = 0;
    const exec = io.exec;
    io.exec = (cmd, args, opts) => {
      if (args[0] === 'patch-id') {
        n++;
        if ((mode === 'old unreadable' && n === 1) || (mode === 'new unreadable' && n === 2)) return '';
        if (mode === 'different' && n === 2) return 'f'.repeat(40);
      }
      return exec(cmd, args, opts);
    };
    carryRedTeamAcrossRestamp(io);
    expect(io.post).not.toHaveBeenCalled();
    expect(syncRedTeamStatusLabels).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/patch.*(unreadable|differ)/));
  });
  it('preserves confirmed-break content, blocked labels and both send-back and card gate outcomes', () => {
    const body = `${redTeamMarker(pr, fromSha)}\n1. [**confirmed**] (correctness, high) \`scripts/x.mjs:1\` — Drops the result`;
    const resultId = redTeamResultId(redTeamForHead([trusted(body)], pr, fromSha));
    const io = fixture({ comments: [trusted(body), ...['sent-back', 'card-queued'].map(outcome => trusted(redTeamGateMarker(pr, fromSha, outcome, resultId)))] });
    carryRedTeamAcrossRestamp(io);
    const carried = io.post.mock.calls[0][0].body;
    expect(carried).toContain('Drops the result');
    expect(carried).not.toMatch(/not required|No confirmed breaks/);
    for (const outcome of ['sent-back', 'card-queued']) expect(carried).toContain(redTeamGateMarker(pr, toSha, outcome, resultId));
    const comments = [...io.comments, trusted(carried)];
    expect([...liveResultGateState(comments, pr, toSha).outcomes]).toEqual(['sent-back', 'card-queued']);
    expect(planRedTeamStatusLabels({ repo, pr, head: toSha, comments, env: {} }).add).toBe('red-team:blocked');
  });
  it.each(['off', 'new result', 'no old result', 'untrusted old result'])('does not carry with %s', mode => {
    const io = fixture();
    if (mode === 'off') io.env.WE_REVIEW_CARRY_ACROSS_REBASE = 'off';
    if (mode === 'new result') io.comments.push(clean(toSha));
    if (mode === 'no old result') io.comments = [];
    if (mode === 'untrusted old result') io.comments[0].author.login = 'stranger';
    carryRedTeamAcrossRestamp(io);
    expect(io.post).not.toHaveBeenCalled();
    expect(io.exec).not.toHaveBeenCalled();
  });
  it('reads the thread and posts through injected IO when comments are omitted', () => {
    const readComments = vi.fn(() => [clean(fromSha)]), postComment = vi.fn();
    const io = fixture({ comments: undefined, readComments, post: undefined, postComment });
    carryRedTeamAcrossRestamp(io);
    expect(readComments).toHaveBeenCalledWith({ repo, pr });
    expect(postComment).toHaveBeenCalledTimes(1);
  });
  it('does not carry gate outcomes naming a different result', () => {
    const io = fixture({ comments: [clean(fromSha), trusted(redTeamGateMarker(pr, fromSha, 'card-queued', '0'.repeat(16)))] });
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
    expect(io.post.mock.calls[0][0].body).not.toContain('we:red-team-gate');
  });
  it('carries the newer carried break over an older raw clear by creation order', () => {
    const newer = { ...carriedBreak(), createdAt: '2026-11-12T12:00:00Z' };
    const older = { ...clean(fromSha), created_at: '2026-11-12T11:00:00Z' };
    const io = fixture({ comments: [newer, older] });
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
    const body = io.post.mock.calls[0][0].body;
    expect(body).toContain('Drops the result');
    expect(body).not.toContain('No confirmed breaks');
    const state = liveResultGateState([trusted(body)], pr, toSha);
    expect(state.resultId).toBe(redTeamResultId(parseRedTeamComment(broken(fromSha))));
    expect([...state.outcomes]).toEqual(['sent-back']);
  });
  it('refuses a result-id/gate mismatch when the selected carry has unreadable gate layout', () => {
    const io = fixture({ comments: [clean(fromSha), carriedBreak({ prose: 'Unknown carry layout' })] });
    expect(liveResultGateState(io.comments, pr, fromSha).resultId)
      .not.toBe(redTeamResultId(parseRedTeamComment(broken(fromSha))));
    carryRedTeamAcrossRestamp(io);
    expect(io.post).not.toHaveBeenCalled();
    expect(syncRedTeamStatusLabels).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('result ID/gate mismatch'));
  });
  it.each(['missing', 'different result'])('refuses findings with %s gate markers', mode => {
    const io = fixture({ comments: [clean(fromSha), carriedBreak({ gates: false })] });
    if (mode === 'different result') io.comments.push(trusted(redTeamGateMarker(pr, fromSha, 'sent-back', '0'.repeat(16))));
    carryRedTeamAcrossRestamp(io);
    expect(io.post).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('findings without gate markers'));
  });
  it('does not post twice when the updated thread contains the first carry', () => {
    const io = fixture();
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
    io.comments.push(trusted(io.post.mock.calls[0][0].body));
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
    expect(syncRedTeamStatusLabels).toHaveBeenCalledTimes(1);
  });
  it('carries a sole carried result through another restamp with its gate markers', () => {
    const io = fixture({ comments: [carriedBreak()] });
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
    const first = io.post.mock.calls[0][0].body;
    const nextSha = 'e'.repeat(40);
    const next = fixture({ fromSha: toSha, toSha: nextSha, comments: [trusted(first)], patchId: () => id });
    carryRedTeamAcrossRestamp(next);
    expect(next.post).toHaveBeenCalledTimes(1);
    const body = next.post.mock.calls[0][0].body;
    expect(parseVerdictCarriedMarker(body)).toEqual({ fromSha: toSha, toSha: nextSha, patchId: id });
    expect(body.match(/review-verdict-carried/g)).toHaveLength(1);
    expect(body).toContain('Drops the result');
    expect(body).not.toContain('No confirmed breaks');
    expect([...liveResultGateState([trusted(body)], pr, nextSha).outcomes]).toEqual(['sent-back']);
  });
  it.each(['marker only', 'result carried from another head'])('does not post over a trusted destination %s', mode => {
    const marker = buildVerdictCarriedMarker({ fromSha: mode === 'marker only' ? fromSha : 'd'.repeat(40), toSha, patchId: id });
    const body = mode === 'marker only' ? marker : `${marker}\nReview verdict carried across an identical contribution.\n${clean(toSha).body}`;
    const io = fixture({ comments: [clean(fromSha), trusted(body)] });
    carryRedTeamAcrossRestamp(io);
    expect(io.post).not.toHaveBeenCalled();
    expect(io.exec).not.toHaveBeenCalled();
  });
  it('ignores an untrusted destination carry marker', () => {
    const body = buildVerdictCarriedMarker({ fromSha, toSha, patchId: id });
    const io = fixture({ comments: [clean(fromSha), { body, author: { login: 'stranger' } }] });
    carryRedTeamAcrossRestamp(io);
    expect(io.post).toHaveBeenCalledTimes(1);
  });
  it.each(['read', 'post', 'sync', 'log'])('never throws on a %s failure', mode => {
    const fail = () => { throw Error('unavailable'); };
    const io = fixture();
    if (mode === 'read') { delete io.comments; io.readComments = fail; }
    if (mode === 'post') io.post = fail;
    if (mode === 'sync') syncRedTeamStatusLabels.mockImplementationOnce(fail);
    if (mode === 'log') io.log = fail;
    expect(() => carryRedTeamAcrossRestamp(io)).not.toThrow();
  });
  it.each(['clear', 'break', 'carried', 'marker from another head'])('skips a destination %s arriving during patch comparison', mode => {
    const marker = buildVerdictCarriedMarker({ fromSha: 'd'.repeat(40), toSha, patchId: id });
    const destination = mode === 'clear' ? clean(toSha)
      : mode === 'break' ? trusted(broken(toSha))
      : trusted(mode === 'carried' ? `${marker}\nReview verdict carried across an identical contribution.\n${clean(toSha).body}` : marker);
    let thread = [clean(fromSha)];
    const io = fixture({ comments: undefined, readComments: vi.fn(() => thread),
      patchId: vi.fn(() => { thread = [clean(fromSha), destination]; return id; }) });
    carryRedTeamAcrossRestamp(io);
    expect(io.readComments).toHaveBeenCalledTimes(2);
    expect(io.readComments.mock.invocationCallOrder[1]).toBeGreaterThan(io.patchId.mock.invocationCallOrder[1]);
    expect(io.post).not.toHaveBeenCalled();
    expect(syncRedTeamStatusLabels).not.toHaveBeenCalled();
    expect(createActionStore({ root: io.coordinationRoot }).list().at(-1).state).toBe('terminal');
  });
  it.each([false, true])('reselects a newer source break and its fresh gates (gated=%s)', gated => {
    const body = broken(fromSha), resultId = redTeamResultId(parseRedTeamComment(body));
    const fresh = [clean(fromSha), trusted(body), ...(gated ? [trusted(redTeamGateMarker(pr, fromSha, 'sent-back', resultId))] : [])];
    const io = fixture({ readComments: () => fresh });
    carryRedTeamAcrossRestamp(io);
    if (!gated) {
      expect(io.post).not.toHaveBeenCalled();
      expect(io.log).toHaveBeenCalledWith(expect.stringContaining('findings without gate markers'));
    } else {
      expect(io.post).toHaveBeenCalledTimes(1);
      expect(io.post.mock.calls[0][0].body).toContain('Drops the result');
      expect(io.post.mock.calls[0][0].body).not.toContain('No confirmed breaks');
      expect(io.post.mock.calls[0][0].body).toContain(redTeamGateMarker(pr, toSha, 'sent-back', resultId));
    }
  });
  it('allows exactly one overlapping call to post using the shared durable claim', () => {
    const first = fixture();
    const actions = createActionStore({ root: first.coordinationRoot });
    const second = fixture({ actions });
    first.actions = actions;
    first.readComments = vi.fn(() => {
      expect(actions.list().at(-1).state).toBe('intent');
      carryRedTeamAcrossRestamp(second);
      return first.comments;
    });
    carryRedTeamAcrossRestamp(first);
    expect(first.post).toHaveBeenCalledTimes(1);
    expect(second.post).not.toHaveBeenCalled();
    expect(second.readComments).not.toHaveBeenCalled();
    expect(second.log).toHaveBeenCalledWith(expect.stringContaining('destination claim held'));
    expect(actions.list()).toHaveLength(1);
    expect(actions.list()[0]).toMatchObject({ state: 'terminal', outcome: 'settled' });
  });
  it('releases a successful claim so a later distinct source situation can claim the same destination', () => {
    const first = fixture();
    carryRedTeamAcrossRestamp(first);
    const actions = createActionStore({ root: first.coordinationRoot });
    const later = fixture({ actions, comments: [carriedBreak()] });
    carryRedTeamAcrossRestamp(later);
    expect(first.post).toHaveBeenCalledTimes(1);
    expect(later.post).toHaveBeenCalledTimes(1);
    expect(later.post.mock.calls[0][0].body).toContain('Drops the result');
    expect(actions.list().map(r => [r.attempt, r.state, r.outcome])).toEqual([
      [1, 'terminal', 'settled'], [2, 'terminal', 'settled'],
    ]);
  });
  it.each(['unreadable final thread', 'failed final read', 'failed post', 'failed label sync'])('releases the claim after %s', mode => {
    const io = fixture();
    const fail = () => { throw Error('unavailable'); };
    if (mode === 'unreadable final thread') io.readComments = () => null;
    if (mode === 'failed final read') io.readComments = fail;
    if (mode === 'failed post') io.post = fail;
    if (mode === 'failed label sync') syncRedTeamStatusLabels.mockImplementationOnce(fail);
    expect(() => carryRedTeamAcrossRestamp(io)).not.toThrow();
    const actions = createActionStore({ root: io.coordinationRoot });
    expect(actions.list().at(-1).state).toBe('terminal');
    if (mode.includes('thread') || mode.includes('read')) expect(io.post).not.toHaveBeenCalled();
    expect(actions.claim({ resource: actions.list()[0].resource, kind: 'red-team-restamp-carry', owner: 'later' }).ok).toBe(true);
  });
  it.each(['claim', 'transition'])('swallows and logs a store %s failure', mode => {
    const io = fixture();
    const actions = createActionStore({ root: io.coordinationRoot });
    io.actions = { ...actions, [mode]: () => { throw Error('store unavailable'); } };
    expect(() => carryRedTeamAcrossRestamp(io)).not.toThrow();
    expect(io.post).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledWith(expect.stringContaining('store unavailable'));
  });
  it('wires exactly one carry after successful writes, only for a plain restamp, using the source acceptance SHA', () => {
    const source = readFileSync('scripts/review-set-label.mjs', 'utf8');
    expect(source.match(/carryRedTeamAcrossRestamp\(/g)).toHaveLength(1);
    const afterWrites = source.slice(source.indexOf('for (const step of order)'));
    expect(afterWrites).toMatch(/if \(to === 'restamp' && !guardedRestamp\) carryRedTeamAcrossRestamp\(/);
    expect(afterWrites).toContain('fromSha: parseReviewedSha(prComments), toSha: headSha');
  });
});
