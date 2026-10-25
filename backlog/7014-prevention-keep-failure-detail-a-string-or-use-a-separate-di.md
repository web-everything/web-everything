---
bornAs: xj5jyv6
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Prevention — Keep failure detail a string, or use a separate diagnostic field. Then assert the detail type per… (from web-everything/web-everything#5839 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/operations/codex-job.mjs:200` — Keep failure `detail` a string, or use a separate `diagnostic` field. Then assert the `detail` type per stopReason in the failures table test.
2. `we:scripts/operations/codex-job.mjs:260` — Write task files with flag 'wx' (exclusive create, no symlink follow) or use mkdtemp-based paths outside the lane; add a write-gate lint that flags writeFile into worker-writable directories without an exclusive-create flag.
3. `we:scripts/operations/codex-job.mjs:353` — Add a helper that strips userinfo from URLs before they go into plan, detail or log output, plus a test using an origin with embedded credentials. Longer term, a standards rule banning raw remote URLs in emitted JSON.
4. `we:scripts/operations/codex-job.mjs` — Add a deterministic regression test named 'replaces a base symlink leaf without modifying its referent' in we:scripts/operations/__tests__/codex-job.test.mjs; assert the referent remains unchanged and the published entry is a regular file containing the audited bytes.
5. `we:scripts/operations/__tests__/codex-job.test.mjs` — Add a deterministic regression test supplying system/global/command and local/worktree helpers together, then assert that every publication Git invocation includes only the permitted helpers.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5839@e697b10fcfe8a6542a59459067916d22b819e4aa

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
