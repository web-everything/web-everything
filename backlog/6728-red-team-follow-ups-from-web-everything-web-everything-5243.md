---
bornAs: xil27zd
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-precedents-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5243 (head a071fa330)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5243 (reviewed head `a071fa330d11d586a90942eb5af5349b809b17e3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-precedents-io.mjs:202` — (failing-input, degraded) Reason-only clearances become permanently unmatchable precedents
   - Scenario: Capture a sanctioned clear-human comment with reason 'The cache in 'we:scripts/lib/foo.mjs' never crosses a process boundary and is safe to reuse.' and no body-file text, then promote it. captureFromComment puts the reason in operatorWords and leaves body empty, but scope derivation reads only body. The resulting active precedent has empty paths, lenses and keywords. A Node probe confirmed matchPrecedents returns [] even for we:scripts/lib/foo.mjs with the identical reason as query text. Derive scope from the reason as well as the body so this supported clearance shape can be injected.
   - Claude's re-check: The clear-human capture puts the reason in operatorWords and leaves body empty. capturePrecedents derives scope only from capture.body, so paths, lenses and keywords are empty. matchPrecedents needs pathScore&gt;0.5 or keywordScore&gt;=1, so it never matches.
2. `we:scripts/lib/review-precedents-io.mjs:243` — (edge-case, degraded) Historical changes citations are attributed to an unreviewed commit
   - Scenario: On head H1, automation posts a changes verdict citing a precedent through buildVerdictComment; that producer emits no reviewed-sha marker for changes. Push repaired head H2 before the first record-citations run. The backfill assigns the H1 verdict to H2 using info.headRefOid, then preserves that incorrect assignment on subsequent runs. A probe also confirmed that an operator accept-ok decision on H2 produces a disagreement sample against this review that actually concerned H1. Resolve the historical reviewed head from reliable evidence, or exclude citations whose head cannot be established ins
   - Claude's re-check: For a changes verdict with no reviewed-sha marker, 'reviewed' is undefined. The head becomes 'recorded ?? info.headRefOid', i.e. the current PR head. The test pins this as '['changes', prHead]'. A changes comment from H1 backfilled after a push to H2 is therefore stored on H2, and later runs keep that head through 'recordedHead'.
3. `we:scripts/lib/review-precedents-io.mjs:242` — (edge-case, degraded) Short and full spellings of one historical head count as separate samples
   - Scenario: With an empty citation store, backfill two automation acceptance comments citing the same precedent: the older reviewed-sha is abcdef987 and the newer is abcdef9870000000000000000000000000000000. The current PR head is a different commit. Normalization only considers the same comment's previously recorded head and the current PR head, so these comments retain different citation ids. A Node probe confirmed foldCitations retains both and precedentAgreement reports pairs=2 for one PR/head/panel, contrary to the intended latest-seat folding. Resolve abbreviations consistently across the thread or
   - Claude's re-check: Head normalization only looks at the same comment's recorded head or the current PR head. A short sha and a full sha that are both unrelated to the current head stay as different strings. That gives different citation ids ('cite:repo#pr(at)head:seat'), so foldCitations keeps both, and precedentAgreement prefix-matches decisions against each, giving pairs=2.

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
