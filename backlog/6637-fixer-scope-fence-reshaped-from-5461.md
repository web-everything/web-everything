---
bornAs: x2w653g
kind: story
size: 8
status: open
scopeRationale: "Acceptance paths outside scope are synthetic fixture paths in temporary test repositories, except we:scripts/lib/repo-profile.mjs, which is an existing read-only prefix-resolution dependency. The scope lists the implementation and test files to edit; fixture paths are not repository deliverables."
scope: ["we:scripts/conveyor/fix-scope-fence.mjs", "we:scripts/conveyor/fix-scope-fence-io.mjs", "we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs", "we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/__tests__/await-verify-pass.test.mjs", "we:scripts/conveyor/__tests__/await-verify-pass-push-before-gate.test.mjs", "we:scripts/conveyor/fix-context-pack.mjs", "we:scripts/conveyor/reconcile-fix-dispatch.mjs", "we:scripts/conveyor/__tests__/reconcile-fix-dispatch.test.mjs", "we:scripts/conveyor/__tests__/fix-round-history.test.mjs", "we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/soak/breaks/fix-scope-merge-bypass.mjs", "we:scripts/conveyor/soak/breaks/fix-scope-merge-bypass.soak.test.mjs", "we:scripts/operations/operator-queue.mjs", "we:scripts/operations/__tests__/operator-queue.test.mjs", "we:scripts/settings/fix-scope-fence.json", "we:skills-src/conveyor/fix-agent-brief.md", "we:docs/agent/testing.md"]
dateOpened: "2026-10-20"
tags: []
relatedTo: ["5467"]
---

# Fixer scope fence: no widening or re-adding operator-removed code (re-shaped from #5461)

Re-shaped from closed PR #5461 (14/12 review rounds, 3 recurring red-team breaks): fence the fixer to its declared scope and block re-adding operator-removed identifiers, with every confirmed break as a named acceptance test.

## Why this card exists

PR #5461 (`lane/scope-fence`) ran out of review auto-repair rounds (14/12), drifted into merge conflicts with `main`, and kept failing the post-accept red team on the same three breaks across four heads (`4e3ab4774d5b`, `869bce730162`, `3373a3326ef2`, `4752c275333c`). Operator ruling 2026-10-20, verbatim "ok" to: "Re-shape it: close this PR and re-file it as a fresh card, with the 3 confirmed breaks written in as acceptance tests. The builder then does it once, properly, against current main."

#5461 was item-less (no originating card). This card folds in the two follow-up cards filed from its red team, which assumed the PR would land: #6193 (merge-aware net change + 12 findings) and #6229 (human-review send-back header). Both are closed not-built as `duplicate` into this card; their findings are carried below.

**Prior work to reuse:** branch `lane/scope-fence` @ `bbc07d596fff002766588b4672e0e7dadeabecd1` (19 files, +1540/-42 vs main at close). Reuse its pure core, adapter, settings cascade and tests where they hold, but rebuild on current `main`; do not merge the old branch wholesale.

## Intent (unchanged from #5461)

The fixer agent widened its own scope: it re-added code the operator had removed, and it edited files outside the scope its brief declared. Operator-removed code could come back on the next fix round without anyone seeing it.

- Fix briefs carry the declared scope and the operator's exclusions (`scope-removed: <identifier>` markers) forward (`we:scripts/conveyor/fix-context-pack.mjs`, `we:skills-src/conveyor/fix-agent-brief.md`).
- Every fixer push path (early, green, salvage in `we:scripts/conveyor/await-verify-pass.mjs`) checks the fixer's own net change before pushing: out-of-scope paths and re-introduced marked identifiers are refused. A needed scope increase goes to needs-you (`we:scripts/conveyor/stand-down.mjs`, `we:scripts/operations/operator-queue.mjs`), never passes silently.
- Cascaded settings `we:scripts/settings/fix-scope-fence.json` with `stand-down` and `warn` modes; the source of each resolved setting is logged. Default stays `warn` until warn-mode data shows a low false-positive rate.

## Acceptance

Every case below is a named test in `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` unless another file is named. Each must fail on current `main` (the fence does not exist there) and pass after. "Refused" means `scopeFenceDecision` returns a non-push action with a violation naming the path or identifier, and the push sink is never called.

### The three recurring confirmed breaks (operator-named)

