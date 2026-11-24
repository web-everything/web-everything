## Forge manifest reuse

`forge-fast-manifest.test.mjs` compares Git-based reuse with a full byte manifest and spies on
file reads. Git status is not sufficient byte evidence for filters, encodings, index flags,
or concurrent writes: hash those leaves normally, and use fresh stat/mode and base blob-size
checks before reuse. Also bind the warm SHA-256 to verified base Git blob bytes: a dirty
warm snapshot followed by a same-size clean reversion must hash the current leaf. Blob
read failures trigger full scans; blobs above the reader limit use normal leaf hashing.
Outside dependency/Git internals, ignored test-shaped files force local fallback, including
files under wholly ignored build directories: Git ignore evidence does not prove exclusion
from the test runner. The named
`refuses runnable scripts/build tests ignored by …` cases cover `.gitignore` and
`.git/info/exclude` for full and delta manifests; `remote-exec.test.mjs`'s
`falls back before transport for a whole-directory ignored test` table pins remote refusal.
Run this fixture and the affected Forge tests through heavy admission.

`forge-manifest-parity.test.mjs` checks full and delta inventories against an independent
filesystem oracle, including hostile `GIT_*` environments, omitted tests, memory bridges,
and replaced file identities. Mutation proofs remove each binding or walk guard separately
and restore it before the next run. Transport fixtures must ship every test-shaped leaf
they create; exact rsync lists and dependency-cache digests include those leaves. Keep
fixture-only Git metadata outside the worker snapshot (or remove it after client manifest
construction), since the runner rejects extra directories.

Stub SSH reachability in manifest-refusal fixtures and reject later transport calls;
real host availability must not decide whether a filesystem guard is exercised.

The named `refuses missing tracked leaves without explicit deletion evidence` table
must cover both Git inventories that retain a missing leaf and inventories that omit
it. Failed, thrown, malformed, truncated, absent, wrong-path and non-deletion evidence
must report `manifest-worktree-mismatch` before prepare or transfer, in full and delta
builds. The `deletion-evidence mutation gate` imports isolated in-memory copies of
the client and removes each cross-check (d) guard independently, including the whole
check; the same bad inventory must escape only in the mutant. Production files are
never rewritten by these probes, and a missing mutation target fails the test.

For named Node filesystem imports, fault injection in an in-memory mutation suite must
load its unchanged control through the same native loader as its mutants. Vitest's
transformed named imports can retain earlier bindings despite `syncBuiltinESMExports()`.
`pr-stall-live-safety.test.mjs` pairs each passing control contract with a failing mutant
assertion, including evidence appended after planning and refusal to persist intent.

Keep direct bound-exec missing-cwd cases and the delta builder's default-cwd case.
Row 13 configures a side-effecting fsmonitor hook: require its sentinel to stay absent
and pin `-c core.fsmonitor=false` on every manifest Git command after binding.

Remote discovery may overlap reachability, HEAD and base discovery, but drain every
speculative process before returning fallback. `buildManifest` always lists ignored files
fresh after base-manifest retrieval; ignored tests created during retrieval must still
refuse admission (`forge-offload.test.mjs`). Capture all base lstat metadata before diff/status, attributes
and index flags. Metadata capture uses at most 16 workers and drains failures before
full scanning. Manifest timing substages appear inside the existing stage report;
`inventory-walk` includes `hashing` (do not add those two counters). SSH and rsync
share multiplexing options only after checking a short, owner-only 0700 directory;
unavailable, unsafe or overlong control paths retain ordinary SSH.

