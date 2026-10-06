---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/__tests__/vitest-shared-hermetic-git.test.mjs", "we:vitest.shared.ts", "we:./__tests__/vitest.shared.test.mjs"]
dateOpened: "2026-10-05"
tags: []
---

# Prevention — Add a worker-side assertion on process.env.GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM to the hermeti… (from web-everything/web-everything#4030 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/__tests__/vitest-shared-hermetic-git.test.mjs:7` — Add a worker-side assertion on process.env.GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM to the hermetic-git test (under both configs if it is included in both tiers).
2. `we:vitest.shared.ts:65` — Write to a per-pid temp file then renameSync atomically, or use a path under the run's private temp root (test-tmp-root) or include the uid in the name.
3. `we:vitest.shared.ts:67` — Add a check:standards rule that flags fixed-name `join(tmpdir(), '<literal>')` writes in shared test helpers. The helpers should use mkdtempSync, or a per-uid directory created with mode 0700 and verified with lstat. Optionally write to a temp name and rename it into place atomically, with flag 'wx'.
4. `we:vitest.shared.ts:71` — Publish the config atomically or use a private config per invocation, and add a deterministic concurrency test that pauses publication while another process reads the config and verifies the complete identity remains available.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4030@f192e20f20d12b913a1273a3fcd385c93824c065

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
