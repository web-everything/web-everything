---
bornAs: x6qjlvh
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-precedents-io.mjs", "we:scripts/lib/review-precedents.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5243 (head e5ed9cb74)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5243 (reviewed head `e5ed9cb7460f813bb24a07fcde2dfebd357668ec`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-precedents-io.mjs:234` — (failing-input, degraded) An escaped SHA example overrides the real reviewed-head marker
   - Scenario: Backfill a trusted automation comment containing '✅ review — accepted\nLiteral example: &lt;!-- reviewed-sha: deadbee --&gt;\n[precedent:prec-probe]\n&lt;!-- reviewed-sha: abcdef123 --&gt;', with headRefOid='abcdef123'. The probe records head='deadbee': the regex matches the first bare reviewed-sha substring, including escaped prose. This misattributes or drops agreement evidence. It should read the actual authoritative marker, yielding abcdef123.
   - Claude's re-check: The reviewed-sha regex is unanchored and takes the first match. 'reviewed-sha: deadbee' inside the escaped prose matches before the real marker. No full SHA starts with 'deadbee', so head falls back to 'deadbee' and is recorded as such.
2. `we:scripts/lib/review-precedents-io.mjs:36` — (edge-case, degraded) Distinct repository names share a precedent transport file
   - Scenario: Store and legitimately promote a precedent for acme/widgets-ui, then read the library for acme-widgets/ui on the same board transport. Both accepted repository names map to review-precedents/acme-widgets-ui.jsonl. An in-memory transport probe showed the second repository reads the first repository's active precedent and withPrecedents injects it when its path matches. Repository storage identities should be collision-free.
   - Claude's re-check: precedentGitPath maps both 'acme/widgets-ui' and 'acme-widgets/ui' to review-precedents/acme-widgets-ui.jsonl. readPrecedents folds every event in the file without filtering by source repo, so one repo's active precedent is visible to the other.
3. `we:scripts/lib/review-precedents.mjs:158` — (edge-case, degraded) A future timestamp permanently outranks corrective direct citations
   - Scenario: Append a source-less citationEvent for one repo/PR/head/seat with verdict='accept' and at='2099-01-01T00:00:00Z'. After correcting the writer's clock, append the same citation identity with verdict='changes' and at='2026-10-13T12:00:00Z'. Both appends report rows=1, but foldCitations still returns accept. The append-time future-stamp clamp does not change persisted bytes, and reads fold the original future timestamp. The later correction should supersede the anomalously stamped row rather than leaving agreement pinned to accept.
   - Claude's re-check: A source-less citation is ranked by its own 'at' in evidenceTime. foldCitations reads the persisted rows unclamped, so the 2099 accept stays newer than the later 2026 changes row. The two ids differ by verdict, so both append (rows=1 each). The append-time clamp only affects the staleness and withdrawal view, not the fold.

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
