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
| Fork 1 — Snapshot mechanism | **(a) Raw blobs captured into a temporary index and exported from the resulting Git tree** | (b) Direct filesystem copy of the lane worktree | High |
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
- **Residual risk proposed for v1 (subject to Fork 4 ratification):** a same-user child that escapes the process group (for example with `setsid`) can write anything the runner user can write, including runner code, trusted objects and primary-checkout dependencies. Mode 0700, chmod and a tree SHA do not isolate processes with the same UID. V1 protects publication from ordinary lane/test-directory rewrites, assuming runner code, recorded SHAs and the trusted object store remain trustworthy; it does not protect against targeted same-UID compromise of those assets. Object-integrity checks catch the corruption exercised by DW-objects, but cannot close a same-user check/use race. Network egress and non-environment credential files are also not blocked in v1; a scrubbed environment and an empty runner-owned `HOME` reduce exposure. Fork 4 (b) is required if hostile same-user execution must be contained.
- **Explicitly out of scope:** Kernel or hardware compromises, root-level attackers on the host machine, availability denial-of-service via infinite loops (bounded only by timeouts), and side-channel attacks across separate OS users.

**The Frozen-Input Rule:** After the Codex worker (or repair step) exits and its process group is killed, the runner captures the in-scope working tree into one content-addressed snapshot. Cleanup does not prove every descendant exited. Validate the captured paths, modes and raw bytes; concurrent reads need not represent a single instant of the lane. Tests start from a disposable materialization of that tree, audit consumes its trusted diff, and publication uses its recorded SHA. No downstream phase re-reads the lane for that attempt (DW-no-read). Each repair is a new attempt with its own capture. This binds initial test inputs and audit/publication identity; arbitrary malicious tests can still rewrite their own executable files during execution. Same-UID attacks on trusted assets remain the Fork 4 residual risk.

| Input | Trust level | Frozen when | Who may read it after |
|---|---|---|---|
| `originUrl` and `startSha` | Untrusted config input, verified once | Bootstrap (`prepareTrustedRepo`) before lane acquisition | `trustedGit` clone, `ls-remote`, and `push` only |
| Allowed `scope` and brief | Trusted caller input | Job initialization (`runJob` start) | Scope validator, snapshot builder, audit prompt builder |
| Lane working tree (`s.lane.path`) | Adversarial | Never trusted directly; scraped once per attempt into a frozen tree object after process-group teardown | Nothing; never read by tests, audit, or publication after snapshot |
| Frozen snapshot (`snapshotTreeSha` + trusted objects) | Trusted under the Fork 4 same-UID limitation | Immediately after worker (and once more after repair if tests fail) | Tests via disposable materialization, audit via trusted diff, publication via tree SHA |
| Test failure output (`stdout`/`stderr`) | Adversarial | When the first test run exits red | Repair prompt builder only (length-capped and tag-sanitized) |
| Audit verdict (`NOT WEAKENED` / `WEAKENED`) | Adversarial model output | Upon audit process exit | Runner verdict parser (`runAudit`) only |

No path is linked from the disposable test or repair directory into the primary checkout or trusted store. A symlink is not a read-only mount; hardlinks plus chmod also share writable inodes with a same-UID process.

| Provisioned path | Source and trust | Write behavior and acceptance |
|---|---|---|
| Snapshot source files | Recorded tree blobs, not live lane files | Private regular-file copies; mutations do not update trusted objects (DW-writer, DW-materialize) |
| `node_modules/` | Dependency installation from the trusted checkout and its recorded lockfile | Private recursive copy with distinct inodes, including resolving package-manager links into that private dependency tree; refuse unresolved/external links. Write-through fixture leaves primary dependencies unchanged (DW-inputs) |
| Required untracked generated inputs | Explicit caller manifest of trusted generated inputs with recorded digests, never arbitrary lane leftovers | Private regular-file copies, reject links/special files and collisions with snapshot paths; test-only inputs stay out of the published tree (DW-inputs) |
| Repair workspace | Prior recorded tree plus the same private input provisioning | Fresh materialization for the one repair attempt (DW-repair) |

Private copies prevent accidental write-through; they do not deny a same-UID process direct access to primary paths outside the disposable directory.

## Fork 1 — Snapshot mechanism

**Fork-existence justification:** Case (a) forced invariant — reading loose files from a live worktree across multiple passes (diff, hash-object, `readFile`, `lstat`) is broken under concurrent writer races and `.gitattributes` line-ending normalization (`we:scripts/operations/codex-job.mjs:237-358`).

