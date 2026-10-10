---
kind: story
size: 5
status: resolved
priority: high
scope: ["we:scripts/conveyor/reconcile-core.mjs", "we:scripts/conveyor/reconcile-pass.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/fix-round-history.mjs", "we:scripts/conveyor/fix-takeover.mjs", "we:scripts/settings/fix.json", "we:skills-src/conveyor/fix-agent-brief.md", "we:scripts/conveyor/__tests__/fix-round-history.test.mjs", "we:scripts/conveyor/__tests__/fix-takeover.test.mjs", "we:scripts/conveyor/__tests__/reconcile-pass.test.mjs"]
dateOpened: "2026-10-10"
dateStarted: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Fixer round history in every fix brief + automatic takeover at the round cap

Make the conveyor fixer as good as a focused takeover worker. (1) A round N>1 fix brief carries a bounded 'previous rounds' section (findings file:line + claim + ruling, what the fixer changed: sha + fix-evidence title, what was re-raised, current rulings), built from PR comments by reusing we:scripts/operations/coroner-rounds.mjs buildPrRounds; setting fix.roundHistory on|off (default on). (2) At round-cap-exhausted (capKind fix) the planner dispatches ONE takeover fix (full-context brief, top claude rung of the fixer-escalation ladder) instead of the 'a person must take it over' note; setting fix.roundCapAction person|takeover (default takeover); one takeover per PR head and per PR; a failed takeover or any ruling dispute still escalates to the operator. Live case: #4708 at 5/5. Settings file we:scripts/settings/fix.json, cascade env > settings > built-in.

## Acceptance

- [A1] **Executable** — `npm run test:unit` over we:scripts/conveyor/__tests__/fix-round-history.test.mjs and we:scripts/conveyor/__tests__/fix-takeover.test.mjs fails before this item (the modules do not exist) and passes after.
- [A2] A round N>1 fix brief opens with a bounded `Previous rounds` section (per round: findings file:line + claim + ruling, what the fixer changed as sha + fix-evidence title, findings raised again; then current rulings), built by reusing we:scripts/operations/coroner-rounds.mjs `buildPrRounds`/`classifyEvent`. Round 1 gets nothing. Setting `fix.roundHistory` on|off, default on.
- [A3] At the fix round cap, `fix.roundCapAction: takeover` (default) dispatches ONE takeover fix on the top claude rung of the fixer-escalation ladder with the full-context brief (takeover section, all rounds, stacked base, rulings) instead of the "a person must take it over" note. `person` keeps the old behavior.
- [A4] Bounds: a trusted takeover marker on the thread spends it (one per head, at most `fix.takeoverMaxPerPr` per PR, default 1); after that, and on any ruling dispute, the operator note is posted as before. Only a spent takeover adds "the takeover already ran"; a ruling dispute adds no suffix to the cap note (the dispute is surfaced by the ruling-escalation ladder, `ruling-dispute`). `fix.takeoverMaxPerPr: 0` (or a present but invalid value, in the file or the env) turns the takeover off, and the note says so (reason `setting-disabled`), never that a takeover ran.
- [A6] The settings live under a `fix` object in we:scripts/settings/fix.json, so the merged settings view (we:scripts/lib/settings-files.mjs) carries the documented `fix.roundCapAction`, `fix.roundHistory` and `fix.takeoverMaxPerPr` paths.
- [A5] Live proof: dry-run replays of #4708 (round 6 brief shows real previous rounds; the 5/5 state plans a takeover on the stronger-model route) and the fix daemon clone adopts the change.

## Non-goals

- [N1] Never auto-resolves a ruling: a ruling dispute still goes straight to the operator. No change to the review cap, the CI-heal cap, the conflict-fix cap or the advisory-fix cap. The CI-heal brief is not changed.

## Risks

