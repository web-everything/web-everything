---
kind: story
size: 2
status: open
scope: ["we:scripts/guard-bash.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5455 (head 6966e639e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5455 (reviewed head `6966e639e5aeab2279d3fc83e33cd6590b23f442`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/guard-bash.mjs:474` — (failing-input, degraded) Shell redirections bypass foreground delegation
   - Scenario: With WE_ORCHESTRATOR_SESSION=1 and no worker markers, submit 'node we:scripts/operations/run.mjs verify&gt;/dev/null' or '&lt;/dev/null node we:scripts/operations/run.mjs verify'. Both hook probes exit 0 with empty stdout, whereas the command without redirections produces a delegation denial. Bash probes with a stub node confirmed both inputs invoke exactly 'we:scripts/operations/run.mjs verify'. headWords does not separate shell redirections from executable arguments, allowing the long verification command to block the orchestrator. Both inputs should require delegation.
   - Claude's re-check: normalize() uses headWords on the segment and requires exact word equality. 'verify&gt;/dev/null' stays one word, and a leading '&lt;/dev/null' becomes words[0]. The diff's own heredocInterpreter rewrite (headWords to shellTokens) shows headWords doesn't strip redirects, so neither input matches and delegation is skipped.
2. `we:scripts/guard-bash.mjs:537` — (failing-input, degraded) Escaped quotes in a double-quoted here-string hide executable commands
   - Scenario: With orchestrator mode enabled, submit 'bash &lt;&lt;&lt; "node \"we:scripts/operations/run.mjs\" verify"'. The hook exits 0 with empty stdout. The here-string scanner passes the backslash-escaped quotes directly into its recursive parser, although the outer shell removes those escapes before supplying stdin. A Bash expansion probe produced 'node "we:scripts/operations/run.mjs" verify'; feeding that text to Bash with a stub node confirmed the verification argv. Decode the outer double-quote escapes before scanning the executable stdin script so this command requires delegation.
   - Claude's re-check: The here-string operand token text goes straight into matches() recursion. The diff does nothing to unescape double-quote backslashes first. Inner '\"we:scripts/operations/run.mjs\"' then fails the basename/word equality, so the delegation is missed. The claim names a concrete input and probe results.

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
