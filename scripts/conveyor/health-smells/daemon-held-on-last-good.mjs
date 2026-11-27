/**
 * x5wbsbc (epic #4075/#3383) — health-watch sign for a daemon clone the rebuild has FROZEN on its last-good
 * build after a failed live smoke, instead of blocking delivery. Operator ruling 2026-09-26: when the new
 * `origin/main` (or an overlay) fails the live smoke, or the smoke harness/environment itself is broken, the
 * daemon-rebuild mechanism (`scripts/lib/daemon-rebuild.mjs`'s `smokeAndAdopt`/`hold`) leaves the clone on its
 * last-good build and keeps it dispatching from there instead of blocking delivery — a deliberate, correct
 * choice, but one that must not go unnoticed forever. This sign opens once a clone has sat held for more than
 * `heldForMs` (15 minutes) and names the reason plus the exact failing check(s), so the operator (or a fix
 * session) knows whether to fix the new tree or the smoke harness itself.
 *
 * Reads `~/.claude/daemon-self-sync-state/<cloneKey>.rebuild.json`'s `held` field, passed through by
 * `health-watch.mjs#probeSelfSync` (see `daemon-rebuild.mjs`'s own doc for the exact shape:
 * `{since, reason: 'smoke-rejected'|'smoke-harness-broken'|'smoke-transient'|'smoke-threw'|'github-auth-broken'|'smoke-env-timeout'|'smoke-env-unavailable', failed, details,
 * lastGood, target, mainSha, updatedAt}`). A cleared hold closes an existing episode only with a newer
 * adoption of a different build. Missing or invalid evidence retains the alert with uncertainty.
 *
 * Notify scope: still notifies even in shadow mode — a PREVIOUSLY approved sign, carried forward unchanged by
 * the Sun 2026-09-27 ~7:40 AM ET operator decision (`we:scripts/conveyor/health-smells-notify-list.mjs`),
 * which ADDED eight more signs to the notify surface without demoting any sign already approved.
 */
import { MINUTE, HOUR, fmtAge } from '../health-watch-core.mjs';

/** Past this age, the hold itself becomes the headline, whatever the reason (`measure.overMaxAge`). */
export const MAX_HELD_AGE_MS = 24 * HOUR;

