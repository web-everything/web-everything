---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7382 (head 1f91ecd9d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7382 (reviewed head `1f91ecd9d394bfba263e4e863f83225da3805a45`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:164` — (failing-input, degraded) Malformed nonempty pidStart silently removes a live red-team holder
   - Scenario: Read a recent canonical we-12-&lt;40-hex-head&gt;.json containing status:"running", a live positive pid, and pidStart:"garbage". With a readable process start time, validation accepts the malformed string, then probeSlotAlive interprets the mismatch as a replaced process. The result is ok:true with no holders. Malformed identity evidence should return ok:false; only a valid stored identity should support a replacement diagnosis.
   - Class: live-reproduced (basis: Reproduced using in-memory filesystem evidence, the current process PID, and the unchanged production liveness probe with an injected readable ps start time. The malformed identity returned ok:true and zero holders; replacing only pidStart with the matching timestamp returned one holder. Unrelated imports were stubbed because this checkout lacks gray-matter.)
   - Also class: correctness-in-normal-use
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
