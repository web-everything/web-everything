---
kind: story
size: 3
status: active
scaffoldedBy: "fixd-supersede-verdict"
dateScaffolded: "2026-10-09"
scope: ["we:scripts/conveyor/ci-heal-verdict-recheck.mjs", "we:scripts/conveyor/ci-heal-escalation-mark.mjs", "we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# A not-a-ci-break ci-heal verdict pins a PR whose required check went red later

Live 2026-10-09: #4535 ci-heal recorded not-a-ci-break at 02:29:18Z while checks still ran; test went red at 02:29:43Z and reconcile refused every heal on that head since. A void marker now voids a contradicted verdict, and the CLI refuses the verdict while required checks are pending or red.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/ci-heal-verdict-recheck.test.mjs we:scripts/conveyor/__tests__/ci-heal-escalation-mark.test.mjs we:scripts/conveyor/soak/breaks/not-a-ci-break-pinned-red.soak.test.mjs` passes; the soak break is expected-fail on a tree without `we:scripts/conveyor/ci-heal-verdict-recheck.mjs`.
- [A2] **Live** — #4535 gets one `verdict void` comment for head 8443f3b68 and the next fix-daemon tick plans a ci-heal (or another, correct refusal) instead of `ci-heal-escalated`.
- [A3] Must: review-gate alone never voids a verdict; a void never hides a `needs-human` or `waiting-on-system-fix` escalation; caps still apply after a void.

## Non-goals

- [N1] No edit to `we:scripts/conveyor/reconcile-core.mjs` (held by #4527): the void works through `we:scripts/conveyor/ci-heal-escalation-mark.mjs#latestCiHealEscalationForHead`.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — only trusted void comments count, and only one naming the same head, posted after the escalation.
2. **Truncated reads** — the rollup is collapsed to the latest run per check; a missing required check reads as not finished, never green.
3. **Shared state files** — n/a: no local state; the void lives on the PR thread.
4. **Fail closed** — setting off = today; a failed required-check read in the CLI warns and records as before; the daemon skips the void on a read error.
5. **Identity scoping** — head-scoped: a void for another head never applies.
6. **State over time** — posted once per head (dedup by reading voids back); a new push re-arms as before.
7. **Who wrote it** — `isTrustedMarkerAuthor` for both the escalation and the void.