How the runner freezes the post-Codex state into an immutable artifact before running tests, audit, or publication:

- **(a) Capture raw blobs into a temporary index (`GIT_INDEX_FILE`) and export the resulting tree blob by blob (Recommended default).** Read each validated regular file once into a bounded buffer, write those exact bytes using `hash-object -w --no-filters --stdin`, and populate the index using NUL-delimited `update-index -z --index-info` records. Start from `startSha`, include deletions, then `write-tree` and validate the resulting tree/diff. Git never stages a lane filename and therefore cannot apply lane `.gitattributes`. `core.autocrlf=false` and `core.eol=lf` alone do not disable `text`, `ident`, encoding or clean filters. Tradeoff: one raw blob ingestion per changed file, one tree write and extraction per attempt, binding content and executable modes (`100644`/`100755`); symlinks and gitlinks are refused (DW-bytes, DW-symlink, DW-gitlink).
- **(b) Copy changed files directly from the lane worktree into a temporary directory using Node `fs` (`readFile`/`lstat`/`writeFile`).** *Rejected:* Node-level file copying across multiple syscalls is non-atomic against a surviving process and still requires a separate staging step later to build the published Git commit, reintroducing a two-representation gap between what was copied and what Git commits.
- **(c) Create a `git worktree` or filesystem overlay mounted over the lane.** *Rejected:* A Git worktree shares the repository state and starts from a committed ref rather than uncommitted lane edits, while OS overlay mounts require elevated privileges not portable across developer macOS and Linux environments.

```js
// Fork 1 (a) — capture one immutable Git tree object in trustedDir
const env = { ...cleanGitEnv, GIT_DIR: s.trustedGitDir, GIT_INDEX_FILE: tempIndex };
await trustedGit(['read-tree', s.startSha], { s, env });
const records = [];
for (const entry of await captureValidatedLaneEntries(s)) {
  if (entry.deleted) { records.push(deletionIndexRecord(entry.path)); continue; }
  const { stdout } = await trustedGit(['hash-object', '-w', '--no-filters', '--stdin'],
    { s, env, input: entry.bytes });
  records.push(nulIndexRecord(entry.mode, stdout.trim(), entry.path));
}
await trustedGit(['update-index', '-z', '--index-info'], { s, env, input: Buffer.concat(records) });
const { stdout: treeOut } = await trustedGit(['write-tree'], { s, env });
await validateSnapshotTree(s, treeOut.trim());
s.snapshotTreeSha = treeOut.trim(); // accepted attempt identity
```

The proposed capture helper enumerates the base tree's tracked paths plus actual filesystem entries, with only explicit caller-declared test-input exclusions and the separately checked Git metadata boundary. Git status/diff and lane ignore rules cannot decide which files are changed: compare the captured raw blob OIDs, descriptor modes and presence to the base tree, so attributes cannot hide a CRLF-only edit. Reject every raw out-of-scope change, including ignored/untracked paths (DW-bytes, DW-scope). The helper rejects unsupported types before opening them, uses no-follow/nonblocking file opens and validates the opened descriptor and path ancestry; it never opens a FIFO to wait for a writer. Mode is derived from that descriptor. NUL records preserve whitespace/newlines and leading dashes without path-option parsing; deletion records use mode 0 and the repository object format's zero OID. Set explicit per-file/total byte limits and timeouts; oversized/unreadable input refuses publication with an operator-visible reason (DW-capture-errors).

Prepare-time Git spike (2026-10-25): with `* text eol=lf ident`, bytes `$Id: lane-value $\r\nconst x = 1;\r\n` changed under the old `update-index --add` sketch despite both EOL config settings. Raw `hash-object -w --no-filters --stdin` plus `update-index -z --index-info` retained identical bytes: blob `912a2f46b17bcda7604ce255795076ba37983e39`, tree `eff0384ae6025c2b64b74f95a856e28904b415b5` (SHA-1 scratch object store). This probes the plumbing, not the absent job implementation.

`Skeptic: SURVIVES — lane attributes cannot transform raw stdin blobs or index-info OIDs; Done when DW-bytes exercises text/eol, ident, encoding, clean filters and export attributes with byte/OID identity.`
`Screen: clear`

## Fork 2 — Test isolation and process cleanup

