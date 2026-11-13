// @vitest-environment node
// (node: the carried-check writer reads its App id setting through a file: URL, as the daemon does.)
import { describe, it, expect, vi } from 'vitest';
import { runReviewJob } from '../review-job.mjs';
import { parseVerdictCarriedMarker } from '../../lib/rebase-verdict-carry.mjs';
import { gateOutcomesForHead, parseRedTeamComment, redTeamGateMarker, redTeamResultId } from '../../lib/red-team-gate.mjs';
const a = 'a'.repeat(40), b = 'b'.repeat(40), p = 'c'.repeat(40);
const trusted = body => ({ author: { login: 'chalbert' }, body });
// #6606: a carry needs a publishable result on the source head. This is the canonical policy-clear result, and the
// gate decision is bound to it, as the gate records one (a carry moves only decisions made on the carried result).
const clearA = `<!-- we:red-team-advisory pr=1 rev=${a} -->\n\nRed team not required on this head: not owed (stored review)`;
const gateA = redTeamGateMarker(1, a, 'card-queued', redTeamResultId(parseRedTeamComment(clearA)));
function fixture() {
  return { root: '.', now: () => 0, claim: () => ({ ok: true }), unclaim: vi.fn(), report: vi.fn(), log: vi.fn(),
    redTeamStatus: () => {},
    readPrevCompletion: () => null, newActorId: () => 'actor', prepareLane: () => ({ head: 'a'.repeat(40) }), acquireLane: () => ({ lanePath: 'fake-lane' }), updateRecord: vi.fn(), releaseLane: vi.fn(),
    carryAcrossRebaseSetting: () => ({ value: 'on', source: 'test' }),
    readCarryEvidence: () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`), trusted(clearA), trusted(gateA)] }),
    contributionPatchId: () => p, restampVerdict: vi.fn(() => ({ ok: true })), postCarryComment: vi.fn(),
    publishCarriedCheck: vi.fn(() => ({ ok: true })), markCarriedCheckOwed: vi.fn(),
    runLoop: vi.fn(() => ({ status: 0, stdout: JSON.stringify({ stopped: 'complete', verdict: { verdict: 'accept', loop: { outcome: 'converged' } } }) })),
    runExtraSeats: vi.fn(), runRedTeam: vi.fn(), startSpeculativeRedTeam: vi.fn(), speculativeRedTeamSetting: () => ({ enabled: true }),
  };
}
describe('review job rebase carry', () => {
  it('restamps before one carry comment and starts no round or seats', () => {
    const io = fixture(); const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out.outcome).toBe('carried'); expect(io.restampVerdict).toHaveBeenCalledWith(expect.objectContaining({ newHead: b }));
    expect(io.postCarryComment).toHaveBeenCalledTimes(1);
    const body = io.postCarryComment.mock.calls[0][0].body;
    expect(parseVerdictCarriedMarker(body)).toEqual({ fromSha: a, toSha: b, patchId: p });
    expect([...gateOutcomesForHead([trusted(body)], 1, b)]).toEqual(['card-queued']);
    for (const key of ['runLoop', 'runExtraSeats', 'runRedTeam', 'startSpeculativeRedTeam']) expect(io[key]).not.toHaveBeenCalled();
    expect(io.restampVerdict.mock.invocationCallOrder[0]).toBeLessThan(io.postCarryComment.mock.invocationCallOrder[0]);
    expect(io.publishCarriedCheck).toHaveBeenCalledTimes(1);
    expect(io.publishCarriedCheck).toHaveBeenCalledWith(expect.objectContaining({
      pr: 1, repo: 'web-everything/web-everything', headSha: b,
    }));
    expect(io.postCarryComment.mock.invocationCallOrder[0]).toBeLessThan(io.publishCarriedCheck.mock.invocationCallOrder[0]);
    expect(out.checkPublished).toBe(true);
    // #6606: the retry marker precedes the comment, so a crash between comment and publication leaves the head owed.
    expect(io.markCarriedCheckOwed).toHaveBeenCalledWith({ pr: 1, repo: 'web-everything/web-everything', headSha: b });
    expect(io.markCarriedCheckOwed.mock.invocationCallOrder[0]).toBeLessThan(io.postCarryComment.mock.invocationCallOrder[0]);
  });
  it('a marker write failure is logged and the carry still comments and publishes', () => {
    const io = fixture();
    io.markCarriedCheckOwed.mockImplementation(() => { throw Error('EACCES'); });
    const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out).toMatchObject({ outcome: 'carried', checkPublished: true });
    expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/retry marker not written \(.*EACCES/));
    expect(io.postCarryComment).toHaveBeenCalledTimes(1);
  });
  it.each(['refused', 'throws'])('a %s check publication preserves the carried verdict without throwing', mode => {
    const io = fixture();
    io.publishCarriedCheck.mockImplementation(() => {
      if (mode === 'throws') throw Error('check API unavailable');
      return { ok: false, reason: 'check API unavailable' };
    });
    const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out).toMatchObject({ outcome: 'carried', headSha: b, checkPublished: false });
    expect(io.publishCarriedCheck).toHaveBeenCalledTimes(1);
    expect(io.postCarryComment).toHaveBeenCalledTimes(1);
    expect(io.postCarryComment.mock.invocationCallOrder[0]).toBeLessThan(io.publishCarriedCheck.mock.invocationCallOrder[0]);
    expect(io.runLoop).not.toHaveBeenCalled();
  });
  it.each(['off', 'unequal', 'unreadable', 'restamp-failed', 'red-team-pending', 'gate-with-hold'])('%s runs the normal arc without a carry comment', mode => {
    const io = fixture();
    if (mode === 'off') io.carryAcrossRebaseSetting = () => ({ value: 'off' });
    if (mode === 'unequal') io.contributionPatchId = ({ sha }) => sha === a ? p : a;
    if (mode === 'unreadable') io.readCarryEvidence = () => { throw Error('read failed'); };
    if (mode === 'restamp-failed') io.restampVerdict.mockReturnValue({ ok: false, reason: 'own proof refused' });
    if (mode === 'red-team-pending') io.readCarryEvidence = () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`)] });
    if (mode === 'gate-with-hold') io.readCarryEvidence = () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`),
      trusted(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->\nunknown hold`)] });
    const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out.outcome).not.toBe('carried'); expect(io.runLoop).toHaveBeenCalledTimes(1); expect(io.postCarryComment).not.toHaveBeenCalled();
    expect(io.publishCarriedCheck).not.toHaveBeenCalled();
    if (['red-team-pending', 'gate-with-hold'].includes(mode)) expect(io.restampVerdict).not.toHaveBeenCalled();
  });

  // #6606 red team: a carry must never post a result the live publisher refuses, or the carried head waits forever
  // for a check no retry can publish. The carry decision reads the re-keyed result with the publisher's own rule.
  const clear = (reason, rev = a) => trusted(`<!-- we:red-team-advisory pr=1 rev=${rev} -->\n\nRed team not required on this head: ${reason}`);
  const withAdvisory = advisory => () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`),
    trusted(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`), advisory] });
  it('a canonical policy-clear result carries, re-keyed to the new head', () => {
    const io = fixture();
    io.readCarryEvidence = withAdvisory(clear('not owed (stored review)'));
    const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out.outcome).toBe('carried');
    expect(io.postCarryComment.mock.calls[0][0].body)
      .toContain(`<!-- we:red-team-advisory pr=1 rev=${b} -->\n\nRed team not required on this head: not owed (stored review)`);
  });
  it.each([
    ['a tab in the reason', clear('not\towed'), true],
    ['a whitespace-only reason', clear('   '), true],
    ['a line separator in the reason', clear(`not${String.fromCharCode(0x2028)}owed`), true],
    ['a paragraph separator in the reason', clear(`not${String.fromCharCode(0x2029)}owed`), true],
    ['no result at all beside the gate marker', null, true],
    // Refused earlier, by the approval guard, not by the publishability gate; pinned so neither path regresses.
    ['extra prose after the reason', trusted(`<!-- we:red-team-advisory pr=1 rev=${a} -->\n\nRed team not required on this head: x\nmore`), false],
    ['a finding-shaped line', trusted(`<!-- we:red-team-advisory pr=1 rev=${a} -->\n 1. [confirmed] x`), false],
  ])('a result the publisher would refuse (%s) is not carried: no restamp, owed marker or comment', (_, advisory, gated) => {
    const io = fixture();
    io.readCarryEvidence = advisory ? withAdvisory(advisory) : () => ({ headSha: b, comments: [trusted(`<!-- reviewed-sha: ${a} -->`),
      trusted(`<!-- we:red-team-gate pr=1 rev=${a} outcome=card-queued -->`)] });
    const out = runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(out.outcome).not.toBe('carried');
    for (const key of ['restampVerdict', 'markCarriedCheckOwed', 'postCarryComment', 'publishCarriedCheck']) expect(io[key]).not.toHaveBeenCalled();
    expect(io.runLoop).toHaveBeenCalledTimes(1);
    if (gated) expect(io.log).toHaveBeenCalledWith(expect.stringMatching(/verdict carry unavailable \(carried red-team result is not publishable/));
  });
});

