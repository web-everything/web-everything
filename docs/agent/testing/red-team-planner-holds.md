## Red-team planner holds

Planner skips persist a bounded `blockedReason`; test legacy entries without it, restart,
reason changes, and removal on unblock. A CI-recovery head move does not override a later
review hold: the planner's acceptance guard still refuses dispatch. The drain reports the
recorded reason only for the exact repo/PR/head and keeps missing or unreadable evidence held.
