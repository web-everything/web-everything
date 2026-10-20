---
bornAs: xjb4egq
kind: story
size: 2
status: open
scope: ["we:scripts/lib/agy-review-juror.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5260 (head ba4c0897c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5260 (reviewed head `ba4c0897c11261c31102c9280a50a4816dd295cb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/agy-review-juror.mjs:349` — (edge-case, degraded) Filesystem-root paths do not overlap any watched checkout
   - Scenario: Reproduced through the runner's injectable ports: modify a shared tracked file and supply an errored list_dir update with parameters={DirectoryPath:'/'}. The runner returns status='ok'; naming the checkouts' immediate parent correctly returns 'voided'. inside(path, '/') tests for a '//' prefix, so '/' overlaps neither the checkout nor its changed files. The changed file lies beneath the explicitly named directory and should trigger the shared-change guard.
   - Claude's re-check: A path of '/' canonicalizes to '/'. inside(x, '/') checks startsWith('//'), so overlaps('/', checkoutRoot) and overlaps('/', changedFile) are both false. A named '/' therefore never overlaps a changed shared path, though naming the parent directory does. This is a real root-path bug in the overlap check.

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
