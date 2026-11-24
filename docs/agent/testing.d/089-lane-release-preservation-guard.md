## Lane release preservation guard

`lane-pool release` checks HEAD and every local branch against the branch tips the pool's canonical
origin lists right now (`ls-remote` checked against the primary checkout and run outside any repository, so a
helper planted in the primary after the check never runs; `ops/*` excluded) after known-litter
cleanup and salvage. No local `refs/remotes/*` ref is proof: stale, forged and symbolic-alias tracking
refs all still refuse. A listed tip the lane has not fetched triggers one hardened fetch before refusing.
That fetch is object-only: it writes into a fresh `refs/release-verify/<nonce>/*` namespace (no
`FETCH_HEAD`), which it deletes again without dereferencing, so it never writes a lane-controlled ref.
A symbolic ref under `refs/remotes/origin/` other than the ordinary `origin/HEAD` alias refuses before
any fetch (the salvage fetch too), and if any local branch, the stash or HEAD moved during the fetch,
release refuses naming the ref instead of recomputing the proof.
Each snapshotted ref kind has a named mutation scenario: a branch moved or deleted, a detached HEAD moved,
HEAD switched to a twin branch, and the stash moved or dropped. The snapshot also records every stash reflog
entry, so dropping an older entry while the tip stays refuses too (its own row). Rows whose move hides the work
then release with no fault, so only the movement check kept it; the other rows still refuse on that retry.
An unresolved origin or an unreadable listing refuses; every named pool in a fixture therefore needs
its primary checkout (a sibling of the reference) so release can resolve that origin.
The listing checks the primary's config with a primary-only rule: ordinary extra remotes (`upstream`, a fork)
and operator auth/signing keys pass; URL rewrites (`insteadOf` / `pushInsteadOf`) and any remote named like the
canonical origin URL still refuse. Salvage transport (`fetchHeads`, `push`, `remoteSha`) keeps the stricter lane rule.
Tracked changes are read with `--ignore-submodules=none`, and assume-unchanged / skip-worktree entries
are compared by executable mode and content, so index flags and submodule-ignore config cannot hide an edit
or a chmod. Past 1000 flagged entries the check fails closed; flagged links and gitlinks are reported, never trusted.
Every evidence read drops inherited git config env first (`GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT/KEY/VALUE`,
global and system config), so a caller's `core.fileMode=false` cannot hide a chmod. Tests pass such env through
`runPool`'s `extraEnv`. The refusal's preservation command pushes to the canonical origin URL, not the lane's
own `origin` remote, which the lane can rewrite.
Known limit: other entries still trust the index stat cache, so a lane that hand-rewrites `.git/index`
with stat fields matching an edited file reads clean. Release does not refuse that shape yet; the
bounded content check is #8143. Tests must not promise refusal for it until that lands.
A lane whose `.git` is not a real directory, carries a `.git/commondir`, or does not resolve its git dir and
common dir to its own `.git` refuses before any release work (config scrub, litter cleanup, salvage push,
evidence reads): those redirect refs, objects and config to another repository, so every later step would
read or write the wrong one. `--discard` does not override it; it is listed with `reason: 'git-dir-redirected'`.
Its tests also run with recovery on, with an ahead commit and litter present, and assert no salvage ref, no
salvage record and the litter kept; a control case shows the same spy sees an un-redirected lane's salvage.
The 1000-entry hash bound is pinned by tampering only the last, then only the first, of exactly 1000 flagged
entries (each refuses by name), and by 1001 flagged entries failing closed.
Untracked files deliberately do not block release: the guard covers tracked changes only.
URL-based salvage may leave no tracking ref: only its verified
remote SHA is an additional exclusion, and unrelated local branches still block release. Tests that
intentionally release tracked edits or unpreserved commits must pass `--discard` explicitly; `--force`
only overrides ownership. Unreadable or oversized Git evidence keeps the lease and names manual
inspection or deliberate `--discard` as the operator fallback.
A work refusal exits 1, names each kept lane in `--json` (`kept: [{ pool?, lane, reason: 'unpushed-work', details }]`)
and journals a loud `release-refused` line. A failed card save does the same with `reason: 'card-salvage-failed'`;
a lane hold stays exit 0 (it journals `hold-refused`) but is listed with `reason: 'held'`. Tests pin the exit code,
the `kept` list and the journal line. Callers that ignore the exit code (the drain's release-on-land,
a launch-failure un-reserve, the reaper) do not yet read `kept`; that caller-side work is #8142.
Canonical-origin isolation fixtures must assert refusal and an unchanged lease when the owning pool's
origin is unresolved. Reclaim fixtures with rejected salvage must first assert that reaper release
refuses, then explicitly discard the lease to exercise reclaim on unpreserved work. The card-filer soak
likewise checks that unreadable status keeps the lease before testing a deliberate discard.

