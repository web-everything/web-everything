---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/lib/change-evidence/record.mjs"]
dateOpened: "2026-11-22"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, live-reproduced, theoretical-race, attacker-same-user] from web-everything/web-everything#7319 (head ca6f5f23e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7319 (reviewed head `ca6f5f23e07dbc1ba8d6a1516d69086acfa55d4d`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:8217` — (failing-input, degraded) Single-repo drains outside WE attribute merges to the WE repository
   - Scenario: Run the drain with --this-repo in frontierui. resolveRepos produces null repository entries, which reach this hook without localSlug. The writer defaults them to web-everything/web-everything, then collects the same-numbered WE PR instead. This either leaves the actual merge uncovered or writes evidence for an unrelated merge. The repository identity should resolve to the drain's localSlug.
   - Class: correctness-in-normal-use (basis: The --this-repo path explicitly returns null. An injected-IO probe of the actual writer confirmed that merged item num=123, repo=null becomes a persisted incoming identity for web-everything/web-everything. No filesystem writes were performed.)
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/change-evidence/record.mjs:49` — (edge-case, degraded) A newer unfinished CI attempt can leave tested and overall verdicts passing
   - Scenario: Supply a successful required test run with id=1 and a newer same-name run with id=2, status=in_progress, conclusion=null, started_at=2026-11-21T11:59:00Z and completed_at=null, for a merge at 12:00:00Z. The completed_at filter discards run 2 before selecting the highest ID, so the builder reports tested=pass and overall=pass using run 1. The newer unfinished attempt should make tested unknown.
   - Class: live-reproduced (basis: Direct buildChangeEvidence probes reproduced the pass with both the shipped fixture and a minimal complete input. The existing incomplete-attempt test retains a non-null completed_at, which misses this input.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
3. `we:scripts/lib/change-evidence/record.mjs:118` — (edge-case, degraded) A same-second label removal is reported as approval still present at merge
   - Scenario: Supply a trusted review:accepted labeled event followed by a higher-ID unlabeled event, both timestamped 2026-11-21T10:00:01Z, before a 12:00:00Z merge. The strict timestamp comparison ignores the removal and records presentAtMerge=true, approved=pass and overall=pass. Event ordering should recognize the later removal and produce approved=fail.
   - Class: live-reproduced (basis: Direct builder probes reproduced this with the shipped fixture and a minimal input. Moving only the removal timestamp one second later correctly changed approved and overall to fail, isolating the timestamp-equality defect.)
   - Also class: theoretical-race
   - Claude's re-check: demonstrated break
4. `we:scripts/lib/change-evidence/record.mjs:42` — (edge-case, degraded) Post-merge editing of a pre-merge revocation resurrects earlier acceptance
   - Scenario: After valid acceptance, add a trusted changes-requested comment created at 2026-11-21T11:30:00Z before a 12:00:00Z merge. Edit its explanation at 12:01:00Z. Backfill drops the entire revocation because updated_at is after merge, then reports reviewed=pass from the older acceptance. The unavailable historical comment body should make review evidence unknown rather than restore acceptance.
   - Class: live-reproduced (basis: Direct builder probes returned reviewed=unknown for the unedited revocation and reviewed=pass after changing only updated_at to after merge. The fixture mutation also produced overall=pass when its approval label remained present.)
   - Also class: attacker-same-user
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
