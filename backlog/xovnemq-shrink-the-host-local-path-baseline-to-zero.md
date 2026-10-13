---
kind: story
size: 3
status: open
scope: ["we:scripts/settings/host-path-baseline.json", "we:scripts/conveyor/flows/", "we:skills-src/conveyor/launchd/"]
dateOpened: "2026-10-13"
tags: []
---

# Shrink the host-local path baseline to zero

Operator rule 2026-10-13: no host-local path is ever committed. we:scripts/lint-host-paths.mjs ratchets tracked files against we:scripts/settings/host-path-baseline.json (72 files at filing: flows, launchd plist examples, tests, fixtures, cards, reports). Replace each real home path with a name resolved on the host (env var or $HOME) or an obvious placeholder (/Users/x/), shrinking the baseline entry in the same commit, until the baseline is empty.

## Acceptance

- [A1] **Executable** — the `files` map in we:scripts/settings/host-path-baseline.json has 72 entries today and is empty after; `node` we:scripts/lint-host-paths.mjs stays green throughout.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not change the lint or its placeholder list (we:scripts/lib/host-path-scan.mjs); only removes debt.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: edits committed text only; no new input is parsed.
2. **Truncated reads** — n/a: the lint reads whole tracked files.
3. **Shared state files** — the baseline is shared; shrink each entry in the same commit as its file so concurrent PRs only conflict on their own lines.
4. **Fail closed** — a runtime path (plist example, flow) that needs a home dir resolves it from `$HOME` or an env var, never a guessed default.
5. **Identity scoping** — n/a: no identity involved.
6. **State over time** — the ratchet only shrinks; a stale entry fails the lint, so the baseline tracks the tree.
7. **Who wrote it** — n/a: no authorship decision.
