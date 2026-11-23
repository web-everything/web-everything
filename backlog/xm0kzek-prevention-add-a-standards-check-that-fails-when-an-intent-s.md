---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/_data/intents/breadcrumb.json"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a standards check that fails when an intent's overflow or collapse prose and its linked block… (from web-everything/web-everything#7393 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/_data/intents/breadcrumb.json:4` — Add a standards check that fails when an intent's `overflow` or `collapse` prose and its linked block's rules disagree. That is hard to script, so at minimum require the reconcile card to be linked from the intent or block, or keep the follow-up as a tracked backlog item with an owner.
2. `we:src/_data/intents/breadcrumb.json:9` — Add a standards rule or unit test over src/_data/intents/*.json. A dimension with `closed: true` must have a non-empty values array. A snapshot or allow-list test on breadcrumb's `values` would pin the 'never extended' claim. Alternatively, drop the unenforced `closed` key and say so in prose only.
3. `we:src/_data/intents/breadcrumb.json:30` — Add a deterministic contract-mapping gate requiring each acceptance and behavioral guarantee to identify a repository-qualified test file, named case, and observable assertion; permit explicitly planned cases during preparation.
4. `we:src/_data/intents/breadcrumb.json:8` — Add a machine-checked contract-to-test manifest requiring each acceptance and behavioral guarantee to reference a repository-qualified named test and its observable assertion; track downstream behavior tests with the FUI implementation.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7393@19c7e40477af15be991934fc1d92ccc4b1e44498

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
