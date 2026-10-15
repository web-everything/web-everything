---
bornAs: xldyxv0
kind: story
size: 2
status: open
scope: ["we:scripts/lib/enqueue-on-event.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5241 (head e3b598326)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5241 (reviewed head `e3b5983262bb6a851367b873e8e24bf1e07a6a5c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/enqueue-on-event.mjs:292` — (edge-case, degraded) A skipped older PR repeatedly consumes the catch-up slot, starving a green PR.
   - Scenario: Queue size 4, capacity 5; #42 and #43 are open, non-draft, ready-labeled and unqueued. #42 has the older readyAt and an IN_PROGRESS check; #43 has completed successful checks. Three catchUp() calls spaced ten minutes apart read [42,42,42], each returning 'not woken', without reading or spawning #43. Selection consumes the one available slot before the wake filter runs. Catch-up should advance to #43 when #42 cannot enqueue and leaves the slot unused.
   - Claude's re-check: planCatchUp slices candidates to 'room' before the wake filter runs in runDue. With room 1, an older PR that isn't woken is reselected every interval, and #43 is never read.
2. `we:scripts/lib/enqueue-on-event.mjs:61` — (failing-input, degraded) Invalid catch-up overrides discard valid platform settings.
   - Scenario: With platform={enabled:true,catchUp:{enabled:true,intervalMinutes:30}}, tool={catchUp:{enabled:12}} resolves catchUp.enabled to false from standard rather than retaining platform true. Likewise, tool={catchUp:{intervalMinutes:true}} resolves the interval to standard 10 instead of platform 30. Both were reproduced directly. The union validator accepts these wrong-leaf types during the cascade, overwriting the valid platform leaf; later validation falls back directly to standard. Invalid tool leaves should preserve the valid lower-layer value.
   - Claude's re-check: VALID.catchUp is a union (boolean or interval), so the cascade accepts 12 for 'enabled' and 'true' for 'intervalMinutes', and they override the platform values. The per-leaf check then rejects them and falls back to standard instead of the platform value. The code comment about the cascade rejecting values before the leaf check is consistent with this.

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
