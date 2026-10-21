---
bornAs: xf9ssun
kind: story
size: 2
status: open
scope: ["we:scripts/lib/tests-first-policy.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5501 (head 0324572de)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5501 (reviewed head `0324572dee9b0b22317d5918dbd812d5e8898d48`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/tests-first-policy.mjs:23` — (failing-input, degraded) Malformed object settings silently remove red-first instructions
   - Scenario: Set repository or platform build.redFirst to {"enabled":true}. A Node probe returned value.redFirst={enabled:true}, invalid=[], and removed the FIRST-commit rule from the actual delivery template. The cascade validates nested boolean leaves instead of rejecting the object; applyTestsFirstPolicy then fails its ===true check. Malformed overrides should be rejected and retain the enabled boolean default.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/tests-first-policy.mjs:50` — (edge-case, degraded) Published build refs can bypass the first-commit advisory
   - Scenario: Verify a published build branch named lane/1234-fix-socket in a checkout without a conveyor-delivery lease, with an implementation-only first commit. This matches the lane/&lt;item&gt;-&lt;slug&gt; ref published by we:delivery-agent-brief.md step 8. Probing redFirstWarning returned null after only reading the branch; it never inspected commits. The same input with branch lane/1234-build-fix-socket produced the expected warning. Recognize actual published build refs rather than requiring a -build suffix.
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/tests-first-policy.mjs:37` — (edge-case, degraded) CRLF templates retain explicitly disabled instructions
   - Scenario: Read we:delivery-agent-brief.md with CRLF line endings, as a core.autocrlf=true checkout can produce, and apply a policy with redFirst=false. A probe using the actual template converted to CRLF retained 'FIRST commit must contain only new or updated acceptance tests'. The regex requires an immediate LF after the opening marker, so it leaves the entire disabled section untouched. Accept CRLF or normalize line endings before processing policy sections.
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
