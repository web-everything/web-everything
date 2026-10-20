---
bornAs: xmrqq05
kind: story
size: 2
status: open
scope: ["we:scripts/lib/review-precedents-io.mjs"]
dateOpened: "2026-10-14"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5243 (head 245c40542)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5243 (reviewed head `245c4054295e6292e1e112f61da94b28ab888dea`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/review-precedents-io.mjs:234` — (failing-input, degraded) An escaped quotation overrides the actual reviewed-head marker during citation backfill.
   - Scenario: Build an accepted verdict for head 'a'.repeat(40), with body 'The previous review used &lt;!-- reviewed-sha: '+ 'b'.repeat(40)+' --&gt;. Fixed [precedent:prec-example].' The real builder escapes the quoted marker and appends the authoritative a-head marker. Passing this automation-authored comment to recordCitationsFromComments nevertheless produces a citation on the b-head: the regex takes the first bare 'reviewed-sha:' occurrence, including escaped prose. It should use the authoritative marker and attribute the citation to the a-head.
   - Claude's re-check: The regex /reviewed-sha:\s*([0-9a-f]{7,40})\b/i.exec(body) is not anchored to '&lt;!--' and takes the first match. Quoted or escaped prose before the real trailing marker therefore wins. The result is head = the b-sha, because reviewed is the 40-char b-sha and no recorded or PR head starts with it.
2. `we:scripts/lib/review-precedents-io.mjs:35` — (edge-case, degraded) Distinct repository names share a precedent file and inject each other's records.
   - Scenario: precedentGitPath('a-b/c') and precedentGitPath('a/b-c') both return 'review-precedents/a-b-c.jsonl'. Using the in-memory stage seam, append and legitimately promote a precedent for a-b/c, then readPrecedents for a/b-c. The second repository receives the first repository's active record; withPrecedents injects it on a matching query. Repository storage identities must remain distinct.
   - Claude's re-check: precedentGitPath collapses '/' and whitespace to '-', so 'a-b/c' and 'a/b-c' both map to review-precedents/a-b-c.jsonl. foldPrecedents and readPrecedents do no repo filtering. validRepo allows hyphens in both parts. The other repo's active record is therefore returned and injected.
3. `we:scripts/lib/review-precedents-io.mjs:161` — (edge-case, degraded) A future-dated direct citation pins the reported verdict despite subsequent writes.
   - Scenario: Append source-less citationEvent records for the same repo, PR, head, seat and precedent: first verdict='accept', at='2099-01-01T00:00:00Z'; then verdict='changes', at='2026-10-14T12:00:00Z'. Both appends report rows:1, but readPrecedents still returns only accept. Append-time clamping is temporary; readPrecedents folds the original future timestamp, which outranks subsequent honest occurrences. The advertised clock-skew recovery should also prevent direct citations from pinning agreement results.
   - Claude's re-check: Direct citations are stored with their original 'at'. The two rows have different verdicts, so their event ids differ and each append reports rows:1. readPrecedents calls foldCitations without clampFutureStamps. evidenceTime for a source-less row is its 'at', so the 2099 accept stays strictly newer than the 2026 changes row and keeps winning.

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
