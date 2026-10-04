---
bornAs: xkv2931
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/broadcast-inject.mjs", "we:scripts/__tests__/broadcast-inject.test.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a test that spawns the script through a symlinked directory, or compare realpathSync(argv[1])… (from web-everything/web-everything#3833 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/broadcast-inject.mjs:243` — Add a test that spawns the script through a symlinked directory, or compare realpathSync(argv[1]) to the module path.
2. `we:scripts/broadcast-inject.mjs:96` — Add a check in the hook, with a test, that we:broadcasts.json is owned by the current uid and is not group/world-writable, plus a length cap on text. Longer term, have plateau-app sign records (HMAC with a key the lane agents cannot read) and have the hook verify the signature. Add the signature requirement to the security-lens checklist for any hook that injects file-sourced text into agent context.
3. `we:scripts/broadcast-inject.mjs:148` — Take over a stale lock by atomic rename to a unique name, or write a random token in the lock and re-read it before unlinking. Add a concurrency test that races two takeovers of a stale lock.
4. `we:scripts/broadcast-inject.mjs:160` — Add a deterministic concurrency regression test that pauses two contenders after observing a stale lock, then verifies that neither can remove the other's replacement lock or emit the same delivery concurrently; include it in the normal test gate.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3833@8216c33fc1e826b4e87637501fcf131beb30407a

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
