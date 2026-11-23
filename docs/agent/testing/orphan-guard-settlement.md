## Orphan guard settlement

A bounded orphan-guard pass must check settled same-head verdicts before deadline deferral,
including wrapped PRs. Otherwise the cursor progresses while cleared PRs become held again,
blocking the ordinary dispatch that must start their first fix round.

Keep the cache process-local, with a six-hour TTL, and invalidate on ordinary fix dispatch or
non-none guard results. Cache only explicitly stable none decisions; grace, ownership, draft
and real orphan decisions must be re-evaluated. Unknown heads cannot provide cache evidence.

The orphan-guard-settles soak break detects the fix behaviorally: two tiny-budget passes must
produce fewer deferrals on the second pass. Its negative fixture removes cache support while
preserving cursor and budget behavior. The daemon tests also assert that held PR counts drain
across repeated passes and that invalidation is scoped to the repository when PR numbers collide.
