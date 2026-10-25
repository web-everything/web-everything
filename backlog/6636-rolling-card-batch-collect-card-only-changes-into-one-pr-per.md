---
bornAs: xafcvmh
kind: story
size: 8
parent: "4703"
status: open
scope: ["we:scripts/operations/land-prevention-card.mjs", "we:scripts/operations/card-batch-file.mjs", "we:scripts/operations/card-batch-io.mjs", "we:scripts/lib/card-batch-policy.mjs", "we:scripts/lib/raised-by.mjs", "we:scripts/lib/card-batch-settings.mjs", "we:scripts/operations/__tests__/land-prevention-card.test.mjs", "we:scripts/operations/__tests__/card-batch-io-real.test.mjs", "we:scripts/lib/__tests__/card-batch-policy.test.mjs"]
dateOpened: "2026-10-20"
tags: []
---

# Rolling card batch: collect card-only changes into one PR per window

Extend rolling admission to existing-card edits and raised-by sidecars. The prevention writer currently batches only a new card without mentions; eligibility also refuses modified cards and nested paths. Ordinary new filings already have a documented batch route. The proposal to cover prepares and every hand writer needs the routing and fallback rulings below before implementation; #5196 overlaps new-filing integration, not the existing-card merge contract.

## Acceptance

Run each criterion after adding its named regression cases (red before, green after). Queue helper, from the repo root:

```bash
q=we:scripts/readiness/heavy-admission.mjs
prove() { node "${q#we:}" run -- npx vitest run "${1#we:}"; }
```

- [A1] **Executable** — `prove we:scripts/operations/__tests__/land-prevention-card.test.mjs`: add regressions for mention-only and mixed new-card/mention writes: all eligible changes enter one admission, retries preserve one contribution per source, and no change disappears on refusal. Routing and fallback expectations await the rulings below.
- [A2] **Executable** — `prove we:scripts/lib/__tests__/card-batch-policy.test.mjs`: add eligibility cases for modified cards and validated raised-by sidecars; refuse malformed/incomplete change lists, traversal, symlinks, deletion, and any non-card source, docs, config, data or test path.
- [A3] **Executable** — `prove we:scripts/operations/__tests__/card-batch-io-real.test.mjs`: add real bare-origin races: concurrent edits preserve both raised-by contributions, duplicate sources add nothing, conflicting prose refuses rather than overwrites, and sealing freezes membership while the next window accepts writes.

## Non-goals

- [N1] No post-approval merge grouping (#6532), automatic resolution of conflicting card prose, or weakening of review/red-team gates.

## Edge cases this change must handle

1. **Untrusted text** — Treat card prose as data; validate paths and sidecars before staging, never interpolate prose into shell commands.
2. **Truncated reads** — An incomplete diff or unreadable card cannot prove card-only eligibility; refuse admission without dropping the pending write.
3. **Shared state files** — Keep lease/token and expected-head protection; union only raised-by records, not arbitrary prose.
4. **Fail closed** — Refuse non-card paths and unsafe edits; do not silently select between spooling and individual-PR fallback (ruling below).
5. **Identity scoping** — Deduplicate by source repo/PR/head and target card within the selected batch kind; do not collapse equal card numbers across repositories.
6. **State over time** — Retried appends remain idempotent; sealed batches never reopen; preserve count/age settings and their source logging.
7. **Who wrote it** — Carry source repo/PR/head and writer into batch membership. Local CLI only: HTTP body caps, CSRF and origin checks are n/a; existing lease waits and count/age bounds remain, and retries cannot reset a sealed window.

## Grounding

- we:scripts/operations/land-prevention-card.mjs:623 gates batching on no mentions; :640 spools failed admission unless disabled.
- we:scripts/lib/card-batch-policy.mjs:86 admits only added top-level regular cards.
- we:scripts/operations/card-batch-io.mjs:60 uses token-owned leases; we:scripts/lib/raised-by.mjs:2 exports the union helper.
- we:skills-src/file-item/SKILL.md:80 already documents new-card batch routing.

## Open questions

Readiness blocked: should review-generated prevention changes ride their source PR or a batch? Should transient admission failure spool (current behavior) or open an individual PR? Does “one batch” combine filing/prevention kinds, and which prepare/hand-writer entry points become mandatory participants? These choices affect isolation, recovery and the acceptance oracle; do not infer them from the PR-count observation.
