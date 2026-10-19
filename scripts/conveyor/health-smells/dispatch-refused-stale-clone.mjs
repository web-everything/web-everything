/**
 * xpinskip (epic #4075/#3383) — a daemon whose EVERY recent tick refused dispatch because its clone is behind
 * origin/main ("the dispatching checkout is N commit(s) behind origin/main — refusing to dispatch"), for more
 * than `minDurationMs` (10 min).
 *
 * Live 2026-09-26 23:39 ET: a conflicting pinned overlay (#2768) made the rebuild refuse every tick, the
 * `wev-review-daemon` clone fell 2 commits behind, and the fix daemon refused ALL dispatch in all three repos,
 * silently, tick after tick. `daemon-owed-no-dispatch` needs owed work and 30 min; `clone-stale` only reads the
 * rebuild's own alert kinds; neither named it. This sign reads only the daemon's own log (a trailing streak of
 * ticks tagged `s` by `health-watch-core.mjs#foldDaemonMemory`) and, when the self-sync probe ran, names the
 * rebuild's latest blocking alert so the episode says WHY the clone is behind.
 *
 * Notify scope: listed in `we:scripts/conveyor/health-smells-notify-list.mjs`'s `NOTIFY_EVEN_IN_SHADOW` (the
 * Sun 2026-09-27 ~7:40 AM ET operator decision) — a fleet silently refusing all dispatch is exactly what shadow
 * mode's notify-suppression must not swallow.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

/** Rebuild alert kinds that mean "the rebuild is not moving this clone". */
const REBUILD_BLOCKED = new Set([
  'pinned-overlay-conflict', 'pinned-overlay-unavailable', 'smoke-rejected', 'clone-held-stale', 'quarantined',
  'rebuild-failed', 'dirty', 'overlay-state-corrupt', 'fetch-failed', 'not-on-main', 'local-commits',
  'merge-in-progress', 'untracked-collision', 'overlay-refresh-failed', 'overlay-held-on-last-good',
]);

/** PURE: the trailing run of stale-refused ticks — `{ticks, since}` (since = the run's first tick). */
export function staleStreak(recentTicks) {
  const ticks = recentTicks || [];
  let n = 0;
  let since = null;
  for (let i = ticks.length - 1; i >= 0 && ticks[i].s; i -= 1) { n += 1; since = ticks[i].at; }
  return { ticks: n, since };
}

/** PURE: the most recent rebuild-blocking alert across every probed clone, or null. */
export function latestRebuildBlock(selfSync, now) {
  let best = null;
  for (const c of selfSync || []) {
    for (const a of c.alerts || []) {
      if (!REBUILD_BLOCKED.has(a.kind) || a.at == null || a.at > now) continue;
      if (!best || a.at > best.at) best = { ...a, cloneKey: c.cloneKey };
    }
  }
  return best;
}

function describeBlock(b) {
  if (!b) return null;
  const d = b.detail || {};
  const who = d.ref ? ` ${d.ref}${d.pr != null ? ` (PR #${d.pr})` : ''}` : '';
  return `${b.kind}${who}`;
}

export default {
  id: 'dispatch-refused-stale-clone',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['daemonLogs'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'alert',
  minDurationMs: 10 * MINUTE,
  minTicks: 2,
  recommendationHint: 'A daemon refuses every dispatch because its clone is behind origin/main — the gated rebuild is not moving it; the rebuild alert named here is the thing to fix (in the product, never the clone by hand).',
  evaluate(probes, { now, daemons }) {
    const block = latestRebuildBlock(probes?.selfSync, now);
    const why = describeBlock(block);
    const out = [];
    for (const [name, mem] of Object.entries(daemons || {})) {
      if (!mem.ticksSeen) continue;
      const { ticks, since } = staleStreak(mem.recentTicks);
      const dur = since != null ? now - since : 0;
      const breach = ticks >= this.minTicks && dur >= this.minDurationMs;
      out.push({
        subject: name,
        breach,
        measure: {
          staleTicks: ticks,
          staleForMin: Math.round(dur / MINUTE),
          staleSinceIso: since != null ? new Date(since).toISOString() : null,
          rebuildBlock: block ? { kind: block.kind, cloneKey: block.cloneKey, at: new Date(block.at).toISOString(), detail: block.detail ?? null } : null,
        },
        summary: ticks
          ? `${name}: ${ticks} tick(s) over ${fmtAge(dur)} refused ALL dispatch — its clone is behind origin/main${why ? `; the rebuild is blocked: ${why}` : ''}.`
          : `${name}: no stale-clone refusals.`,
        recommendation: block?.kind === 'pinned-overlay-conflict'
          ? `The rebuild refuses because a pinned overlay${describeBlock(block).slice(block.kind.length)} conflicts with main and main lacks the mechanism it carries (or it is pinned explicitly). Rebase that overlay's branch; the same registration re-applies by itself.`
          : why
            ? `${name}'s clone is not advancing because the rebuild is blocked (${why}) — read ~/.claude/daemon-self-sync-state/${block.cloneKey}.alerts.jsonl and fix that cause in the product, not the clone.`
            : `${name}'s clone is behind origin/main and nothing in the rebuild alerts says why — read the daemon log and the clone's .rebuild.json.`,
      });
    }
    return out;
  },
};
