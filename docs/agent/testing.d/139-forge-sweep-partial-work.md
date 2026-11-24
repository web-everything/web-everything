## Forge sweep partial work

`forge-exec-sweep.mjs` shares `slots.scanEntryBound` (integer 1000–1000000, default 200000) between
slot and presync tree inspection and proven-tree removal. Entry-bound exhaustion
preserves the tree and reports `partial` with an operator fallback to raise the
bound or stop writers and inspect manually. Depth limits and filesystem errors
remain refusals. `slots.maxRunDirsPerTick` (integer 1–10000, default 200) counts only
reclaimed directories (would-reclaim in dry-run) across sorted slots and legacy
directories. Fresh, reserved, live-record and oversized trees do not consume this
budget. At the bound, inspection stops and unexamined candidates carry over with
a reclaimed/remaining partial note. Invalid bounds use defaults and report
`default (invalid budget value)` provenance. Partial work alone exits zero with a stderr
warning. Unreadable reservations refuse and preserve the entire affected slot.
The sweep unit suite and `forge-sweep-scan-bound-refusal` soak pin these guarantees.
