---
bornAs: x7okl89
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5549-worker-contract-s3a-unified-wrapper.md", "we:scripts/operations/worker-result-router.mjs", "we:scripts/operations/__tests__/worker-wrapper.test.mjs", "we:scripts/operations/__tests__/worker-result-router.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Add a lint or standards rule for backlog cards. Each "Edge cases this change must handle" line th… (from web-everything/web-everything#4439 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5549-worker-contract-s3a-unified-wrapper.md:33` — Add a lint or standards rule for backlog cards. Each "Edge cases this change must handle" line that makes a guarantee must name a test file or test case, or say n/a.
2. `we:scripts/operations/worker-result-router.mjs:33` — Restore `@` only when the path matches a strict `node_modules/@scope/` shape. Add a test that a hostile `/@user` in scope and transcriptPath is still defanged. A write-gate cannot decide this, so a unit test is the guard.
3. `we:scripts/operations/worker-result-router.mjs:301` — Add a per-session or per-role sub-cap (or rate limit) on new drafts, and take a store-level lock around the cap check. Add a test where one session floods the cap and a second session still gets a draft. File this as a backlog item for the 114 drafts store.
4. `we:scripts/operations/__tests__/worker-wrapper.test.mjs:338` — Add a deterministic test in we:web-everything/scripts/operations/__tests__/worker-wrapper.test.mjs named 'caps bytes read when the result file grows after fstat'; instrument the filesystem seam and assert total bytes requested/read never exceeds maxBytes + 1 and overflow is refused.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4439@24a7366b7ecc46f017774fef372d296a19074146

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
