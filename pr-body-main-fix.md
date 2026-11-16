First red commit: 34c309b3d1e1b59b81430914a4f9c2c83f200fb8 (last green 82e2290e2f90e3f70c62f4f94b7265df5329da48).

Cause: the only failing test in CI run 43157793183 (test-shard 9, so also coverage-merge and test) was `scripts/__tests__/verify-lane.test.mjs` "keeps the slot heartbeat while its own stdout is not being read". It sampled the heartbeat once at a fixed 2.9s; on a loaded coverage shard the watchdog thread started late, so it read the acquire-time value. The merged range (#6687) does not touch verify-lane, and the test passes on repeated local runs.

Fix: poll until the heartbeat advances while the gate is still alive (bounded by the 4s ceiling), then wait for the ceiling kill. All assertions are kept: the heartbeat must advance while stdout is unread, the gate must be killed at the ceiling, the heartbeat must stop afterwards.

Tests: `npm run test:unit -- scripts/__tests__/verify-lane.test.mjs` 170/170.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
