---
bornAs: xcmo9wr
kind: story
size: 3
status: open
scope: ["we:scripts/lib/repo-slug.mjs", "we:scripts/operations/land-human-only.mjs", "we:scripts/operations/__tests__/repo-slug-alias.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Operations match a checkout when the repo slug and origin differ

Live: land-human-only --repo=web-everything/web-everything, run from lane-10 (origin chalbert/web-everything), refused with "no checkout of web-everything/web-everything to read the pinned diff from". record-referral-ruling needed --repo=chalbert/web-everything too, while the needs-you feed prints web-everything/web-everything. Fix: resolve the slug through GitHub's canonical name or a renamed-repo alias, so either slug matches the checkout; the needs-you pick: line prints a slug that works. Related: 5058, 5503. [A1] Executable: node --test we:scripts/operations/__tests__/repo-slug-alias.test.mjs, where both slugs resolve to the same checkout.

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
