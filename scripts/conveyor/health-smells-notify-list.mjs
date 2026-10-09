/**
 * @file scripts/conveyor/health-smells-notify-list.mjs
 * Lives OUTSIDE `health-smells/` on purpose (mirrors `health-smells-shape.mjs`): every `.mjs` file in that
 * directory is disk-discovered as a smell module by `health-smells/index.mjs`, so this plain data file (no
 * default export) sitting inside it would fail the smell shape check and break the whole registry at import.
 * @description #4077 continuation — ONE declared place for "which signs notify even in shadow mode" (health-watch's
 *   global mode today). Before this file, that opt-in lived as a scattered `notifyEvenInShadow: true` field
 *   hand-added to each individual smell's own definition file — seven of them, accreted one incident at a time
 *   (`claude-auth-expired`, `daemon-held-on-last-good`, `dispatch-permission-stall`, `dispatch-refused-stale-clone`,
 *   `duplicate-live-sessions`, `machine-overload`, `bg-isolation-stall`), with no single place that named the
 *   whole notify surface. `health-watch-core.mjs#planActions` now checks a smell's `id` against this Set
 *   instead of reading a field off the smell object — see that function's own `notifySet` param.
 *
 * OPERATOR DECISION (Sun 2026-09-27 ~7:40 AM ET): the night of 2026-09-26→27 the watch opened a real episode
 * for every outage (rebuild freezes, 0 acquirable lanes, the drain's gh-rate-limit window, duplicate heals,
 * stalled fixers, orphaned PRs, a silent daemon) but notified on almost none of them, because the notify
 * surface (the scattered flag's set, at the time) did not line up with what actually fired that night. The
 * operator reviewed the night's real episodes and ADDED eight more signs to the notify surface — one
 * notification per episode, the existing dedupe/cooldown/flap rules unchanged. This is an ADDITION, not a
 * reset: every sign already approved to notify by an earlier operator decision (`claude-auth-expired`,
 * `daemon-held-on-last-good`, `dispatch-permission-stall`, `machine-overload`, `bg-isolation-stall`,
 * `dispatch-refused-stale-clone`, `duplicate-live-sessions` — the same seven the old scattered flag covered)
 * stays exactly as it was; none of them is demoted. The Set below is that previous notifying set UNION the
 * eight signs this decision adds (two of the eight — `dispatch-refused-stale-clone`, `duplicate-live-sessions`
 * — were already in the previous set, so the union has 13 entries, not 15). Every OTHER registered smell
 * (never approved to notify by any decision so far) stays record-only (shadow).
 */
export const NOTIFY_EVEN_IN_SHADOW = new Set([
  // Previously approved (earlier operator decisions; the old scattered `notifyEvenInShadow: true` field) — kept.
  'claude-auth-expired',
  'daemon-held-on-last-good',
  'dispatch-permission-stall',
  'machine-overload',
  'bg-isolation-stall',
  // Sun 2026-09-27 ~7:40 AM ET operator decision — added:
  'drain-failing-repeatedly',   // drain gh-error / pass-failed streak — 2026-09-27 ~04:04-04:33Z
  'dispatch-refused-stale-clone', // already approved above too — listed once, a Set
  'lane-starvation',            // fewer than 5 acquirable lanes — 2026-09-27 ~01:30Z, 0 acquirable
  'gh-call-failures',
  'gh-graphql-budget',
  'duplicate-live-sessions',    // already approved above too — listed once, a Set
  'draft-not-promoted',       // Operator duration policy, 2026-10-01 (#xyx5mea).
  'red-pr-unattended',
  'repeated-pr-attempts', // Operator rule, 2026-09-30: surface repeated trials per PR.
  'pr-no-owner',
  'daemon-silent',
  'build-session-idle',    // Operator order, 2026-10-06: supervise build/prepare so models never spin for nothing.
  'build-session-overrun',
  'build-session-looping',
  'external-run-stalled',
  'ruling-needed-waiting', // Operator order, 2026-10-04 ~08:15 ET: a parked review waited ~8 h on a ruling with no alert (PR #3794).
  // Operator order, 2026-10-07 (builder-starved-2): the builder starved twice in one day while this smell sat
  // record-only in shadow mode (opened 18:16Z, nobody told) — a starving builder must reach the operator.
  'builder-starved',
  // Operator ruling, 2026-10-09 ("Add it", PR #4461): a red main must reach the operator even during quiet hours
  // (with a silent daemon it is the only alert that breaks through). One episode per main SHA — the smell's subject
  // is `main:<sha>` — so this is one alert per broken main commit.
  'pre-existing-red-on-main',
]);