**Fork-existence justification:** Case (a) forced invariant — running tests inside the mutable lane worktree (`we:scripts/operations/codex-job.mjs:273-320`) allows test hooks or background children to mutate files in place or survive across phases.

How the runner executes tests and prevents surviving subprocesses from interfering with subsequent steps:

- **(a) Materialize a disposable test worktree from `snapshotTreeSha` for each test run, spawn the runner in a dedicated process group (`detached: true`), and kill that group before returning (Recommended default).** Ordinary test/`afterAll` writes affect private copies; no exports from this mutable directory are staged for publication. Group cleanup kills descendants still in that group; escaped children are the Fork 4 limitation. Tradeoff: extracting the tree and making private dependency/generated-input copies adds I/O per run (DW-inputs, DW-writer).
- **(b) Run tests in the lane worktree and compare pre-test and post-test `worktreeFingerprint` / `captureAuditExport` hashes.** *Rejected:* This is the exact seed-patch design (`we:scripts/operations/codex-job.mjs:297-358`) defeated in R89: a surviving subprocess can restore bytes A whenever `git diff` or `git hash-object` runs and write bytes B when `captureAuditExport` reads, passing every fingerprint comparison while publishing untested bytes.
- **(c) Make the lane worktree `chmod -R a-w` during tests and run tests in place.** *Rejected:* Any process running as the same OS user owns the files in the lane and can call `chmod` to restore write permissions before mutating them.

```js
// Fork 2 (a) — isolated test checkout + process-group kill
await materializeTree(s, s.snapshotTreeSha, testDir); // cat-file per blob, no attribute processing
const child = spawn('node', testArgs(testDir), { cwd: testDir, detached: true, env: cleanTestEnv });
try { return await waitForExit(child, s.opts.timeoutMs); }
finally { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
```

`Skeptic: SURVIVES — conditional on trusted assets remaining intact, a setsid-escaped child's lane/testDir rewrites do not feed publication; Done when DW-writer waits for writes after group cleanup and asserts origin tree identity. Direct trusted-store/runner attacks remain accepted residual risk, not a claimed prevention.`
`Screen: clear`

## Fork 3 — Bounding Codex worker and repair output

**Fork-existence justification:** Case (b) genuine choice — the interface between the untrusted Codex process and the snapshot builder must either harvest in-scope files from a worktree checkout or require Codex to emit a patch artifact; both cannot govern the same handoff.

How the runner bounds what Codex is allowed to contribute to the snapshot:

- **(a) Let Codex edit the lane worktree, kill its process group on exit, reject any out-of-scope or unsupported path types (`changedFiles` + `pathsWithinScope`), and stage only the verified in-scope paths into `snapshotTreeSha` (Recommended default).** Preserves standard file-editing tools for the Codex worker and repair step while ensuring out-of-scope edits, `.git` tampering, or special files (FIFOs, sockets, device nodes, submodules) cause an immediate fail-closed abort before snapshotting. Tradeoff: requires enumerating and validating worktree status once before `write-tree`.
- **(b) Run Codex in a read-only tree and require it to write a unified diff patch file applied via `git apply` into the trusted repo.** *Rejected:* LLMs frequently produce malformed hunk headers or line counts in raw unified diffs, causing spurious repair loops on valid code changes that normal file writes handle cleanly.

`Skeptic: SURVIVES — capture can race escaped lane writers, so validate the actual tree rather than claiming teardown eliminates them; Done when DW-scope, DW-special, DW-metadata, DW-symlink and DW-gitlink exercise refusals, while DW-writer exercises lane mutation after capture. Fork 4 limits attacks on trusted assets.`
`Screen: clear`

## Fork 4 — How strongly are the worker and test processes isolated?

**Fork-existence justification:** Case (b) genuine choice — process isolation can be same-user plus cleanup, or an operating-system sandbox; the two have different portability and cost, and both cannot be the default.

- **(a) Same user, dedicated process group, kill the group after every phase, sweep for leftover children, keep runner directories mode 0700, and bind later steps to the tree SHA (Recommended default, with the explicit trust assumption above).** Portable on macOS and Linux. Ordinary lane/testDir rewrites do not feed publication, but targeted same-UID attacks on runner code, recorded SHAs, objects or dependencies are not contained. Ratifying (a) accepts this integrity and confidentiality risk; it does not assert OS isolation.
- **(b) Run worker, repair and test processes in an unprivileged mount and PID sandbox (Linux namespaces or a macOS sandbox profile).** *Rejected as the v1 default:* the two platforms need different mechanisms, the dev machines lack unprivileged namespaces, and it delays the redesign; file it as a follow-up card once (a) is built.
- **(c) Run everything in a container per job.** *Rejected:* heavier than the heavy-admission pool allows today and does not remove the need for the tree-SHA binding.

