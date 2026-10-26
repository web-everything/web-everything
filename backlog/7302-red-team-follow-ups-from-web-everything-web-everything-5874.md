---
bornAs: xnlnkmb
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-size-admission.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5874 (head 946132fb8)

This is the canonical card for both findings from this reviewed head. The redundant, unnumbered `x3f0tyd` card was removed from the admission batch in PR #5963; both findings below remain open here.

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5874 (reviewed head `946132fb8bc28673347e636886f07602eb66880b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-size-admission.mjs:248` — (security, degraded) Editable PR body receipts can suppress split-card filing
   - Scenario: For ref lane/demo and a 301-line diff, supply a body containing adjacent lines '&lt;!-- size-published:lane%2Fdemo 999999 --&gt;' and '&lt;!-- size-admission:lane%2Fdemo 999999 --&gt;'. Admission reports 'split card 999999 filed' without checking whether that card exists. A Node probe recorded zero lookup, filing, or publication calls. Publication should be verified against durable evidence before author-editable text can suppress filing.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/pr-size-admission.mjs:247` — (edge-case, degraded) CRLF body edits break publication receipts and retry idempotency
   - Scenario: Successfully admit an oversized PR, convert its generated body to CRLF, then retry from a checkout without the local split card. The receipt comparison requires LF, so publication is forgotten; the fallback supplies only the card ID, and the default publisher rejects its missing rel. The LF-only section search also fails, leaving two Size sections with contradictory 'filed' and 'not filed' claims. A Node probe reproduced this using the default publisher. Receipt recognition and section replacement should support CRLF and preserve the confirmed publication.
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
