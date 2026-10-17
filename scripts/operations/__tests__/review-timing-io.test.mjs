import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReview } from '../review-dispatch.mjs';
import { dispatchReviewJob } from '../review-job.mjs';
import { readPr, createReviewPrSinks } from '../review-pr-io.mjs';
import { shapeReadFinding, renderJudgeInput, REVIEW_EFFECTS } from '../review-pr.mjs';
const head = 'a'.repeat(40);
it.each([REVIEW_EFFECTS.LABEL, REVIEW_EFFECTS.ADVISORY_NOTE, REVIEW_EFFECTS.STACK_HOLD])('voids %s before any publish when same-head CI turns red', async effect => {
  const runNode = vi.fn(); const postComment = vi.fn();
  const sinks = createReviewPrSinks({ runNode, postComment, publishGate: () => ({ headSha: head, checks: [{ name: 'unit', head_sha: head, conclusion: 'failure' }] }) });
  await expect(sinks[effect]({ pr: 7, repo: 'o/n', reviewedHead: head, body: 'verdict' })).rejects.toThrow('review void');
  expect(runNode).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
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
      ciGate: () => ({ allowed: false, headSha: head, startAfter, reason: 'ci-red', affected: [] }) });
    expect(result.skipped).toContain('ci-red');
  }
  expect(spawn).not.toHaveBeenCalled();
});
