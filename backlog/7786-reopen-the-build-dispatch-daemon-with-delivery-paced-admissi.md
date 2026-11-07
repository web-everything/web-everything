---
bornAs: xftzdp6
kind: story
size: 2
status: open
scope: ["we:plan.md"]
dateOpened: "2026-11-02"
tags: []
---

# Reopen the build-dispatch daemon with delivery-paced admission (R111, operator "We could reopen builder eventu

MED priority hint. ## (held 2026-10-25 18:49 ET) Reopen the build-dispatch daemon with delivery-paced admission (R111, operator "We could reopen builder eventually too") Move the R111 rule from the orchestrator prompt into the build-dispatch daemon: admit a new build only when open PRs ≤ cap (settings cascade, 18), new PRs in the window ≤ merged-in-window + 2, and load < 36. Otherwise hold with reason `delivery-paced`, and emit a daemon event. Pull candidates from we:plan.md / the cleared queue. Then the orchestrator stops hand-dispatching builds. Prerequisite: the drain is flowing again (#5941 adopted) and the R106 pr-merged event exists. Scope (R111a): the daemon builds ordinary delivery cards only. Debug/prototype work (daemon bug fixes, prototype-load, stuck-PR takeovers) stays orchestrator-dispatched. Tag or route those so the daemon never picks them. Later, not a priority (operator 2026-10-25 ~18:50 ET: "Eventually builder should be able to do both but adding that is not a priority"): the builder also takes debug/prototype work. Park as a follow-up card.

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
