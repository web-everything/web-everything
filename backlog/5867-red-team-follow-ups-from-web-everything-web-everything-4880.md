---
bornAs: xhcuz3g
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4880 (head f3c6f0f56)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4880 (reviewed head `f3c6f0f56e3aa52d4137cd495ea01e6b1e31d81a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/reconcile-core.mjs:476` — (failing-input, degraded) A later no-push fix turn can reuse an already completed claim and refund spent heals.
   - Scenario: Trusted comments, chronologically: fix-4631 begins at aaaaaaaaa at 00:00, ends at bbbbbbbbb at 01:00, then three heal markers arrive at 02:00, 03:00 and 04:00. A subsequent fix-4631 turn pushes nothing; its begin comment fails to post, but its end at bbbbbbbbb posts at 05:00. This is supported by fixBegin's best-effort comment posting. Because beginSha never consumes the first begin, the second end reuses aaaaaaaaa and falsely establishes another push. The source-function probe changed the charged count from 3 to 0 and resetAt from 01:00 to 05:00. The completed begin must not authorize another
   - Claude's re-check: beginSha is never cleared after an end consumes it. In the named sequence the second fix-4631 end (bbbbbbbbb) is compared against the stale begin (aaaaaaaaa), so it counts as a new push. That moves resetAt to 05:00 and drops the three heals posted at 02:00–04:00.

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
