/**
 * @file breaks/rebuild-omits-merged-overlay-discarded.mjs — live break, 2026-10-31 ET on `wev-review-daemon` (D-R338).
 * The review rebuild smokes PASSED (ready-candidate-recorded three times), but each candidate was then discarded as
 * `superseded-omits-live-overlay: perf5-job-store-m1, perf-fetch-fresh-m2, m5`. Those overlays had been auto-dropped
 * as `in-main` during the same build (their PRs merged), so the candidate "omitted" overlays the running build still
 * listed as live. The daemon stayed on a build 34+ commits behind main for ~3 hours.
 *
 * Fix: an omitted live overlay whose registration the plan auto-removed as pr-merged/in-main AND whose content is
 * contained in the candidate's own build is no longer a loss — the candidate is adopted. An omitted overlay without
 * that proof (unmerged) still discards: that guard is the 00:11 holder-fix loss.
 *
 * Scenario: real `matchReadyCandidate` from the tree under test, driven with the live shape. PRE-fix the in-main case
 * is discarded every time; FIXED it is adopted, while the unmerged and mixed cases are still discarded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');

export default {
  id: 'rebuild-omits-merged-overlay-discarded',
  title: 'a verified rebuild candidate was discarded forever as superseded-omits-live-overlay because the omitted overlays had merged (auto-dropped in-main) — the daemon never adopted a build',
  card: 'D-R338 (lane/review-omits-overlay)',
  fixedBy: { sha: 'a876d48b7f', where: 'lane/review-omits-overlay', paths: ['scripts/lib/daemon-rebuild/adopt.mjs'] },
  fixPresent(root) {
    const p = join(root, 'scripts/lib/daemon-rebuild/adopt.mjs');
    return existsSync(p) && /contentInBuild/.test(readFileSync(p, 'utf8'));
  },
  async run({ log } = {}) {
    const root = REPO_ROOT;
    const { matchReadyCandidate } = await import(pathToFileURL(join(root, 'scripts/lib/daemon-rebuild/adopt.mjs')).href);
    const violations = [];
    const t0 = 1_000_000;
    const ready = {
      kind: 'candidate', prevHead: 'H', tree: 'T1', passedAt: new Date(t0).toISOString(),
      adopt: { finalSha: 'S1', inputsKey: 'K1', mainSha: 'M1', applied: [] },
    };
    const live = (...refs) => refs.map((r) => ({ ref: r, sha: `${r}-sha` }));
    const m = (liveApplied, merged, contained = true) => matchReadyCandidate({
      ready, plan: { finalSha: 'S2', inputsKey: 'K2', mainSha: 'M2', applied: [] }, prevHead: 'H',
      treeOf: () => 'T2', stillWanted: () => true, verifyBuilt: () => true, liveApplied, carries: () => false,
      removedForMain: (r) => merged.includes(r), contentInBuild: () => contained, nowMs: t0 + 60_000, maxAgeMs: 3_600_000,
    });
    const inMain = m(live('perf5-job-store-m1', 'perf-fetch-fresh-m2', 'm5'), ['perf5-job-store-m1', 'perf-fetch-fresh-m2', 'm5']);
    log?.(`in-main omitted -> adopt=${!!inMain.adopt} reason=${inMain.reason ?? ''}`);
    if (!inMain.adopt) violations.push({ invariant: 'merged-omission-discarded', detail: `verified candidate discarded though every omitted overlay is in main: ${inMain.reason}` });
    const unmerged = m(live('lane/unmerged'), []);
    if (unmerged.adopt) violations.push({ invariant: 'unmerged-omission-adopted', detail: 'candidate adopted while silently dropping an unmerged overlay' });
    const mixed = m(live('perf5-job-store-m1', 'lane/unmerged'), ['perf5-job-store-m1']);
    if (mixed.adopt) violations.push({ invariant: 'unmerged-omission-adopted', detail: 'mixed in-main + unmerged omission adopted' });
    const noProof = m(live('m5'), ['m5'], false);
    if (noProof.adopt) violations.push({ invariant: 'unmerged-omission-adopted', detail: 'in-main label without content proof adopted' });
    return { violations };
  },
  judge(report) {
    return report.violations.map((v) => `[${v.invariant}] ${v.detail}`);
  },
};
