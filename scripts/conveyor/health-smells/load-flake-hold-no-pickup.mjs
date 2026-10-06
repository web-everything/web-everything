/**
 * @file scripts/conveyor/health-smells/load-flake-hold-no-pickup.mjs
 * @description A load-flake hold (fix saved on an alt branch, waiting for the reverify pass) that no reverify run has
 *   touched for longer than WE_LOAD_FLAKE_NO_PICKUP_MINUTES (default 60). Live 2026-10-06, PR #4017: fix-dispatch refused
 *   it as `load-flake-hold` for 1h+ while the reverify pass logged `no-candidate` (it read only the first 100 of 286 comments).
 */
import { loadFlakeHoldsWithoutPickup, loadFlakeNoPickupMinutes } from '../load-flake-hold.mjs';
import { repoKeyForSlug } from '../../lib/constellation-repos.mjs';

export default {
  id: 'load-flake-hold-no-pickup', scope: 'repo', cadence: 'gh', probes: ['prs'],
  openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert',
  recommendationHint: 'A load-flake hold has waited past the limit with no reverify pickup. Check the load-flake-reverify pass log for the PR and fix the pass, not the PR by hand.',
  evaluate({ prs }, { now, env = process.env }) {
    const limitMinutes = loadFlakeNoPickupMinutes(env);
    return loadFlakeHoldsWithoutPickup({ prs: prs ?? [], now, limitMinutes }).map(({ pr, hold, ageMinutes }) => {
      const repo = repoKeyForSlug(pr.repo) ?? pr.repo;
      return {
        subject: `pr:${repo}#${pr.number}`, breach: true,
        measure: { ageMinutes, limitMinutes, alt: hold.alt.branch, altSha: hold.alt.sha },
        summary: `${repo} PR #${pr.number}: load-flake hold on ${hold.alt.branch} waited ${ageMinutes}m (limit ${limitMinutes}m) with no reverify pickup`,
        recommendation: 'Read .conveyor/pass-daemon.load-flake-reverify.log: if it says no-candidate, the pass and reconcile read the hold differently. Fix the pass.',
        escalation: { humanOnly: true, actionRef: `pr:${repo}#${pr.number}`,
          description: `Load-flake hold on ${repo} PR #${pr.number} unattended ${ageMinutes}m`, status: 'observed', reason: 'hold with no reverify pickup past the limit' },
      };
    });
  },
};
