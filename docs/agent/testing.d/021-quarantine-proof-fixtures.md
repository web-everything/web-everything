## Quarantine proof fixtures

Quarantine addition scenarios using `red-main-quarantine-62da75ed3.json` must explicitly supply a
hypothetical earlier run of the failing sha whose re-run passed the job (run attempt 2, latest job
attempt `success`), never a passing attempt on the failing run itself (a job that passes there is no
longer failing): the recorded episode had none and must remain a negative replay. A green merge group is never flake
proof, because it tested its queued PR's changes, which may fix the failure. Keep proof validation
enabled and the recorded fixture unchanged, including when exercising the once-per-tick safety net
through both health smells.

