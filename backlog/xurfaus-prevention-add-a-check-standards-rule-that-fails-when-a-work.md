---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:.github/workflows/ci.yml", "we:scripts/lib/sibling-credential.mjs", "we:scripts/lib/__tests__/sibling-credential.test.mjs"]
dateOpened: "2026-10-07"
tags: []
---

# Prevention — Add a check:standards rule that fails when a workflow referencing an App private-key secret has no docume… (from plateauapp/plateau-app#212 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:.github/workflows/ci.yml:61` — Add a check:standards rule that fails when a workflow referencing an App private-key secret has no documented least-privilege installation (or uses an App not registered as read-only for the target repo), and file the plateau-specific read-only App as a follow-up before WE_APP_PRIVATE_KEY is set.
2. `we:scripts/lib/sibling-credential.mjs:77` — Probe a contents-read endpoint and add a deterministic test where metadata succeeds but contents access is denied, asserting that preflight emits the named failure annotation.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#212@dfce60050454077f1401744320bd89990c525dab

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
