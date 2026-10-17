import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReview } from '../review-dispatch.mjs';
import { dispatchReviewJob, createReviewJobIo } from '../review-job.mjs';
import { readPr, createReviewPrSinks } from '../review-pr-io.mjs';
import { shapeReadFinding, renderJudgeInput, REVIEW_EFFECTS } from '../review-pr.mjs';
const head = 'a'.repeat(40);
it.each([REVIEW_EFFECTS.LABEL, REVIEW_EFFECTS.ADVISORY_NOTE, REVIEW_EFFECTS.STACK_HOLD])('voids %s before any publish when same-head CI turns red and cancellation is enabled', async effect => {
  const runNode = vi.fn(); const postComment = vi.fn();
  const sinks = createReviewPrSinks({ readPublishHead: () => head, env: { WE_REVIEW_CANCEL_ON_CI_RED: 'true' }, runNode, postComment,
    publishGate: () => ({ headSha: head, checks: [{ name: 'unit', head_sha: head, conclusion: 'failure' }] }) });
  await expect(sinks[effect]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' })).rejects.toThrow('review void');
  expect(runNode).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
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
