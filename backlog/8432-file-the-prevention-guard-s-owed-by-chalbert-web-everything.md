---
bornAs: x3hxr6i
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:agent-memory-src/process-rules-as-configurable-policy.md", "we:backlog/4364-drafts-belong-to-their-author-no-generic-fix-ci-heal-on-a-dr.md", "we:backlog/4365-automatic-postmortem-on-every-merge-conflict-a-conflict-a-sc.md", "we:backlog/4366-prevent-prs-that-open-with-red-ci-local-pre-flight-mirrors-e.md"]
dateOpened: "2026-09-28"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2872's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:agent-memory-src/process-rules-as-configurable-policy.md:8` — Add a check:standards rule that resolves any 'checklist item N' or memory-link item-number reference against the target file's actual numbered items. Failing that, a plan-review lens item: 'cited artifact exists on main today'.
2. `we:backlog/4364-drafts-belong-to-their-author-no-generic-fix-ci-heal-on-a-dr.md:157` — Plan-review lens item: for every 'the loop already has X' claim, quote the line where X is bound in scope. The build-time guard is the card's own Task 3 test (d): a no-PR claim must not refresh, so a gate on `why === null` fails it.
3. `we:backlog/4364-drafts-belong-to-their-author-no-generic-fix-ci-heal-on-a-dr.md:152` — A rule requiring every explicitly named safety guard or failure branch in a design doc to have a corresponding test case in the proof plan.
4. `we:backlog/4365-automatic-postmortem-on-every-merge-conflict-a-conflict-a-sc.md:183` — A rule requiring complex logical reductions described in a design to have an explicit fixture verifying the reduction's behavior.
5. `we:backlog/4366-prevent-prs-that-open-with-red-ci-local-pre-flight-mirrors-e.md:435` — A checklist item requiring any design modification that introduces a new behavioral branch to also introduce a corresponding test fixture.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2872@e024ec03468eb68ed077df1528a3318e632f1b5d

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
