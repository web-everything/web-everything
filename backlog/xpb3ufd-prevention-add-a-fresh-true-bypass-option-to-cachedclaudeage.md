---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/dispatch-lane-io.mjs", "we:scripts/lib/lane-salvage.mjs", "we:scripts/lib/claude-agents-cache.mjs", "we:scripts/lib/build-queue-cache.mjs", "we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/lib/__tests__/lane-salvage.test.mjs", "we:scripts/lib/__tests__/claude-agents-cache.test.mjs", "we:scripts/lib/__tests__/build-queue-cache.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a fresh: true / bypass option to cachedClaudeAgents. Add a test that primes the cache and ass… (from web-everything/web-everything#3995 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#3995's review (reviewed head `0d0a51d9c10f2f4a4b9da037f41263def056722c`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/operations/dispatch-lane-io.mjs:3255` — Add a `fresh: true` / bypass option to `cachedClaudeAgents`. Add a test that primes the cache and asserts that stop-then-verify callers bypass it. A lint gate could require every `cachedClaudeAgents` call site to declare `readAfterWrite` explicitly.
2. `we:scripts/lib/lane-salvage.mjs:130` — Give destructive or fail-closed callers an explicit uncached path (`fresh: true`), and add a test pinning that the salvage gate bypasses the cache. Document the TTL staleness contract at the helper.
3. `we:scripts/lib/claude-agents-cache.mjs:16` — Put the cache directory in a per-user state home, or create it with mode 0o700 and verify lstat owner === getuid() and not-a-symlink before reading or writing. Share one `ensureOwnedCacheDir()` helper between the two caches. Add a standards lint that flags `tmpdir()`-derived paths read as trusted input.
4. `we:scripts/lib/lane-salvage.mjs:130` — Add a `fresh: true` option to `cachedClaudeAgents` that bypasses the cache, and use it from destructive-path callers. Add a test asserting that `readAgentsStrict` and the reaper paths always call fetch. Alternatively, add a standards check that any caller labelled fail-closed does not use the cached path.
5. `we:scripts/lib/build-queue-cache.mjs:17` — Add a deterministic regression test that sets one file's mtime into the future, edits another existing file, and requires the key to change; fingerprint each file's metadata.
6. `we:scripts/lib/lane-salvage.mjs:130` — Require a fresh agent listing before authorizing salvage and add a deterministic test that warms an empty cache, introduces a live agent, and verifies salvage is refused.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
