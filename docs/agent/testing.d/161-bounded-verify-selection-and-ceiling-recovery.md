## Bounded verify selection and ceiling recovery

Verify gates execute explicit sorted test files, including complete graph selections. Graph failures,
empty lists and oversized argv use changed tests plus direct importers clipped to `relatedMaxTests`,
then the named `alwaysRunTests` suites. An empty union skips the test half; never emit unfiltered Vitest.
Explicit related gates share the selector; `--gate-uncapped` is an audited exemption.
A related gate stamped by an older dispatcher (`--run --passWithNoTests --testTimeout=N --hookTimeout=N`)
converts to a capped gate keeping its stamped timeouts; any other unknown option is still refused.
Missing timeouts on such a stamp mean factor 1, so the host's factor is not added; the converted gate
shards exactly as the default would, so it is still recognized as the default gate.
Gate ceilings get one capped retry tied to lane, head and killed job. Detached jobs settle in
`verify-gate-job.mjs`, so recovery must cover that consumer as well as `verify-dispatch.mjs`'s
in-process sweep. Persist the retry identity in job input to dedupe the enqueue-before-marker crash window.

