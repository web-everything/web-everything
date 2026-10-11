---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4770 (head 5a5390508)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4770 (reviewed head `5a5390508d71b758535ac20d9d549df6d09943f2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/mechanical-round-cap.mjs:295` — (failing-input, degraded) Git-quoted filenames reject legitimate mechanical conflict resolutions.
   - Scenario: Resolve a conflict solely in café.txt, which both branches changed. With Git's default path quoting, the diff header is 'diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"', while --name-only emits '"caf\303\251.txt"'. Feeding these outputs through the source's injectable git reader returns proven:false, reason:'edits-outside-conflict-files', because pathOfHeader returns the entire quoted header instead of the filename. The equivalent ASCII-path control returns proven:true. Thus an eligible PR remains capped solely because its filename needs quoting. Decode Git paths consistently, including qu
   - Claude's re-check: pathOfHeader's regex needs 'diff --git a/'. A Git-quoted header starts 'diff --git "a/...', so it does not match and the whole header string is returned as the path. '--name-only' output is quoted ('"caf\303\251.txt"'), which does not equal that header string either. So 'changed' is never found in 'baseChanged', 'outside' is non-empty, and the result is proven:false with edits-outside-conflict-files. Nothing in the diff decodes quoted paths.

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
