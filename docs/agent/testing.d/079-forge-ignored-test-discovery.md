## Forge ignored test discovery

Git ignores and Vitest discovery do not establish that a file is unused. A selected
`a.test.mjs` can import an ignored `b.test.mjs` even when filename filters, config excludes,
workspace selection or include patterns omit `b.test.mjs` from `globTestFiles(filters)`.
Static imports, re-exports, dynamic imports and imports through helpers all need the
dependency bytes at execution time. Discovery alone is insufficient evidence for omission.

Full and delta manifest admission therefore retain `ignored-test-file` local fallback for
every ignored test-shaped file outside dependency/Git internals. The independent filesystem
walk also refuses unshipped tests (`unshipped-test-file`) and ignored leaves projected into
test paths by tracked directory aliases (`unshipped-symlink`), including nested aliases.
No discovery result, argv, environment, warm base or retry exempts those checks. Until
dependency inclusion can be established, use local execution through heavy admission.
The refusal names the path; no remote prepare, transfer or execution follows it.

`forge-test-selection.mjs` remains a bounded diagnostic of test entry points, separate from
manifest admission. Its native child resolves the lane's Vitest and physical cwd, mirrors the
CLI environment prelude and closes discovery without running tests. Its 60-second SIGKILL
deadline, 4 MiB output bound and conservative error handling do not prove dependency closure.
Keep the real-Vitest regression showing that an ignored dependency executes despite being
absent from discovery, along with full/delta and pre-transport refusal tests for all import
shapes and the filesystem/alias checks. Invalid environments continue to retain manifest
refusal without launching discovery. Warm bases export tracked Git entries only, and policy
exclusions still refuse test-shaped entries.

A credential-named alias is refused like any excluded path. The one exemption is the
`.claude/agent-memory/` bridge's exact image of a tracked `agent-memory-src/` source-extension
file that itself passed the public-blob check; any other credential-named alias still refuses.
Full/delta memory-bridge regressions also require index membership, matching public and index
blobs, and matching working bytes. A deleted source contributes neither a source entry nor an alias.
Review each exemption conjunct against a named fixture or an explicit upstream invariant.
The projection's index, source-classification and source-entry checks repeat source-admission
invariants: a credential source must pass the public-blob checks before entering the projection
corpus. Do not claim independent mutation coverage for those redundant checks from a test
that already refuses at source admission.


