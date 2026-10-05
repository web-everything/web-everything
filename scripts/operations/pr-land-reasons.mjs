/**
 * @file scripts/operations/pr-land-reasons.mjs
 * @description `pr-land.mjs`'s own `reason` vocabulary, bucketed by what the caller should do — a LEAF (no
 *   imports), so a module that only needs the table does not drag in the `open-pr` operation's registry.
 *
 * WHY A LEAF. `open-pr.mjs` owns this table's meaning and re-exports it unchanged, but it also registers an
 * operation (`registry.mjs`, `step-kinds.mjs`, `declared-homes.mjs`). `we:scripts/conveyor/infra-blocked.mjs`
 * needs only the table (#4348-open-pr-retry), and it sits inside the driver-watchdog's pinned import graph
 * (`we:scripts/conveyor/__tests__/driver-watchdog.test.mjs`), which must stay free of the driver's machinery.
 * Importing the table from here keeps that graph one leaf wider instead of four operation modules wider.
 */

/**
 * The home's own `reason` vocabulary, split by WHAT THE CALLER SHOULD DO — which is the only split that
 * matters here and is not the same as "did it exit non-zero".
 *
 * A GUARD ANSWERED (`refused`): the home looked at the request and said no. Editing the request, or fixing
 * the lane, is the fix. This is the bucket that must survive to the caller intact, because it includes
 * #2833's verify refusals — the guard the whole operation exists to route through.
 *
 * THE ENVIRONMENT COULD NOT COMPLETE (`unrun`): the request was fine and the home could not act on it. A
 * missing `gh` credential is the case that matters on this host, and calling it a refusal — as the first
 * cut of this function did, because pr-land emits a structured `reason` for it — sends the caller off to
 * edit a request that was never the problem. Found by running the operation, not by reading it.
 */
export const HOME_REASONS = Object.freeze({
  // opened — `enqueued`/`labelled-on-green` are `--label-on-green`'s two terminal reasons (pr-land.mjs's
  // `PLAN.triggerDrain ? 'enqueued' : 'labelled-on-green'`): the PR is real and labelled ready-to-merge,
  // same as `parked`, just not merged by this call. Missing here, they fell to `unrun` and the sink threw
  // "the PR was NOT opened" for a PR that had, in fact, opened — hit live 7 times across 2026-08-29/30.
  opened: 'opened', parked: 'opened', 'merged-git-fallback': 'opened', enqueued: 'opened', 'labelled-on-green': 'opened',
  // a guard answered — fix the request or the lane
  'bad-delegation': 'refused', 'bad-park': 'refused', 'bad-ref': 'refused', 'empty-body': 'refused', 'locus-prefix': 'refused',
  'no-ref': 'refused', 'no-such-src': 'refused', behind: 'refused', conflict: 'refused',
  'check-red': 'refused',
  // Create-time soak declaration guard — add replay evidence or a body waiver before pushing.
  'soak-declaration': 'refused',
  // we:xniq7xs — the open-PR backpressure limit refused a NEW pr-land open over the per-repo cap (the ref
  // stays pushed): a guard answered, same as `check-red`/`behind` — land/review the existing PRs, or override.
  'pr-limit': 'refused',
  // fix procedure (2026-09-27) — another fixer holds the live fix claim on this branch's PR (`fix-procedure.mjs`):
  // a guard answered — wait for its `fix-end`.
  'fix-claimed': 'refused',
  // …and the #2833 verify refusals, which come from `lib/lane-verify.mjs`'s own `verifyGateDecision`
  // rather than from pr-land's argv parsing. THESE ARE THE ONES THAT MATTER: they are the guard the
  // bypass skipped, and every one of them must reach the caller as an answer, never as a shrug.
  'verify-unfinished': 'refused', 'verify-red': 'refused', 'verify-corrupt': 'refused',
  unverified: 'refused', untracked: 'refused', 'red-ci-gated': 'refused',
  // the environment could not complete — the request is not what is wrong
  'gh-error': 'unrun', 'push-failed': 'unrun', 'fallback-failed': 'unrun', 'check-timeout': 'unrun',
  'blocked-on-infra': 'unrun',
});
