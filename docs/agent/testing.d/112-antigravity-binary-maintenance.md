## Antigravity binary maintenance

`scripts/operations/__tests__/agy-upgrade-check.test.mjs` injects command execution,
child spawn/kill, time, filesystem and attention publication. No real agy or brew
runs. Its timeout probes assert exact child PID SIGKILL and completion without a
close event; output overflow also kills the child. The persisted dead-health
probe checks both model families, malformed/future/expired records and normal
quota fallback. Keep the two maintenance JSON files excluded from the legacy
root quota scan: malformed optional health must not become a quota parse error.
The run lock serializes scheduled ticks; a killed checker requires operator
inspection and removal of its leftover lock before maintenance can resume.

