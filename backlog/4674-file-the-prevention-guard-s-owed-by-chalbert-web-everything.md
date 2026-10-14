---
bornAs: xgf9hl7
kind: story
size: 8
status: open
scope: ["we:scripts/codex-direct-task.mjs", "we:scripts/settings/codex-sandbox.json", "we:scripts/__tests__/codex-direct-task.test.mjs", "we:scripts/__tests__/codex-direct-task-sandbox.test.mjs"]
dateOpened: "2026-09-30"
preparedDate: "2026-10-13"
preparedAgainstSha: "9a06b7c3cc60135cae188de7755ee0c730d9c93a"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3208's independent review

Filed mechanically by the unattended review loop (#2749) — every finding below reduced chalbert/web-everything#3208's review (reviewed head `4d0327b28c313abf70fd3c69a852414c92f82349`) to prevention-outstanding by naming a guard neither captured nor filed:

Current prevention obligations (locations rechecked during preparation; historical citations and corrections below):

1. `we:scripts/codex-direct-task.mjs:831` — create the resolved admission lock directory before spawning; test a nonexistent pool override at the spawn boundary.
2. `we:scripts/codex-direct-task.mjs:831` — replace the unrestricted Git-directory grant with the protected-metadata policy ruled below, for both clones and linked worktrees.
3. `we:scripts/codex-direct-task.mjs:671` — filter the non-review child environment; prevent inherited write-scoped credentials from reaching it and test the actual spawn options.
4. `we:scripts/codex-direct-task.mjs:210` — distinguish an intentionally empty optional list from an empty list being used as evidence of completeness. Preserve valid empty optional roots; cover required permission-plan cardinality explicitly. The originally suggested blanket quantifier lint has a false-positive premise here.
5. `we:scripts/codex-direct-task.mjs:830` — derive the temporary base from the supplied environment, with a documented fallback. Cover scratch-clone allocation too (`we:scripts/codex-direct-task.mjs:527`). Add a local reviewer checklist beside the environment-aware helper.

## Operator ruling (2026-10-13 ~13:25 ET) — finding 2

The prepare was blocked with needs-ruling on finding 2: whether to reject ordinary clones by requiring linked worktrees, or keep clone support with a narrower Git-metadata permission. The operator chose (b), "ok. using settings and policies if makes sense":

- **Keep scratch clones and lane clones supported.** Every lane is an ordinary clone today, so requiring worktrees would break all Codex tasks.
- **Narrow what the sandbox may write.** Codex keeps write access to the git objects and refs it needs to commit, but the Git hooks directory and Git config file are not writable inside the sandbox. Every git invocation in the sandboxed run carries `core.hooksPath=/dev/null`.
- **As a setting/policy.** The protected git-metadata paths and the hooks override are a cascade setting (e.g. `codex.sandbox.gitMetadata { protectedPaths: ["hooks", "config"], disableHooks: true }`). It is documented and logs its source layer. The default is protected, and no layer may widen it without the override being logged.
- **Test.** A hook or config written by the sandboxed run is refused or never executed by a later git call. Also cover a linked-worktree gitdir and a clone gitdir.
- **Later option, not in this card.** Moving lanes to linked worktrees and then requiring them.

Findings 1, 3, 4 and 5 need no ruling and remain delivery obligations; the factual correction to finding 4 is recorded in Progress. Prefer a setting wherever a finding names a policy choice, e.g. the env allowlist in finding 3.

## Progress

Preparation research on 2026-10-13 against `9a06b7c3cc60135cae188de7755ee0c730d9c93a`; no preparation stamp applied.

- **Old premise/scope:** five mechanically captured recommendations at historical launcher lines 824, 826, 204, 210 and 822, with only the launcher and its existing unit test in scope, size 3. **Corrected premise/scope:** the runtime gaps remain at `we:scripts/codex-direct-task.mjs:830`, `we:scripts/codex-direct-task.mjs:831` and `we:scripts/codex-direct-task.mjs:671`. The operator ruling additionally requires a settings policy and real sandbox evidence, so add planned `we:scripts/settings/codex-sandbox.json` and planned `we:scripts/__tests__/codex-direct-task-sandbox.test.mjs`. The story is not already delivered.
- The existing permission test at `we:scripts/__tests__/codex-direct-task.test.mjs:853` checks argument construction and that a private temp directory exists, but never asserts the admission directory exists at spawn. Its custom TMPDIR is a nonexistent placeholder and its assertions currently accept allocating elsewhere. The linked-worktree test at `we:scripts/__tests__/codex-direct-task.test.mjs:776` expects the whole Git directory to be writable; update that expectation, retaining the log/output-location checks.
- Finding 4's **old premise** was that any quantifier without a preceding length check is a vacuous-truth defect. **Corrected premise:** the optional roots list defaults to empty at `we:scripts/codex-direct-task.mjs:171`; `.some()` at line 210 rejects invalid members and line 214 intentionally omits an empty override. Also, `runGate` builds a nonempty execution plan before `.every()` (`we:scripts/codex-direct-task.mjs:600`). A blanket ban would reject correct code. Preserve the prevention goal with explicit required-plan cardinality tests and a local review checklist, not a repository-wide syntactic ban.
- Settings already have shared mechanisms: feature-file ownership in `we:scripts/lib/settings-files.mjs:8`, cascade resolution in `we:scripts/lib/policy-cascade.mjs:176`, and source formatting in `we:scripts/lib/policy-cascade.mjs:132`. Reuse these without editing them. The existing conditional logger at `we:scripts/lib/policy-cascade.mjs:153` can be disabled; a policy widening must therefore also produce an unconditional launch audit record without secret values.
- Observed installed CLI version: `codex-cli 0.162.1`; its sandbox help exposes named permission profiles. [Official permission documentation](https://developers.openai.com/codex/permissions) describes profile inheritance, specific-path precedence and read/write entries, and says not to mix profiles with legacy sandbox configuration. This supports the proposed mechanism, **not a claim that enforcement has been proved**; the required real-sandbox proof is below.
- **Size 3 → 8:** estimate approximately 460 changed lines: launcher 180 (environment, Git metadata, profile construction and audit), feature settings 20, existing tests 150, real-sandbox tests 110. The work is grounded in the spawn boundary at `we:scripts/codex-direct-task.mjs:671`, allocation at `we:scripts/codex-direct-task.mjs:830`, existing permission assertions at `we:scripts/__tests__/codex-direct-task.test.mjs:853`, and the settings ownership rule cited above. This is a story, so no `estimatedLoc` is added.
- Consumer checked: `we:scripts/conveyor/concurrent-baseline-comparison.mjs:175` delegates to the existing API; preserve its signature and result shape. No consumer edit is planned. The independent parked-PR reviewer owns preparation review; the runner owns checks and stamping.

## Design

Implement the five obligations in the existing launcher, keeping its public entry points and report fields compatible. Add internal helpers for resolving policy, building a permission plan, filtering child environment and resolving the temporary base. Pass resolved values explicitly between `codexDirectTask`, `runCodexDirectExec` and the argv builder; direct use of the exported execution helper must not bypass environment filtering or metadata policy. Invalid policy/path input fails before spawn with an actionable error and no unprotected retry.

1. **Settings and provenance.** Add planned `we:scripts/settings/codex-sandbox.json`, owning `codex.sandbox` only, read through the existing settings reader from the launcher's trusted installation, not the target checkout. Resolve through the existing cascade with protected defaults: `gitMetadata.protectedPaths: ["hooks", "config"]` and `gitMetadata.disableHooks: true`. Validate relative descendants (reject traversal, absolute entries and malformed lists). Add an environment policy with explicit allowed names and denied credential patterns; default denial covers token, secret, password and private-key variables plus Git configuration injection variables. Preserve the runtime essentials needed for PATH, home-based Codex authentication, locale, routing and admission. Do not infer GitHub token privilege from a variable name: no inherited GitHub token is forwarded by default. Log effective policy and source layers, never environment values. Any explicit relaxation must emit an unconditional warning/audit line before launch, even when routine cascade logging is off. Invalid values keep the protected lower-layer value and are identified in that record.
2. **Git metadata.** Resolve and canonicalize both the worktree Git directory and common directory, deduplicate clone paths, and build a named permission profile extending the workspace baseline. Permit the job's Git bookkeeping and commit operations while making configured protected descendants read-only in both locations. Protect worktree-specific config as well when present. Validate root overlaps so the admission/temp grants cannot reopen a protected descendant. Preserve other baseline protected paths. Use the named profile for edit runs rather than combining it with legacy sandbox switches. Review runs retain their read-only mode and receive no edit roots. Keep network behavior equivalent to the current edit launcher. Refuse an unsupported/unusable profile rather than silently granting the entire common directory.
3. **Hooks.** Supply `core.hooksPath=/dev/null` through Git's process-environment configuration for Git commands inherited by the sandboxed shell, stripping conflicting inherited Git configuration variables first; the launcher's own Git subprocesses use an explicit equivalent override. Pin the setting in the child shell policy so normal shell initialization does not lose it. This is an inherited Git default, not a claim that environment variables are tamper-proof against arbitrary code: filesystem protection remains necessary, and the proof includes a later ordinary Git invocation outside the job. Explicit command-level attempts to override hooks must be included in the security test and any residual limitation reported, not hidden behind argv assertions.
4. **Environment and paths.** Select temporary storage from the supplied environment's TMPDIR, then TMP, then TEMP, falling back to the OS default only when none is supplied. Reject an explicitly selected nonexistent/non-directory base with a clear error; do not silently substitute the parent's environment. Thread the same resolution into scratch-clone allocation. Create the admission directory recursively before spawning. Filter a copy of the environment, then set the private TMPDIR/TMP/TEMP and Git overrides; never mutate the caller's object. Keep review behavior separate from edit-only grants.
5. **Prevention guard.** Add a short reviewer checklist beside these helpers covering supplied-env provenance, required nonempty permission plans, optional empty collections, common-directory protection and spawn-time directory existence. Tests enforce these concrete invariants. This replaces finding 4's unsound blanket lint while preserving its empty-input prevention objective; the broader lint suggestions remain follow-ups.

## MVP

**Must:** all five corrected obligations; protected defaults with source logging; ordinary clone, scratch clone and linked-worktree compatibility; actual admission-directory creation; filtered non-review spawn environment; supplied-env temp allocation; empty-input regression cases; and a real sandbox proof of Git protection with successful permitted writes. The existing API, diff capture and review-only permissions remain compatible.

Build in one cohesive change: first add failing regressions, then policy/settings and helper seams, then wire allocation/spawn/argv, then run the sandbox proof. Do not activate a partially implemented metadata policy. A failing enforcement probe blocks delivery; mocked tests alone cannot satisfy this item.

**Could, outside MVP:** cross-launcher static analysis and a migration to linked worktrees. Neither is required to make the direct launcher safe under the ruled policy.

## Test plan

- Extend existing `we:scripts/__tests__/codex-direct-task.test.mjs`: assert the overridden admission directory exists **inside the spawn callback**, verify unique temp roots beneath a real supplied TMPDIR, test TMP/TEMP fallback and invalid bases, and cover scratch creation. The original behavior must fail the admission and supplied-temp tests.
- In the same test file, inspect spawn env with synthetic GH_TOKEN, GITHUB_TOKEN, arbitrary token/secret/password values and conflicting Git config variables; assert denied values are absent, required operational names survive, overrides are pinned, and the original env is unchanged. Cover direct `runCodexDirectExec` callers too.
- Cover settings precedence, invalid-value fallback, protected defaults, explicit widening audit despite routine logging being disabled, and secret-free diagnostics. Load planned `we:scripts/settings/codex-sandbox.json` through the shared reader in these tests; this is its matching test coverage.
- Cover empty optional roots as valid, malformed entries as invalid, and an empty/missing required metadata plan as a pre-spawn failure. Preserve review's lack of edit grants. Update the existing linked-worktree assertions to inspect protected paths and common-dir resolution instead of expecting an unrestricted root.
- Add planned `we:scripts/__tests__/codex-direct-task-sandbox.test.mjs` for disposable real clone/worktree fixtures and the installed CLI sandbox. Exercise the exact generated policy without calling a paid model. Attempt append, replacement/rename and recreation of protected config/hooks, including absent paths and symlink aliases; verify denial and unchanged contents. Verify permitted source, index, object, ref, temp and admission writes and a local commit. Plant a harmless marker hook before launch and confirm it does not execute under the inherited override. Attempt planting a new hook/config inside the sandbox, then run Git outside it and confirm no injected marker executes. Run with malicious inherited Git configuration as well as clean env.
- All execution uses the host heavy queue. The runner can run the existing test now; the builder runs both files after implementation with `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/codex-direct-task.test.mjs we:scripts/__tests__/codex-direct-task-sandbox.test.mjs`. Here `we:` denotes repository-relative paths and must be stripped for shell execution. Also run `node we:scripts/readiness/heavy-admission.mjs run -- npm run check:standards` with the same path translation. Do not treat a skipped or unsupported sandbox test as successful enforcement evidence.

## Proof plan

Retain the exact CLI version, platform, resolved policy/source record, queued commands, exit statuses and sanitized assertions from disposable fixtures. Before implementation, demonstrate failures for missing admission directory, ignored supplied TMPDIR and forwarded synthetic write-token values. After implementation, demonstrate those same cases passing and the real sandbox refusing protected writes while a permitted local commit succeeds for both clone and linked-worktree layouts. Scratch-clone allocation must also use the supplied base.

Distinguish policy serialization from OS enforcement: fake-spawn tests prove only the former. Capture the actual sandbox's failed writes and absent hook marker, plus unchanged config bytes after later Git execution. If the host cannot execute the sandbox probe, report the limitation and leave delivery unproved; do not weaken the policy to get green tests. No claim of current enforcement or test passage is made by this preparation.

## Follow-ups

- After the local regressions establish correct semantics, extend prevention across other launchers: analyze unconditional raw environment forwarding and unprotected common-directory grants, accounting for narrower protected-path rules. This is broader coverage, not a prerequisite for this launcher's fixes.
- A general quantifier lint needs a semantic contract identifying required nonempty collections; a syntax-only `.some()`/`.every()` ban is not sound. Carry the local checklist and regression examples into any later rule proposal.
- A cross-launcher supplied-env audit may flag global temp accessors, but must allow the documented fallback when no custom temp variable exists.
- Lane migration to linked worktrees remains the operator's explicitly deferred option. Do not require it here and do not change dependency edges.

## Done when

1. The queued unit tests fail against the original missing-directory, ignored-env and credential-forwarding behavior, then pass with the implementation.
2. The real sandbox test proves protected Git metadata cannot be planted or replaced, permitted Git operations still work, and the hook marker stays absent; clone and linked-worktree cases both pass.
3. Protected settings and any relaxation have visible source provenance without secret values; review mode retains read-only permissions.
4. All scope entries have matching tests as described, and the queued standards gate passes. Runner-owned preparation checks and independent review precede stamping.
