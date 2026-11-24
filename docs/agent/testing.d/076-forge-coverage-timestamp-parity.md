## Forge coverage timestamp parity

Remote transport stubs must answer the worktree-binding probe before inventory or SSH;
use `fixtures/forge-bound-git.mjs` in injected-Git fixtures so transport-failure tests
reach their intended run/finish branch. Keep their exact dispatch and no-local-rerun assertions.

Legacy coverage report rewrites must restore the timestamp captured from the open source file.
Re-reading the staged timestamp and converting it again can truncate another microsecond,
making coverage older than a source with the same original mtime. The absolute-path coverage
table in `scripts/readiness/__tests__/remote-exec.test.mjs` pins equal fractional mtimes and
compares staged nanoseconds before its `cpSync` transport loses sub-millisecond precision.

