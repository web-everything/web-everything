---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md"]
dateOpened: "2026-10-17"
tags: []
---

# Prevention — A check:standards rule requiring each Acceptance 'Executable' test file to be among the card's sc… (from web-everything/web-everything#5519 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md:22` — A check:standards rule requiring each Acceptance 'Executable' test file to be among the card's scope files that contain the guarded symbol; failing that, a review-lens checklist item mapping each guarantee to the file that owns the code.
2. `we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md:14` — Template the A3 live-evidence command with a PR-keyed pattern, e.g. rg on 'claim-held' together with the repo#PR, in the scaffold for live-observation criteria.
3. `we:backlog/5745-drain-no-merge-while-a-fix-or-ci-heal-claim-is-live.md:28` — Add a planned named test, `drain delivery strategy: unset settings preserves default`, that omits strategy configuration and overrides and asserts the existing default's observable delivery action; include it in the scoped test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5519@e899563008de9c9e9f28f7435519af14cbadc1c6

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
