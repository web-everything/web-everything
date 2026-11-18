---
name: "Lane→PR is the ONLY delivery for EVERY repo — shared tooling, never assume a repo lacks it"
metadata:
  node_type: memory
  type: feedback
---

**Every constellation repo (WE, Frontier UI, plateau-app) delivers edits ONLY via a lane clone →
ready-to-merge PR.** No direct-to-main, no per-repo exception. This sharpens rule 104 (edit-work runs in a
lane clone): it is universal, not WE-specific.

**The tooling is SHARED, not per-repo.** WE's `we:scripts/lane-pool.mjs` and `we:scripts/pr-land.mjs` operate
on ANY repo via `--repo=<path>` (`pr-land` resolves its `REPO` from `--repo`; the lane manifest carries
cross-repo `repos`). A repo having no `pr-land`/`lane` script in its OWN `plateau-app:scripts/` does **not**
mean it lacks the flow — the flow *is* the shared WE tooling. To use a repo's flow:
`node we:scripts/lane-pool.mjs acquire --repo=<repo> …`, work and **commit in that lane**, then record the
verification for the commit you just made —
`node we:scripts/operations/run.mjs verify --checkout=<repo> --json` (it shells `we:scripts/verify-lane.mjs`,
the only writer of the `.git/.lane-verify` marker) — and only then
`node we:scripts/pr-land.mjs --repo=<repo> …`.

**The verify step is not optional and it must come AFTER the commit** (#3321). `pr-land`'s finish-guard now
demands a fresh green marker by default, the marker is keyed to HEAD, and this arc lands from the lane clone —
where the marker *is* reachable, so the strict gate applies and a missing or stale marker is refused with
`unverified` (exit 3). A verify run before the commit is already stale by the time you land (#3212).

**The failure (2026-07-19):** I glanced at `plateau-app:scripts/`, saw no lane/pr-land script, and told the
user "plateau has none of the lane/PR tooling" — reasoning from *local absence* instead of the established
universal invariant (rule 104, which was loaded in my context). the operator: "I established lane as the only way to
deliver any of the repos … very important." A dangerous assumption — it could lead to bypassing the lane
guarantee (isolation / review / drain) with a direct-to-main edit.

**How to apply:** treat "lane→PR for every repo, via the shared tooling + `--repo`" as a hard,
non-re-derivable invariant — **never** conclude a repo lacks it from a `scripts/` listing. When unsure of a
repo's flow, verify via the SHARED tool's `--repo` support (`lane-pool list --repo=<repo>`), not per-repo
scripts.

**Meta-lesson (recurring this session):** when a loaded memory/invariant answers the question, **APPLY it** —
do not re-derive a contradicting conclusion from shallow local evidence. This was the second instance in one
session; the WE-boundary slip ([[we-standard-needs-reviewed-decision]]) was the first. Related:
[[repo-constellation]], rule 104 (edit-work runs in a lane clone).
