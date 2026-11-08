---
bornAs: xtfptpb
kind: story
size: 5
status: open
scope: ["we:scripts/apply-review-request.mjs", "we:scripts/review-set-label.mjs", "we:scripts/lib/review-independence.mjs", "we:scripts/lib/auto-land-seam.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Request actor and sessionId are self-declared; omitting sessionId turns the #2844 self-clear refusal into 'un…

Flow-sim gap R7b-G4, class K8 (authority asymmetry). Failing input: PR opened by session S (author stamp in PR body). Session S (or anything that can push to ops/review-requests) pushes we:10-accepted.json with actor='independent-reviewer' and NO sessionId. 'apply workflow runs the label CLI with CLAUDE_CODE_SESSION_ID deleted. Cited: we:scripts/apply-review-request.mjs:142-152, we:scripts/apply-review-request.mjs:185-190, we:scripts/review-set-label.mjs:1417-1431, we:scripts/lib/review-independence.mjs:261-270, we:scripts/lib/auto-land-seam.mjs:151. Soak-break sketch: Fixture: PR body with author stamp for session S; request {to:'accepted', actor:'x', no sessionId}. Action: apply main() with fake spawn and real decideClearerIndependence. Assertion that fails today: the request is refused (apply requires sessionId for `acce…

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
