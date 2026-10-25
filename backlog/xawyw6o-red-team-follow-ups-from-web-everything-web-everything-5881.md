---
kind: story
size: 2
status: open
scope: ["we:scripts/remote-test.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5881 (head cd877c8ef)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5881 (reviewed head `cd877c8ef9c9f5f79d5595781fe9d319ac6e4d80`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/remote-test.mjs:45` — (edge-case, degraded) A client clock one second ahead rejects a newly dispatched successful run
   - Scenario: A complete pre-dispatch snapshot is empty, the client's createdAfter is 2026-10-25T12:00:01.100Z, and GitHub creates the new successful exact-SHA run at 2026-10-25T12:00:00Z. Despite its new run ID, freshDispatchRun rejects it because its server timestamp precedes the client's rounded timestamp. Discovery consequently times out and returns exit 2. An offline comparison reproduced success with createdAfter=12:00:00.100Z and failure without waiting on the run when only that timestamp advanced one second. Freshness should accommodate bounded clock skew or use server-derived timing alongside the I
   - Claude's re-check: demonstrated break

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
