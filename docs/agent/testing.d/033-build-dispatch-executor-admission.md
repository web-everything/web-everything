## Build-dispatch executor admission

Candidate executor prediction must call `decideDispatchRoute` with the dispatch loader's scope, size,
risk, tags and delivery-agent override, then `probationLaunchDecision` with the actual launch setting.
`routing.executed` alone is the fallback: an enabled probation worker can actually execute the build.
Test a real predicted external route with Claude capacity full, and preserve the run record's known
executor when deduplicating it with an earlier executor-less claim. The total own-item WIP cap applies
across both executor pools.

