## Forge tracked-symlink parity

Forge projects stage-0 index symlinks to regular files; it never ships or follows a
symlink during transfer. The link's working bytes must hash to its index blob OID,
all parent and target directories must be real directories, and the target
must stay inside the repository and contain tracked content. This rule applies to
every path, including the memory and skills bridges. Untracked, changed, unmerged,
escaping or incomplete links refuse with `unshipped-symlink`. Cyclic projections
also refuse; expanding links share the walk's count/byte limits and report
`manifest-walk-limit` when those limits are exceeded.

Apply the path policy to every projected leaf, including nested aliases and normalized
`node_modules` components. Excluded aliases refuse with `unshipped-symlink` in full
and delta builds. Only the exact `.claude/skills/` and `.claude/agent-memory/` prefixes
are exempt from the dot-directory exclusion; their remaining path components still
must pass policy. The named policy-excluded tracked-alias table includes credential,
dot-directory, NFKC and invisible-character variants and checks refusal before transport.

Manifest refusals keep the reason code separate from `detail`: the offending path
relative to the checkout, decoded as lossy UTF-8 and kept on one line. Preserve
this detail through verification wrappers and remote fallback; heavy admission
logs it with the shared `oneLine` sanitizer and bound.

Symlink-detail fixtures must use valid manifest byte paths: invalid UTF-8, tabs,
ESC, DEL and Unicode line separators can exercise lossy decoding and sanitization,
but LF/CR are rejected by `pathParts` before the inventory symlink check. Keep
separate negative cases for LF/CR that assert rejection before filesystem inspection.

Projected entries retain their regular `sourcePath` and link evidence for staging
reverification. Delta manifests always transfer projected leaves, including unchanged
ones: their alias paths have no corresponding regular Git blob for digest assembly.
Keep the full/delta filesystem oracle, negative admission cases and staging-swap
case in `forge-manifest-parity.test.mjs`, plus the real manifest/stager/worker fixture
in `remote-exec.test.mjs`. Run these and the affected fast-manifest/offload suites
through the host heavy-admission queue.

