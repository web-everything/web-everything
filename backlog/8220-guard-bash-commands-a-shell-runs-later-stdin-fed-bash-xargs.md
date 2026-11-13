---
bornAs: xw656tv
kind: story
size: 5
status: open
scaffoldedBy: "fix-6744"
dateScaffolded: "2026-11-12"
scope: ["we:scripts/guard-bash.mjs"]
dateOpened: "2026-11-12"
tags: []
related: ["6744"]
---

# guard-bash: commands a shell runs later (stdin-fed bash, xargs argv, aliases, trap, copied gated script) bypass every deny arm

The Bash guard (we:scripts/guard-bash.mjs) reads only the command line it is handed. Text that a shell runs later never reaches its deny arms: a script fed to `bash` on stdin (here-string, pipe, `bash -s`), `source <(…)`, arguments that `xargs` appends, an alias defined then used, a `trap` body, or a gated script copied under another name. The self-review of the PR 6744 repair showed each of these lets `--skipPrePrReview` (and `git push origin main`) through, unchanged from before that PR. This item makes the guard refuse, or read, each of those shapes.

## Acceptance

- [A1] **Executable** — `decide()` returns a deny for each of: `bash <<< 'git push origin main'`, `printf 'git push origin main' | bash`, `source <(echo git push origin main)`, `echo --skipPrePrReview | xargs node we:scripts/pr-land.mjs` (written with the plain repo path in the test), `alias p='git push origin main'; p`, `trap 'git push origin main' EXIT`; each returns null on the parent commit.
- [A2] **Executable** — the decoded argv value (`$'…'`, as added in PR 6744) is used by the shell `-c` option reader and the `npx --call=` reader too: `bash $'-\x63' 'git push origin main'` and `npx $'--c\x61ll=git push origin main'` are denied.
- [A3] Must: a shape the guard cannot read (unknown stdin source, unknown alias body) is refused, never allowed.
- [A4] **Executable** — an expansion that carries the whole gated command is refused: `"$@" --title=x` and `$X` (the expansion supplies `node <gated script> --skipPrePrReview`), a wrapper's argument (`env "$@" node …`, `timeout "$@" …`, `nice "$@" …`, `command "$@"`), and the arguments a `bash -c '…"$@"…' _ <args>` script receives. PR 6744 already refuses a multi-word expansion (`"$@"`, `"${a[@]}"`, `"${!x}"`, unquoted `$X`) in Node options and their values, the `-e` source, the script and operation words, and a multi-word command word followed by a visible gated script. It also still refuses an ordinary `$CMD $ARG` / `"$TOOL" "$F"` (a hidden command word is read as a possible gated script); this item narrows that over-refusal without opening the shapes above.
- [A5] **Executable** — the gated-script read does not fail open on runtimes other than `node` (`tsx`, `bun`, `deno run`, `npx tsx` with a gated script and the flag are denied), nor on a value-taking Node option missing from the hand-kept option list (`node --localstorage-file x <gated script> --skipPrePrReview` is denied).

## Non-goals

- [N1] Not a full shell interpreter: variable values set earlier in the same command are not tracked; such shapes fail closed under A3.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the stdin/here-string/xargs text is read with the same quote-aware scanner and decoded argv value as the command line.
2. **Truncated reads** — n/a: the guard reads one in-memory command string.
3. **Shared state files** — n/a: the guard is pure over the command text.
4. **Fail closed** — any later-run text the guard cannot read is refused (A3).
5. **Identity scoping** — n/a: applies the same to every agent session.
6. **State over time** — n/a: no persisted state.
7. **Who wrote it** — n/a: the guard judges command text, not its author.

## Duplicate admission

self-review of the PR 6744 repair found these same-class variants outside its argv-decoding fix
