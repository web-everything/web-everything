---
bornAs: xdl4bm2
kind: story
size: 2
status: active
scaffoldedBy: "fix-5485"
dateScaffolded: "2026-10-21"
scope: ["we:scripts/lib/mandate-fence.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# fenceUntrusted: catch zero-width and look-alike characters inside fence tags

Found by the PR #5485 self-review. fenceUntrusted rewrites an embedded open or close tag (any case, inner whitespace) so quoted text cannot close its fence, but it does not normalise zero-width characters or Unicode look-alikes inside the tag. Fix: NFKC-normalise and strip zero-width/format characters before the tag match, or reject such tags. Test: a body holding a close tag with a zero-width joiner or full-width angle bracket stays inside the fence.

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
