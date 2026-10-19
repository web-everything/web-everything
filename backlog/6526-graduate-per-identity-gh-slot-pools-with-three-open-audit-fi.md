---
bornAs: xfnp6yt
kind: story
size: 8
status: open
scope: ["we:scripts/settings/host-overload.json"]
dateOpened: "2026-10-19"
tags: []
---

# Graduate per-identity gh slot pools with three open audit findings

Parked on lane/hot-gh-slots-wip (commits 31b51130e and 4af5b9286): gh throttle slots become per-identity pools with a reserved background slot, per the operator on 2026-10-18 ('Slots should also be per gh app'). Three audit findings are still open: (1) span cap, (2) mutex fencing, (3) lease-expired exclusion. Fix each with a named test, then land through a graduation PR.

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
