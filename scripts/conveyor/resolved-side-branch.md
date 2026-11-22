# Saved conflict repairs — push-only fixer launch

Read-only, bounded discovery in `resolved-side-branch-io.mjs` supplies the planner
with saved refs and ancestry. Detection requires an exact automation-authored alt
record, a full SHA, ancestry containing the current PR head and base, and one
unambiguous newest repair. Unreadable evidence, over 16 refs, over 32,768 ancestors,
or divergent repairs refuses both push-only and full-resolution launches and calls
for operator inspection. The scan rotates at most eight PRs and shares a 128-call
API budget. Unscanned PRs are distinct from unreadable evidence.

For a saved repair the planner emits `kind: fix` with `pushOnly: { branch, sha }`.
The normal `dispatchFix` launch owns claims, heartbeat, verification, self-review,
hooks and token handling. Its brief pins the saved ref/SHA and permits pushing
only to that PR's own safe `lane/*` head. It forbids new conflict work, repairs,
rebases, forced pushes and review-state changes. The launcher owns its existing
capped pre-review check; this mode adds no second self-review loop. Verification
failure stands down for operator inspection, never a full re-resolve in that round.
Conflict and previous-round resume paths are excluded so old repair instructions
cannot replace the push-only brief.

Active load-flake holds retain their existing retry-limited worker ownership and
refuse fixer launches before push-only admission. A saved SHA already owned by that
worker also cannot restart its retry allowance after a closed or exhausted attempt;
operator inspection is required. A closed historical hold for a different saved SHA
does not block unrelated push-only work. Use the shared hold readers, including
their legacy/abbreviated-SHA handling, rather than treating producer evidence as admission.

The automation-authored alt record is also a durable, exact-head review handoff.
Once the PR head equals its full saved SHA, the normal planner owes independent
review before another fix, even with unchanged labels/comments and after the saved
ref is deleted or no longer scanned. Only a later trusted review whose structured
producer evidence covers that exact full SHA consumes the handoff. Re-arms, older
heads, abbreviated/quoted evidence and untrusted comments do not consume it. Normal
claim, liveness, draft, referral and CI gates still apply. If a review gate requires
new repair work, refuse for operator inspection instead of launching a full fixer.
The push-only task changes no review label or acceptance and adds no custom writer.

`fix.pushResolvedSideBranch` retains its existing cascade and environment key but
now enables the push-only fixer task. Its effective value/source is logged by
reconciliation. Disabled or unreadable policy refuses saved repairs without falling
back to full resolution. There is no custom daemon writer phase or privileged push IO.

No merge permission, hold, acceptance, label clearance or human clearance is
carried by detection or dispatch. The new head still faces the normal merge gate.
Stand-down carry-over remains in `stand-down.mjs`; successfully posted questions
still emit `fix-question-asked`, including the daemon notes path.

The named merge-path checklist is in `resolved-side-branch.test.mjs`, bounded
read-only probes in `resolved-side-branch-discovery.test.mjs`, and the behavior soak
in `resolved-conflict-push-only.soak.test.mjs`.
