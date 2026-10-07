/**
 * A daemon clone that is merely BEHIND `origin/main` for too long, whatever its rebuild state file says.
 * `clone-stale` only reads rebuild/alert files, so a clone that never runs the gated rebuild (the drain's data clone,
 * the drain code clone `.lanes/we-drain-daemon/code`, the 2026-10-06 case: ~20h behind main, no alert, no log line)
 * was invisible. Probe `cloneLag` reads git itself for EVERY clone `daemonCloneRoots` knows: how many main commits the
 * clone's HEAD lacks and since when the oldest of them has existed. Breaches when that age passes `maxBehindMs` while
 * main kept moving. A clone whose HEAD is not an ancestor of main (overlay-carrying) is not reported.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'clone-behind-main',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['cloneLag'],
  openAfter: 2,
  closeAfter: 2,
  severity: 'high',
  action: 'investigate',
  maxBehindMs: 30 * MINUTE,
  recommendationHint: 'A daemon clone has not followed origin/main for over 30 minutes.',
  evaluate({ cloneLag }, { now }) {
    return (cloneLag || []).map((c) => {
      const age = c.behind > 0 && c.behindSinceMs != null ? now - c.behindSinceMs : 0;
      return {
        subject: `clone-lag:${c.cloneRoot}`,
        breach: c.behind > 0 && age > this.maxBehindMs,
        measure: { behind: c.behind, behindMin: Math.round(age / MINUTE), head: c.head },
        summary: `daemon clone ${c.cloneRoot} is ${c.behind} commit(s) behind origin/main, the oldest unapplied ${fmtAge(age)} old.`,
        recommendation: `Clone ${c.cloneRoot} is not following main. Find the daemon that owns it and why its refresh/rebuild never ran or was rejected (its log, ~/.claude/daemon-self-sync-state/*.alerts.jsonl); fix that refresh path in the product, never reset the clone by hand.`,
      };
    });
  },
};
