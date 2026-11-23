---
kind: story
size: 2
status: open
scope: ["we:scripts/wip-publish.ts"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use, coverage-or-style] from plateauapp/plateau-app#230 (head 95c09f108)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#230 (reviewed head `95c09f1086d06f160d620147eef5211e49973396`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/wip-publish.ts:131` — (failing-input, degraded) --out still makes network requests despite its advertised offline behavior
   - Scenario: Run npm run wip:publish -- --out we:snapshot.json with an authenticated GitHub CLI. The new branch calls read(), which reaches readWip() and unconditionally invokes readPrs(), executing gh pr list against web-everything/web-everything. This contacts GitHub even without WIP_PUBLISH_TOKEN or WIP_RELAY_URL. Offline, the request instead fails or times out and the dump has degraded pull-request data. The advertised no-network mode should produce its snapshot without initiating network requests.
   - Class: correctness-in-normal-use (basis: Static call-path evidence: readWip unconditionally schedules readPrs in its Promise.all; readPrs executes gh pr list; guardedExec passes gh commands directly through to execFile. No output-mode network guard exists. This occurs during ordinary documented --out use.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
