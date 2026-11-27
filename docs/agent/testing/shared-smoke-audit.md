## Shared smoke evidence and ownership

`scripts/lib/__tests__/daemon-rebuild-shared-smoke.test.mjs` has one named audit
regression per finding. The checkout cases use private local Git repositories
and isolated configuration; no GitHub or host lane probe runs in those fixtures.

A cache hit still returns a current smoke result. The optional `runEnvironment`
port must invoke the ordinary smoke runner with code-only reuse, retaining all
lane, authentication and reachability checks and refusals. Without that port,
the hit runs full smoke. Stored evidence never supplies the current verdict.

Tracked harness regular files are bound by their actual bytes as well as Git's
diff. Tracked symlinks and submodules conservatively disable shared reuse;
operators can run ordinary smoke rather than attempting to bind external code.
Candidate verification rejects hidden index flags and compares actual regular
file bytes and executable modes against HEAD, independently of porcelain status.
Untracked `node_modules` remains dirty; only the verified ignored symlink is allowed.

All lock mutations share a short atomic directory mutex. Reclamation, heartbeat
and release quarantine the observed directory and verify its inode and complete
owner again before mutation. A replacement is restored intact. A held mutation
mutex is never reclaimed by age: followers run full smoke at their existing wait
bound. After a crashed mutation, an operator must verify no writer remains before
removing the abandoned `.guard` directory; inspect preserved quarantine paths if
restoration failed. The audit regression covers this bounded fallback too.
