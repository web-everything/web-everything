---
kind: story
size: 2
status: open
scope: ["we:scripts/ci/prune-actions-caches.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7451 (head 5aae2cd28)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7451 (reviewed head `5aae2cd28369752374489c36f5eb6464ec72e21d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/ci/prune-actions-caches.mjs:118` — (edge-case, degraded) Immediate usage verification falsely fails successful cleanup because GitHub usage statistics lag behind deletions.
   - Scenario: Start with three 1.7 GB overlays for the same ref/language and one 0.1 GB npm cache. Run --apply --verify-acceptance. Deleting the two older overlays leaves 1.8 GB and preserves npm, but the usage endpoint can still return the previous 5.2 GB. The script exits 1 and marks the scheduled workflow failed. A read-only probe with mocked API responses reproduced this exact result. Verification should account for delayed statistics or calculate usage from the refreshed cache inventory.
   - Class: correctness-in-normal-use (basis: [GitHub documents] (https://docs.github.com/en/rest/actions/cache#get-github-actions-cache-usage-for-a-repository) that repository cache usage refreshes approximately every five minutes and may take at least five minutes to update. The workflow checks immediately after deletion. The failure was reproduced locally with mocked responses; no live GitHub mutation was performed.)
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
