---
bornAs: x41mr6v
kind: decision
size: 5
status: open
scope: ["we:scripts/operations/codex-job.mjs", "we:scripts/operations/__tests__/codex-job.test.mjs"]
dateOpened: "2026-10-25"
preparedDate: "2026-10-25"
preparedAgainstSha: "1453ea41ecd75b76ea7dbce1f81059f9247bd573"
tags: []
---

# codex-job: tests, audit and publish read one frozen snapshot

## Digest

> Code status: `we:scripts/operations/codex-job.mjs` is not on `main`. It exists only in the closed #5839 seed patch, so every `we:scripts/operations/codex-job.mjs:NNN` reference below is a line in that patch, not in the tree. The seed patch is a delta on the earlier #5839 branch, so function names and line numbers below come from that branch file and cannot be re-checked on `main`; the build must re-verify each at implementation time. Code blocks are sketches: `cleanGitEnv`, `trustedGitDir`, `materializeTree` and `snapshotTreeSha` are proposed names, not seed names. This card decides the redesign before the file is rebuilt.

PR #5839 ran through 18 review rounds and was closed because incremental worktree-based fixes kept uncovering a new break class almost every round: credential capture via inherited helpers and environment variables, time-of-check to time-of-use (TOCTOU) races between diffing and staging, source rewrites in passing `afterAll` hooks or under `.gitattributes` `text eol=lf` normalization, relative `remote.origin.url` paths resolving differently between the primary worktree and the publication clone, and finally a surviving test subprocess alternating file bytes or modes so that Git fingerprints and tests see bytes A while the pre-test snapshot, audit export, and publication export all read bytes B. As long as tests execute inside the mutable lane worktree or share write access to the files later read for audit and publication, a background child process spawned during an earlier step can time its writes between checks and cause untested bytes to be published.

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| Fork 1 — Snapshot mechanism | **(a) Git tree object captured into a temporary index and exported into a read-only directory** | (b) Direct filesystem copy of the lane worktree | High |
| Fork 2 — Test isolation and process cleanup | **(a) Run tests inside an isolated disposable copy of the frozen snapshot and kill the whole process group on exit** | (b) Run tests in the lane worktree and verify post-test fingerprints | High |
| Fork 3 — Bounding Codex worker and repair output | **(a) Extract only in-scope paths from the lane into the snapshot tree** | (b) Require Codex to emit a unified diff patch file only | Med-High |
| Fork 4 — Process isolation level | **(a) Same user, process-group kill, tree-SHA binding** | (b) OS sandbox | Med |

## Trust boundary and threat model

The job runner (`we:scripts/operations/codex-job.mjs`) orchestrates untrusted model generations and untrusted test execution before pushing a verified commit to a trusted remote.

- **Trusted:** The runner process itself (`we:scripts/operations/codex-job.mjs`), the initial base commit SHA (`startSha`) resolved once from the remote, the declared `scope` prefixes, the sanitized Git execution wrapper (`trustedGit`), and the runner-owned temporary directories outside the lane worktree.
- **Adversarial:**
  - **Codex worker and repair output:** Can write arbitrary files, symlinks, gitlinks, `.git/config`, hooks, `.gitattributes`, or out-of-scope paths in the lane worktree, and can leave background processes running after the Codex CLI exits.
  - **Test subprocesses:** Can mutate sources during or after tests (e.g., `afterAll`), fork detached background processes that outlive the test runner, watch filesystem access or procfs to alternate bytes A and B between Git fingerprint checks and Node `readFile`/`lstat` exports, or attempt to read credentials from the environment.
  - **Git configuration, remotes, and hooks:** Repository `.git/config`, `.githooks`, system/global gitconfigs, credential helpers, replacement refs, filters (`textconv`, `ext-diff`, `smudge`/`clean`), and relative `remote.origin.url` definitions.
- **Residual risk accepted in v1 (ruled in Fork 4):** a same-user child that escapes the process group (for example with `setsid`) can still write anything the runner user can write. The design does not rely on files it can touch: the snapshot is identified by its tree SHA, and every later step checks that SHA. Network egress and non-environment credential files for worker and test processes are also not blocked in v1; the mitigation is a scrubbed environment and an empty runner-owned `HOME`, with a sandbox as a follow-up card.
- **Explicitly out of scope:** Kernel or hardware compromises, root-level attackers on the host machine, availability denial-of-service via infinite loops (bounded only by timeouts), and side-channel attacks across separate OS users.

