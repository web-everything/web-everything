---
kind: story
size: 2
status: active
scaffoldedBy: "fix-5439"
dateScaffolded: "2026-10-16"
scope: ["we:scripts/lib/red-team-gate.mjs"]
dateOpened: "2026-10-16"
tags: []
---

# red-team-gate readers miss records inside a verdict-carry comment

When `carryAcrossRebase` moves a verdict, `we:scripts/operations/review-job.mjs` posts ONE comment: every carried
gate marker, then the verdict-carried marker, then the re-keyed red-team body. The readers in
`we:scripts/lib/red-team-gate.mjs` are anchored to the start of a comment, so `redTeamForHead` never sees the
carried result and `gateOutcomesForHead` sees only the first carried gate marker. `redTeamQueueReason`,
`redTeamRulingNeeded` and `applyRedTeamGate` therefore misread a carried head. PR #5439 fixed the drain's enqueue
hold locally (`we:scripts/lib/drain-queue-safety.mjs#threadRecords`); move that split into the gate module so
every reader shares it.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/lib/__tests__/red-team-gate.test.mjs`: a carried body
  built exactly as the review job builds it (two gate markers + carried marker + re-keyed result) is read by
  `redTeamForHead` and both gate outcomes are reported by `gateOutcomesForHead`; fails before, passes after.

## Non-goals

- [N1] Changing the carry body's layout in the review job — readers adapt to it, so old carried comments stay readable.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — split only a comment whose verdict-carried marker parses; each split part keeps the comment's author for the trust check.
2. **Truncated reads** — n/a: pure readers over the comments they are given.
3. **Shared state files** — n/a: no state written.
4. **Fail closed** — a carried body with no red-team marker yields only its gate parts; nothing is invented.
5. **Identity scoping** — every split part still matches only its own `pr=` and `rev=`.
6. **State over time** — split parts keep the carry comment's thread position, so ordering checks see them at the carry time.
7. **Who wrote it** — untrusted carry comments stay ignored (`isTrustedMarkerAuthor`).
