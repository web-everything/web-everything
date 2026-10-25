---
bornAs: xj96r7b
kind: story
size: 2
status: open
scope: ["we:scripts/lib/lane-pool-salvage-push.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5859 (head ae1d9db01)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5859 (reviewed head `ae1d9db01d17b0bed4a004824e5c54a08e685115`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/lane-pool-salvage-push.mjs:122` — (edge-case, degraded) Salvage rejects ordinary configuration in the trusted primary checkout
   - Scenario: Configure remote.upstream.url or a repository-local credential.helper in the primary checkout, then release a lane containing an unpublished commit. remoteSha runs checkTransportConfig in repo.referencePath, where the lane-only whitelist rejects that ordinary primary configuration. Salvage returns 'failed' before pushing; release still drops the lease, and automatic recovery cannot reclaim the unpublished lane. A read-only probe of the exported implementation reproduced both refusals, with an origin-only control passing. The trusted primary's legitimate configuration should not be classified a
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
