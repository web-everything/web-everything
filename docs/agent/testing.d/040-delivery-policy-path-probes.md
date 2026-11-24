## Delivery policy path probes

All worktree delivery-policy sources and journal IO use `resolveTrustedConfigPath` in
`scripts/lib/delivery-policy.mjs`. Canonical allowed bases may resolve platform aliases;
symlinks below those bases are refused, including parents whose targets stay inside the base.
Use its `beforeRead` hook to swap a leaf or directory after validation: reads/appends must
refuse the swap or retain the originally validated inode. The fd's device/inode and size
are checked before IO, and reads are bounded even if a concurrent writer grows the file.
Cache hits still check paths; the existing mtime-based content cache remains intentional.

Explicit journal redirects must stay inside the working directory, daemon state, or the
configured logs root. Fixtures should put journals under their isolated daemon state.
Invalid policy sources retain defaults (or the protective failsafe) with warnings; journal
failures remain best effort (empty reads, skipped writes). Journals reaching the 1 MiB source
limit require operator rotation before further reads/appends. Regression home:
`scripts/lib/__tests__/delivery-policy.test.mjs`.

Policy defaults use a code-owned runtime import allow-list (currently empty).
Check source before bundling, generated output after bundling, and the exact bytes at
the runtime import boundary. Computed imports, template specifiers (including plain
templates), concatenation, unlisted literals, `import.meta`, and dynamic code constructors
must be refused. Type-only imports are erased; strings and comments are inert data.
The `policy runtime import allow-list` tests pair an approved literal with isolated
refusals at both scan and runtime boundaries. Keep each refusal independent of unrelated
forbidden syntax so a second guard cannot mask a regression.

Journal append tests cover exclusive lock creation, owner-token checks before writes and
release, and size checks after acquisition. A stale lock with a live or unknown PID must
remain held. Competing stale removers must serialize through the same generation guard
as normal release, then recheck ownership; an abandoned generation guard requires
operator cleanup after checking that no writer is active. Preserve the synchronized
two-writer tests, including the case with capacity for only one more record.

