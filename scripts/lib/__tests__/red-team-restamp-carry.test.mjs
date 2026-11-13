import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { carryRedTeamAcrossRestamp } from '../red-team-restamp-carry.mjs';
import { redTeamMarker, redTeamForHead, redTeamResultId, redTeamGateMarker, liveResultGateState } from '../red-team-gate.mjs';
import { parseVerdictCarriedMarker } from '../rebase-verdict-carry.mjs';
import { syncRedTeamStatusLabels, planRedTeamStatusLabels } from '../red-team-status-labels.mjs';

vi.mock('../red-team-status-labels.mjs', async original => ({ ...await original(), syncRedTeamStatusLabels: vi.fn() }));
const pr = 42, repo = 'owner/repo', fromSha = 'a'.repeat(40), toSha = 'b'.repeat(40), id = 'c'.repeat(40);
const trusted = body => ({ body, author: { login: 'chalbert' } });
const clean = sha => trusted(`${redTeamMarker(pr, sha)}\nNo confirmed breaks.`);
function fixture(over = {}) {
  return { pr, repo, fromSha, toSha, comments: [clean(fromSha)],
    env: { WE_REVIEW_CARRY_ACROSS_REBASE: 'on' }, log: vi.fn(), post: vi.fn(),
    // Exercise the unmodified contributionPatchId, including different merge bases after main moves.
    exec: vi.fn((cmd, args, opts) => {
      if (args[0] === 'cat-file') return '';
      if (args[0] === 'merge-base') return args[2] === fromSha ? 'd'.repeat(40) : 'e'.repeat(40);
      if (args[0] === 'diff') return 'same contribution';
      if (args[0] === 'patch-id') { expect(opts.input).toBe('same contribution'); return id; }
      throw Error('unexpected git call');
    }), ...over };
}
beforeEach(() => vi.clearAllMocks());
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
  it.each(['read', 'post', 'sync', 'log'])('never throws on a %s failure', mode => {
    const fail = () => { throw Error('unavailable'); };
    const io = fixture();
    if (mode === 'read') { delete io.comments; io.readComments = fail; }
    if (mode === 'post') io.post = fail;
    if (mode === 'sync') syncRedTeamStatusLabels.mockImplementationOnce(fail);
    if (mode === 'log') io.log = fail;
    expect(() => carryRedTeamAcrossRestamp(io)).not.toThrow();
  });
  it('wires exactly one carry after successful writes, only for a plain restamp, using the source acceptance SHA', () => {
    const source = readFileSync('scripts/review-set-label.mjs', 'utf8');
    expect(source.match(/carryRedTeamAcrossRestamp\(/g)).toHaveLength(1);
    const afterWrites = source.slice(source.indexOf('for (const step of order)'));
    expect(afterWrites).toMatch(/if \(to === 'restamp' && !guardedRestamp\) carryRedTeamAcrossRestamp\(/);
    expect(afterWrites).toContain('fromSha: parseReviewedSha(prComments), toSha: headSha');
  });
});
