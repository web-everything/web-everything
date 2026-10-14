---
bornAs: xgf9hl7
kind: story
size: 3
status: open
scope: ["we:scripts/codex-direct-task.mjs", "we:scripts/__tests__/codex-direct-task.test.mjs"]
dateOpened: "2026-09-30"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#3208's independent review

Filed mechanically by the unattended review loop (#2749) — every finding below reduced chalbert/web-everything#3208's review (reviewed head `4d0327b28c313abf70fd3c69a852414c92f82349`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/codex-direct-task.mjs:824` — In the same code path, `mkdirSync(lockRoot,{recursive:true})` before spawning. Add a test that uses a nonexistent pool override and asserts the directory exists when the child is spawned.
2. `we:scripts/codex-direct-task.mjs:826` — Add a unit test and guard in codexDirectTask that refuses or narrows the writable gitdir when it equals a common dir containing hooks/config, for example by requiring a linked worktree or passing core.hooksPath=/dev/null. Longer term, a check:standards rule that flags any writable_roots entry resolving to a .git common dir.
3. `we:scripts/codex-direct-task.mjs:204` — Pass a filtered env to non-review runs (an allowlist or stripped *_TOKEN and secret vars, with a read-only GH token only where needed), and add a test that the spawn env excludes the write-scoped token. A check:standards rule could flag spawn(..., {env: process.env}) in codex job launchers.
4. `we:scripts/codex-direct-task.mjs:210` — A lint rule that flags the use of .some() or .every() on an array without a preceding length check, to prevent vacuous truth bugs.
5. `we:scripts/codex-direct-task.mjs:822` — A reviewer checklist or lint rule enforcing that scripts accepting a custom `env` object must extract environment variables (like TMPDIR) from that object rather than using global accessors like `tmpdir()`.

## Operator ruling (2026-10-13 ~13:25 ET) — finding 2

The prepare was blocked with needs-ruling on finding 2: whether to reject ordinary clones by requiring linked worktrees, or keep clone support with a narrower Git-metadata permission. The operator chose (b), "ok. using settings and policies if makes sense":

- **Keep scratch clones and lane clones supported.** Every lane is an ordinary clone today, so requiring worktrees would break all Codex tasks.
- **Narrow what the sandbox may write.** Codex keeps write access to the git objects and refs it needs to commit, but `.git/hooks/` and `.git/config` are not writable inside the sandbox. Every git invocation in the sandboxed run carries `core.hooksPath=/dev/null`.
- **As a setting/policy.** The protected git-metadata paths and the hooks override are a cascade setting (e.g. `codex.sandbox.gitMetadata { protectedPaths: ["hooks", "config"], disableHooks: true }`). It is documented and logs its source layer. The default is protected, and no layer may widen it without the override being logged.
- **Test.** A hook or config written by the sandboxed run is refused or never executed by a later git call. Also cover a linked-worktree gitdir and a clone gitdir.
- **Later option, not in this card.** Moving lanes to linked worktrees and then requiring them.

Findings 1, 3, 4 and 5 need no ruling and are delivered as written. Prefer a setting wherever a finding names a policy choice, e.g. the env allowlist in finding 3.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.
