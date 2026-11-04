---
kind: story
size: 8
parent: "7625"
status: open
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-11-03"
tags: []
---

# guard-bash: replace shell-state tracking with an allowlist that fails closed on unresolved git targets

Residuals from PR 6262 (R451), same family as 7625. Replace we:scripts/guard-bash.mjs shell-state tracking (assignments, declare, conditionals, eval, wrappers, tilde) with a narrower supported shell language: any git invocation whose target dir or refspec cannot be resolved statically, while a daemon clone is registered, is denied unless provably a lane clone. PR 6262 now implements an explicit daemon Git read classification, unknown-option refusal, compound export tracking, persisted remote.*.fetch config reads, config/remote mutation protection and the tilde/HOME, declare/local, SPEC and bundled-flag checks. Those are delivered safeguards, not residual bypass claims. This card retains the broader shell-language redesign; its acceptance design remains outstanding.

## Acceptance

- [A1] **Executable** — with a daemon clone registered, a command whose Git target directory, refspec, wrapper
  directory or code-running environment cannot be resolved statically is denied, unless it is proven to touch
  only a lane clone. Named test: a new `describe('allowlist shell language')` block in
  `we:scripts/__tests__/guard-bash.test.mjs`. It must turn red on the current tracker. The two back-edge shapes in
  the round-11 residual below are its first rows: a function defined before the export, and a loop body that
  exports after the write.
- [A2] **Matrix** — one deterministic test crosses every wrapper and its directory options (`env -C/--chdir`,
  `sudo -D/--chdir`, `env -S`) with every `FS_MUTATING_PROGRAMS` entry and a redirect. It also crosses every
  `DAEMON_GIT_READS` entry with each `GIT_CODE_ENV` name, each code-running `-c` key and option, and a redirect
  into a clone. Every crossed cell must deny at a protected target. PR 6262 already ships the wrapper × writer
  half and the env × read half (`A2 wrapper matrix with non-git file-writing children`, `GIT_CODE_ENV: every
  listed name makes a daemon-clone read unsafe`). This item adds the `-c` key, option and redirect columns.
- [A3] **No new over-deny** — the lane-push idiom table (`lane push idiom verdicts (intended, recorded)`) and the
  existing allow lists stay green unchanged. Any change to a recorded verdict is an explicit decision, written in
  this card.

## Risks

- R1: a narrower shell language denies idioms agents use today. Covered by A3: the recorded verdict tables must
  stay green.
- R2: a new wrapper or env name ships without a matrix row. Covered by A2: the test iterates the exported
  constants whole, so a new entry gets its row automatically.

## Test plan

- A1 → the new `allowlist shell language` describe block (red before, green after).
- A2 → the two matrix describe blocks named above, plus the new `-c` key, option and redirect columns.
- A3 → `lane push idiom verdicts (intended, recorded)` and the existing allow-list tests in the daemon-clone
  describe block.

## Non-goals

- [N1] No change to the lane, primary-tree or wait-poll arms. Only the daemon-clone decision changes.
- [N2] No runtime sandboxing. The guard stays a static, pure classifier of the command text.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the command text is the untrusted input. Quoting, `$`/backtick expansion, ANSI-C
   strings, `-S` split strings and tilde forms are each either resolved or denied.
2. **Truncated reads** — a command cut off before an option value or a subcommand is denied with a named reason
   (the A1 truncated-inventory test).
3. **Shared state files** — the only file read is the clone's own `remote.*.fetch` config. A failed or partial
   read returns null, and null denies.
4. **Fail closed** — an unknown wrapper option, an unknown global flag or an unmodelled writer of a protected name
   denies at a protected target. It never guesses.
5. **Identity scoping** — n/a: the guard has no identities. It judges one command against the registered clone
   roots.
6. **State over time** — the scope tracker models text order today. Back-edges (loops and earlier-defined
   functions) are A1's first rows.
7. **Who wrote it** — n/a: every command is treated the same, whoever wrote it.

## Audit finding carried from PR 6262 (R451)

The final audit found one origin/main deny that HEAD no longer denies: `git branch -C <name> <copy>` read as a `-C <dir>` target on main (a false positive, since `branch -C` copies a branch). The new parser stops reading `-C` at the subcommand. No protected-clone write bypass was shown. Decide in the allowlist redesign whether to restore a deny for this shape.

## Residual carried from the PR 6262 judge send-back (round 11)

The send-back made unmodelled writers (`read`, `printf -v`, `for NAME in`, `+=`, `let`, `getopts`, `mapfile`, declaration builtins, eval/source) of GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR and GIT_CONFIG* fail closed for the whole scope, so loop back-edges and earlier-defined functions are covered for them. A MODELLED export reached through a back-edge is still read in text order and stays open: `g(){ git reset --hard; }; export GIT_DIR=<clone>/.git; g` and `while :; do git reset --hard; export GIT_DIR=<clone>/.git; done` are allowed. The allowlist redesign should close it (a function call or loop body runs with every value its scope assigns).

## Residuals carried from the PR 6262 advisory (round 13) — both also on main

- A git command classed as a read (`DAEMON_GIT_READS`) returns before any redirect target is checked: a `git status` or `git log` redirected into a file under a daemon clone, run from a lane, writes inside the clone.
- A read can still run code in the clone: a bare `--ext-diff` or `--textconv` (which run the clone's own configured programs), and a `GIT_CONFIG*` file set by an earlier statement (reads after it are a pinned allow). Since the 09:49Z advisory round these are closed: every `GIT_CODE_ENV` name is denied as a command prefix (behind `env`/`time` anywhere, bare at a clone target) or when exported earlier in the command; a `GIT_TRACE*` file inside a clone counts as a write; and a global `-c`/`--config-env` key outside the known-harmless list, or `--exec-path`, makes a read judged by its target.
- Writers the guard does not model even unwrapped: `dd of=`, `find -delete` / `-exec`, `tar -x -C`, `unzip -d`, `ditto`, interpreters (`node -e`), and operands it cannot see (`echo <clone>/x | xargs rm`, `rm $D/x`). Paths are compared after `resolve()`, not `realpath`, so a symlinked alias of a clone root is not matched.
- Prevention asked for: a deterministic matrix test — every `DAEMON_GIT_READS` entry crossed with a redirect into a clone and with each code-running env / `-c` key / option — that must deny at a protected target.
