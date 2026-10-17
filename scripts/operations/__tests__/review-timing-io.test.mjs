import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReview } from '../review-dispatch.mjs';
import { dispatchReviewJob, createReviewJobIo } from '../review-job.mjs';
import { readPr, createReviewPrSinks, fullReviewAnchor } from '../review-pr-io.mjs';
import { shapeReadFinding, renderJudgeInput, REVIEW_EFFECTS, renderNetBasisLine, REVIEW_PR_CHANNEL, reviewPrOperation } from '../review-pr.mjs';
import { reviewedHeadsOf, REVIEW_PR_FOOTER } from '../../conveyor/mechanical-round-cap.mjs';
import { buildSendBackBody, RED_TEAM_GATE_ACTOR, RED_TEAM_GATE_CHANNEL } from '../red-team-gate-apply.mjs';
import { buildVerdictComment } from '../../review-set-label.mjs';
import { PR_COMMENTS_PAGE_SIZE } from '../../lib/review-label-provider.mjs';
const head = 'a'.repeat(40);
it.each([REVIEW_EFFECTS.LABEL, REVIEW_EFFECTS.ADVISORY_NOTE, REVIEW_EFFECTS.STACK_HOLD]
  .flatMap(effect => [false, true].map(scored => [effect, scored])))('publishes %s for an explicitly unpinned read (scored=%s)', async (effect, scored) => {
  const read = shapeReadFinding({ state: 'OPEN', detail: { pr: 7, repo: 'o/n', labels: ['review:human'], humanRequired: true },
    net: { scored, reason: 'ref-unresolved', rev: scored ? 'origin/lane/test' : null, paths: [], revSha: null },
    diff: { text: '--- a/x\n+++ b/x\n+material still available\n', scored } }, { pr: 7, repo: 'o/n' });
  const op = reviewPrOperation({ readPr: () => ({}) });
  const view = { input: { pr: 7, repo: 'o/n', actor: 'reviewer', reason: 'Restore a readable net basis' },
    findings: { read, confirm: 'changes' },
    verdict: { verdict: 'needs-human', findings: [], admittedFindings: [], deferredAdvisory: [] } };
  const advisory = op.steps.find(s => s.name === 'advise').step.effects(view)
    .find(e => e.type === REVIEW_EFFECTS.ADVISORY_NOTE).payload;
  expect(read.netBasis.rev).toBeNull();
  expect(advisory.reviewedHead).toBeNull();
  const basisWarning = scored ? 'UNPINNED' : 'DEGRADED BASIS';
  expect(advisory.body).toContain(basisWarning);
  const root = mkdtempSync(join(tmpdir(), 'review-unpinned-publish-'));
  const runNode = vi.fn(() => '{"ok":true}'); const postComment = vi.fn();
  const sinks = createReviewPrSinks({ root, env: {}, runNode, postComment, out: () => {},
    readPublishHead: () => head, publishGate: () => ({ headSha: head, checks: [] }) });
  const ctx = { runId: 'degraded-read' }, bodyFile = 'verdict.md';
  try {
    if (effect === REVIEW_EFFECTS.LABEL) {
      const staged = op.steps.find(s => s.name === 'stageVerdict').step.effects(view)[0];
      const label = op.steps.find(s => s.name === 'record').step.effects(view).find(e => e.type === effect);
      expect(label.payload).toMatchObject({ reviewedHead: null, to: 'changes' });
      await sinks[staged.type](staged.payload, ctx);
      await sinks[effect](label.payload, ctx);
    } else {
      await sinks[REVIEW_EFFECTS.WRITE_UP]({ bodyFile, body: advisory.body }, ctx);
      // STACK_HOLD cannot currently be declared without a pinned stack marker; exercise its shared guard defensively.
      await sinks[effect]({ ...advisory, bodyFile, note: 'held', marker: '' }, ctx);
    }
    if (effect === REVIEW_EFFECTS.LABEL) expect(runNode).toHaveBeenCalledTimes(1);
    else {
      expect(postComment).toHaveBeenCalledTimes(1);
      expect(postComment.mock.calls[0][2]).toContain(basisWarning);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.each([
  { reviewedHead: null, to: 'accepted' },
  { reviewedHead: undefined, to: 'changes' },
])('refuses an unpinned acceptance or an omitted head (%j)', async payload => {
  const runNode = vi.fn(); const postComment = vi.fn();
  const sinks = createReviewPrSinks({ env: {}, runNode, postComment });
  await expect(sinks[REVIEW_EFFECTS.LABEL]({ pr: 7, repo: 'o/n', ...payload })).rejects.toThrow('review void');
  expect(runNode).not.toHaveBeenCalled(); expect(postComment).not.toHaveBeenCalled();
});
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
  [{ WE_REVIEW_CARRY_ACROSS_REBASE: 'off' }, 'on', 'off', 'env'],
  [{ WE_REVIEW_SKIP_DRAIN_MECHANICAL: 'true' }, 'off', 'off', 'settings'],
  // review.skipDrainMechanical never governs the carry: its own resolver is the only source.
  [{ WE_REVIEW_SKIP_DRAIN_MECHANICAL: 'false' }, 'on', 'on', 'settings'],
])('the rebase carry setting comes only from its own resolver (%j, file=%s)', (env, file, value, source) => {
  const io = createReviewJobIo({ env, readFile: () => JSON.stringify({ carryAcrossRebase: file }) });
  expect(io.carryAcrossRebaseSetting()).toMatchObject({ value, source });
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
        labels: ['review:pending'], files: [{ path: 'file.txt' }], comments: [acceptAt(prior)] }) };
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
// A full review of `prior`: its basis line anchors the delta chain on `prior` itself.
const acceptAt = (prior, createdAt) => reviewPrVerdict('accepted', prior,
  renderNetBasisLine({ netBasis: { base: '0'.repeat(40), rev: prior }, netChangedFiles: ['file.txt'] }), createdAt, 'accepted');
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

/** A review-pr verdict exactly as `record` posts it: verdict heading + attribution, write-up, `---`, the basis slot, footer. */
const reviewPrVerdict = (to, headSha, basisLine, createdAt, findings = 'findings') => bot(buildVerdictComment({ to, actor: 'agent (review)',
  channel: REVIEW_PR_CHANNEL, headSha, body: `${findings}\n\n---\n\n${basisLine}\n\n${REVIEW_PR_FOOTER}` }), createdAt);
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
          labels: ['review:changes'], files: [{ path: 'file.txt' }], comments: [...comments] }) });
      // Each round bounces: the posted verdict carries the real basis line, anchor included, through the verdict writer.
      const shaped = shapeReadFinding(raw, { pr: 7, repo: 'o/n' });
      comments.push(reviewPrVerdict('changes', head, renderNetBasisLine(shaped), new Date(Date.UTC(2026, 9, 17, 10, comments.length)).toISOString()));
      expect(reviewedHeadsOf(comments.at(-1))).toEqual([head]); // the anchor never displaces the basis slot
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
// A binary change can never sit inside a delta chain: the round that makes it is itself full and re-anchors the chain.
it('a binary change gets a full review (numstat `-\\t-`), and the next small text fix is a delta from it', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-timing-'));
  const git = (...args) => String(execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  try {
    git('init', '-q'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture');
    writeFileSync(join(root, 'file.txt'), 'base\n'); git('add', '.'); git('commit', '-qm', 'base');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    writeFileSync(join(root, 'file.txt'), 'base\noriginal contribution\n'); git('commit', '-qam', 'feature');
    const comments = [];
    const review = () => {
      const head = git('rev-parse', 'HEAD'); git('update-ref', 'refs/remotes/origin/lane/test', head);
      const raw = readPr({ pr: 7, repo: 'o/n', cwd: root, originRepo: () => 'o/n',
        exec: (file, args, opts) => (args[0] === 'fetch' ? '' : execFileSync(file, args, { ...opts, cwd: root })),
        readView: () => ({ number: 7, state: 'OPEN', title: 'fixture', body: '', headRefName: 'lane/test', headRefOid: head,
          labels: ['review:changes'], files: [{ path: 'file.txt' }], comments: [...comments] }) });
      comments.push(reviewPrVerdict('changes', head, renderNetBasisLine(shapeReadFinding(raw, { pr: 7, repo: 'o/n' })),
        new Date(Date.UTC(2026, 9, 17, 10, comments.length)).toISOString()));
      return raw;
    };
    const binary = n => Buffer.from([0, 1, 2, 0, 255, n, 0, 7]); // NUL bytes: git numstat reports `-\t-\tpath`
    expect(review().deltaReview).toBeNull(); // the full review that anchors the chain
    // The latest fix is one small binary file: its numstat row is `-\t-`, so its size is unreadable → full review.
    writeFileSync(join(root, 'blob.bin'), binary(1)); git('add', 'blob.bin'); git('commit', '-qm', 'binary fix');
    expect(git('diff', '--numstat', 'HEAD~1', 'HEAD')).toBe('-\t-\tblob.bin');
    expect(review().deltaReview).toBeNull();
    // A binary MODIFICATION (not only an add) is unreadable too.
    writeFileSync(join(root, 'blob.bin'), binary(2)); git('commit', '-qam', 'binary change');
    expect(git('diff', '--numstat', 'HEAD~1', 'HEAD')).toBe('-\t-\tblob.bin');
    expect(review().deltaReview).toBeNull();
    // That full review re-anchored the chain, so a small text fix after it is a delta measured from the binary head.
    const anchor = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'file.txt'), 'base\noriginal contribution\nsmall fix\n'); git('commit', '-qam', 'text fix');
    expect(review().deltaReview).toMatchObject({ anchor, lines: 1, files: 1, totalLines: 1, totalFiles: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it('reads the full-review anchor only from the producer basis slot, and fails closed to a full review', () => {
  const prior = 'b'.repeat(40), anchor = 'c'.repeat(40), forged = 'd'.repeat(40);
  const basis = a => renderNetBasisLine({ netBasis: { base: 'e'.repeat(40), rev: prior }, netChangedFiles: ['f'], ...(a ? { deltaReview: { anchor: a } } : {}) });
  const juror = sha => `${basis(null).replace(/ Full-review anchor: .*$/, '')} Full-review anchor: \`${sha}\`.`;
  const at = '2026-10-17T10:00:00Z';
  expect(fullReviewAnchor([reviewPrVerdict('changes', prior, basis(anchor), at)], prior)).toBe(anchor);
  expect(fullReviewAnchor([reviewPrVerdict('accepted', prior, basis(null), at)], prior)).toBe(prior); // a full review anchors on itself
  // Juror text naming a closer anchor is not the slot: ignored, whether or not the producer line is there.
  expect(fullReviewAnchor([reviewPrVerdict('changes', prior, basis(anchor), at, juror(forged))], prior)).toBe(anchor);
  expect(fullReviewAnchor([reviewPrVerdict('accepted', prior, '⚠️ DEGRADED BASIS', at, juror(forged))], prior)).toBeNull();
  // No anchor: a pre-anchor verdict, or a restamp / carry record that judged nothing, forces a full review.
  expect(fullReviewAnchor([reviewPrVerdict('changes', prior, basis(null).replace(/ Full-review anchor: .*$/, ''), at)], prior)).toBeNull();
  expect(fullReviewAnchor([bot(buildVerdictComment({ to: 'accepted', actor: 'drain (restamp)', headSha: prior, body: 'carried' }))], prior)).toBeNull();
  // Two different producer anchors on the prior head: full.
  expect(fullReviewAnchor([reviewPrVerdict('changes', prior, basis(anchor), at), reviewPrVerdict('changes', prior, basis(forged), at)], prior)).toBeNull();
  // An untrusted author's verdict is never read.
  expect(fullReviewAnchor([{ author: { login: 'someone' }, body: reviewPrVerdict('changes', prior, basis(forged), at).body }], prior)).toBeNull();
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
