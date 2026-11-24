---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:blocks/time-tracks/TimeTracksElement.ts", "we:blocks/time-tracks/__tests__/TimeTracksElement.test.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Prevention — Add a unit test that mounts the demo markup, formatted with whitespace, and asserts no empty unplaced slot… (from frontier-ui/frontierui#53 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:blocks/time-tracks/TimeTracksElement.ts:84` — Add a unit test that mounts the demo markup, formatted with whitespace, and asserts no empty unplaced slot. The guard would then become `Array.from(el.childNodes).some(n => n.nodeType !== 3 || n.textContent.trim())`.

Idempotency key (do not edit): approval-prevention-key:frontier-ui/frontierui#53@50bae164dac1c8a52dfa9beb028b19b17d89479b

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
