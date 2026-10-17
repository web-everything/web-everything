---
bornAs: xj0teal
kind: story
size: 2
status: resolved
scope: ["we:scripts/guard-bash.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-10-12"
dateStarted: "2026-10-15"
dateResolved: "2026-10-15"
preparedDate: "2026-10-15"
preparedAgainstSha: "37d55ee65aad06d177e15de929b4115762a3b0bf"
tags: []
---

# Guard-bash resolves home paths before matching daemon-clone and lane paths

Held finding 248: a leading cd written with home shorthand must identify the same protected daemon clone or owned lane as its absolute spelling. Prevent the reported drain-clone detach bypass without executing shell expansion during inspection.

## Progress

- PR #5403 takeover: restored the operator-approved b13b289fa guard and tests; retained no later implementation changes. Added resolver and real-hook deny regressions for `D=~/x; D=<clone>; ( D=/tmp ); cd "$D" && git checkout --detach`. The baseline already preserves the known parent value across this subshell assignment.

- Rechecked at 37d55ee65. Original scope named only `we:scripts/guard-bash.mjs` and asked to expand tilde and HOME before matching paths. The defect remains: `we:scripts/guard-bash.mjs:2469` strips quotes, recognizes only whole-variable targets backed by command-local assignments, then resolves a tilde literally against the reported cwd. HOME with a suffix falls back to reported cwd. The CLI uses this result before both daemon-root and lane-lease classification at `we:scripts/guard-bash.mjs:4348`.
- Corrected scope includes `we:scripts/__tests__/guard-bash.test.mjs`. Its daemon CLI harness at `we:scripts/__tests__/guard-bash.test.mjs:3421` already provides temporary registry roots and subprocess hook invocation. Keep this task on leading-cd resolution and downstream classification; direct git -C and arbitrary file operands are separate parser surfaces (`we:scripts/guard-bash.mjs:1863`, `we:scripts/guard-bash.mjs:1938`).
- Increase size 1 to size 2: approximately 55 source lines for quote-aware, injectable home expansion and 100 test lines for resolver plus hook cases. Evidence: quote removal currently precedes expansion at `we:scripts/guard-bash.mjs:2470`, so blind string replacement would incorrectly expand quoted tilde and single-quoted HOME. The existing hook harness keeps proof within the same test file.

- Built 2026-10-15: `resolveEffectiveCwd` now expands the leading-cd target quote-aware (`expandCdTarget`), takes an injectable `home` (default `process.env.HOME`, `null` = unset), applies HOME assignments preceding the cd and treats a `HOME=` it cannot evaluate as unknown, while preserving the base literal-variable assignment collection. Pure resolver cases plus real-hook daemon-clone cases (deny `git checkout --detach`, allow `git status`, quoted/single-quoted/unset controls) added to the guard test file.

## Design

Resolve supported home forms in the leading cd argument before absolute/relative path normalization. Support bare tilde, unquoted tilde-slash, unquoted HOME/braced HOME with a suffix, and double-quoted HOME forms, including home paths containing spaces. Preserve quoting information until expansion is complete: quoted tilde and single-quoted HOME are literal shell text, not home aliases. Reuse the existing parser/token information where possible instead of evaluating shell text.

Use the hook process's HOME as the shell's home source, with an injectable value for unit tests; honor literal command-local HOME assignments preceding the cd. Preserve the base resolver’s existing literal-variable collection for ordinary lane targets; broader assignment and scope analysis belongs to #x5tbryq. An unset HOME must not fabricate an absolute home target; unsupported substitutions retain the existing unresolved-target behavior. Never invoke a shell, expand arbitrary environment variables, or execute substitutions to discover a path.

Feed the resolved path through the existing realpath, daemon registry and lane lease checks. Home spelling confers no authority: a registered daemon clone under the lane tree is still protected, and a foreign/contested lane remains subject to the same refusal as its absolute path.

## MVP

Implement home-aware leading-cd resolution in the existing guard, preserving the current public call shape with an optional injected home context if needed. Add pure resolver cases and real hook-process cases using temporary home/registry fixtures. No edits to actual daemon clones, leases or user HOME.

## Test plan

In `we:scripts/__tests__/guard-bash.test.mjs`, compare shorthand with absolute paths for tilde, HOME, braced HOME, double quotes, trailing slash, spaces and dot segments. Negative controls: quoted tilde, single-quoted HOME, unknown variables, command substitutions, heredoc body text, missing HOME and assignments after cd. Pin existing literal lane-variable behavior.

Extend the temporary registry CLI harness: from an unrelated reported cwd, submit a home-spelled cd followed by git checkout --detach and require deny for the registered clone. Assert git status remains allowed. Check the resolver's lane root and the existing own/foreign/contested lane classification with equivalent absolute and home-spelled targets. Use inert command strings; the hook inspects them and must never execute the proposed checkout. Verify fixture cleanup and no changes to real registry files.

Run the scoped suite and standards gate only through the host heavy queue.

## Proof plan

Capture the resolver's incorrect current result and hook decision for the isolated daemon fixture, then the corrected absolute target and deny output after implementation. Compare each with the already-protected absolute spelling. Include the read-only control and quoted-literal controls so the fix proves both protection and shell-compatible interpretation. No live detach or daemon restart is authorized or needed.

## Acceptance

Supported leading-cd home forms reach the same daemon and lane guards as their absolute equivalents. Quoting preserves literal paths, and no inspected command is executed.

## Non-goals

No general shell interpreter, named-user tilde lookup, arbitrary variable expansion, daemon registry redesign, lease-policy change or repair of an already detached clone. Direct git -C and explicit file-operand expansion remain outside this leading-cd fix.

## Edge cases

Treat input as untrusted syntax. Unterminated quoting and unresolved substitutions keep existing conservative handling; this patch must not introduce an allow override. Keep realpath matching and registry ownership intact. Tests use isolated temporary state; no production shared files are written. This is a local inspection hook, not a new network endpoint, so HTTP body/rate/CSRF controls do not apply.

## Follow-ups

Audit home expansion in direct git -C targets and filesystem operands separately; both currently use independent resolution sites. Do not claim this leading-cd fix closes every shell spelling of a protected path.

## PR #5403 scope correction

Removed the all-landings subsystem and restored the base parser and single-directory CLI checks. The patch adds only home-target expansion and unresolved bracket-glob handling; ordinary variables retain the base resolver semantics. Regressions pin nested-subshell fallback, parent values across subshell assignments, and readonly/export declarations without values. All-landings analysis is deferred to #x5tbryq, with implementation paths `we:scripts/guard-bash.mjs` and `we:scripts/__tests__/guard-bash.test.mjs`.
