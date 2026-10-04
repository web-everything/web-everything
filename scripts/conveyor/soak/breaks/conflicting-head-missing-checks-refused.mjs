/**
 * @file breaks/conflicting-head-missing-checks-refused.mjs — live case web-everything/web-everything#3771
 * (2026-10-03). The fix-dispatch daemon logged `reconcile-refused check-read-failed … required-check hydration
 * refused … missing required checks: test, smoke, daemon-soak, soak-replay-gate` for that PR every pass, and an
 * earlier PR (#3787) hit the same shape.
 *
 * ROOT CAUSE: `reconcile-pass.mjs#hydrateChecks` demands every required check name on every PR. GitHub runs NO
 * `pull_request` CI on a CONFLICTING head (no merge commit exists to test), so for a conflicting PR those names can
 * never appear: the read cannot succeed, one GitHub call was spent on it every tick, and a `check-read-failed`
 * refusal was reported for a fault that does not exist. The repair that PR is owed (a mechanical re-sync with
 * main) consumes no CI at all, so the absence must be EXPECTED there: no read, no refusal, the conflict-fix still
 * planned. Every other path keeps refusing.
 *
 * This replays the REAL #3771 data (`__tests__/fixtures/pr-3771-conflicting-no-ci.json`, live 2026-10-03) through
 * the REAL `runReconcilePass` with injected readers, and checks four things:
 *   (a) the conflict repair is planned for it;
 *   (b) no `check-read-failed` refusal is raised for it, and the REST feed is not read;
 *   (c) the SAME PR made non-conflicting still refuses on the missing checks (the guard stays on every other path);
 *   (d) a conflicting PR with a real read ERROR (it had observed check evidence) still refuses.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const REQUIRED = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];

export default {
  id: 'conflicting-head-missing-checks-refused',
  title: 'a CONFLICTING PR (no CI can ever run on its head) is refused check-read-failed for missing required checks, every tick (#3771)',
  card: 'PR #3771; #3787',
  fixedBy: { sha: 'b47f2b7b49fa4c50777eaee1671af0d7197a154f', where: 'lane/fix-conflict-missing-ci', paths: ['scripts/conveyor/reconcile-pass.mjs'] },
  fixPresent(root) {
    return readFileSync(join(root, 'scripts/conveyor/reconcile-pass.mjs'), 'utf8').includes('isConflictingPr');
  },
  async run({ log, sourceRoot } = {}) {
    const root = sourceRoot ?? join(new URL('.', import.meta.url).pathname, '..', '..', '..', '..');
    const { runReconcilePass } = await import(pathToFileURL(join(root, 'scripts/conveyor/reconcile-pass.mjs')).href);
    const real = JSON.parse(readFileSync(join(root, 'scripts/conveyor/__tests__/fixtures/pr-3771-conflicting-no-ci.json'), 'utf8'));
    const violations = [];
    const pass = (pr, readChecks) => runReconcilePass({
      repo: 'we', readPrs: () => [pr], readAgents: () => [], enrich: (a) => a,
      readRequiredChecks: () => ({ checks: REQUIRED }), readChecks,
      enrichMainRed: (prs) => ({ prs, mainRedWindows: [] }), enrichAlreadyLanded: (p) => p, enrichBaseRef: (p) => p,
      enrichSystemFix: (p) => p, enrichFixClaims: (p) => p, enrichTimeouts: (p) => p, enrichReferralHolds: (p) => p,
      resolveMainSha: () => null, now: Date.parse('2026-10-03T23:00:00Z'),
    });
    const refused = (plan) => plan.refusals.filter((r) => r.kind === 'check-read-failed');

    let reads = 0;
    const live = pass(real, () => { reads++; return []; });
    log?.(`#3771 live data -> dispatch=${live.dispatch.map((d) => d.kind)} refusals=${refused(live).length} reads=${reads}`);
    if (!live.dispatch.some((d) => d.prNumber === 3771 && d.kind === 'fix' && d.isConflict)) {
      violations.push({ invariant: 'conflict-repair-planned', detail: 'the conflict re-sync was not planned for PR #3771' });
    }
    if (refused(live).length) {
      violations.push({ invariant: 'no-false-check-refusal', detail: `a conflicting head was refused: ${refused(live)[0].why}` });
    }
    if (reads) violations.push({ invariant: 'no-pointless-read', detail: `the REST check feed was read ${reads}x for a head that can never have checks` });

    const clean = pass({ ...real, mergeStateStatus: 'CLEAN', labels: real.labels.filter((l) => l.name !== 'merge-status:conflicting') }, () => []);
    if (!refused(clean).length) {
      violations.push({ invariant: 'other-paths-still-refuse', detail: 'a NON-conflicting PR with missing required checks was no longer refused' });
    }

    const observed = { ...real, statusCheckRollup: [{ name: 'smoke', status: 'COMPLETED', conclusion: 'CANCELLED' }] };
    const errored = pass(observed, () => { throw new Error('HTTP 502'); });
    if (!refused(errored).length) {
      violations.push({ invariant: 'real-read-error-still-refuses', detail: 'a real read error on a conflicting PR was swallowed' });
    }
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
