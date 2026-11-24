## Copied CLI fixtures

When copying `scripts/` into a throwaway checkout, link that checkout's `node_modules` to the source
checkout's installed dependencies. Run the copied entry point so its `import.meta.url` still resolves
mutations inside the fixture. Node resolves package imports from the copied modules' location, even
when the child process runs from another directory. Copy repository-relative imports outside `scripts/`
too: the transcript checker needs `skills-src/inspect-codex-transcript/` at the fixture root. When moving
`scripts/` for locus guards, move that dependency alongside it and retain access to `node_modules`.
Remove the fixture during teardown.

Post-run transcript diagnostics resolve their policy independently of the optional inspector dependency.
Keep the named checker-import failure regression in `scripts/__tests__/codex-direct-task.test.mjs`:
a completed run must still return its report, preserve the shipped warn default, and enforce fail in
both foreground output modes. `scripts/lib/__tests__/codex-transcript-check.test.mjs` pins the real
settings file to warn/3000000 with tool provenance, checks unreadable settings/platform sources, and
guards executable-looking custom input with an execution sentinel and a static evaluation check.
An unreadable policy source must retain a readable higher-priority mode; unknown mode fails closed.