`Skeptic: SURVIVES — within the stated v1 trust assumption, Done when DW-writer proves that setsid-escaped lane/testDir rewrites do not change the published tree, and DW-objects proves actual object corruption is refused. Neither test claims protection from a same-UID attacker rewriting the runner or racing the integrity check; that requires option (b).`
`Screen: clear`

## Supported by default (not decisions)

- **Publication uses the recorded `snapshotTreeSha` directly:** `commitAndPush` uses `git commit-tree <snapshotTreeSha> -p <startSha>` in `s.trustedDir`; it never stages the test directory. Assert the created and remote commits' tree equals the recorded tree (DW-writer, DW-no-read).
- **Audit reads only the trusted diff:** generate `git diff-tree --no-ext-diff --no-textconv --no-renames -p <startSha> <snapshotTreeSha>` in `s.trustedDir` under sanitized config. The audit invocation receives only that diff, the brief and sanitized context; it has no lane cwd or file-reading tools. Only an explicit valid `NOT WEAKENED` verdict permits publication (DW-audit-source, DW-weakened, DW-missing-verdict).
- **Scope and mode checks run on captured objects as well as pre-capture inputs:** inspect NUL-delimited `ls-tree -r -z` and `diff-tree --no-renames -r -z` against `startSha`; validate both rename endpoints via delete/add semantics, enforce component-boundary scope prefixes, and reject non-regular modes, unsafe paths and metadata tampering before tests/publication. Enumerate untracked files without trusting lane Git config; never silently drop out-of-scope files. Compare lane Git metadata to its bootstrap baseline without executing it (DW-scope, DW-special, DW-metadata, DW-symlink, DW-gitlink).
- **Materialise raw bytes:** use `cat-file` blob bytes, never `git archive` or a filtered checkout. Export attributes do not remove/substitute files (DW-bytes, DW-materialize).
- **Repair starts from the prior snapshot:** fresh materialization plus private dependency/generated-input copies; no primary-checkout links and no reuse of lane leftovers (DW-repair, DW-inputs).
- **Publication verifies actual object payloads:** traverse the recorded tree, rehash raw tree/blob payloads with Git's object type/length framing and compare each digest with the expected OID. Missing, unreadable, wrong-type or mismatched objects refuse with `snapshot-integrity-failed` and zero pushes before `commit-tree`. Comparing the recorded SHA with itself is not a check. TestDir rewrites need no detection because publication never reads that directory. This detects specified corruption, subject to the same-UID limitation (DW-objects, DW-writer).
- **Explicit resolved remote URL and sanitized Git environment:** keep bootstrap-only URL resolution against the primary worktree and pass it explicitly to clone, `ls-remote` and push; strip inherited `GIT_*`, block system/global config, hooks, helpers, replacement refs, external diff and textconv, and use an empty `HOME`. Lane config is never executed (DW-git-env).

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
- **`changedFiles(s)` and `pathsWithinScope` check in `checkDiffScope(s)` (`we:scripts/operations/codex-job.mjs:215-232, 394-400`) — REPLACE discovery, retain refusal policy:** Git-normalized status can hide raw EOL/ident edits. Enumerate base tracked paths and actual filesystem entries, compare captured raw OIDs/modes/presence to the base without honoring lane ignore rules, then apply component-boundary scope checks. Keep `no-changes` / `diff-out-of-scope` refusals and NUL-safe names, and validate the actual candidate tree as a second check (DW-bytes, DW-scope).
- **Bounded single-repair loop in `runTests(s)` (`we:scripts/operations/codex-job.mjs:273-338`) — KEEP (adapted to re-snapshot):** Runs Vitest through the heavy-admission queue, handles `tests-deferred`, sanitizes `</test-failure-data>` prompt-injection tags in failure output, allows at most one Codex repair pass, and fails with `tests-red` if the second run fails.
- **`worktreeFingerprint(s, ...)` (`we:scripts/operations/codex-job.mjs:234-392`), `captureAuditExport(s)` (`we:scripts/operations/codex-job.mjs:321-355`), and `checkAuditedFiles(s)` (`we:scripts/operations/codex-job.mjs:360-373`) — REPLACE:** These functions attempt to detect mid-test and post-audit mutations by re-reading `git diff`, `git hash-object`, `lstat`, and `readFile` on the live lane worktree and comparing SHA-256 fingerprints (`testedFingerprint`, `testedExportFingerprint`, `auditFingerprint`, `auditExportFingerprint`). Replace all four with a single `captureSnapshotTree(s)` step that writes one Git tree object into `s.trustedDir` before tests run, so tests, `runAudit(s)`, and `commitAndPush(s)` all consume that frozen tree without ever re-reading `s.lane.path`.

