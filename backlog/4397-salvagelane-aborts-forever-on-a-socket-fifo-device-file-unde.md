---
bornAs: x7pj0mw
kind: task
parent: "4075"
status: open
blockedBy: ["4273"]
scope: ["we:scripts/lib/lane-salvage.mjs", "we:scripts/lib/__tests__/lane-salvage.test.mjs"]
dateOpened: "2026-09-28"
tags: []
preparedDate: "2026-09-30"
preparedAgainstSha: "57b54c601b0518cbf3ede27d2e403a489d8d67cf"
---

# salvageLane aborts forever on a socket/FIFO/device file under .claude/worktrees/

`salvageLane` copies every unregistered `.claude/worktrees/` entry using a hand-rolled `copyLitterTreeSync` (formerly `fs.cpSync`). `copyFileSync` throws on a non-regular special file (a Unix socket, FIFO, or device node), which aborts the WHOLE salvage — and since salvageLane's own contract is 'throw before any reset/clean', the lane can never be reclaimed via the salvage path until an operator manually removes the offending file by hand. Surfaced by an automated review during #4273's build (security lens, degraded impact, carve-out — not required to land #4273 itself). 

## Progress

* **Premise Correction**: The original card stated that `#4273's salvageLane copies every unregistered ... with fs.cpSync ... cpSync throws on a non-regular special file`. However, `fs.cpSync` was subsequently replaced with `copyLitterTreeSync` because of an uncaught C++ abort. The premise remains valid, but the mechanism is now `copyFileSync` throwing a catchable JS error instead of `cpSync`.
* **Scope Correction**: Added `we:scripts/lib/__tests__/lane-salvage.test.mjs` to the scope to ensure the new behavior is explicitly tested.

## Design

Update `copyLitterTreeSync` in `we:scripts/lib/lane-salvage.mjs` to handle non-regular files safely. Currently, it checks `st.isSymbolicLink()` and `st.isDirectory()`, then falls back unconditionally to `copyFileSync`, which throws on special files.

1. Add a check for `st.isFile()`.
2. If `st.isFile()` is true, use `copyFileSync` as before.
3. If it is none of these (meaning it's a socket, FIFO, device node, etc.), skip `copyFileSync`.
4. Instead, write a placeholder file at the destination (e.g., `${dest}.skipped.txt`) indicating the skip and the type of special file encountered (e.g. `Skipped non-regular file (FIFO/socket/device) at ${src}`).

## MVP

Modify `copyLitterTreeSync` to check `st.isFile()`. For non-regular files, write a `${dest}.skipped.txt` file detailing the reason and skip the actual copy. Ensure `salvageLane` does not abort when it encounters a socket.

## Test plan

In `we:scripts/lib/__tests__/lane-salvage.test.mjs`:
Add a test that places a real Unix socket (using `net.createServer().listen(sock)`) under a mock `.claude/worktrees/stray/` directory. Call `salvageLane`. Assert that it does not throw, and that the salvage destination contains the `.skipped.txt` placeholder instead of crashing.

## Proof plan

1. Execute the new test via `npx vitest run we:scripts/lib/__tests__/lane-salvage.test.mjs` and verify it passes.
2. The passing test proves the lane salvage succeeds on lanes holding Unix sockets.

## Follow-ups

- Audit other tree-copying logic in the system to verify similar resilience against special files.

## Done when

- [A1] **Executable** — Add the named acceptance test `salvages a Unix socket with a skipped-file placeholder` in `we:scripts/lib/__tests__/lane-salvage.test.mjs`. Run `npm run test:unit -- lane-salvage`: that case must fail against the current unconditional special-file copy and pass after the build. It creates a real Unix socket, asserts salvage does not throw, and checks the destination `.skipped.txt` placeholder and its reason. Record the red run before implementation; this names the test to author, not a claimed passing result.
