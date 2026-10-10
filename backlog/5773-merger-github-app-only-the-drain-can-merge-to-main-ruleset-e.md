---
bornAs: x7hljd1
humanGate: { kind: setup, what: "operator creates the merger GitHub App and the main ruleset restricting updates to it" }
kind: story
size: 3
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Merger GitHub App: only the drain can merge to main (ruleset-enforced one writer)

Operator 2026-10-10: the drain gets its own GitHub App and is the ONLY identity allowed to merge to main. A ruleset on main restricts updates to the merger App (operator account kept as emergency bypass); with the GitHub merge queue (#4708/#4717) the same App is the only one that enqueues. Gains: least privilege (fixer/reviewer/builder identities can push branches but never merge), the one-writer-to-main statute enforced by GitHub instead of by convention, a separate API budget (core limit was exhausted 2026-10-10 20:25Z), one audit identity. Must also move the drain's direct main pushes (JIT numbering/resolve-on-land, today over the operator's SSH key) onto the App, or SSH stays a second writer. Identity switch is a setting (drain.identity: app-merger | app-shared | ssh) via the cascade with fallback. HUMAN GATE (setup): operator creates the App (contents:write, pull_requests:write, checks:read; installed on web-everything/web-everything) and the ruleset (App has no admin by design); agents then wire we:scripts/merge-ai-prs.mjs and the token shim. Done when: a merge by any non-merger identity is refused by GitHub on a test PR; drain merges and numbering pushes succeed as the App; health smell if the App token is missing.

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
