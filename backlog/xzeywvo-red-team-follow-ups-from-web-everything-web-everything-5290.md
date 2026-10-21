---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5290 (head 48da67c4b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5290 (reviewed head `48da67c4b0012a5e937ec962e41e413a4f73dbaa`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/gh-throttle.mjs:1809` — (failing-input, degraded) A text caller can corrupt cached bytes for subsequent callers
   - Scenario: Return UTF-8 log bytes for 'café\n' (636166c3a90a). Fetch the completed job log through runGhSync with encoding:'ascii', then fetch the identical args without encoding. The first call re-encodes its lossy decoded string into the shared cache; the second returns 63616643290a ('cafC)\n') instead of the upstream bytes. This sequence reproduced with the public runner using an in-memory filesystem and injected spawn. Store original bytes, or prevent decoded results from contaminating other encoding contexts.
   - Claude's re-check: With a non-buffer encoding such as 'ascii', result is a lossy decoded string. It is re-encoded with Buffer.from(result, encoding) and stored in a cache shared across encodings. A later caller with no encoding gets the corrupted bytes. The same applies to invalid UTF-8 under 'utf8'.

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
