---
bornAs: x9otabd
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-worker.mjs", "we:scripts/operations/__tests__/codex-worker.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a snapshot test over a repo with an initialized submodule, so any gitdir-resident config the… (from web-everything/web-everything#4016 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/codex-worker.mjs:330` — Add a snapshot test over a repo with an initialized submodule, so any gitdir-resident config the wrapper trusts must be in the fingerprint set. Alternatively, refuse any baseline gitlink at lane acquire.
2. `we:scripts/operations/codex-worker.mjs:478` — Run verify under a scrubbed environment (no push credentials), or in a sandbox, until the post-verify guard has passed. Document in the wrapper header that the guard is a content boundary only. File this as a backlog item for the pilot's graduation criteria.
3. `we:scripts/operations/codex-worker.mjs` — Add a deterministic orchestration regression test that leaves an allowed file dirty during verification and asserts publication is refused, with the success fixture reporting a clean working tree after commit.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4016@6fca7b6162b35006af6639988d2f4c3bbb6a93de

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
