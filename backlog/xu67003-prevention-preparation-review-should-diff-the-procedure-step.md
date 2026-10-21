---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x5wqxb3-per-pr-review-run-identity-index-so-the-drain-s-red-team-evi.md", "we:backlog/x0lckod-slice-3-retire-the-full-review-run-scan-to-a-missing-index-f.md", "we:backlog/xl3mmn5-slice-0-review-pr-run-identity-is-immutable-writerun-refuses.md", "we:backlog/xukmjgl-slice-2-switch-the-red-team-evidence-reader-to-the-identity.md"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention — Preparation review should diff the procedure steps against the invariants they must satisfy. The… (from web-everything/web-everything#5742 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/x5wqxb3-per-pr-review-run-identity-index-so-the-drain-s-red-team-evi.md:44` — Preparation review should diff the procedure steps against the invariants they must satisfy. The existing planned card 5360 does not cover procedure/invariant consistency, so it needs a review-lens note.
2. `we:backlog/x0lckod-slice-3-retire-the-full-review-run-scan-to-a-missing-index-f.md:19` — Extend planned gate 5360 so that a retirement or replacement card must map every guarantee of the card it supersedes to a named case or an explicit drop.
3. `we:backlog/xl3mmn5-slice-0-review-pr-run-identity-is-immutable-writerun-refuses.md:43` — The planned 5360 rule (per-guarantee file/case/assertion mapping) would catch it if it also checks that edge-case claims appear in the mapped assertion text.
4. `we:backlog/x5wqxb3-per-pr-review-run-identity-index-so-the-drain-s-red-team-evi.md:119` — Preparation review lens: each stated lifecycle step must name the owning file in some slice's scope.
5. `we:backlog/x0lckod-slice-3-retire-the-full-review-run-scan-to-a-missing-index-f.md:18` — Make 5360's `requires_omitted_setting_default_case` rule also require that a retirement or follow-on slice's regression list is a superset of its predecessor's named cases, or states an explicit exemption for each one dropped.
6. `we:backlog/xukmjgl-slice-2-switch-the-red-team-evidence-reader-to-the-identity.md:30` — Add a preparation-review lens item: any 'requires operator ruling X' gate must name the exact artifact and reader, with a missing-artifact test case. Ideally a check:standards rule would catch a 'ruling'/'soak' precondition in Acceptance that has no artifact path.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5742@4b622bedb38d84e5735029c84d07d2637f7957ba

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
