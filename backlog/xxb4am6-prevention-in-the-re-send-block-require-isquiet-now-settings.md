---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/health-watch.mjs", "we:scripts/lib/quiet-hours-io.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/lib/__tests__/quiet-hours-io.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — In the re-send block, require isQuiet(now, settings, toggle).quiet before re-sending, and clear h… (from web-everything/web-everything#4461 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/health-watch.mjs:1355` — In the re-send block, require `isQuiet(now, settings, toggle).quiet` before re-sending, and clear `heldByQuietHours` once a flush has run outside quiet hours. Add a test that crosses 07:00 with a held episode.
2. `we:scripts/lib/quiet-hours-io.mjs:261` — Write the timestamped digest file only after a confirmed send, and overwrite only `we:latest-digest.md` beforehand. Optionally prune old digests.
3. `we:scripts/lib/quiet-hours-io.mjs` — Add a deterministic producer/consumer boundary test at and above MAX_ENTRY_BYTES, and reject oversized holds so the existing direct-delivery fallback runs.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4461@c58d31e07e4d46ae86a7ccfb99c132b38bb0774f

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
