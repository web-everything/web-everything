## Pinned-hook checkout roots

Pinned guard code must resolve operated-checkout paths through `scripts/lib/hook-root.mjs`,
independently of its source location. The launcher sets `WE_HOOK_ROOT` to the real Git toplevel
of its cwd; an unresolvable root denies. Keep direct-execution checks and resource imports tied
to `import.meta.url`. Direct calls retain the script-parent root.
`scripts/hooks/__tests__/hook-root.test.mjs` probes primary/lane protection, seeded daemon
paths and lint scope through the real launcher using isolated primary/worktree fixtures under
`TMPDIR`. The launcher tests execute the configured settings wrapper from linked worktrees
and clone lanes with replaced lane launchers and guards, proving dedicated-clone execution,
lane-root propagation and fail-closed denial when clone evidence is missing or incomplete.
Private scripts revisions and the sync/publication mutex protect delayed imports during
scheduled reset/clean; their lifetime is the owning guard invocation.

The launcher requires an empty porcelain status (including untracked files), HEAD equal to
`refs/remotes/origin/main`, and, when `WE_GUARD_ORIGIN` is set, an exact origin URL match.
All Git calls and the child guard receive an environment with every `GIT_*` variable removed;
other environment variables survive. Sync removes working-tree write bits after publication
and restores owner write access before refresh. Permissions discourage edits; launcher checks
remain mandatory. Launcher/sync tests cover dirty tracked and untracked files, divergent or
missing main refs, origin mismatches, hostile Git overrides and read-only refresh/late imports.


