---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/file-class-policy.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7426 (head 9151131bb)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7426 (reviewed head `9151131bba41f6e0b6911900845f177cbb9aa042`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/file-class-policy.mjs:52` — (failing-input, degraded) A missing pinned preset silently removes its restrictions
   - Scenario: Create preset P with a bot-owned we:secret.json row and writers:[], then policy p with preset:{uri:P.id,digest:digestOf(P)}, rows:[], and unmatched:'source'. Call recordOnly with chain:[p], a valid head/change, and we:secret.json modified. Omitting presets produces verdict:'pass' with no findings; supplying presets:[P] produces fail/not-writer. An unresolved pinned dependency should reject the input or produce unknown, rather than evaluate without its restrictions.
   - Class: live-reproduced (basis: A read-only Node probe reproduced both results through recordOnly. The demonstrated impact is incorrect recorded evidence; no live merge authorization was exercised.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/file-class-policy.mjs:85` — (edge-case, degraded) Renaming out of an append-only namespace bypasses removal detection
   - Scenario: Use a policy with unmatched:'source' and a logs/** append-only row. Supply a renamed file with path:'we:public/log.json', previousPath:'we:logs/log.json', and entries before containing key a and after empty. recordOnly returns pass with no findings because it classifies only the destination. The protected source path has lost its entry and should produce removed-entry, or the unsupported rename evidence should produce unknown.
   - Class: live-reproduced (basis: A read-only Node probe observed the renamed file classified as unmatched source and the evaluation passing. This affects record accuracy in the current record-only implementation.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/file-class-policy.mjs:99` — (failing-input, degraded) Malformed build results are accepted as successful rebuilds
   - Scenario: Define x-lock as committed:true, pr:'any', writers:'builder', unit:'file', and assign we:lock.json to it. Supply we:lock.json modified and builds:[{row:'we:lock.json',outcome:'error'}]. recordOnly returns pass with no findings. The branch recognizes only absent, unknown, and fail outcomes, so every other value supplies apparent success. Malformed or unrecognized outcomes should be rejected or recorded as unknown.
   - Class: live-reproduced (basis: A read-only Node probe reproduced pass through recordOnly despite the build outcome being error. No successful rebuild evidence was supplied, and no production gate was invoked.)
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
