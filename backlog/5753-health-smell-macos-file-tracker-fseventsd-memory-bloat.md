---
bornAs: xs38oxz
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/health-smells/", "we:scripts/lib/resource-sampler.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Health smell: macOS file-tracker (fseventsd) memory bloat

Held item 206 (session 2026-10-10). Live 13:25 ET: fseventsd at 11.6 GB RSS + ~100% CPU from lane/rebuild file churn -> 62 GB used, swap 26.5/27.6 GB, CPU 44% sys, test queue cut to 2. The operator restarted it (`sudo launchctl kickstart -k system/com.apple.fseventsd`): 35 GB used, swap 1.4 GB, 20% idle. Fix: the resource sampler records fseventsd RSS/CPU and swap use; a health smell fires when RSS > setting (default 2 GB) or swap > 80%, telling the operator the one command (we cannot sudo); the resource service treats swap pressure as a hold signal. Root-cause fix is the pnpm card (held 205) plus lighter rebuilds.

## Acceptance

- [A1] **Executable** — a test feeds sampler rows over and under the thresholds and the smell fires and clears; swap pressure appears as a resource hold reason.
- [A2] **Live** — the smell fires once on the next bloat with the exact command in the message.

## Non-goals

- [N1] Restarting fseventsd automatically (needs sudo; operator only).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: process stats only.
2. **Truncated reads** — A missing sample is `unknown`, not healthy.
3. **Shared state files** — Sampler rows in the existing resource store.
4. **Fail closed** — Sampler error -> no hold change, alert.
5. **Identity scoping** — Host-wide signal.
6. **State over time** — The smell clears itself when RSS and swap drop.
7. **Who wrote it** — n/a: sampler-written.
