## Red-team gate catch-up regressions

`scripts/lib/red-team-gate-catchup.test.mjs` pins send-back-only retry nomination,
including sent-back records and round-cap reopening. Card-only plans stay with the
in-job path, including failed card records. Its co-located path is explicitly included
in `vitest.config.ts`; the usual scripts glob only discovers `__tests__/`.
The failed-send-back soak replays the real apply gate with injected IO. Run both through
heavy admission; the standalone soak test uses `vitest.soak.config.ts`.

Any operator ruling or release record excludes the whole result from catch-up, even
when another finding remains open. Ambiguous records and unreadable or incomplete
dispositions nominate nothing and remain with the operator path. Automatic cap reopening
requires the same verified standing-ruling scope as apply; unreadable scope credits no
automatic grant. Unknown gate failures stop the result key and attempt one
`red-team-gate-stuck` publication for operator review.