**The Frozen-Input Rule:** Immediately after the Codex worker (or repair step) finishes and all lane subprocesses are terminated, the runner captures the in-scope working tree into one immutable snapshot (a Git tree object written from a temporary index and materialized into a runner-owned read-only directory with its tree hash recorded). The tests, the Codex audit, and the publication commit all read exclusively from that recorded immutable snapshot; nothing re-reads the mutable lane working tree after the snapshot is taken.

| Input | Trust level | Frozen when | Who may read it after |
|---|---|---|---|
| `originUrl` and `startSha` | Untrusted config input, verified once | Bootstrap (`prepareTrustedRepo`) before lane acquisition | `trustedGit` clone, `ls-remote`, and `push` only |
| Allowed `scope` and brief | Trusted caller input | Job initialization (`runJob` start) | Scope validator, snapshot builder, audit prompt builder |
| Lane working tree (`s.lane.path`) | Adversarial | Never trusted directly; scraped once per attempt into a frozen tree object after process-group teardown | Nothing; never read by tests, audit, or publication after snapshot |
| Frozen snapshot (`snapshotTreeSha` + read-only directory) | Trusted once hash-captured and scope-checked | Immediately after worker (and once more after repair if tests fail) | Test runner (via isolated copy), audit prompt generator, and publication commit |
| Test failure output (`stdout`/`stderr`) | Adversarial | When the first test run exits red | Repair prompt builder only (length-capped and tag-sanitized) |
| Audit verdict (`NOT WEAKENED` / `WEAKENED`) | Adversarial model output | Upon audit process exit | Runner verdict parser (`runAudit`) only |

## Fork 1 — Snapshot mechanism

**Fork-existence justification:** Case (a) forced invariant — reading loose files from a live worktree across multiple passes (diff, hash-object, `readFile`, `lstat`) is broken under concurrent writer races and `.gitattributes` line-ending normalization (`we:scripts/operations/codex-job.mjs:237-358`).

How the runner freezes the post-Codex state into an immutable artifact before running tests, audit, or publication:

- **(a) Capture a Git tree object via a temporary index (`GIT_INDEX_FILE`) and export it once, blob by blob from the object store, into a runner-owned read-only directory (Recommended default).** Using `trustedGit` against the trusted object store with `--work-tree=<lane>` and a fresh `GIT_INDEX_FILE`, stage only the in-scope paths without filters (`-c core.autocrlf=false -c core.eol=lf`), run `git write-tree` to obtain a single cryptographic `snapshotTreeSha`, and materialize it outside the lane. Tradeoff: requires one `git write-tree` and tree extraction per attempt, but binds content and executable modes (`100644`/`100755`) into a single content-addressed root hash inside the trusted repo's object database; symlinks and gitlinks are refused (see Supported by default).
- **(b) Copy changed files directly from the lane worktree into a temporary directory using Node `fs` (`readFile`/`lstat`/`writeFile`).** *Rejected:* Node-level file copying across multiple syscalls is non-atomic against a surviving process and still requires a separate staging step later to build the published Git commit, reintroducing a two-representation gap between what was copied and what Git commits.
- **(c) Create a `git worktree` or filesystem overlay mounted over the lane.** *Rejected:* A Git worktree shares the repository state and starts from a committed ref rather than uncommitted lane edits, while OS overlay mounts require elevated privileges not portable across developer macOS and Linux environments.

```js
// Fork 1 (a) — capture one immutable Git tree object in trustedDir
const env = { ...cleanGitEnv, GIT_DIR: s.trustedGitDir, GIT_WORK_TREE: s.lane.path, GIT_INDEX_FILE: tempIndex };
await trustedGit(['read-tree', s.startSha], { s, env });
await trustedGit(['update-index', '--add', '--remove', '--', ...inScopeFiles], { s, env });
const { stdout: treeOut } = await trustedGit(['write-tree'], { s, env });
s.snapshotTreeSha = treeOut.trim();
```

`Skeptic: SURVIVES — beat attack that .gitattributes in the lane could alter blob bytes during update-index; running against s.trustedGitDir with --no-Renames and clean attributes config ignores lane-injected filter attributes.`
`Screen: clear`

## Fork 2 — Test isolation and process cleanup

**Fork-existence justification:** Case (a) forced invariant — running tests inside the mutable lane worktree (`we:scripts/operations/codex-job.mjs:273-320`) allows test hooks or background children to mutate files in place or survive across phases.

