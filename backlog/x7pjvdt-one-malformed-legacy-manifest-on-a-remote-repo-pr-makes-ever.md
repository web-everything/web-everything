---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# One malformed legacy manifest on a remote-repo PR makes every drain pass 'incomplete context' and defers ever…

Flow-sim gap R9c-G1, class K4 (poison record halts a whole pass). Failing input: Open PR in frontier-ui/plateau-app whose PR body has no lane-manifest block and whose head tree has we:.lane-manifest.json containing conflict markers or a trailing comma (a fixer or rebase edited it). Other open non-WE PRs carry no manifest (normal impl/orphan PRs). Drain pass reads the PR; gh contents API returns 200 with the… Cited: we:scripts/merge-ai-prs.mjs:5044-5053, we:scripts/merge-ai-prs.mjs:2144, we:scripts/merge-ai-prs.mjs:2147, we:scripts/merge-ai-prs.mjs:2063-2095, we:scripts/merge-ai-prs.mjs:2710-2711. Soak-break sketch: Fixture: two non-WE open PRs, A has a head-tree we:.lane-manifest.json = '{'item':12,'; B has none (gh stub returns 404 for B). Action: run buildCarrierHealth/reduceOpenPrContext + planLabelDrain via readRemoteManifestViaApi with a stub exec returning A's byt…

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
