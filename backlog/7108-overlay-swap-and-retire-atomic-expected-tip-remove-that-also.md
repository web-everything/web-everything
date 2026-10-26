---
bornAs: xula5kc
kind: story
size: 3
status: open
scope: ["we:scripts/daemon-overlay.mjs", "we:scripts/lib/daemon-load-overlay.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Overlay swap and retire: atomic expected-tip remove that also removes every contained older registration

2026-10-24 17:27 ET: content-landed registrations (codex-wait, ciheal-bounced-real-red) cannot be retired safely because 69e71fead7 forbids blind remove-by-name; want an atomic remove keyed on the expected tip. 2026-10-25 02:44 ET: prototype-load swap-remove-failed - registering a newer variant left contained older variants registered on review (1025, 1025b-m1, 1025b, 1025b-m2). The swap must remove every registration the new one contains, atomically by expected tip.

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
