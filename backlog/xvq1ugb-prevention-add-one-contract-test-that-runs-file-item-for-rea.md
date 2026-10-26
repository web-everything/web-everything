---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-size-admission.mjs", "we:scripts/pr-land.mjs", "we:scripts/lib/__tests__/pr-size-admission.test.mjs", "we:scripts/__tests__/pr-land.test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Prevention — Add one contract test that runs file-item for real in a temp backlog dir (no stubbed execFileSync… (from web-everything/web-everything#5874 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-size-admission.mjs:134` — Add one contract test that runs `file-item` for real in a temp backlog dir (no stubbed `execFileSync`) and asserts `fileSplitItem` returns a card id accepted by `splitCardId`. Better, share the payload builder between the operation and the adapter so the shape cannot drift.
2. `we:scripts/pr-land.mjs:1243` — Reuse the first verdict (memoise it) instead of calling the helper again. Add a per-mode `runCli` test with injected forge and git that asserts one label application and one body edit for an over-size PR.
3. `we:scripts/lib/pr-size-admission.mjs:196` — Add one `sanitizeForBody()` helper that strips control characters and `&lt;!--`/`--&gt;` and rejects commas for scope entries. Route every interpolation into the body or file-item arguments through it. Back it with a property test over filenames containing newlines, commas and marker text.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5874@59dd2a7df2c6f714b65fe1042b2c8f3759b32592

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
