## Forge tracked-at-HEAD manifests (S1)

`remote.manifest` defaults to `legacy`; `tracked` binds shipped regular files to the
pinned HEAD blob and executable mode. Resolve it from the standard and platform preferences
only; checkout settings and `WE_HEAVY_ADMISSION_REMOTE_MANIFEST` cannot override it, even
in private pools. The policy log includes its source.
Tracked runs use a full inventory so warm-leaf reuse cannot bypass the boundary.
Tracked transport is always rsync: Git bundles contain history outside the validated
leaf manifest. Git-dependent tests refuse with `bundle-local`, including needsGit
routing with a cached bundle capability and the host-overload route. Tracked rsync uses
the same route plus full-selection proof as legacy bundles: a readable pure-test filter
can also select a Git-dependent test by substring, and must fall back locally. Record the refusal
in the manifest log before local execution. Presync resolves the same canonical policy
as admission and skips tracked or manifest-related fail-closed policies before any Git,
SSH, rsync, lock or cache-state operation. Its legacy delta behavior is unchanged.
The explicit remote CLI may force enablement only when manifest policy has not failed
closed; retain and log the canonical refusal reason when entering local admission.
Tracked admission refuses external client overrides before importing them: an older
installed client may ignore the manifest option. The built-in client enforces the boundary.
Coverage is never shipped in tracked mode, including `coverage/coverage-final.json` when
ignored, untracked, staged or committed. Structure validation cannot bind coverage counters
to genuine execution or HEAD. Commands that consume coverage input (`check:standards` or
an explicitly supplied `DIFF_COVERAGE_BASE`, the existing standards/Git-input signal) refuse
with `coverage-local` and run locally, even if the report is absent. Ordinary test commands
omit the report without reading it. Generating coverage with `--coverage` does not itself
consume a local coverage report. Legacy coverage inclusion, portability rewriting and
full-ship selection remain unchanged.
Sibling snapshots keep their existing index-based selection and identity checks; tracked
runs bind every shipped sibling file's bytes and executable bit to the sibling's pinned HEAD
tree, independently of the index and `core.fileMode`. Mode or content mismatches refuse as
`dirty` before the final sibling status check. They also apply the path+oid size exceptions
and binary allowlist, and count sibling bytes
against the main manifest's total cap. Size/type refusals keep their manifest reason and
are logged; operators can run locally or review a path+oid size exception.

`remote.manifest` comes only from the canonical host preferences path, including when
`WE_PLATFORM_PREFERENCES` redirects other settings for a private pool or test. Inject `home`
into `loadAdmissionPolicy` to test that path without reading the real home file. Missing,
unreadable, oversized, malformed or structurally invalid canonical evidence disables remote
execution for every caller, with a policy source explaining the local fallback. A valid,
existing canonical object without `remote.manifest` uses the standard manifest default.
Direct `ENOENT` also fails closed, including after a previously tracked policy's cache expires.
Remote-capable fixtures must inject an existing canonical preferences file via `home`.
Neither CLI enablement nor last-good settings may override that manifest refusal.
The shared `loadAdmissionPolicy` resolver is
the only canonical manifest source for admission, the explicit CLI and presync. Failed reads
are retried on the next call; they never use the redirected manifest or a cached last-good
host manifest. An invalid
platform manifest value disables remote execution with a policy source explaining the local
execution requirement, even if private tool/environment settings enable remote execution.

Every tracked refusal and every legacy shadow verdict appends metadata only to
`~/.plateau/forge-manifest-refusals.jsonl`; `FORGE_MANIFEST_REFUSALS_LOG` overrides the path.
`buildManifest` takes an explicit `shadow` option, default false. `runRemote` selects
it once from the original options, before `bindGit` wraps the executor, and carries
it through delta assembly and full retries. Shadow evaluation runs only when the
caller supplied no executor, filesystem or inventory (`listFiles`); injected callers
retain the legacy exec/fs call sequence.
`FORGE_MANIFEST_SHADOW=0` disables the default-on shadow for costly trees. Logging and
shadow failures never alter legacy admission. Tests must point the log at their temp root.
The real-Git `runRemote` regression replaces only SSH/rsync executables on PATH and
asserts a completed legacy run still ships an untracked file while logging its
shadow refusal; the injected-executor case compares calls against shadow disabled.
`forge-manifest-tracked.test.mjs` exercises local fallback without remote dispatch,
HEAD hashes, size bounds, binary extensions, coverage omission and setting provenance.
`heavy-admission.test.mjs` covers canonical manifest authority and invalid-policy local execution.
For the non-UTF-8 refusal-log case, inject the raw Git inventory record: filesystem
sandboxes may deny creating such filenames before the manifest code can observe them.
The `forge-manifest-untracked-shipped` soak break uses the real manifest builder in a
temporary Git repository. Run these scoped tests through heavy admission; the soak
file needs `--config vitest.soak.config.ts`.
### Orchestrator quarantine authority

`resolveOrchestratorAuthority` reads repo `authority.redMainQuarantine` from the discovered
`scripts/settings/orchestrator-authority.json` and platform `orchestrator.authority.redMainQuarantine`
through `readPlatformPreferences().prefs.orchestrator` using only its default paths. Missing current
platform or operator files deny authority; absent optional legacy files are allowed. Unreadable or
invalid platform evidence still denies authority. Authority reads validate raw JSON in every platform
file (including legacy files) before merging: duplicate object keys, including escape-equivalent names
and repeated parent blocks, deny access even when a later file or the repo grants it. Fix the ambiguous
file to restore an explicit grant. Repeated names in separate objects and punctuation inside strings
are valid. The repo reader uses
`readSettingsChecked`: duplicate ownership or read taint denies authority even over a platform grant.
For this explicit authority grant, platform wins over
repo in both directions; only boolean `true` grants access, and invalid values deny it. There is
no authority environment override, including platform-file path overrides. Tests inject
`platform`/`tool` or the `readFile` IO seam instead of redirecting the authority files.
The resolver logs the effective value and actual source through the shared policy diagnostics.

The IO writer and CLI add/remove/prune resolve authority; pure quarantine functions receive
`orchestratorAuthority` explicitly. Keep owner validation, TTL limits, and actor audit records
on the same path as operator and safety-net writes. `setMode` and `setFixPrs` remain limited to
the safety net and operator even with orchestrator authority enabled. The authority settings tests cover closed
defaults and conflicting layers; quarantine tests cover validation and removal; the IO test
verifies persisted events and commit messages against a temporary local Git origin.