// #6606: the production carry publisher leaves a durable retry marker when its attempt is not confirmed, so the
// on-skip recovery pass republishes the check instead of skipping the carried head for good.
describe('review job carried check outbox wiring', () => {
  it('a refused carried-check publication leaves the head owed for recovery', async () => {
    const { createReviewJobIo } = await import('../review-job.mjs');
    const { readCarriedCheckUnpublished } = await import('../../lib/drain-red-team-evidence.mjs');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'carry-outbox-'));
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(dir, 'locks'), WE_APP_ID: 'unset' };
    try {
      const exec = vi.fn(() => { throw Error('no GitHub in tests'); });
      const io = createReviewJobIo({ root: dir, env, exec });
      io.markCarriedCheckOwed({ pr: 2, repo: 'web-everything/web-everything', headSha: b });
      expect(readCarriedCheckUnpublished({ repo: 'web-everything/web-everything', pr: 2, head: b, env })).toBe(true);
      expect(io.publishCarriedCheck({ pr: 1, repo: 'web-everything/web-everything', headSha: b })).toMatchObject({ ok: false });
      expect(readCarriedCheckUnpublished({ repo: 'web-everything/web-everything', pr: 1, head: b, env })).toBe(true);
      expect(readCarriedCheckUnpublished({ repo: 'web-everything/web-everything', pr: 1, head: a, env })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  // #6606 referral (block): the default publisher built its gh as `{ ...options, cwd, env }` (the job env replaced the
  // WE-App writer env on the POST) and took `appId: env.WE_APP_ID`, which the review daemon never sets. The on-skip
  // recovery pass's default republisher had the same two defects; both now build from one shared publisher.
  it.each(['review job', 'on-skip recovery'])('the %s default publisher resolves the App id from the setting and POSTs the check as today\'s App', async site => {
    const { createReviewJobIo } = await import('../review-job.mjs');
    const { carriedCheckPublisher } = await import('../../lib/review-red-team-on-skip.mjs');
    const { readCarriedCheckUnpublished } = await import('../../lib/drain-red-team-evidence.mjs');
    const { renderRedTeamComment } = await import('../review-extra-seats.mjs');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'carry-writer-'));
    // The review daemon: a reviewer-role identity with its own inherited token, and no WE_APP_ID.
    const env = { WE_SHARED_RUNS_DIR: join(dir, 'runs'), WE_RED_TEAM_CHECK_LOCK_DIR: join(dir, 'locks'),
      WE_GITHUB_APP_ROLE: 'reviewer', GH_TOKEN: 'fixture-role-token' };
    const repo = 'web-everything/web-everything';
    const body = renderRedTeamComment({ pr: 1, rev: b, provider: 'codex', model: 'fixture', findings: [], recheckStatus: 'not-needed', foldedVerdict: 'accept' });
    const runs = [], writes = [];
    try {
      const exec = vi.fn((file, args, options = {}) => {
        expect(file).toBe('gh');
        if (args.includes('POST')) {
          writes.push({ args, env: options.env, cwd: options.cwd });
          // GitHub as the shim sees it: only today's App (the legacy role, no inherited token) may write.
          if (options.env?.WE_GITHUB_APP_ROLE !== 'legacy' || options.env?.GH_TOKEN) throw Error('HTTP 403: Resource not accessible by integration');
          if (String(args[1]).includes('/statuses/')) return '{}';
          runs.push({ ...JSON.parse(options.input), id: 100 + runs.length, app: { id: 5037855 } });
          return JSON.stringify({ id: 100 + runs.length - 1 });
        }
        if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: b, labels: [] });
        if (String(args).includes('/issues/1/comments'))
          return `${JSON.stringify({ id: 'n1', url: 'u', author: { login: 'web-everything' }, body, createdAt: '2026-11-07T12:00:00Z' })}\n`;
        if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } });
        if (String(args[1]).includes('/check-runs')) return JSON.stringify({ total_count: runs.length, check_runs: runs });
        if (/\/status\?/.test(String(args[1]))) return JSON.stringify({ total_count: 0, statuses: [] }); // no hold to clear
        throw Error(`unexpected gh read: ${args.join(' ')}`);
      });
      const publish = site === 'review job' ? createReviewJobIo({ root: dir, env, exec }).publishCarriedCheck
        : carriedCheckPublisher({ repo, env, run: (args, options) => exec('gh', args, options) });
      expect(publish({ pr: 1, repo, headSha: b })).toEqual({ ok: true });
      // Hold first (send-back item 1): the publication-hold status, then the one success check run. Every write runs as
      // today's App (the fixture holds no status, so no clear is posted).
      expect(writes.map(w => (String(w.args[1]).includes('/statuses/') ? 'hold' : 'check'))).toEqual(['hold', 'check']);
      for (const write of writes) {
        expect(write.env).toMatchObject({ WE_GITHUB_APP_ROLE: 'legacy', WE_SHARED_RUNS_DIR: env.WE_SHARED_RUNS_DIR });
        expect(write.env.GH_TOKEN).toBeUndefined();
        if (site === 'review job') expect(write.cwd).toBe(dir);
      }
      expect(runs).toEqual([expect.objectContaining({ app: { id: 5037855 }, external_id: `${repo}#1`, conclusion: 'success' })]);
      expect(readCarriedCheckUnpublished({ repo, pr: 1, head: b, env })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('human clearance remains owned by restamp', () => {
  it.each([true, false])('equal patches carry human clearance only if the restamp agrees (%s)', async agrees => {
    const { decideRestampHumanClearance, buildVerdictComment } = await import('../../review-set-label.mjs');
    const { parseLatestHumanClearedSha, parseReviewedSha, decideContradictoryVerdictHeal } = await import('../../lib/review-escalation.mjs');
    const oldDiff = 'diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n';
    const comments = [trusted(buildVerdictComment({ to: 'clear-human', actor: 'operator', headSha: a, reviewedDiff: oldDiff })),
      trusted(clearA), trusted(gateA)];
    const io = fixture(); io.readCarryEvidence = () => ({ headSha: b, comments });
    io.restampVerdict = vi.fn(() => {
      const humanClearance = decideRestampHumanClearance({ comments, headSha: b, headDiff: agrees ? oldDiff : oldDiff.replace('+new', '+changed') });
      comments.push(trusted(buildVerdictComment({ to: 'restamp', actor: 'review-carry', headSha: b, reviewedDiff: oldDiff, humanClearance })));
      return { ok: true };
    });
    expect(runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io).outcome).toBe('carried');
    comments.push(trusted(io.postCarryComment.mock.calls[0][0].body));
    expect(parseLatestHumanClearedSha(comments)).toBe(agrees ? b : null);
    const heal = decideContradictoryVerdictHeal({ currentLabels: ['review:accepted', 'review:human'], headSha: b,
      humanClearedSha: parseLatestHumanClearedSha(comments), acceptedSha: parseReviewedSha(comments), fetchOk: true });
    expect(heal.heal).toBe(!agrees);
    const { sweepReviewHoldLabels } = await import('../../conveyor/review-hold-reconcile.mjs');
    const provider = { readPrState: () => ({ state: 'OPEN', number: 1, labels: ['review:accepted', 'review:human'], headRefOid: b }),
      postComment: vi.fn(), setLabels: vi.fn() };
    const swept = sweepReviewHoldLabels({ repo: 'web-everything/web-everything', listPrs: () => [{ number: 1, labels: ['review:accepted', 'review:human'] }],
      provider, readComments: () => comments, readPr: () => ({ ...provider.readPrState(), comments }), settings: { referralDefault: 'operator' }, acceptCarry: () => [], runRuling: () => [] });
    expect(swept[0].healed ?? []).toEqual(agrees ? [] : ['review:accepted']);

  });
  it('unequal patches never invoke the human restamp writer', () => {
    const io = fixture(); io.contributionPatchId = ({ sha }) => sha === a ? p : b;
    runReviewJob({ pr: 1, repo: 'web-everything/web-everything' }, io);
    expect(io.restampVerdict).not.toHaveBeenCalled();
  });
});
