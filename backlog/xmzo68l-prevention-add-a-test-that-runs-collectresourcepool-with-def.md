---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs", "we:scripts/lib/__tests__/resource-pool-io.test.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Prevention — Add a test that runs collectResourcePool with default cap derivation against the real settings an… (from web-everything/web-everything#7181 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/resource-pool-io.mjs:259` — Add a test that runs `collectResourcePool` with default cap derivation against the real settings and asserts each legacy kind (fix, blocker, review, redTeam, build, heavy, forge) resolves a finite cap, or that the unknown set equals an explicit allowlist.
2. `we:scripts/lib/resource-pool-io.mjs:148` — Review lens: every `continue` or skip in a fail-closed reader needs a named fixture test. A check:standards rule is hard to write for this, so file it as a lens note.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7181@e8d35fcae15fe9159d4de4ef08e462fcf0685967

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
