# Saved conflict repairs — normal lane verification

Bare transport is discovery only. The writer reuses load-flake reverify IO to prepare
the saved ref, acquire a build lane, check its exact SHA, and run verify-lane with
the sanitized verification environment. Host-load deferral, red or unreadable verify,
or unreadable admission publishes a stand-down and fix-question-asked; no fixer is
relaunched. A green result permits only a normal, non-forced git push FROM that lane,
with the repository's complete pre-push hook chain. Hooks are never replaced or disabled.
The normal push guard additionally checks the advertised destination SHA against the
expected PR head. A lane with missing, changed or obsolete hooks requires operator
inspection; the writer never installs a private hook to get past that refusal.
After verification and immediately before transport, read the lane's complete effective
Git configuration, including worktree settings and includes. Refuse URL rewrites,
credential sources, proxies, transport commands, URL-shaped remote aliases and other
unsafe lane configuration; never silently scrub it to make the push pass. Unknown,
unreadable, truncated or oversized configuration requires operator inspection. The App
credential helper is scoped to HTTPS on github.com so another host cannot request it.

Promotion also needs a complete App-authored stand-down/alt record binding this PR's
exact branch and full SHA, bounded ancestry containing current head and base, an open
same-repository PR headed under lane/, and head-bound verification/CI admission.
Missing verification records trigger normal verification, even with pushBeforeGate
enabled: a saved ref has no live early-push waiter. Previous-head CI uses the normal
fixPushGate and configured timing policy; unknown evidence refuses. Known
load-flake repairs remain owned by the retry-limited load-flake worker. This limits
the feature deliberately rather than weakening either existing rule.

The injectable write protocol acquires the fixing and dispatch claims, rechecks
inside the claim, prepares transport, persists the exact repair handoff and carries
unanswered questions BEFORE pushing, then rereads open/head/base immediately before
and after the write. A successful push remains pushed-unrecorded if readback or
recording fails. A pending head-bound handoff suppresses old findings after a crash
and lets the existing rearmPushedFixes worker re-arm for review. Carrying a question
never carries an acceptance or human clearance. Writes use only an owner-bound App
token; GitHub calls pin the real executable, github.com, a clean environment, and
personalRoute=false on each throttled call.

Scans rotate under the daemon's existing phase budgets, PR cursors and adoption
yield. Only actually unreadable scans hold a PR; unscanned PRs retain their ordinary
reconciliation. A full 100-PR inventory, over 16 saved refs, over 32,768 ancestors,
or an exhausted shared API budget requires operator inspection. The shared reconcile
pass supplies evidence to both fixer and ci-heal consumers.

Merge-path checklist: producer identity is the shared marker-authorship login list,
with exact record bindings; missing signals refuse; comment sequence (not dates)
closes a repair round; claims and live rechecks protect read/write races; all writes
bind full head/base SHA and PR; handoffs bind source head, repair SHA and branch;
unknown inputs refuse; success recording follows the effect; pending protection
precedes it; no personal credentials or hostile environment reach transport; no label
waives admission; no child runs concurrently with an unowned claim. The simplest
safe hook and verification fallback is refusal, with the existing guarded workers
as the operator-visible recovery path. Negative probes for all sixteen audit items
live in resolved-side-branch*.test.mjs.

Question publication still emits fix-question-asked only after the comment succeeds.
No merge-gate, waiver, acceptance or human-clearance result is changed by this pass.
