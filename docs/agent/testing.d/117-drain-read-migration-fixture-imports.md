## Drain read-migration fixture imports

Load the drain/adoption graph with static imports during collection in
`proc-read-migration-74b.test.mjs`, as the reaper fixture does in `proc-read-migration-74c.test.mjs`.
Dynamic imports of that cyclic graph can remain unresolved in the Vite runner, even when awaited
sequentially. Keep fake executable PATH setup in `beforeAll` and all large-output/failed-read
assertions inside the original per-test deadlines; increasing the setup timeout does not resolve the import stall.
