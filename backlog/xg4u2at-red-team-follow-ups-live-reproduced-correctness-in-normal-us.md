---
kind: story
size: 2
status: open
scope: ["we:scripts/backlog-placement-trial.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7269 (head 06f4cc949)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7269 (reviewed head `06f4cc94967e48f77344990b15a66377a9744879`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/backlog-placement-trial.mjs:58` — (failing-input, degraded) An incidental Everstandards reference overrides an explicit WE placement
   - Scenario: Classifying we:backlog/8636-reconcile-we-conformance-level-scales-and-stale-maturity-ref.md returns everstandards/unknown with high confidence. Its directive reads 'Placement: WE. Source: 'everstandards-format-2026-11-20' ...'. The parser searches the whole line for Everstandards before checking WE. Removing the Source sentence returns we. The explicit WE destination should remain authoritative when followed by a source citation.
   - Class: live-reproduced (basis: Observed by importing classifyCard in Node and passing the existing backlog card, then comparing its result with the source citation removed. No files were modified.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/backlog-placement-trial.mjs:32` — (failing-input, degraded) An invalid frontmatter closing delimiter produces a confident classification
   - Scenario: Input '---\nkind: story\n---not-a-delimiter\n# New intent block plug adapter' returns target we, rule score-we, confidence medium. The closing-delimiter regex accepts the prefix of '---not-a-delimiter', although the document has no valid closing frontmatter delimiter. It should return unsure with unreadable-frontmatter, as promised for unreadable frontmatter.
   - Class: live-reproduced (basis: Observed through a read-only Node invocation of classifyCard with this exact synthetic input.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break

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
