---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild/state.mjs", "we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs", "we:scripts/lib/daemon-rebuild/__tests__/state.test.mjs", "we:scripts/lib/daemon-rebuild/__tests__/orchestrator-ask.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add the named cases to required CI, injecting both nonzero ancestry-command errors and thrown exc… (from web-everything/web-everything#7487 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild/state.mjs:270` — Add the named cases to required CI, injecting both nonzero ancestry-command errors and thrown exceptions; this regression gate needs a future backlog item.
2. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:31` — Require CI tests asserting zero filesystem calls for both Vitest detection paths, plus a rebuild test injecting journal-read failures and asserting successful adoption and exactly one alert; this guard needs a future backlog item.
3. `we:scripts/lib/daemon-rebuild/state.mjs:271` — Add a mutation-testing step, or a check:standards rule, for security-guard conjuncts. Until then, review should require one failing-input test per `&&` leg of any staleness or admission predicate.
4. `we:scripts/lib/daemon-rebuild/state.mjs:267` — Give fail-closed helpers a reviewer checklist item requiring a throwing-dependency test. Better, add a lint or test-helper that runs each `catch { return <bool> }` guard under an injected throw.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7487@4383bdc29180fb93835611df51872f69fed4f84b

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
