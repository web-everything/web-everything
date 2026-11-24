## Stuck trace isolation

The stuck-trace node:test fixtures inject both operations and the event sink. Keep
`fileURLToPath(import.meta.url)` resolution inside the default child runner: the digest
fixtures import modules through data URLs, where eager file-path resolution fails.
The digest and merge watcher share the watcher receipt directory; when overriding
its state directory, pass that directory as the digest’s `traceStateDir` too.
When exercising production branches with fully injected IO, stub `VITEST` and
`WE_UNDER_TEST` to empty strings and assert `isUnderTest()` is false. Vitest 1.x
stringifies `vi.stubEnv(name, undefined)` to the truthy string `"undefined"`, which
keeps the isolation guards active and can make negative-path assertions vacuous.
Restore the environment after each case; retain the production isolation guards.

