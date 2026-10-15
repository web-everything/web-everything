---
bornAs: xfbvhyj
kind: story
size: 3
status: active
scaffoldedBy: "fix-5273"
dateScaffolded: "2026-10-14"
scope: ["we:scripts/lib/review-escalation.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention: route every trusted-comment builder's non-constant text through one marker neutralizer

PR #5273 security finding: we:scripts/conveyor/human-surface-repark.mjs interpolated raw PR file names into a comment posted by the trusted account, so a file name could forge reviewed-sha and cleared-human markers that the trusted-author parsers count. Fixed there with a percent-encoding neutralizer. Owed prevention: move that neutralizer to a shared lib, add a check:standards rule that every builder posting through the trusted account routes non-constant text through it, and a property test that parseLatestHumanClearedSha and the park marker regexes find only markers the builder itself emitted. Also add a soak scenario for a foreign review:human hold added after a clearance (the PR #5273 heal now proves label ownership from label events).

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
