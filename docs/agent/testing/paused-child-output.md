## Paused child output

Attach output collectors before pausing a child pipe. Node automatically resumes unread
stdio after child exit, so a listener attached after a delay can miss already-drained output.
Waiting for `close` ensures the pipe has drained, but cannot recover data consumed before
the listener was attached.

Slow-reader regressions should cover both a small write that exits before explicit resume
and a write large enough to exercise backpressure. Keep the output assertions in both cases.
See `scripts/__tests__/lane-pool-acquire-reclaim-log.test.mjs` for both paths.
