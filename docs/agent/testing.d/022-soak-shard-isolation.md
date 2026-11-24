## Soak shard isolation

Keep the 50-tick baseline alone in CI shard 1; balance break scenarios by measured time across the other
four shards. Each world spawns real daemon and Git subprocesses, so timing balance alone can put competing
worlds beside the baseline and exhaust its overall deadline even when completed ticks satisfy every invariant.
Regression coverage must preserve every file exactly once, the single-shard fallback, and baseline isolation
when its stored timing is missing or stale. Keep tick counts, invariants, and timeout limits intact.

