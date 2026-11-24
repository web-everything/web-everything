## Merge drain CLI fixtures (R1063a)

`merge-ai-prs-prestage.test.mjs` and `merge-ai-prs-listing-dedupe.test.mjs` call the exported
`main(argv, { env, stdout, exit })` through `scripts/__tests__/fixtures/merge-ai-prs-cli-harness.mjs`.
Mock `node:child_process` before importing the CLI. The harness reloads module-scoped paths/settings
per invocation, captures exit with a sentinel, restores ambient IO in `finally`, and refuses unported
commands even if a best-effort CLI reader catches the error. It spies on `process.cwd()` because
Vitest's thread pool cannot chdir. Run it sequentially within each test file.
The gh/git function ports also generate the executable shims for the two `*.real.test.mjs` smokes.
Those files are explicitly excluded from the PR unit config. There is currently no filename-based
scheduled real-process config discovery; scheduled-runner enrollment remains separate.
