## Build-dispatch prepare retirement

A live daemon PID does not prove its prepare worker is live. Probe dispatch-entry `live`,
`expectedBy`, and `lastSeenLiveAt` independently: an explicitly dead session retires past its
expected deadline or after 20 minutes without a live observation. Settlement records
`prepare-session-dead`, clears the claim and guard, and increments `itemPrepareAttempts`
without double-counting a same-tick TTL retirement. Keep this outcome retryable rather than
turning it into a permanent `prepare-unstamped` hold on the next tick.

