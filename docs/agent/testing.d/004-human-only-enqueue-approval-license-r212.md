## Human-only enqueue approval license (R212)

`human-only-enqueue-license.test.mjs` uses local Git repositories to exercise exact clearance,
the shared numbering proof, and main merges whose sensitive blobs match `origin/main`.
Admission reads complete comments and live head/labels; missing or unreadable evidence retains
the human hold. Successor proof is read-only, with 8 MiB per Git output and 1024 changed paths;
exceeding either limit asks the operator to re-approve the current head or queue it. All license
and numbering Git reads share `numberingGitRunner`, which discovers and disables every promisor
before reading objects, denies transports and lazy fetch, and isolates global config and replacement
objects. Caller `exec` handles only GitHub evidence. The runner's `readFailed` flag blocks license
fallback even when optional alias reads fail; only grep status 1 and config `--get-regexp` status 1
mean absent optional evidence. Keep real missing/corrupt objects, output overflow, and marker-writing
promisor helpers in the license/numbering suites. Drive the actual proofs through their internal runner
seams with a spy wrapping real Git: assert every call's explicit 5-second timeout and exact 8 MiB
output / 1 MiB numbering-blob caps, environment and pins. Replaying commands through factory defaults
does not verify proof call sites. The structural AST test ignores comments and allows only the shared
runner's Git process site and the license's `gh pr view`; its inline bypass samples must fail.
`drain-merge-strategy.test.mjs` covers the setting-off refusal and best-effort `needs-you` event.
Run these and `merge-queue-enqueue.test.mjs` through the host heavy-admission queue.

