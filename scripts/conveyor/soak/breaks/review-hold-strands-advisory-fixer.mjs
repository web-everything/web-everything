/** PR #5235 red-team replay: a review-hold advisory must hand its admitted finding to the fixer. */
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'review-hold-strands-advisory-fixer',
  title: 'a changes advisory on a red review hold retains its advisory fixer across reconcile ticks',
  card: 'PR #5235 red-team finding on PR #5157 replay, 2026-10-13',
  fixedBy: { sha: 'HEAD', where: 'lane/pr-ownership', paths: ['scripts/conveyor/reconcile-core.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), 'utf8')
      .includes('if (ciRepairOwed && !reviewHoldRed)');
  },
  async run({ sourceRoot = ROOT, log } = {}) {
    const { planReconcile } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/reconcile-core.mjs')).href);
    const { ADVISORY_NOTE_MARKER } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/advisory-round-count.mjs')).href);
    const { buildAdvisoryFixComment } = await import(pathToFileURL(join(sourceRoot, 'scripts/conveyor/advisory-fix-mark.mjs')).href);
    const fx = JSON.parse(readFileSync(join(sourceRoot,
      'scripts/conveyor/__tests__/fixtures/pr-ownership/pr-5157-before-ci-heal.json'), 'utf8'));
    const pr = fx.pr;
    const merge = pr.statusCheckRollup.filter(r => r.name === 'merge-gate').at(-1);
    merge.mergeGateReviewHold = { holds: ['test-gaming'], jobId: 1 };
    const options = { repo: 'we', prs: [pr], now: Date.parse(fx.observedAt),
      requiredChecks: ['test', 'smoke', 'daemon-soak', 'soak-replay-gate', 'merge-gate'],
      advisoryReviewOnHumanHandoff: 'on' };
    const violations = [];
    const initial = planReconcile(options);
    if (initial.dispatch.length !== 1 || initial.dispatch[0].kind !== 'review')
      violations.push('the first held tick must dispatch one advisory review');
    pr.labels = pr.labels.filter(l => l.name !== 'review:pending');
    pr.labels.push({ name: 'advisory:changes' });
    pr.comments.push({ author: { login: 'web-everything' }, createdAt: fx.observedAt,
      body: `${ADVISORY_NOTE_MARKER}\n\n**Verdict:** Changes requested\n\n**Advisory outcome:** \`changes\`\n\nAdmitted finding: the test games the gate.\n\nNet basis: \`${'0'.repeat(40)}..${pr.headRefOid}\`` });
    for (let tick = 1; tick <= 3; tick++) {
      const plan = planReconcile({ ...options, now: options.now + tick * 60_000 });
      log?.(`tick ${tick}: dispatch=${plan.dispatch.map(d => `${d.kind}/${d.mode}`).join(',') || 'none'}`);
      if (plan.dispatch.length !== 1 || plan.dispatch[0].kind !== 'fix' || plan.dispatch[0].mode !== 'advisory-fix')
        violations.push(`tick ${tick}: an unaddressed advisory must dispatch exactly one advisory fixer`);
      if (!plan.refusals.some(r => r.kind === 'review-hold-red'))
        violations.push(`tick ${tick}: the CI-heal refusal must remain visible`);
    }
    const oldHead = pr.headRefOid;
    pr.headRefOid = 'b'.repeat(40);
    const stale = planReconcile({ ...options, advisoryFixCap: 0, roundCapAction: 'person' });
    if (stale.dispatch.length !== 1 || stale.dispatch[0].advisoryReview?.head !== pr.headRefOid
        || stale.dispatch[0].advisoryReview?.ciWaived !== true)
      violations.push('a stale advisory past the fix cap must receive a head-pinned held-gate review');
    const mark = { author: { login: 'web-everything' }, body: buildAdvisoryFixComment({}) };
    pr.comments.push(mark);
    const addressed = planReconcile(options);
    if (addressed.dispatch.length !== 1 || addressed.dispatch[0].advisoryReview?.head !== pr.headRefOid
        || addressed.dispatch[0].advisoryReview?.ciWaived !== true)
      violations.push('the repaired head must receive a head-pinned held-gate review');
    for (const blocker of [{ isDraft: true }, { referralHold: { kind: 'same-head', why: 'awaiting ruling' } }]) {
      if (planReconcile({ ...options, prs: [{ ...pr, ...blocker }] }).dispatch.length)
        violations.push('recovery reviews must retain draft and referral guards');
    }
    pr.comments.pop();
    pr.headRefOid = oldHead;
    // Genuine required CI failures still belong to ci-heal, even with an admitted advisory.
    pr.statusCheckRollup.filter(r => r.name === 'test').at(-1).conclusion = 'FAILURE';
    if (!planReconcile(options).dispatch.some(d => d.kind === 'ci-heal'))
      violations.push('a real test failure alongside the hold must retain ci-heal ownership');
    return { violations };
  },
  judge(report) { return report.violations; },
};
