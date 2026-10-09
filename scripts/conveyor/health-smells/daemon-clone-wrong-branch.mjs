/**
 * A daemon clone sitting on a transport/store branch (`ops/*`) instead of `main`. Live 2026-10-09 06:52 ET: the
 * verdict-ledger store writer checked `ops/review-requests` out in the review daemon's own clone; the daemon died
 * on MODULE_NOT_FOUND and stayed down ~1.5 h before anyone looked. HIGH: a clone on such a branch has no daemon
 * code in its tree, so the daemon is down (or will be on its next restart).
 *
 * Probe: `we:scripts/lib/daemon-clone-branch-probe.mjs#probeDaemonCloneBranches` (`daemonCloneBranches`).
 * Self-heal: `we:scripts/lib/daemon-rebuild/wrong-branch-heal.mjs` (allowlisted branch + store-only changes).
 */
export default {
  id: 'daemon-clone-wrong-branch',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['daemonCloneBranches'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'investigate',
  recommendationHint: 'A daemon clone is checked out on a store/transport branch instead of main — its daemon has no code to run.',
  evaluate({ daemonCloneBranches }) {
    return (daemonCloneBranches || []).map(({ cloneRoot, branch }) => ({
      subject: cloneRoot,
      breach: true,
      measure: { cloneRoot, branch },
      summary: `${cloneRoot} is on branch \`${branch}\`, not main — its daemon's code is not in the tree.`,
      recommendation: `Run \`node scripts/lib/daemon-rebuild.mjs --clone=${cloneRoot}\`: it heals an allowlisted store `
        + 'branch with store-only changes (wrongBranchHeal in daemon-rebuild-settings.json) and refuses anything else. '
        + 'Then find the WRITER that switched the clone — never hand-checkout inside a daemon clone.',
    }));
  },
};
