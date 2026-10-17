import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReview } from '../review-dispatch.mjs';
import { dispatchReviewJob, createReviewJobIo } from '../review-job.mjs';
import { readPr, createReviewPrSinks, fullReviewAnchor } from '../review-pr-io.mjs';
import { shapeReadFinding, renderJudgeInput, REVIEW_EFFECTS, renderFullReviewAnchor } from '../review-pr.mjs';
import { buildSendBackBody, RED_TEAM_GATE_ACTOR, RED_TEAM_GATE_CHANNEL } from '../red-team-gate-apply.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import { PR_COMMENTS_PAGE_SIZE } from '../../lib/review-label-provider.mjs';
const head = 'a'.repeat(40);
it.each([REVIEW_EFFECTS.LABEL, REVIEW_EFFECTS.ADVISORY_NOTE, REVIEW_EFFECTS.STACK_HOLD])('voids %s before any publish when same-head CI turns red and cancellation is enabled', async effect => {
  const runNode = vi.fn(); const postComment = vi.fn();
  const sinks = createReviewPrSinks({ readPublishHead: () => head, env: { WE_REVIEW_CANCEL_ON_CI_RED: 'true' }, runNode, postComment,
    publishGate: () => ({ headSha: head, checks: [{ name: 'unit', head_sha: head, conclusion: 'failure' }] }) });
  await expect(sinks[effect]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' })).rejects.toThrow('review void');
  expect(runNode).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});
it('with cancellation on, an optional red never voids a finished review', async () => {
  const postComment = vi.fn();
  const sinks = createReviewPrSinks({ readPublishHead: () => head, env: { WE_REVIEW_CANCEL_ON_CI_RED: 'true' }, postComment,
    publishGate: () => ({ headSha: head, requiredChecks: ['unit'],
      checks: [{ name: 'CodeQL', head_sha: head, conclusion: 'failure' }, { name: 'unit', head_sha: head, conclusion: 'success' }] }) });
  await expect(sinks[REVIEW_EFFECTS.ADVISORY_NOTE]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' })).resolves.toEqual({ posted: true });
  expect(postComment).toHaveBeenCalledTimes(1);
});
it('publishes an advisory on same-head red CI when cancellation is disabled', async () => {
  const postComment = vi.fn();
  const sinks = createReviewPrSinks({ readPublishHead: () => head, env: { WE_REVIEW_CANCEL_ON_CI_RED: 'false' }, postComment,
    publishGate: () => ({ headSha: head, checks: [{ name: 'unit', head_sha: head, conclusion: 'failure' }] }) });
  await expect(sinks[REVIEW_EFFECTS.ADVISORY_NOTE]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' })).resolves.toEqual({ posted: true });
  expect(postComment).toHaveBeenCalledTimes(1);
  expect(postComment).toHaveBeenCalledWith('o/n', 7, 'verdict');
});
it.each([false, true])('publishes with unreadable CI when the head is pinned (cancel=%s)', cancel => {
  const postComment = vi.fn();
  const publishGate = vi.fn(() => ({ allowed: false, reason: 'unreadable-ci' }));
  const sinks = createReviewPrSinks({ readPublishHead: () => head, publishGate, postComment,
    env: { WE_REVIEW_CANCEL_ON_CI_RED: String(cancel) } });
  return expect(sinks[REVIEW_EFFECTS.ADVISORY_NOTE]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' })).resolves.toEqual({ posted: true }).then(() => {
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(publishGate).toHaveBeenCalledTimes(cancel ? 1 : 0);
  });
});
it.each([REVIEW_EFFECTS.LABEL, REVIEW_EFFECTS.ADVISORY_NOTE, REVIEW_EFFECTS.STACK_HOLD])('refuses %s with a missing or superseded reviewed head', async effect => {
  for (const reviewedHead of [undefined, 'b'.repeat(40)]) {
    const runNode = vi.fn(); const postComment = vi.fn();
    const sinks = createReviewPrSinks({ readPublishHead: () => head, runNode, postComment,
      publishGate: () => ({ headSha: head, checks: [] }), env: {} });
    await expect(sinks[effect]({ pr: 7, repo: 'o/n', reviewedHead, body: 'verdict' })).rejects.toThrow('review void');
    expect(runNode).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
  }
});
it('honors the documented rebase carry setting independently of mechanical skipping', () => {
  const io = createReviewJobIo({ env: {}, readFile: () => '{"carryAcrossRebase":"off"}' });
  expect(io.carryAcrossRebaseSetting().value).toBe('off');
});
it.each([
  [{ WE_REVIEW_CARRY_ACROSS_REBASE: 'off' }, 'on'],
  [{ WE_REVIEW_SKIP_DRAIN_MECHANICAL: 'false' }, 'on'],
  [{ WE_REVIEW_SKIP_DRAIN_MECHANICAL: 'true' }, 'off'],
])('keeps either rebase carry kill switch effective (%j, legacy=%s)', (env, legacy) => {
  const io = createReviewJobIo({ env, readFile: () => JSON.stringify({ carryAcrossRebase: legacy }) });
  expect(io.carryAcrossRebaseSetting().value).toBe('off');
});
it('fails open on a thrown CI read but refuses an unreadable head or a head change during that read', async () => {
  for (const mode of ['ci-fault', 'head-fault', 'head-moved']) {
    const postComment = vi.fn(); let reads = 0;
    const sinks = createReviewPrSinks({ env: { WE_REVIEW_CANCEL_ON_CI_RED: 'true' }, postComment,
      readPublishHead: () => {
        if (mode === 'head-fault') throw Error('offline');
        return ++reads > 1 && mode === 'head-moved' ? 'b'.repeat(40) : head;
      }, publishGate: () => { throw Error('offline'); } });
    const result = sinks[REVIEW_EFFECTS.ADVISORY_NOTE]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' });
    if (mode === 'ci-fault') await expect(result).resolves.toEqual({ posted: true });
    else await expect(result).rejects.toThrow('review void');
    expect(postComment).toHaveBeenCalledTimes(mode === 'ci-fault' ? 1 : 0);
  }
});
it('reads a real small fix as a delta while keeping the full net diff and head fingerprint basis', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-timing-'));
  const git = (...args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(root, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/main', base);
    writeFileSync(join(root, 'file.txt'), 'base\noriginal contribution\n'); git('commit', '-qam', 'feature');
    const prior = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'file.txt'), 'base\noriginal contribution\nfix delta\n'); git('commit', '-qam', 'fix');
    const current = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/lane/test', current);
    const options = { pr: 7, repo: 'o/n', cwd: root, originRepo: () => 'o/n',
      exec: (file, args, opts) => {
        if (args[0] === 'fetch') return ''; // refs are already pinned locally; no network in this fixture
        return execFileSync(file, args, { ...opts, cwd: root });
      }, readView: () => ({ number: 7, state: 'OPEN', title: 'fixture', body: '', headRefName: 'lane/test', headRefOid: current,
        labels: ['review:pending'], files: [{ path: 'file.txt' }], comments: [{ author: { login: 'web-everything' }, body: `<!-- reviewed-sha: ${prior} -->` }] }) };
    const raw = readPr(options);
    expect(raw.deltaReview).toMatchObject({ priorHead: prior, head: current, lines: 1, files: 1 });
    expect(raw.deltaReview.text).toContain('+fix delta');
    expect(raw.deltaReview.text).not.toContain('+original contribution');
    expect(raw.diff.text).toContain('+original contribution');
    const shaped = shapeReadFinding(raw, { pr: 7, repo: 'o/n' });
    const prompt = renderJudgeInput(shaped);
    expect(prompt).toContain('Judge only this delta');
    expect(prompt).not.toContain('+original contribution');
    expect(shaped.netBasis.rev).toBe(current);
    expect(readPr({ ...options, timingPolicy: { deltaMaxLines: 0, deltaMaxFiles: 3 } }).deltaReview).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** A prior head A (reviewed), then a one-line head B; `comments(prior)` is the PR thread at B. */
function readDeltaFixture(comments) {
  const root = mkdtempSync(join(tmpdir(), 'review-timing-'));
  const git = (...args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(root, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    writeFileSync(join(root, 'file.txt'), 'base\nvulnerable code\n'); git('commit', '-qam', 'feature');
    const prior = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'file.txt'), 'base\nvulnerable code\ndocs line\n'); git('commit', '-qam', 'docs');
    const current = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/lane/test', current);
    return readPr({ pr: 7, repo: 'o/n', cwd: root, originRepo: () => 'o/n',
      exec: (file, args, opts) => (args[0] === 'fetch' ? '' : execFileSync(file, args, { ...opts, cwd: root })),
      readView: () => ({ number: 7, state: 'OPEN', title: 'fixture', body: '', headRefName: 'lane/test', headRefOid: current,
        labels: ['review:pending'], files: [{ path: 'file.txt' }], comments: comments(prior) }) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const bot = (body, createdAt) => ({ author: { login: 'web-everything' }, body, ...(createdAt ? { createdAt } : {}) });
const acceptAt = (prior, createdAt) => bot(buildVerdictComment({ to: 'accepted', actor: 'agent (review)', headSha: prior, body: 'accepted' }), createdAt);
const redTeamBounce = createdAt => bot(buildVerdictComment({ to: 'changes', actor: RED_TEAM_GATE_ACTOR, channel: RED_TEAM_GATE_CHANNEL,
  body: buildSendBackBody({ pr: 7, head: 'a'.repeat(40), findings: [{ file: 'file.txt', line: 2, category: 'edge-case', impact: 'broken', summary: 'vulnerable code' }] }) }), createdAt);
it('requires a full review when a confirmed post-accept red-team break is still outstanding', () => {
  expect(readDeltaFixture(prior => [acceptAt(prior, '2026-10-17T10:00:00Z')]).deltaReview).not.toBeNull();
  for (const comments of [
    prior => [acceptAt(prior, '2026-10-17T10:00:00Z'), redTeamBounce('2026-10-17T10:05:00Z')],
    prior => [redTeamBounce('2026-10-17T10:05:00Z'), acceptAt(prior, '2026-10-17T10:00:00Z')], // order-independent
    prior => [acceptAt(prior), redTeamBounce()], // unreadable chronology fails closed
  ]) {
    const raw = readDeltaFixture(comments);
    expect(raw.deltaReview).toBeNull();
    expect(renderJudgeInput(shapeReadFinding(raw, { pr: 7, repo: 'o/n' }))).toContain('+vulnerable code');
  }
  // A bounce the prior-head review already superseded does not block the delta.
  expect(readDeltaFixture(prior => [redTeamBounce('2026-10-17T09:00:00Z'), acceptAt(prior, '2026-10-17T10:00:00Z')]).deltaReview).not.toBeNull();
  // A thread at the gh comment page cap may hide the newest bounce: full review.
  const filler = Array.from({ length: PR_COMMENTS_PAGE_SIZE - 1 }, () => ({ author: { login: 'someone' }, body: 'note' }));
  expect(readDeltaFixture(prior => [acceptAt(prior, '2026-10-17T10:00:00Z'), ...filler]).deltaReview).toBeNull();
});

it('caps the cumulative delta since the last full review: three small deltas, the third is reviewed in full', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-timing-'));
  const git = (...args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const lines = n => Array.from({ length: 20 }, (_, i) => `delta ${n} line ${i}\n`).join('');
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(root, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    let content = 'base\noriginal contribution\n';
    writeFileSync(join(root, 'file.txt'), content); git('commit', '-qam', 'feature');
    const comments = [];
    const review = () => {
      const head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/lane/test', head);
      const raw = readPr({ pr: 7, repo: 'o/n', cwd: root, originRepo: () => 'o/n',
        exec: (file, args, opts) => (args[0] === 'fetch' ? '' : execFileSync(file, args, { ...opts, cwd: root })),
        readView: () => ({ number: 7, state: 'OPEN', title: 'fixture', body: '', headRefName: 'lane/test', headRefOid: head,
          labels: ['review:pending'], files: [{ path: 'file.txt' }], comments: [...comments] }) });
      // The posted verdict carries the producer's anchor line through the real verdict writer.
      const shaped = shapeReadFinding(raw, { pr: 7, repo: 'o/n' });
      comments.push(bot(buildVerdictComment({ to: 'accepted', actor: 'agent (review)', headSha: head,
        body: `findings\n\n${renderFullReviewAnchor(shaped)}` }), new Date(Date.UTC(2026, 9, 17, 10, comments.length)).toISOString()));
      return { head, raw };
    };
    const full = review();
    expect(full.raw.deltaReview).toBeNull();
    const modes = [];
    for (const n of [1, 2, 3]) {
      content += lines(n); writeFileSync(join(root, 'file.txt'), content); git('commit', '-qam', `fix ${n}`);
      const { raw } = review();
      modes.push(raw.deltaReview ? 'delta' : 'full');
      if (raw.deltaReview) expect(raw.deltaReview).toMatchObject({ anchor: full.head, lines: 20, files: 1 });
    }
    // 20 + 20 lines stay within deltaMaxLines (50); the third brings the total since the full review to 60.
    expect(modes).toEqual(['delta', 'delta', 'full']);
    // The full third review re-anchors the chain on its own head, so the next small fix is a delta again.
    content += lines(4); writeFileSync(join(root, 'file.txt'), content); git('commit', '-qam', 'fix 4');
    expect(review().raw.deltaReview).toMatchObject({ anchor: git('rev-parse', 'HEAD~1'), lines: 20 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('reads the full-review anchor fail-closed: a second anchor value in the thread forces a full review', () => {
  const prior = 'b'.repeat(40);
  const tied = body => bot(buildVerdictComment({ to: 'accepted', actor: 'agent (review)', headSha: prior, body }));
  const line = sha => renderFullReviewAnchor({ deltaReview: { anchor: sha } });
  expect(fullReviewAnchor([tied('x')], prior)).toBe(prior); // a verdict without the line predates delta review: full
  expect(fullReviewAnchor([tied(line('c'.repeat(40)))], prior)).toBe('c'.repeat(40));
  expect(fullReviewAnchor([tied(`${line('c'.repeat(40))}\n${line(prior)}`)], prior)).toBeNull();
  // An untrusted author's line is never read.
  expect(fullReviewAnchor([tied('x'), { author: { login: 'someone' }, body: `<!-- reviewed-sha: ${prior} -->\n${line('c'.repeat(40))}` }], prior)).toBe(prior);
});

it.each([['session', dispatchReview], ['job', dispatchReviewJob]])('%s dispatch cannot waive the configured fast-check gate', (_mode, dispatch) => {
  const spawn = vi.fn();
  for (const startAfter of ['fast-checks', 'push']) {
    const result = dispatch({ pr: 7, repo: 'web-everything/web-everything', root: join(tmpdir(), 'review-timing-daemon-fixture'),
      dir: join(tmpdir(), 'review-timing-jobs-fixture'), checkoutExists: () => true,
      checkStaleness: () => ({ fresh: true, behind: 0 }), readCompletion: () => null,
      spawnAgent: spawn, spawnJob: spawn, advisoryCiWaiver: { head },
      env: { WE_REVIEW_START_AFTER: startAfter },
      ciGate: () => ({ allowed: false, headSha: head, reason: 'ci-red', affected: [] }) });
    expect(result.skipped).toContain('ci-red');
  }
  expect(spawn).not.toHaveBeenCalled();
});