- [R1] A takeover runs more than once for a PR or head (a retried launch, a restart, a forged marker), spending a strong-model session per tick.
- [R2] A launch fault after the marker burns the only takeover without any session having run.
- [R3] The takeover's own re-arm is denied its review (it lands past the cap), so the takeover work is never judged.
- [R4] The takeover overrides an instruction it cannot carry (the operator send-back's must-fix body) or settles a ruling dispute without the operator.
- [R5] The operator note misstates what happened (says a takeover ran when it never did, or hides launch faults).
- [R6] The settings are unreadable through the shared settings loader (wrong namespace), or a bad value silently turns the takeover on.
- [R7] The previous-rounds section leaks untrusted or secret text into a brief, or grows without bound.

## Test plan

The takeover and round-history modules did not exist before this item, so each case is RED before it and green after.

- [T1] (R1) we:scripts/conveyor/__tests__/fix-takeover.test.mjs — the per-head and per-PR bound, abbreviated shas, forged markers from untrusted logins, quoted markers. RED before this item.
- [T2] (R2) same file — void markers only after a launch proven not to have started; timeouts and kills keep the marker; at most 2 voids honoured per PR; the marker is posted before the spawn and the void before the claim release (`dispatchFix` wiring tests). RED before this item.
- [T3] (R3) same file — `takeoverReviewCap`: a takeover launched at or above the cap is reviewed one round past its launch count, no more. RED before this item.
- [T4] (R4) same file and we:scripts/conveyor/__tests__/reconcile-pass.test.mjs — the operator send-back site never takes over; a ruling dispute refuses; `person` keeps the old refusal (that part is also a regression guard for the old behaviour). RED before this item.
- [T5] (R5) same file — the note names launch faults on `takeover-void-limit`, says "already ran" only on `takeover-spent`, and says "turned off" on `setting-disabled` (`takeoverMaxPerPr` 0, negative, or not a number). RED before this item.
- [T6] (R6) same file — the shipped file nests under `fix`; `readDeclaredSettings` owns `fix.*` leaves and no bare leaf; env > file > built-in; an unknown `roundHistory` falls through, but the two settings that can start a takeover fail closed: an invalid `roundCapAction` (`persn`, `""`, an array) resolves to `person` and an invalid takeover limit (`-1`, `off`, `100`, `""`, `[3]`), in the file or the env, resolves to 0, so the takeover stays off; a flat key is ignored. RED before this item.
- [T7] (R7) we:scripts/conveyor/__tests__/fix-round-history.test.mjs — trusted comments only, credential-looking lines withheld, the size cap (oldest rounds dropped first), a failed read returns null, the setting gates the section, and round 1 gets nothing. RED before this item.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only trusted-login comments are read (coroner `normalizeComment` + `isTrustedMarkerAuthor`); quoted lines are labelled DATA; every line goes through `scrubPublish` and is withheld when it looks like a credential.
2. **Truncated reads** — the section is capped (8000 chars, 8 rounds, 8 findings per round, 12 rulings), dropping the oldest rounds first; a failed `gh` read returns null and the brief is sent unchanged.
3. **Shared state files** — n/a: no new shared file; the settings file is read-only config.
4. **Fail closed** — an unreadable settings file falls back to the built-in default; a failed takeover-marker post aborts the spawn (env fault, retried next tick), so a takeover never runs without its bound recorded.
5. **Identity scoping** — the marker is keyed on PR + head sha; a forged marker from an untrusted login is ignored.
6. **State over time** — the bound is read off the PR thread every tick, so a daemon restart cannot reset it.
7. **Who wrote it** — markers and history count only automation/operator logins.
8. **Launch fails after the marker** — a failure that PROVES no agent started (before any launch call, or a launch that exited non-zero / never ran) posts a trusted void marker for that head BEFORE the claim is released; it cancels one start marker, so the retry still owns the takeover. A launch timeout or kill is indeterminate (the session may be live), so the marker stands and no second takeover starts. If the void cannot be posted, the marker stands (the safe side of the bound). Only the first 2 voids per PR are honoured, so a launch fault that lasts posts at most 2 extra comments; then the operator note names the launch faults. Known gap: a marker post that times out after GitHub kept the comment, or a crash between marker and launch, leaves the marker standing (safe side). The void body is a fixed phrase: the spawn error (paths, stderr) never goes onto the PR.
9. **The takeover's own review** — a takeover is a round beyond the cap: its re-arm lands one past the count it LAUNCHED at, so the start marker records `attempts=N` and the review cap is the higher of `cap + started takeovers` and `N + 1` for each started (un-voided, trusted) marker. A takeover that launched above the cap (the count can run ahead of the re-arm count, e.g. 6/5) is still reviewed at 7; one round past its launch count and no more. A marker without a launch count falls back to cap + 1. The fix path still refuses another fixer past the cap, so a bounce after the takeover goes to the operator.
10. **Every fix cap site** — the plain bounce and the block-ruled-referral sites may take over (the row carries the blocked referrals). The operator send-back site never does: its must-fix body is not carried by a takeover row, so a person reads it.
