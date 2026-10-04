---
bornAs: xj3sqro
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lane-drain.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Drain numbers with code older than what the same pass just merged

Live 2026-10-03: PR #3806 fixed the drain's soak-citation rewrite scope, merged at 18:24:03Z. The same drain pass then ran JIT numbering for #3809's cards at 18:24:42Z on its pre-#3806 code. Commit 2efe1dc3b rewrote the soak fixture HASH again and turned main red a third time (fixed by PR #3828). Fix: when a pass merges a PR that changes the drain's own code (we:scripts/lane-drain.mjs, we:scripts/merge-ai-prs.mjs, we:scripts/lib/), the numbering step runs from the freshly merged main (re-exec), or is deferred to the next pass. Done when: a test proves numbering after a self-modifying merge uses the new code; a soak break replays 2efe1dc3b.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
