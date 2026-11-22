# Saved conflict repairs

`resolved-side-branch.mjs` is pure. Its branch evidence contains a ref name, exact tip,
and bounded complete ancestry (tip included). The PR carries exact head and current base
tips. Only this PR's `lane/*-fix-<PR>-*` refs count. The unique descendant of all eligible
tips wins; divergent tips require operator inspection. Dates never choose a repair.

`resolved-side-branch-push.mjs` discovers saved remote refs (the fixer brief already pushes
the alt ref), proves ancestry in a disposable bare repository, and pushes the pinned SHA
with the owner's fresh App installation token. The planner emits `resolved-side-branch-owed`
instead of a fixer; unreadable, oversized or ambiguous evidence holds dispatch and names
operator inspection as the fallback. A daemon tick scans at most eight PRs per repo;
operators can inspect/reduce the held inventory and let the next tick retry. Inventories
of 100 PRs, over 16 matching refs, or over 32,768 ancestors refuse rather than truncate.

`fix.pushResolvedSideBranch` defaults on. It resolves standard → platform →
`scripts/settings/fix-resolved-side-branch.json` → `WE_FIX_PUSH_RESOLVED_SIDE_BRANCH=on|off`.
The daemon logs the value and source, and runs this pass before dispatch and question notes.
Unreadable/invalid settings disable writes. Planner suppression remains in effect when the
push switch is off; turning it off never restarts a fixer over an already-saved repair.

Push success is read back before the observational dedupe record/event is written.
No persistent record authorizes a push: strict ancestry against the live head makes retries
stateless. A crash after push cannot replay that same SHA as a strict descendant. The
daemon also suppresses fixer launch for that exact pushed head for the rest of its tick.
The next head is evaluated by the existing gate/review machinery. This pass never edits
gate results, review labels, stand-down markers, waivers or human clearance, and never
declares verify green. A human-only workflow/test-gaming/red-team hold remains a merge hold.

After a durable stand-down question is posted, the CLI and daemon note publisher emit
`fix-question-asked` through `daemon-events.jsonl` (shared `appendDaemonEvent`). It carries
repo, PR, head and `detail.needsYou=true`. This distinct kind reaches watches filtering
`fix-stood-down`, `status:needs-you` and `drain-skip:conflicting`; monitor configuration
outside this repo needs no edit. Failed question publication emits no question event.

Merge-path checklist answers and negative probes (tests in `__tests__/resolved-side-branch*.test.mjs`):

1. Producer identity: push credentials come only from the owner-bound App cache. Status
   or comment success cannot authorize this push or clear a gate. Personal-token negatives
   refuse before any child call; question events are emitted by the actual publisher.
2. Missing evidence: missing exact base, ancestry, claim result or token refuses. Missing
   input and unreadable scan tests pin the operator fallback.
3. Ordering: ancestry only; reversed/absent timestamp and divergent-tip tests.
4. Races: API reads before preparation, immediately before write, and after push. Tests
   move the head before/after write and at Git's advertisement boundary.
5. Head binding: full 40-hex throughout; a trusted pre-push hook checks the advertised
   old oid, new oid and destination ref. Plain push then uses the server's ordinary CAS.
   Short/newline SHA and moved-fetch tests refuse, with no force fallback.
6. Round binding: no verdict, hold or clearance is carried. The real workflow gate test
   proves old-head human clearance cannot clear the new head.
7. Catches: scan/credential/push failures refuse; no exception produces allow. The
   unreadable and failed-push tests assert no push/state respectively.
8. Write ordering: effect, readback, record. Failed-push and changed-readback tests
   assert no dedupe record.
9. Crash windows: no gate is opened, even if record writing dies after push. The crash
   test retries at the new head without another push.
10. Credentials: no personal fallback, gh auth-token call, stored helper or inherited PAT.
    Cache-missing and both personal-token formats have negative tests.
11. Environment: fresh bare repo, fixed system git/PATH, empty system/global config,
    no replace/lazy objects or commit graph. Every fetched SHA is verified. The transport
    test plants hostile environment/config and checks the actual command producer.
12. Exemptions: no label or policy can waive ancestry or a merge hold. Different-PR,
    force-needed and new-head workflow-hold tests.
13. Liveness: no fixer code or verification child runs here; a live fix claim refuses.
    The held/unknown-claim negatives prevent racing an active author.
14. Simplicity: no retry loop, force push, carry, acceptance marker or new gate bypass.
    The crash test exercises the stateless alternative; the daemon soak checks order
    and preserves a new-head workflow hold.
