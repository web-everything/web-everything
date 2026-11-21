---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/8640-fix-daemon-soak-50-tick-and-pr-live-owner-watch-timeouts-und.md", "we:backlog/8641-audit-carry-hardening-origin-main-ref-repo-binding-malformed.md", "we:backlog/8643-harden-dep-trace-tracer-loader-stdout-sync-writes-and-frozen.md", "we:backlog/8644-overlay-remove-must-force-re-adopt-or-hold-the-daemon.md", "we:backlog/8645-urgent-verify-shim-skip-anchor-the-approved-shim-dir-and-bin.md", "we:backlog/8646-red-team-queue-requeue-loop-never-parks-16-requeues.md", "we:backlog/8647-mechanical-re-push-with-no-agy-file-change-should-carry-the.md", "we:backlog/8648-author-stamp-guard-should-judge-the-current-pr-body-and-igno.md", "we:backlog/8652-sk1-follow-ups-sync-commands-deploy-single-root-post-merge-h.md", "we:backlog/8653-reinforce-the-5-waived-forge-slots-capacity-findings-from-72.md", "we:backlog/8654-pin-ready-pin-stale-detail-reason-and-restore-is-ancestor-fo.md", "we:backlog/8655-pre-existing-guard-gaps-found-in-the-7170-rescope.md", "we:backlog/8658-release-a-stale-claim-only-when-its-owner-shows-no-heartbeat.md", "we:backlog/8660-fix-daemon-should-ask-once-then-fall-back-to-a-worker-takeov.md", "we:backlog/8662-auto-resume-a-run-whose-only-pending-work-is-ledger-events.md", "we:backlog/8663-canary-prs-should-self-close-when-their-diff-empties.md", "we:backlog/8666-red-team-queue-lost-pr-7146-silently-after-a-drain-rebase-he.md", "we:backlog/8667-review-set-label-needs-a-way-to-drop-a-stale-status-needs-yo.md", "we:backlog/8670-close-pre-existing-fail-open-guards-found-by-the-r1103-audit.md", "we:backlog/8671-stop-prs-from-stopping-for-a-ruling-the-rulings-file-already.md", "we:backlog/8672-stop-treating-recurring-identical-waiver-approvals-as-new-ru.md", "we:backlog/8673-lane-drain-bornas-grep-fails-open.md", "we:backlog/8674-test-gaming-gate-should-match-parameterized-replacements.md", "we:backlog/8676-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md", "we:backlog/8677-s1e-env-narrowing-slice-needs-its-own-design-and-red-team-r1.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Require edge-to-test mappings in check:item; plan rejects partial and wrong-PR head evidence in w… (from web-everything/web-everything#7291 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/8640-fix-daemon-soak-50-tick-and-pr-live-owner-watch-timeouts-und.md:28` — Require edge-to-test mappings in check:item; plan `rejects partial and wrong-PR head evidence` in we:scripts/conveyor/__tests__/pr-live-owner-watch.test.mjs, asserting no successful completion.
2. `we:backlog/8641-audit-carry-hardening-origin-main-ref-repo-binding-malformed.md:29` — Gate behavioral constraints on explicit test mappings; plan `refuses incomplete carry evidence without changing waivers` and `rechecks changed carry evidence` in we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs.
3. `we:backlog/8643-harden-dep-trace-tracer-loader-stdout-sync-writes-and-frozen.md:18` — Add a check:item gate rejecting active cards with placeholder acceptance; recover the intended test file and name planned cases for loader stdout synchronous writes and frozen subprocess options.
4. `we:backlog/8644-overlay-remove-must-force-re-adopt-or-hold-the-daemon.md:27` — Require negative-case mappings for refusal promises; plan `holds daemon after incomplete or failed readoption` in we:scripts/operations/__tests__/prototype-load-remove-real.test.mjs, asserting removed code never executes.
5. `we:backlog/8645-urgent-verify-shim-skip-anchor-the-approved-shim-dir-and-bin.md:29` — Require lifecycle/error constraints to cite planned cases; add `refuses unresolved shim paths` and `invalidates probe after tool replacement` in we:scripts/operations/__tests__/urgent-verify.test.mjs.
6. `we:backlog/8646-red-team-queue-requeue-loop-never-parks-16-requeues.md:27` — Require state-transition mappings; plan `preserves requeue identity and parking across restart` and `holds dispatch on unreadable history` in we:scripts/conveyor/__tests__/red-team-queue-requeue.test.mjs.
7. `we:backlog/8647-mechanical-re-push-with-no-agy-file-change-should-carry-the.md:30` — Require each carry prerequisite to map to a negative fixture; plan `refuses missing invalid and wrong-PR verdict evidence` in we:scripts/operations/__tests__/open-pr-audit-gate.test.mjs.
8. `we:backlog/8648-author-stamp-guard-should-judge-the-current-pr-body-and-igno.md:29` — Require evidence-read refusal promises to map to fault injection; plan `refuses failed or truncated current-body reads` in we:scripts/operations/__tests__/open-pr.test.mjs.
9. `we:backlog/8652-sk1-follow-ups-sync-commands-deploy-single-root-post-merge-h.md:29` — Require an explicit refusal-case mapping; plan `refuses missing roots and incomplete deployment inputs` in we:scripts/__tests__/sync-commands-deploy.test.mjs, asserting neither root changes.
10. `we:backlog/8653-reinforce-the-5-waived-forge-slots-capacity-findings-from-72.md:24` — Require default-preservation and refusal constraints to cite tests; plan `pins unset slot capacity` with an independent expected value and `refuses admission when capacity sources fail` in we:scripts/readiness/__tests__/forge-slots.test.mjs.
11. `we:backlog/8654-pin-ready-pin-stale-detail-reason-and-restore-is-ancestor-fo.md:29` — Require separate negative-result and execution-error fixtures; plan `refuses readiness on ancestry read failure` in we:scripts/conveyor/__tests__/pr-ready-stuck.test.mjs.
12. `we:backlog/8655-pre-existing-guard-gaps-found-in-the-7170-rescope.md:34` — Require temporal constraints to reference transition tests; plan `refuses expired or replaced evidence before execution` in we:scripts/__tests__/pr7170-guard-gaps.test.mjs, asserting no runner launches.
13. `we:backlog/8658-release-a-stale-claim-only-when-its-owner-shows-no-heartbeat.md:28` — Require release prerequisites to have negative fixtures; plan `retains claim on missing activity or changed ownership` in we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs, including cross-account owner activity.
14. `we:backlog/8660-fix-daemon-should-ask-once-then-fall-back-to-a-worker-takeov.md:22` — Require permission-relaxation cards to map preserved refusals and restart behavior; plan `retains ineligible takeover holds` and `preserves ask-once takeover across restart` in we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs.
15. `we:backlog/8662-auto-resume-a-run-whose-only-pending-work-is-ledger-events.md:28` — Require failure and replay mappings; plan `holds resume on unreadable pending work` and `resumes ledger work once across restart` in we:scripts/operations/__tests__/run-ledger-resume.test.mjs.
16. `we:backlog/8663-canary-prs-should-self-close-when-their-diff-empties.md:28` — Require destructive-action prerequisites to map to failure and transition tests; plan `keeps canary open on failed or changed diff evidence` in we:scripts/operations/__tests__/open-pr.test.mjs.
17. `we:backlog/8666-red-team-queue-lost-pr-7146-silently-after-a-drain-rebase-he.md:22` — Require each outcome constraint to cite an assertion; plan `invalidates old-head review and retains unknown-head hold` in we:scripts/conveyor/__tests__/red-team-queue-head-move.test.mjs.
18. `we:backlog/8667-review-set-label-needs-a-way-to-drop-a-stale-status-needs-yo.md:28` — Require clearance predicates to have missing-evidence fixtures; plan `retains needs-you on incomplete acceptance evidence` in we:scripts/__tests__/review-set-label.test.mjs.
19. `we:backlog/8670-close-pre-existing-fail-open-guards-found-by-the-r1103-audit.md:16` — Assign stable site IDs and gate exact inventory-to-case correspondence; the planned `refuses admission at every audited fail-open site` in we:scripts/conveyor/__tests__/resource-gate-fail-closed.test.mjs needs separate assertions for both reapers.
20. `we:backlog/8671-stop-prs-from-stopping-for-a-ruling-the-rulings-file-already.md:28` — Require automatic-resolution prerequisites to map to negative cases; plan `retains stop on incomplete or changed ruling evidence` in we:scripts/operations/__tests__/open-pr.test.mjs.
21. `we:backlog/8672-stop-treating-recurring-identical-waiver-approvals-as-new-ru.md:28` — Require reuse predicates to map to negative fixtures; plan `requires approval for incomplete or wrong-scope approval evidence` in we:scripts/operations/__tests__/open-pr.test.mjs.
22. `we:backlog/8673-lane-drain-bornas-grep-fails-open.md:28` — Require distinct assertions for read completeness and state preservation; plan `refuses partial bornAs evidence without changing drain state` in we:scripts/__tests__/lane-drain.test.mjs.
23. `we:backlog/8674-test-gaming-gate-should-match-parameterized-replacements.md:28` — Require relaxed-check cards to map error paths explicitly; plan `retains finding for incomplete or unparseable replacement` in we:scripts/__tests__/test-gaming-parameterized.test.mjs.
24. `we:backlog/8676-owed-ci-rerun-executor-residuals-exhausted-rows-soak-gap-rea.md:17` — Require budget contracts to declare units and observable bounds; plan `caps each read timeout at remaining pass duration` in we:scripts/conveyor/__tests__/reconcile-pass.test.mjs using a controlled clock, and add a zero-duplicate-follow-up assertion to A1.
25. `we:backlog/8677-s1e-env-narrowing-slice-needs-its-own-design-and-red-team-r1.md:16` — Make check:item require an explicit case name alongside each executable acceptance entry; name the planned case `blocks S1e readiness without complete current design and review` in we:scripts/__tests__/s1e-design-contract.test.mjs.
26. `we:backlog/8678-probe-and-restrict-service-mediated-credential-reads-in-conf.md:17` — Require compatibility and fallback requirements to map to cases; plan `falls back when required agy authentication cannot work under service restrictions` in we:scripts/lib/__tests__/agy-sa … [truncated: 653 chars over the 7868-char cap]

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7291@8b58c9935ab559084628d2350b03be5314c85861

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
