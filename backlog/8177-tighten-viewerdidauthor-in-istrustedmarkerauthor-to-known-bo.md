---
bornAs: xey6chx
kind: story
size: 2
status: open
scope: ["we:scripts/lib/marker-authorship.mjs", "we:scripts/lib/__tests__/marker-authorship.test.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# Tighten viewerDidAuthor in isTrustedMarkerAuthor to known bot and operator logins

Reinforce #6713/#6584 (audit residual, ruled R895+R903): we:scripts/lib/marker-authorship.mjs isTrustedMarkerAuthor trusts a comment when viewerDidAuthor is true even for an unlisted login, so every trusted-author shape in we:scripts/lib/accept-carry-forward.mjs inherits that bypass. Restrict the viewerDidAuthor path to AUTOMATION_LOGINS and OPERATOR_LOGINS and add a red-first test that an unlisted author with viewerDidAuthor=true is not trusted.

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