How the runner executes tests and prevents surviving subprocesses from interfering with subsequent steps:

- **(a) Materialize a disposable test worktree from `snapshotTreeSha` for each test run, spawn the test runner in a dedicated process group (`detached: true`), and kill the entire process group (`process.kill(-pid, 'SIGKILL')`) before returning (Recommended default).** Even if a test or `afterAll` hook rewrites files in its working directory, it mutates only the disposable test copy; the frozen `snapshotTreeSha` in `s.trustedDir` and the read-only audit snapshot remain untouched. Killing the process group reaps background children before repair or audit starts. Tradeoff: materializing the test directory and linking `node_modules` adds small I/O overhead per test run.
- **(b) Run tests in the lane worktree and compare pre-test and post-test `worktreeFingerprint` / `captureAuditExport` hashes.** *Rejected:* This is the exact seed-patch design (`we:scripts/operations/codex-job.mjs:297-358`) defeated in R89: a surviving subprocess can restore bytes A whenever `git diff` or `git hash-object` runs and write bytes B when `captureAuditExport` reads, passing every fingerprint comparison while publishing untested bytes.
- **(c) Make the lane worktree `chmod -R a-w` during tests and run tests in place.** *Rejected:* Any process running as the same OS user owns the files in the lane and can call `chmod` to restore write permissions before mutating them.

```js
// Fork 2 (a) — isolated test checkout + process-group kill
await materializeTree(s, s.snapshotTreeSha, testDir); // cat-file per blob, no attribute processing
const child = spawn('node', testArgs(testDir), { cwd: testDir, detached: true, env: cleanTestEnv });
try { return await waitForExit(child, s.opts.timeoutMs); }
finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
```

`Skeptic: SURVIVES — beat attack that a test child could call setsid() to escape the process group and mutate the lane; because tests run in testDir and publication reads s.snapshotTreeSha from s.trustedDir, an escaped child cannot alter the frozen tree object.`
`Screen: clear`

## Fork 3 — Bounding Codex worker and repair output

**Fork-existence justification:** Case (b) genuine choice — the interface between the untrusted Codex process and the snapshot builder must either harvest in-scope files from a worktree checkout or require Codex to emit a patch artifact; both cannot govern the same handoff.

How the runner bounds what Codex is allowed to contribute to the snapshot:

- **(a) Let Codex edit the lane worktree, kill its process group on exit, reject any out-of-scope or unsupported path types (`changedFiles` + `pathsWithinScope`), and stage only the verified in-scope paths into `snapshotTreeSha` (Recommended default).** Preserves standard file-editing tools for the Codex worker and repair step while ensuring out-of-scope edits, `.git` tampering, or special files (FIFOs, sockets, device nodes, submodules) cause an immediate fail-closed abort before snapshotting. Tradeoff: requires enumerating and validating worktree status once before `write-tree`.
- **(b) Run Codex in a read-only tree and require it to write a unified diff patch file applied via `git apply` into the trusted repo.** *Rejected:* LLMs frequently produce malformed hunk headers or line counts in raw unified diffs, causing spurious repair loops on valid code changes that normal file writes handle cleanly.

`Skeptic: SURVIVES — beat attack that staging from the lane worktree is vulnerable to a background Codex child racing update-index; killing the Codex process group before changedFiles + update-index eliminates concurrent lane writers before the snapshot is taken. A child that escapes the group is covered by Fork 4 and by the post-write-tree check on the snapshot tree.`
`Screen: clear`

## Fork 4 — How strongly are the worker and test processes isolated?

**Fork-existence justification:** Case (b) genuine choice — process isolation can be same-user plus cleanup, or an operating-system sandbox; the two have different portability and cost, and both cannot be the default.

- **(a) Same user, dedicated process group, kill the group after every phase, sweep for leftover children, keep runner directories mode 0700, and bind every later step to the tree SHA (Recommended default).** Portable on macOS and Linux and enough because the frozen-input rule makes escaped writers harmless to the published bytes. Tradeoff: an escaped child can still read or damage files the runner user owns, which is why the residual risk is stated in the threat model.
- **(b) Run worker, repair and test processes in an unprivileged mount and PID sandbox (Linux namespaces or a macOS sandbox profile).** *Rejected as the v1 default:* the two platforms need different mechanisms, the dev machines lack unprivileged namespaces, and it delays the redesign; file it as a follow-up card once (a) is built.
- **(c) Run everything in a container per job.** *Rejected:* heavier than the heavy-admission pool allows today and does not remove the need for the tree-SHA binding.

