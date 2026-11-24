## Verdict-ledger contention regression (R365 fix 2)

`verdict-ledger-io.test.mjs` uses local bare origins and real rejected pushes to
exercise repeated push races. Its injected monotonic clock models slow attempts
without sleeping on the host; the legacy-delay witness exhausts eight attempts,
while yielding at least one measured attempt duration lets the writer land.
Keep the real rejection assertions alongside the clock model: simulated elapsed
time alone is not evidence of a Git failure. Exhaustion still refuses clearing
rows, and the F4 diagnostics retain a bounded first-line Git cause.
