---
bornAs: xwpgmwh
kind: story
size: 3
status: active
scaffoldedBy: "fix-5485"
dateScaffolded: "2026-10-21"
scope: ["we:scripts/operations/deliver-item-wrapper.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Pin wrapper net-diff base to a daemon-read sha, not the lane's origin/main

Found by the PR #5485 self-review. computeLaneDiffStats (deliver-item-wrapper) resolves origin/main inside the builder's lane, which the builder can write. An update-ref of refs/remotes/origin/main, a replace ref or a shallow graft can make the merge-base equal HEAD, so the net diff is empty and the statute/policy-core park falls back to the self-reported file list. The self-review diff and pr-land net-diff reads share the same trust. Fix: read the base sha from the daemon's own checkout and pass it in; set GIT_NO_REPLACE_OBJECTS=1 in the hardening env. Test: a lane whose origin/main ref points at HEAD still parks review:human on a statute path.

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
