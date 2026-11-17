---
bornAs: x3b4t88
kind: story
size: 2
status: resolved
dateOpened: "2026-11-16"
dateResolved: "2026-11-17"
tags: []
---

# Make verify-daemon createVerifyWakeSleep fake-timer test load-independent

Use a virtual mailbox and fake timers so the deterministic scheduling tests never depend on real mailbox I/O or sleeps.

## Acceptance

- [A1] **Executable** — the scoped command below passes with zero failures under load, with the same scheduling assertions as before. Repeat it in 20 separate invocations using the shell loop below; Vitest 1.6.1 has no `--repeat` flag.

  Defending test: `we:skills-src/conveyor/__tests__/verify-daemon.test.mjs` → `createVerifyWakeSleep — deterministic scheduling guarantees` → `scheduling completes using only virtual mailbox operations and fake timers`. Observable assertions: the wake exists in the in-memory files map, all six mailbox operations reach the virtual fs, a stat watcher is registered while pending and removed on completion, no mailbox directory exists on disk, and fake time alone completes the wake with no timers left.

```sh
npm run test:unit -- skills-src/conveyor/__tests__/verify-daemon.test.mjs
```

```sh
attempt=0
while [ "$attempt" -lt 20 ]; do
  npm run test:unit -- skills-src/conveyor/__tests__/verify-daemon.test.mjs || exit 1
  attempt=$((attempt + 1))
done
```

## Prevention follow-ups (open)

- [ ] Add a `check:standards` acceptance-command validation rule: syntax-check `Executable` commands and reject unknown CLI flags against the installed tool version. Regression: reject `vitest run <test-file> --repeat=20` with Vitest 1.6.1 and accept the scoped `npm run test:unit -- <test-file>` command above.
- [ ] Add an acceptance-card validation gate requiring each guarantee to identify a repository-qualified test file, named case and observable assertion. Regression: reject a file-only repeat command as evidence for a no-real-I/O guarantee; accept A1's explicit mapping above.

## Non-goals

- [N1] Does not change daemon behaviour or weaken any assertion.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: test-only change.
2. **Truncated reads** — n/a: test-only change.
3. **Shared state files** — each case owns a fresh virtual files map and unique mailbox path; mailbox routing is cleared after each case without patching Node's filesystem object.
4. **Fail closed** — assert virtual writes and watcher registration, reject a native directory watch, and fail if a mailbox appeared on disk.
5. **Identity scoping** — route only the case's mailbox path through the virtual fs; preserve the existing filesystem guards elsewhere.
6. **State over time** — retain burst, deadline and watcher-failure assertions; check active watchers before completion and zero watchers/timers afterward.
7. **Who wrote it** — n/a: test-only change.