export default {
  id: 'daemon-held-on-last-good',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['selfSync'],
  // Even a failed/missing probe must annotate owed alerts rather than silently retaining stale certainty.
  evaluateMissingProbes: true,
  openAfter: 1,
  closeAfter: 1,
  missingSubjectsUnknown: true,
  severity: 'high',
  action: 'alert',
  heldForMs: 15 * MINUTE,
  recommendationHint: 'A daemon clone is held on its last-good build after a failed live smoke — its alerts file names the failing check(s); fix the tree (or, if the harness itself is broken, the tool the check exercises) — never the clone by hand.',
  evaluate({ selfSync }, { now, episodes = {} }) {
    const previous = Object.values(episodes).filter(ep => ep.smell === this.id);
    const rows = Array.isArray(selfSync) ? [...selfSync] : [];
    const seen = new Set(rows.map(c => `clone:${c.cloneKey}`));
    for (const ep of previous) {
      if (!seen.has(ep.subject)) rows.push({ cloneKey: ep.subject.slice('clone:'.length) });
    }
    return rows.map((c) => {
      const subject = `clone:${c.cloneKey}`;
      const prior = previous.find(ep => ep.subject === subject);
      const held = c.rebuild?.held ?? null;
      if (!held && prior) {
        const adopted = c.rebuild?.adopted;
        // Old persisted episodes may lack heldSinceIso: require adoption after first observation then.
        const recordedSince = Date.parse(prior.measure?.heldSinceIso ?? '');
        const after = Number.isFinite(recordedSince) ? recordedSince : prior.firstBreachAt;
        const resolved = c.rebuild?.held === null && Number.isFinite(adopted?.at)
          && adopted.at > after && adopted.at <= now && typeof adopted.head === 'string'
          && adopted.head.length > 0 && typeof prior.measure?.lastGood === 'string'
          && adopted.head !== prior.measure.lastGood;
        return { subject, breach: !resolved,
          measure: { ...prior.measure, daemon: c.cloneKey,
            episodeId: prior.measure?.episodeId ?? prior.id,
            uncertainty: resolved ? [] : ['unconfirmed-adoption'] },
          summary: resolved ? `clone ${c.cloneKey}: newer build adopted.` : prior.summary,
          recommendation: resolved ? `clone ${c.cloneKey} adopted a newer build.`
            : 'Inspect the daemon rebuild state and adoption history; rebuild through the normal smoke gate. The hold cannot yet be confirmed cleared.',
        };
      }
      const uncertainty = [];
      const validSince = typeof held?.since === 'number' && Number.isFinite(held.since)
        && Math.abs(held.since) <= 8.64e15 && held.since <= now;
      const since = validSince ? held.since : null;
      if (held && !validSince) uncertainty.push('invalid-since');
      const heldMs = since != null ? now - since : null;
      const heldMin = heldMs != null ? Math.round(heldMs / MINUTE) : null;
      const breach = !!held && (since == null || heldMs > this.heldForMs || !!prior);
      const failed = held?.failed == null ? null : String(held.failed);
      if (failed?.length > 4096) uncertainty.push('oversized-failed');
      const failedChecks = failed ? failed.slice(0, 4096).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ') : null;
      const lastGood12 = held?.lastGood ? String(held.lastGood).slice(0, 12) : null;
      const overMaxAge = heldMs != null && heldMs > MAX_HELD_AGE_MS;
      if (overMaxAge) uncertainty.push('ancient-hold');
      const reasonPart = held ? `${held.reason}${failedChecks ? `: ${failedChecks}` : ''}` : null;

      return {
        subject,
        breach,
        measure: {
          daemon: c.cloneKey,
          episodeId: prior?.measure?.episodeId ?? prior?.id ?? `${this.id}:${c.cloneKey}:${since ?? now}`,
          heldMs,
          uncertainty,
          heldReason: held?.reason ?? null,
          heldSinceIso: since != null ? new Date(since).toISOString() : null,
          heldMin,
          failedChecks,
          lastGood: held?.lastGood ?? null,
          target: held?.target ?? null,
          overMaxAge,
        },
        summary: held
          ? `clone ${c.cloneKey} held on its last-good build ${lastGood12 ?? '?'} for ${fmtAge(heldMs)}${reasonPart ? ` (${reasonPart})` : ''} — still dispatching from it.`
          : `clone ${c.cloneKey}: not held.`,
        recommendation: !held
          ? `clone ${c.cloneKey} is not currently held on its last-good build.`
          : uncertainty.length
            ? 'Inspect the daemon rebuild state and full alerts history; rebuild through the normal smoke gate. Hold evidence is uncertain or older than 24 hours; escalate to the operator if it cannot be verified.'
          : held.reason === 'github-auth-broken'
            ? `GitHub rejects the daemon's App token even after a forced re-mint — an ENVIRONMENT fault, not the tree. Check the App installation / private key (\`node scripts/conveyor/github-app-status.mjs\`); the clone keeps dispatching from its last-good build (${lastGood12 ?? '?'}) and re-checks every tick. Full history: ~/.claude/daemon-self-sync-state/${c.cloneKey}.alerts.jsonl.`
          : held.reason === 'smoke-env-timeout'
            ? `A smoke check${failedChecks ? ` (${failedChecks})` : ''} ran out of time even with widened budgets — the HOST is overloaded, not the new tree (no overlay is blamed, nothing is rejected). Find what is loading the machine (\`uptime\`, the heavy-admission queue); the clone keeps dispatching from its last-good build (${lastGood12 ?? '?'}) and adopts on the first tick the smoke fits in time. Full history: ~/.claude/daemon-self-sync-state/${c.cloneKey}.alerts.jsonl.`
          : held.reason === 'smoke-env-unavailable'
            ? `GitHub API degraded — an ENVIRONMENT fault, not the tree; nothing rejected, no overlay blamed. Check githubstatus.com / \`gh api rate_limit\`; the clone keeps dispatching from its last-good build (${lastGood12 ?? '?'}) and adopts on the first tick GitHub answers. Full history: ~/.claude/daemon-self-sync-state/${c.cloneKey}.alerts.jsonl.`
          : held.reason === 'smoke-harness-broken'
            ? `The smoke harness/environment itself fails${failedChecks ? ` (${failedChecks})` : ''} — it fails the same way even on the last-good build, so this is not a regression in the new tree. Fix the tool the named check exercises, not the clone; it keeps dispatching from its last-good build (${lastGood12 ?? '?'}) meanwhile. Full history: ~/.claude/daemon-self-sync-state/${c.cloneKey}.alerts.jsonl.`
            : `The new origin/main (or an overlay) fails ${failedChecks || 'the smoke gate'} — fix that in the tree, not the clone. Per the 2026-09-26 operator ruling, the clone keeps dispatching from its last-good build (${lastGood12 ?? '?'}) meanwhile rather than blocking delivery. Full history: ~/.claude/daemon-self-sync-state/${c.cloneKey}.alerts.jsonl.`,
      };
    });
  },
};
