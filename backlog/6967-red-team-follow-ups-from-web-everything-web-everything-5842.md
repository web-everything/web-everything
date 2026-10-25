---
bornAs: xd1gv6o
kind: story
size: 2
status: open
scope: ["we:scripts/operations/judge-sweep-facts-io.mjs"]
dateOpened: "2026-10-23"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5842 (head 9af7a603e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5842 (reviewed head `9af7a603ec095b1b23ae71900e7d5e3f371daa85`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/judge-sweep-facts-io.mjs:90` — (failing-input, degraded) Valid findings on root-level files invalidate the entire verdict history
   - Scenario: Supply a trusted verdict produced by renderPanelComment containing one CONFIRMED finding on we:README.md:1 or we:package.json:1, plus a valid Net basis line. The corpus parser excludes paths without a slash, so the declared finding count mismatches and throws. Observed latestVerdict:null, openReferrals:null, and 'comment evidence unreadable or budget exhausted'. Adding a newer clean acceptance does not recover: mapping the historical verdict still throws. Valid root-file findings must parse, and an older parsing failure should not suppress independently readable current referral evidence.
   - Claude's re-check: demonstrated break
2. `we:scripts/operations/judge-sweep-facts-io.mjs:209` — (edge-case, degraded) A non-bearing observed ledger row reverses an existing acceptance
   - Scenario: Provide a trusted clean acceptance at 13:00 and normalized ledger rows for the same PR/head: accepted at 13:00, followed by observed at 13:01. At 13:02, the reader returns latestVerdict.accepted:false with no evidenceErrors. The canonical foldVerdictLedger still returns accepted because observed is explicitly non-bearing. Selecting the last verdict row without filtering non-bearing rows incorrectly manufactures a rejection; observed must leave the effective acceptance unchanged.
   - Claude's re-check: demonstrated break
3. `we:scripts/operations/judge-sweep-facts-io.mjs:90` — (failing-input, degraded) Canonical slash-qualified finding categories silently lose their defect class
   - Scenario: Use buildPanelFindings with a correctness finding whose category is fail-open, then publish it through renderPanelComment with a valid Net basis line. The canonical category becomes correctness/fail-open, whose findingDefectClass is fail-open. The reused corpus parser does not recognize slash-qualified group headings; the reader instead emits class:'unknown' and a key beginning '[null,' with no evidenceErrors. Reproduced with we:scripts/x.mjs:1. Preserve the full published category so defect classes and finding identities remain accurate.
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
