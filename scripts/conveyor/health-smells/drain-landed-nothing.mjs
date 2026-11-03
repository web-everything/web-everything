/**
 * EMERGENCY-1 / R461 — the drain had queued PRs but landed nothing for more than `minStalledMs`. Reads the drain's
 * own `history.jsonl` passes (via the `drainHistory` probe): a stall is every pass in the window considering PRs
 * and merging none, with the window actually covered by passes (a quiet drain with nothing queued is not a stall).
 * 2026-11-03: a freeze-branch read timeout held every PR for hours as "main is red [manual]" and nothing alerted.
 * Repeats come from the health-watch core: `repeatReminders` re-notifies with a doubling gap from `reminderAfterMs`, so the
 * alert backs off instead of going quiet. The hold reason from the latest pass rides in the summary.
 */
import { HOUR } from '../health-watch-core.mjs';

const MIN = 60 * 1000;

/** PURE: the stall over the last `windowMs`, or null when the drain landed something / had nothing queued / is not covered. */
/** A pass that proves the drain recovered: it merged something, or it cleanly (exit 0, nothing failed) found nothing queued. */
const isRecovery = (p) => (Number(p.merged) || 0) > 0 || ((Number(p.considered) || 0) === 0 && (p.clean ?? (p.exit === 0 && !(Number(p.failed) > 0) && !(Number(p.failedRepos) > 0))) === true); // `clean` (the probe's strict read) wins: unreadable failure counters are never clean
/** A pass that had queued PRs and landed none. Failed zero-count passes are neither this nor recovery: they are ignored. */
const isStalled = (p) => (Number(p.considered) || 0) > 0 && (Number(p.merged) || 0) === 0;

/**
 * PURE: the stall, or null. The stall STARTS at the first queued-and-unmerged pass after the latest recovery (or
 * the beginning of history) and holds while no recovery follows; it counts once it has lasted `windowMs`. Records with
 * a missing/invalid count and failed zero-count passes are ignored (unknown, never recovery).
 */
export function landedNothing(rawHistory, { now, windowMs = 30 * MIN } = {}) {
  const history = (rawHistory || []).filter((p) => p.valid !== false && now - p.at >= 0).sort((a, b) => a.at - b.at);
  let start = null; let last = null; let passes = 0;
  for (const p of history) {
    if (isRecovery(p)) { start = null; last = null; passes = 0; } else if (isStalled(p)) { start ??= p.at; last = p; passes += 1; }
  }
  if (start == null || now - start < windowMs) return null;
  const bits = [...(last.skippedPrs || []), ...(last.deferredDetail || [])].map((x) => String(typeof x === 'string' ? x : JSON.stringify(x)).replace(/\s+/g, ' ').slice(0, 160));
  return { passes, considered: Number(last.considered) || 0, reason: bits.length ? bits.slice(0, 2).join(' | ') : `queued PRs landed none for ${Math.round((now - start) / MIN)} min; no hold reason in history, see daemon.log` };
}

/** PURE: how many history passes fall in the window (fewer than `minPasses` is UNKNOWN, never clean). */
export function passesInWindow(rawHistory, { now, windowMs = 30 * MIN } = {}) {
  return (rawHistory || []).filter((p) => p.valid !== false && now - p.at >= 0 && now - p.at <= windowMs).length;
}

/** PURE: recovery evidence in the window — a valid pass that merged something, or a CLEAN (exit 0, nothing failed, no repo listing failed) pass that found nothing queued; a failed or partial pass with zero candidates proves nothing. Anything else is UNKNOWN. */
export function recovered(rawHistory, { now, windowMs = 30 * MIN } = {}) {
  return (rawHistory || []).some((p) => p.valid !== false && now - p.at >= 0 && now - p.at <= windowMs && isRecovery(p));
}

export default {
  id: 'drain-landed-nothing',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['drainHistory'],
  missingSubjectsUnknown: true, // a missing/unreadable history is unknown, never proof the drain recovered
  openAfter: 1,
  closeAfter: 1,
  severity: 'high',
  action: 'alert',
  windowMs: 30 * MIN,
  repeatReminders: true, // the core re-notifies while the stall persists, the gap doubling from reminderAfterMs (cap 4h)
  reminderAfterMs: HOUR,
  recommendationHint: 'The drain has had queued PRs for 30+ minutes and landed none — read the hold reason (freeze-unreadable vs a real red main) in the drain log.',
  evaluate({ drainHistory }, { now }) {
    if (!Array.isArray(drainHistory)) return [];
    const r = landedNothing(drainHistory, { now, windowMs: this.windowMs });
    // Too few passes to judge (the drain stopped completing passes): UNKNOWN, so an open episode stays open and keeps reminding.
    // Clean only on evidence of recovery (a merge, or nothing queued); a window we cannot judge stays unknown.
    if (!r && !recovered(drainHistory, { now, windowMs: this.windowMs })) return [];
    return [{
      subject: 'drain',
      breach: !!r,
      measure: r ? { passes: r.passes, considered: r.considered } : { passes: 0, considered: 0 },
      summary: r ? `drain: ${r.passes} pass(es) in the last ${Math.round(this.windowMs / MIN)} min each considered queued PRs (${r.considered}) and landed none — ${r.reason}` : 'drain: landing normally',
      recommendation: 'Read the latest "skipped:" line in the drain log. "freeze-unreadable" means the shared freeze branch could not be read (host load or git); "main is red" means a real red main.',
    }];
  },
};