`Skeptic: SURVIVES — beat the attack that a setsid child outlives the group kill and rewrites the runner directories; publication reads only the recorded tree SHA from the object store and re-verifies it before commit-tree, so a rewritten directory is detected, not published.`
`Screen: clear`

## Supported by default (not decisions)

- **Publication exports the recorded `snapshotTreeSha` directly:** `commitAndPush` creates the commit in `s.trustedDir` directly from `s.snapshotTreeSha` (`git commit-tree <snapshotTreeSha> -p <startSha>`) rather than re-reading files from the lane or re-staging exports. The alternative (re-reading the worktree at commit time) is broken and excluded by the Frozen-Input Rule.
- **Audit reads the diff of `snapshotTreeSha` against `startSha` from `s.trustedDir`:** The audit step runs in a read-only directory or inspects the pre-generated diff from `git diff-tree -p <startSha> <snapshotTreeSha>` inside `s.trustedDir`, never touching `s.lane.path`, making `changed-after-audit` races impossible by construction.
- **Scope and mode checks run on the snapshot tree, not the live lane:** after `write-tree`, run `git ls-tree -r` and `git diff-tree` against `startSha` and fail closed on any out-of-scope path or any mode other than 100644 and 100755. Modes 120000 (symlink) and 160000 (gitlink) are refused, so extraction can never follow a link out of the test directory.
- **Materialise with attribute processing disabled:** write each blob's bytes from the object store (`cat-file`) into the test directory instead of using `git archive`, so an in-scope `.gitattributes` (`export-ignore`, `export-subst`, `eol`, `working-tree-encoding`) cannot make the tested files differ from `snapshotTreeSha`.
- **The repair pass starts from the prior snapshot:** the repair workspace is materialised fresh from the last `snapshotTreeSha`, never from surviving lane files; `node_modules` is linked read-only from the primary checkout and is not part of the snapshot.
- **Publication re-verifies:** before `commit-tree`, the runner recomputes the tree SHA it is about to publish and refuses if it differs from the recorded value.
- **Explicit resolved remote URL and sanitized Git environment:** Keep the seed patch's rule that `remote.origin.url` is read once at bootstrap, resolved against the primary worktree (`path.resolve(s.opts.repo, s.originUrl)`), and passed explicitly to `clone`, `ls-remote`, and `push` under a scrubbed environment (`GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, stripped `GIT_*` variables, empty `core.hooksPath` and `credential.helper`).

---

## Context

### Prior art

- **Git content-addressed plumbing (`git write-tree`, `git read-tree`, `git commit-tree`):** Git's low-level plumbing separates index manipulation (`GIT_INDEX_FILE`) and tree object creation (`write-tree`) from working-tree checkouts. Once `write-tree` hashes blobs and modes into the object database, `commit-tree` creates a commit directly from that tree SHA without consulting the filesystem again, eliminating worktree-to-commit TOCTOU windows.
- **Nix and Bazel hermetic build/test sandboxes:** Both systems prevent build and test actions from mutating source trees by executing actions inside ephemeral sandboxes populated with read-only inputs or isolated copies, and reaping the action's process group (and PID namespace where supported) before collecting outputs.
- **TOCTOU filesystem race literature (Bishop & Dilger 1996; Dean & Hu 2004):** Classic TOCTOU attacks exploit any check-then-use sequence over mutable filesystem paths by swapping file contents or symlinks between the validation syscall and the consumption syscall. The established fix is to ingest the untrusted bytes into a kernel- or trusted-process-owned immutable object first, then run all validation and consumption against that private object.
- **CI systems pinning commit/tree SHAs and GitHub Actions `pull_request_target` hazards:** In CI pipelines, checking out a mutable branch ref or executing untrusted test scripts in a privileged workspace (`pull_request_target` with checkout of untrusted PR code) allows untrusted code to modify the workspace or exfiltrate credentials. Safe pipelines separate the untrusted execution environment from the privileged publication environment and bind approvals to an immutable tree or commit hash.
- **Reproducible builds (in-toto / SLSA provenance attestations):** Build provenance frameworks bind verification attestations (test results, audit reviews) to the cryptographic digest of the exact artifact or source tree tested, rather than asserting that a mutable directory was unchanged between steps.

