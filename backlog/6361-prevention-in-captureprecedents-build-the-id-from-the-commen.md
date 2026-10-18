---
bornAs: x9t0j4q
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/review-precedents-io.mjs", "we:scripts/lib/review-precedents.mjs", "we:scripts/lib/__tests__/review-precedents-io.test.mjs", "we:scripts/lib/__tests__/review-precedents.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — In capturePrecedents, build the id from the comment's own stable fields only (comment id or url p… (from web-everything/web-everything#5243 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/review-precedents-io.mjs:173` — In `capturePrecedents`, build the id from the comment's own stable fields only (comment id or url plus createdAt). Add a test that captures the same comment against two different `headRefOid` values and expects the second run to skip it.
2. `we:scripts/lib/review-precedents.mjs:64` — Add a check:standards rule or integration test requiring any event kind that changes what gets injected into a juror prompt to carry a verifiable attestation. Examples are a signed commit by an operator key or a required operator-only ref. Until then, `promote` should print the full pattern and rationale for confirmation.
3. `we:scripts/lib/review-precedents.mjs:112` — Have `promote` and `supersede` print the record being activated, and require `--confirm-hash=<sha of record>`. Add a fold test where a non-seed first write precedes the genuine seed. Use a content hash (sha256) in the id, or let a later exact-seed event win over a non-seed draft.
4. `we:scripts/lib/review-precedents-io.mjs:225` — Extract citations only from the structured finding fields. The card's CITE hook already plans `extractCitations` over verdict findings, so the comment-body backfill could be dropped or limited to the fixed footer. Add a matching test showing that a keyword present only in the PR body or diff cannot inject a `not-real` precedent without a path hit.
5. `we:scripts/lib/review-precedents.mjs` — Add a deterministic producer-to-capture regression test using buildVerdictComment with headSha and an ordinary body, then advance info.headRefOid and assert the captured source head and draft ID remain unchanged; prefer the producer marker before prose or current-head fallback.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5243@a071fa330d11d586a90942eb5af5349b809b17e3

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
