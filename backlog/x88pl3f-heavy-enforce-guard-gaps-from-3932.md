---
kind: story
size: 3
status: open
scope: ["we:scripts/"]
dateOpened: "2026-10-05"
tags: []
---

# Heavy-enforce guard gaps from #3932

(a) ungatedHeavyHead still allows exec npx vitest run, env -i npx vitest run and stdbuf -oL npx vitest run; normalize wrappers before classifying. (b) A node run of we:scripts/check-standards.mjs from another path gets the path-less suggestion npm run check:standards -- --local, wrong for that cwd; keep the original path. (c) An implicit vitest watch (vitest we:a.test.mjs in a TTY) is suggested unchanged and queues a watcher; normalize to vitest run.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
