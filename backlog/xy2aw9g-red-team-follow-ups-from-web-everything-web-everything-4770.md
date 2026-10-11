---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/mechanical-round-cap.mjs"]
dateOpened: "2026-10-11"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#4770 (head de9c73a33)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#4770 (reviewed head `de9c73a33b759b9bd62a9e91ca453ba3ed073eb9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/mechanical-round-cap.mjs:299` — (failing-input, degraded) Git-quoted filenames falsely disqualify valid mechanical conflict resolutions.
   - Scenario: Resolve a conflict solely in café.txt, a file changed by both the PR and its merged base. With Git's default quoting, the patch header is 'diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"', while --name-only returns '"caf\303\251.txt"'. pathOfHeader does not recognize the quoted header and returns the entire header as the filename. The probe returned proven:false, reason:edits-outside-conflict-files, with that header in outside. An exhausted PR consequently loses its promised mechanical review. Both representations should resolve to the same filename and prove this round mechanical.
   - Claude's re-check: pathOfHeader's regex needs 'a/' right after 'diff --git ', so a quoted header ('"a/caf\303\251.txt"') falls through and returns the whole header line. '--name-only' returns the quoted path, so the two never match. The header lands in 'outside' and the round is 'proven:false' unless the net diff is identical.

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
