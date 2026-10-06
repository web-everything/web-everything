---
bornAs: x3r79dp
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/we-scan-cache.mjs", "we:scripts/lib/__tests__/we-scan-cache.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a lint or standards rule that every spawn() in scripts/lib attaches child.on('error', ...). A… (from web-everything/web-everything#4143 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/we-scan-cache.mjs:128` — Add a lint or standards rule that every spawn() in scripts/lib attaches child.on('error', ...). Add a test that runs startBackgroundBuild with PATH lacking nice and cargo.
2. `we:scripts/lib/we-scan-cache.mjs:118` — Write a failure marker (key plus timestamp) in the cache dir on a failed or refused build, and have startBackgroundBuild skip while it is fresh. Add a test for the repeated-miss case.
3. `we:scripts/lib/we-scan-cache.mjs:42` — Build from a pristine export of origin/main (`git archive origin/main scripts/rust-scan | tar -x` into a temp dir, with --target-dir in the cache) instead of the working tree, so unkeyed files cannot enter; add a test that plants build.rs/.cargo/config.toml in the working tree and asserts the published binary's build did not read them. Alternatively hash the whole crate dir excluding target/.
4. `we:scripts/lib/we-scan-cache.mjs:116` — In resolveSharedWeScan, return null when referenceFiles is empty (fail toward JS), plus a unit test for that case; a lint rule flagging `.every(` over a possibly-empty collection used as a trust predicate is a heavier alternative.
5. `we:scripts/lib/we-scan-cache.mjs:171` — Build from an isolated snapshot of the validated source and add a deterministic test that changes the original checkout during the injected build, verifying that the published binary still comes from the validated snapshot.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4143@04f500d7d110484e4a1815ad9e2c03da9ab0aad2

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