### What the seed patch already does

Drawn from `we:scripts/operations/codex-job.mjs` and `we:scripts/operations/__tests__/codex-job.test.mjs` in the closed PR #5839 seed patch:

- **`prepareTrustedRepo(s)` (`we:scripts/operations/codex-job.mjs:177-190`) — KEEP:** Reads `remote.origin.url` once with `--no-includes`, resolves relative filesystem remote paths against `s.opts.repo` (`path.resolve(s.opts.repo, s.originUrl)`), creates a `--no-local --no-checkout --template=` clone in `s.trustedDir`, and resolves `startSha` from the remote ref.
- **`trustedGit` / sanitized Git environment (`we:scripts/operations/codex-job.mjs` + test matrix lines 125-150) — KEEP:** Scrubs `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, hooks, credential helpers, replacement refs, submodules, and system/global config so hostile lane config cannot hijack Git subcommands or capture credentials.
- **`changedFiles(s)` and `pathsWithinScope` check in `checkDiffScope(s)` (`we:scripts/operations/codex-job.mjs:215-232, 394-400`) — KEEP:** Enumerates tracked and untracked changes with `-z` and fails closed with `no-changes` or `diff-out-of-scope` before any test or audit runs.
- **Bounded single-repair loop in `runTests(s)` (`we:scripts/operations/codex-job.mjs:273-338`) — KEEP (adapted to re-snapshot):** Runs Vitest through the heavy-admission queue, handles `tests-deferred`, sanitizes `</test-failure-data>` prompt-injection tags in failure output, allows at most one Codex repair pass, and fails with `tests-red` if the second run fails.
- **`worktreeFingerprint(s, ...)` (`we:scripts/operations/codex-job.mjs:234-392`), `captureAuditExport(s)` (`we:scripts/operations/codex-job.mjs:321-355`), and `checkAuditedFiles(s)` (`we:scripts/operations/codex-job.mjs:360-373`) — REPLACE:** These functions attempt to detect mid-test and post-audit mutations by re-reading `git diff`, `git hash-object`, `lstat`, and `readFile` on the live lane worktree and comparing SHA-256 fingerprints (`testedFingerprint`, `testedExportFingerprint`, `auditFingerprint`, `auditExportFingerprint`). Replace all four with a single `captureSnapshotTree(s)` step that writes one Git tree object into `s.trustedDir` before tests run, so tests, `runAudit(s)`, and `commitAndPush(s)` all consume that frozen tree without ever re-reading `s.lane.path`.

## Risks

The snapshot adds one tree write and one extraction per attempt. A test that needs `node_modules` or untracked generated files must have them linked into the disposable test directory, or Fork 2 (a) reports false reds. Scope filtering happens before `write-tree`; a path the filter misses is published untested, so the out-of-scope refusal is a blocking guarantee, not debt.

## Test plan

The Tier 1 fixtures under Done when are the red-green set: a surviving writer during `runTests`, an adversarial audit verdict, and the symlink, gitlink and `.gitattributes` cases. Run them through the heavy queue against `we:scripts/operations/__tests__/codex-job.test.mjs` only.

## Done when

- **Tier 1 (executable):** `npx vitest run` on `we:scripts/operations/__tests__/codex-job.test.mjs` passes a real-Git fixture where a background process spawned during `runTests` continuously rewrites an in-scope fixture source file in `s.lane.path` and in the test runner's `cwd` after tests pass, proving that the published commit on `origin` still contains the exact `snapshotTreeSha` bytes that were tested and audited.
- **Tier 1 (executable):** `npx vitest run` on `we:scripts/operations/__tests__/codex-job.test.mjs` passes an adversarial model-output fixture where the audit invocation returns structurally valid text whose first line is `WEAKENED: removed assertion` (and a second case where it omits `NOT WEAKENED`), and `runJob` refuses publication with `stopReason: 'audit-failed'` and zero pushes to `origin`.
- **Tier 1 (executable):** the same test file passes cases where the lane contains a symlink, a gitlink, and an in-scope `.gitattributes` with `export-ignore`; the first two end with a refusal and zero pushes, the third tests and publishes identical bytes.
- **Tier 2 (observable):** `we:scripts/operations/codex-job.mjs` contains no calls to `readFile`, `lstat`, `readlink`, `git diff`, or `git status` against `s.lane.path` after the snapshot tree is recorded for a given test attempt.
