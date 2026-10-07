---
bornAs: xlr5p8a
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/pr-comment-read-guard.mjs", "we:scripts/lib/__tests__/pr-comment-read-guard.test.mjs"]
dateOpened: "2026-10-06"
tags: []
---

# Prevention — Add a fixture test that mixes a paginated and an unpaginated read in one file and asserts one fin… (from web-everything/web-everything#4166 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/pr-comment-read-guard.mjs:50` — Add a fixture test that mixes a paginated and an unpaginated read in one file and asserts one finding. Alternatively, match pagination within a few lines of the read, or inside the same function.
2. `we:scripts/lib/pr-comment-read-guard.mjs:23` — Scan statement-joined text (multi-line argv arrays) or use an AST pass. Add a test case for a split-line `--json` / `comments` array and for the paginated GraphQL reader. A comment-read allowlist keyed on `pageInfo` would remove the `we:pr-state-io.mjs` false positive.
3. `we:scripts/lib/pr-comment-read-guard.mjs:50` — Scope the paginate check to the same call or a few adjacent lines. Add a mixed-file fixture test asserting the unpaginated read is still counted.
4. `we:scripts/lib/pr-comment-read-guard.mjs:33` — Strip `//` line comments before looking for `/*`, or use a real tokenizer such as acorn. Add a fixture test with `/*` inside a `//` line followed by a bare read.
5. `we:scripts/lib/pr-comment-read-guard.mjs:47` — Add a deterministic mixed-request regression test requiring the bare comment endpoint to remain flagged when another request uses pagination, and restrict pagination exemptions to the corresponding request.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4166@ec5862267f1ce2d9250c5a570aa1b85883503c69

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.