- [A1] **`keeps a literal # in a diff-derived filename; never truncates it to a directory`** — item-less PR whose diff touches only `we:scripts/conveyor#note.txt`; fallback scope is `we:scripts/conveyor#note.txt`. A repair editing `we:scripts/conveyor/await-verify-pass.mjs` is **refused**; a repair editing `we:scripts/conveyor#note.txt` is pushed. Run it with a `.mjs` extension too, as the red team did (written as `.txt` here only because this card's path linter splits on `#`). (Red team at `we:scripts/conveyor/fix-scope-fence.mjs:88` / `:89`, heads `869bce730162` and `4752c275333c`.)
- [A2] **`resolves canonical fui: and plateau: scope prefixes to their repository`** — the Frontier UI repo, scope `fui:src/guard.mjs`, changed path `fui:src/guard.mjs` → **pushed**, no violation, in both `warn` and `stand-down` mode, and no stand-down write. Same for the Plateau app repo with `plateau:src/guard.mjs`. Control: a `fui:` entry does not authorize a path in the Web Everything repo. Prefixes resolve through `we:scripts/lib/repo-profile.mjs`, not a hand-kept key list. (Heads `4e3ab4774d5b`, `869bce730162`, `4752c275333c`.)
- [A3] **`a file scope never authorizes descendants when the file is replaced by a directory`** — two sub-cases, both **refused**: (a) scope `we:guard.mjs`, changed paths `we:guard.mjs` and `we:guard.mjs/new-subsystem.mjs`; (b) extensionless scope `we:LICENSE` derived from the PR diff, fixer deletes `we:LICENSE` and adds `we:LICENSE/evil.mjs`. Control: an entry the card declares as a directory (trailing `/`, e.g. `we:scripts/conveyor/__tests__/`) still covers files beneath it. (Heads `4e3ab4774d5b`, `4752c275333c`.)

### Other confirmed breaks (from #5461's red team, #6193 and #6229)

- [A4] **`withholds the push when the backlog cannot be read`** — card declares only `we:guard.mjs`, PR diff has `we:guard.mjs` and `we:outside.mjs`; `loadItems` throws `EIO` during the push check → push **withheld** with a warning (no scope known), never a fallback to the PR-diff scope. (`we:scripts/conveyor/fix-scope-fence-io.mjs:192`.)
- [A5] **`enforces scope-removed markers in a human-review send-back`** — operator comment `🔁 human review — changes requested` + blank line + `scope-removed: cdLandings`, scope `we:guard.mjs`, added line `+function cdLandings() {}` → **refused** in `stand-down` mode. Header recognition shares one pattern with `CHANGES_RE` in `we:scripts/conveyor/fix-context-pack.mjs`, not a second copy. (`we:scripts/conveyor/fix-scope-fence.mjs:41`, ex-#6229.)
- [A6] **`judges only the fixer's own net change across a catch-up merge`** — the fixer merges current `main` into the lane, pulling upstream files outside scope → **pushed** (upstream files are not the fixer's change). Computed as proposed head vs pre-fix head merged with the same upstream base, using a merge-aware tree diff. (ex-#6193 (1).)
- [A7] **`an off-scope edit or re-added identifier hidden inside a merge commit is refused`** — the fixer's own edit to an out-of-scope file, or a re-added marked identifier, inside a merge commit → **refused**. Merge commits are not blanket-excluded. (ex-#6193 (2),(3).)
- [A8] **`catches re-added identifiers in prefix-increment statements`** — added line `++cdLandings;` with `scope-removed: cdLandings` → **refused**. (ex-#6193 (4).)
- [A9] **`reads identifiers from git plumbing, not coloured or binary-classified diff text`** — with `color.ui=always` set, and with the file marked binary via a `.gitattributes` entry, a re-added marked identifier is still **refused**. (ex-#6193 (5); also the 2026-10-20 mandatory-review security finding at `we:scripts/conveyor/fix-scope-fence-io.mjs:78`.)
- [A10] **`classifies a moved head and unexpected git errors correctly`** — a moved head is a terminal head-move (not transient); an unexpected `cat-file` failure or fatal git error **withholds the push** and reports the error, never reads as a head move. (ex-#6193 (6),(7).)
- [A11] **`every fixer push path enforces the fence`** in `we:scripts/conveyor/__tests__/await-verify-pass.test.mjs` — early, green and salvage pushes each call the fence, and none calls the push sink on a refused decision. (ex-#6193 (9).)
- [A12] **`live adapter blocks a marker-removed identifier over a real repository`** — real temp git repo: a commit removes a function and carries the marker; the fixer re-adds it → **refused** through the live adapter, not only the pure core. (ex-#6193 (8).)

### Rules the tests above encode

- **Diff-derived file names stay literal.** A path taken from a PR diff is an exact file entry. No `#`, `?`, glob or extension heuristic ever turns it into a directory or pattern.
- **Fail closed.** Any unreadable evidence (backlog, PR commits past a page, git errors, oversized reads, incomplete operator comments) withholds the push and routes to a person. It never widens scope and never counts as a transient retry.
- **File vs subtree is declared, not guessed.** A trailing `/` makes a subtree; everything else is one file.
- **Untrusted text stays inert.** Fixer-controlled paths and identifiers render inert and bounded in stand-down reasons; only operator-authored comments carry markers.

- [A13] **Executable** — `npx vitest run` over `we:scripts/conveyor/__tests__/fix-scope-fence.test.mjs` and `we:scripts/conveyor/__tests__/await-verify-pass.test.mjs` (through the heavy queue) passes with A1–A12 present; A1–A5 are each shown red against a mutation that reverts the fix, recorded in the PR body.
- [A14] The post-accept red team on the new PR reports no confirmed break in the A1–A3 classes.

## Non-goals

- [N1] Flipping the default from `warn` to `stand-down`. That needs warn-mode false-positive data and a separate ruling.
- [N2] Reviving `lane/scope-fence` as-is or force-pushing it. The new work lands as one fresh PR from a lane on current `main`.

## Edge cases this change must handle

1. **Untrusted text** — fixer-controlled paths and identifiers rendered inert and length-bounded; markers honoured only from operator-authored comments.
2. **Truncated reads** — oversized marker evidence or commit lists past the first page → push withheld; the brief says evidence is incomplete.
3. **Shared state files** — n/a: the fence reads git and the backlog read-only; its only write is the existing needs-you stand-down.
4. **Fail closed** — see the fail-closed rule above (A4, A10).
5. **Identity scoping** — scope prefixes resolve per repository (A2); a `fui:` entry never authorizes a WE path.
6. **State over time** — net change is judged against the pre-fix head merged with the same upstream base (A6, A7), so catch-up merges neither block valid repairs nor hide edits.
7. **Who wrote it** — only operator-authored `scope-removed:` markers count; fixer- or bot-authored comments are ignored.
