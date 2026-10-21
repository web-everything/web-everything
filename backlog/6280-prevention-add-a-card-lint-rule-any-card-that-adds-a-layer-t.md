---
bornAs: x8ywo47
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x9p23rk-we-operator-override-slice-2-cascade-layer-above-env-with-so.md", "we:backlog/xt96sbx-we-operator-override-slice-3-guard-floor-confirm-and-flag-on.md", "we:backlog/x9ryzme-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md", "we:backlog/xkwhvyg-we-operator-override-slice-1-host-wide-store-and-operator-on.md", "we:backlog/xogmcq9-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md", "we:docs/agent/platform-decisions.md", "we:backlog/xouq5b0-decision-operator-override-settings-layer-db-backed-above-th.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — Add a card-lint rule: any card that adds a layer to resolveCascade must name a test for leaf-vs-w… (from web-everything/web-everything#5549 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6264-we-operator-override-slice-2-cascade-layer-above-env-with-so.md:15` — Add a card-lint rule: any card that adds a layer to resolveCascade must name a test for leaf-vs-whole-key merge semantics.
2. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:14` — Card-lint: tests for 'isolated degradation' must name the unrelated entries asserted still present.
3. `we:backlog/6267-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md:13` — Same card-lint as the slice-3 finding.
4. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:10` — Card-lint: a child card whose parent decision states a fail-closed invariant must either carry the invariant itself or declare blockedBy on the slice that does.
5. `we:docs/agent/platform-decisions.md:6283` — Extend check:standards to fail on a '#<id>' decision reference in we:docs/agent/platform-decisions.md that matches no anchor or backlog id.
6. `we:backlog/6268-decision-operator-override-settings-layer-db-backed-above-th.md:1` — A check:standards rule that fails when a decision card has status: resolved and a quoted ruling but no operator-authored ruling artifact or commit trailer. File this as a backlog item.
7. `we:backlog/6264-we-operator-override-slice-2-cascade-layer-above-env-with-so.md:1` — Add blockedBy edges (2 and 4 after 3, 3 after 1), or have the slice-1 reader treat every key as loosening until slice 3 lands. File a standards check that a card whose Acceptance names a guard floor is an ancestor of the cards that make the guarded behaviour live.
8. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:22` — State the same-user file-write limit explicitly in the card (as a Non-goal or filed debt). When hardening, add an HMAC or root-owned store plus a test that a forged log line is rejected. File a hardening card.
9. `we:backlog/6266-we-operator-override-slice-1-host-wide-store-and-operator-on.md:29` — A check:standards rule that each non-n/a 'Edge cases' line on a story card maps to a named test in Acceptance. Report as unverified, since I ran no mutation.
10. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:14` — Add named tests: 'instruction with markup and control characters is shown escaped', 'a malformed entry is skipped and the other entries still appear', 'feed lines carry actor and time', 'a truncated layer resolves to the lower layers'. Enforce with the same edge-case-to-test check.
11. `we:backlog/6267-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md:32` — The same edge-case-to-test standards check. Add the trusted-PR test before this card starts.
12. `we:backlog/6264-we-operator-override-slice-2-cascade-layer-above-env-with-so.md:33` — Require behavioral checklist entries to carry test references, and reject unmapped entries with a deterministic card-validation gate.
13. `we:backlog/6269-we-operator-override-slice-3-guard-floor-confirm-and-flag-on.md:34` — Gate preparation on explicit guarantee-to-test mappings, with distinct obligations for missing, forged, and mismatched confirmation.
14. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:31` — Add a deterministic guarantee-to-test mapping gate; require isolated-degradation entries to state an assertion that unrelated output remains available.
15. `we:backlog/6267-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md:22` — Extend card validation to require named automated or live verification cases for every acceptance and behavioral checklist obligation.
16. `we:backlog/6269-we-operator-override-slice-3-guard-floor-confirm-and-flag-on.md:34` — Require guarantee-to-test mappings that separately enumerate missing, forged, and replayed authorization evidence, enforced by a preparation completeness gate.
17. `we:backlog/6265-we-operator-override-slice-4-needs-you-flag-for-confirmed-lo.md:31` — Gate each feed guarantee on a named planned test and explicit assertion; require failure-isolation cases to assert preservation of unrelated entries.
18. `we:backlog/6264-we-operator-override-slice-2-cascade-layer-above-env-with-so.md:33` — Require named mixed-validity cases whenever a preparation card promises whole-input rejection, alongside the guarantee-to-test completeness gate.
19. `we:backlog/6267-we-drain-requests-a-red-team-re-run-when-a-run-left-no-usabl.md:22` — Use a deterministic card-completeness gate requiring named checks for every Acceptance item and behavioral edge-case constraint.
20. `we:docs/agent/platform-decisions.md:6294` — Require caller-level named tests for lifecycle guarantees in the preparation mapping, including observable changes between ticks.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #6023, finding 4 → #5590, finding 14 → #5473, finding 19 → #5473.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5549@02bc157ef1bf46e718ad5ff3696cfda69072758c

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

## Also raised by

- Also raised by web-everything/web-everything#5633 (finding 1: `we:backlog/6365-we-6265-slice-4-a-crash-after-an-active-override-publish-mus.md:12` — Require each promised recovery transition to map to a named planned test and observable assertions; add a card-validation gate rejecting unmapped behavior entries.) · key `approval-prevention-key:web-everything/web-everything#5633@3c27e493c120cc24e8e93f6861763d4791cdc363`