## Risks

The snapshot adds one tree write and one extraction per attempt. Required dependencies and generated inputs need private copies in the disposable test directory; missing provisioning causes false reds (Done when DW-inputs). Scope filtering happens before `write-tree`; out-of-scope refusal is a blocking guarantee (Done when DW-scope).

## Test plan

These are **planned executable cases**, not tests present or run in this preparation PR. Every row is a required acceptance criterion for the rebuild. Use a real local bare origin and the production `runJob` wiring, injecting only model/test processes and observable filesystem/Git boundaries. Count actual push invocations and inspect the origin ref/tree; a refusal with zero pushes also leaves the origin unchanged. Run the focused suite through `npm run test:unit -- <planned-test-file>` from WE when implemented, omitting the `we:` locus prefix in the command argument. No manual grep substitutes for DW-no-read.

| Guarantee / Done-when ID | Planned test file | Planned case name | Fixture and observable assertion |
|---|---|---|---|
| DW-writer: escaped lane/testDir writers cannot feed publication | `we:scripts/operations/__tests__/codex-job.test.mjs` | `setsid-escaped writer preserves snapshot publication identity` | Spawn a real detached-session child (`setsid()` or the platform's equivalent session API); handshake proves a different session/process group, survival of group kill, and completed lane/testDir writes after test success and after audit. Record initial test inputs and audit diff, then assert the origin commit tree equals recorded `snapshotTreeSha` and every published blob/mode matches it. A second variant rewrites only testDir and still publishes the same tree; no directory-rewrite refusal is expected. Use bounded handshakes and kill the escaped PID in fixture cleanup. |
| DW-weakened: explicit weakened verdict refuses | `we:scripts/operations/__tests__/codex-job.test.mjs` | `WEAKENED audit verdict refuses publication` | Return structurally valid `WEAKENED: removed assertion`; assert `audit-failed`, zero pushes and unchanged origin. |
| DW-missing-verdict: absent/invalid verdict refuses | `we:scripts/operations/__tests__/codex-job.test.mjs` | `missing NOT WEAKENED verdict refuses publication` | Parameterize missing, empty, malformed and conflicting verdicts; assert `audit-failed`, zero pushes and unchanged origin. |
| DW-symlink: links refuse | `we:scripts/operations/__tests__/codex-job.test.mjs` | `symlink snapshot input refuses publication` | File and ancestor-directory links, including replacement during capture; assert refusal before tests, zero pushes, no outside-target bytes ingested. Include a base-tree link so post-tree validation is exercised. |
| DW-gitlink: submodules refuse | `we:scripts/operations/__tests__/codex-job.test.mjs` | `gitlink snapshot entry refuses publication` | Supply mode 160000 in a candidate/base tree; assert refusal before tests and zero pushes. |
| DW-bytes: capture never normalizes or omits raw edits | `we:scripts/operations/__tests__/codex-job.test.mjs` | `snapshot blobs equal no-filters lane bytes under attributes` | Separate fixtures for CRLF plus `text eol=lf`, `text eol=crlf`, expanded `$Id: ... $` plus `ident`, UTF-16LE plus `working-tree-encoding`, a sentinel clean filter, and `export-ignore`/`export-subst`. Include a base LF file with already-tracked `* text eol=lf`, then rewrite only its lane bytes to CRLF: even when Git reports no semantic diff, capture must include the raw edit rather than return `no-changes`. Assert captured blob OIDs equal `hash-object --no-filters` of the fixture buffers, blob bytes equal those buffers, sentinel filter never executes, and tested/published bytes agree. |
| DW-materialize: exports retain all files and modes | `we:scripts/operations/__tests__/codex-job.test.mjs` | `export-ignore snapshot files retain byte and mode identity` | Attribute-marked files remain present with literal substitution tokens; executable/non-executable modes match the tree and each exported blob equals `cat-file` bytes. |
| DW-scope: all changed paths are checked | `we:scripts/operations/__tests__/codex-job.test.mjs` | `out-of-scope changes refuse publication` | Otherwise successful jobs add/delete/modify/rename an out-of-scope file, including ignored and untracked `.github/` files, attribute-hidden CRLF-only edits, both rename directions across scope, a sibling prefix (`src-other` for `src/`), newline, CR, Unicode, quote, backtick and leading-dash paths. Assert `diff-out-of-scope` before tests and zero pushes; include valid in-scope punctuation/newline paths to prove NUL parsing preserves them. |
| DW-special: special files refuse without hanging | `we:scripts/operations/__tests__/codex-job.test.mjs` | `FIFO socket and device snapshot inputs refuse publication` | Real FIFO and Unix socket; descriptor-classifier injection for block/character devices on unprivileged hosts. Assert unsupported-type refusal before any blocking read, bounded completion and zero pushes for each type. |
| DW-metadata: lane Git metadata is data, never authority | `we:scripts/operations/__tests__/codex-job.test.mjs` | `git metadata tampering refuses publication` | Change `.git` indirection, config, HEAD/refs, index and hooks independently from the bootstrap baseline; assert `git-metadata-tampered`, zero tests/pushes and no hook/helper sentinel execution. |
| DW-inputs: tests retain private dependencies and generated inputs | `we:scripts/operations/__tests__/codex-job.test.mjs` | `snapshot tests retain required dependencies and generated inputs` | A test imports a required dependency and reads a manifested untracked generated file, then writes both private copies. Assert tests pass, primary bytes/inodes remain unchanged, dependency copies share no primary inode/link, copied package links resolve only inside the private tree, and neither test-only input enters the origin tree. Missing inputs, external/unresolved links or path collisions refuse provisioning with zero pushes. |
| DW-repair: repair starts from the prior snapshot | `we:scripts/operations/__tests__/codex-job.test.mjs` | `repair starts from prior snapshot and recaptures once` | First test fails, then mutate leftover lane/testDir files; record repair's initial files and assert they equal the prior snapshot. Its accepted edit produces a new capture used by the second tests, audit and origin tree. A second failure ends `tests-red` after exactly one repair and zero pushes. |
| DW-audit-source: audit consumes only trusted diff | `we:scripts/operations/__tests__/codex-job.test.mjs` | `audit reads only the trusted snapshot diff` | Rewrite lane/testDir before audit; record actual model argv, cwd, tool permissions and prompt input. Assert exact trusted base-to-snapshot diff, no mutable-directory content or lane file tools, and consistent snapshot identity. |
| DW-objects: real integrity failures refuse | `we:scripts/operations/__tests__/codex-job.test.mjs` | `snapshot object corruption refuses publication` | Between capture/audit and publication, corrupt the stored tree/blob payload under its original OID, remove an object, and inject unreadable/wrong-type object reads separately. Rehash actual payloads; assert `snapshot-integrity-failed`, zero `commit-tree`/push calls and unchanged origin. An intact-object control publishes the recorded tree. |
| DW-git-env: inherited Git configuration cannot execute | `we:scripts/operations/__tests__/codex-job.test.mjs` | `trusted git scrubs worker configuration and resolves remote once` | Inject inherited `GIT_*`, HOME/global/system configs, replacement refs, helpers, hooks, external diff, textconv and filters with execution sentinels; record env/argv at capture, audit and publication. Assert scrubbed values and zero sentinel execution; relative origin is resolved at bootstrap and later lane config/URL rewrites cannot redirect a push (metadata edits refuse). |
| DW-no-read: downstream phases cannot read the lane | `we:scripts/operations/__tests__/codex-job.test.mjs` | `no lane filesystem or git reads after snapshot capture` | Instrument the production filesystem and Git command boundaries (including direct imports): after each accepted capture, throw on lane-path reads, metadata calls, streams/open/directory traversal, or Git worktree/status/diff access. Exercise success, audit refusal, test failure/repair, integrity refusal and cleanup; reads occur only inside the next attempt's explicit capture. Assert zero downstream lane reads. A deliberate extra `lstat` in audit must make this test red even with unchanged bytes. |
| DW-capture-errors: ingestion bounds fail visibly | `we:scripts/operations/__tests__/codex-job.test.mjs` | `unreadable oversized and timed-out capture refuses publication` | Inject unreadable/disappearing input, per-file and total-size overflow, malformed NUL records and Git timeout. Assert a specific bounded capture refusal, operator-visible limit/error plus retry-in-new-attempt guidance, zero tests/pushes, and temporary-index cleanup; never publish a partial tree. |

## Done when

- **DW-writer (executable):** `setsid-escaped writer preserves snapshot publication identity` passes with confirmed post-kill writes and exact origin-tree equality.
- **DW-weakened / DW-missing-verdict (executable):** `WEAKENED audit verdict refuses publication` and `missing NOT WEAKENED verdict refuses publication` pass with zero pushes.
- **DW-symlink / DW-gitlink / DW-special / DW-metadata (executable):** `symlink snapshot input refuses publication`, `gitlink snapshot entry refuses publication`, `FIFO socket and device snapshot inputs refuse publication`, and `git metadata tampering refuses publication` pass each refusal variant.
- **DW-bytes / DW-materialize (executable):** `snapshot blobs equal no-filters lane bytes under attributes` and `export-ignore snapshot files retain byte and mode identity` pass byte/OID/mode assertions.
- **DW-scope (executable):** `out-of-scope changes refuse publication` passes every changed-path variant with `diff-out-of-scope` and zero pushes.
- **DW-inputs (executable):** `snapshot tests retain required dependencies and generated inputs` passes both usable-input and write-through/provisioning-refusal variants.
- **DW-repair (executable):** `repair starts from prior snapshot and recaptures once` passes fresh-input, one-repair and second-failure assertions.
- **DW-audit-source / DW-git-env (executable):** `audit reads only the trusted snapshot diff` and `trusted git scrubs worker configuration and resolves remote once` pass actual invocation/input assertions.
- **DW-objects (executable):** `snapshot object corruption refuses publication` refuses real payload corruption, missing/unreadable/wrong-type objects before commit/push.
- **DW-no-read (executable):** `no lane filesystem or git reads after snapshot capture` passes instrumented downstream branches and fails on an injected post-capture lane read.
- **DW-capture-errors (executable):** `unreadable oversized and timed-out capture refuses publication` passes every failure/cleanup branch.

All named cases above belong to `we:scripts/operations/__tests__/codex-job.test.mjs`; the Test plan table supplies the fixture and observable assertion for each Done-when ID. The implementation is not done until these cases exist and pass; preparation alone supplies no runtime coverage or mutation verdict.

## Prevention work register (filed with this decision; implementation still owed)

The recurring acceptance-mapping gate is already filed in [#5360](5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md) and [#5473](5473-prevention-add-the-named-planned-cases-and-a-deterministic-b.md). The following PR #5954 requirements extend that existing work; recording them does not claim those gates exist:

- **P1 — complete mappings:** in the planned `we:scripts/__tests__/check-backlog-item.test.mjs` case `prepared guarantees require named assertion mappings`, remove each guarantee/test-file/case/assertion cell in turn; preparation refuses each omission. Include Risks sentences containing `guarantee`, `refus` or `must`, and every invariant/refusal under Supported by default. Require a mapped Done-when ID; a filename elsewhere is insufficient.
- **P2 — skeptic traceability:** in the same planned test file, `skeptic survival claims require exercised Done-when attacks` rejects each SURVIVES line without a valid Done-when reference and complete attack/assertion mapping. A same-UID residual-risk statement must not be counted as prevention of the attack.
- **P3 — Git plumbing spike:** in the same planned test file, `Git plumbing sketches require a cited scratch spike` refuses completed preparation for a plumbing sketch without recorded command/input/output evidence. Retain a behavioral real-Git spike for every normalization-sensitive command; review checks semantics in addition to presence. The Fork 1 spike above satisfies the present card's evidence requirement.
- **P4 — linked-input boundary:** in the same planned test file, `provisioned paths require trust rows and write-through fixtures` refuses a provisioned/link path without its source, write semantics and named write-through assertion. The table above and DW-inputs use private copies; symlink or hardlink/chmod claims cannot satisfy read-only isolation.

DW-no-read is the deterministic instrumented runtime guard owed by this rebuild; P1–P4 are preparation-gate extensions, not a replacement for those behavioral tests. No gate implementation or preparation-template rollout is included in this design-only repair.
