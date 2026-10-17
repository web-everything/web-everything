/** Per-attempt seat observations on the existing review-pr run record. No verdict authority. */
export function seatTiming({ seat, lens, provider = null, model = null, startedAt, finishedAt = null, verdict = null, findingsCount = null }) {
  return { seat, lens: lens ?? null, provider, model, startedAt, finishedAt, verdict, findingsCount };
}

export function withSeatTiming(run, row) {
  const rows = [...(run.seatTimings ?? [])];
  const index = rows.findIndex(r => r.seat === row.seat && r.lens === row.lens && r.startedAt === row.startedAt);
  if (index < 0) rows.push(seatTiming(row));
  else rows[index] = seatTiming(row);
  return { ...run, seatTimings: rows };
}

const instant = value => typeof value === 'string' ? Date.parse(value) : NaN;
const percentile = (values, p) => values.length ? values[Math.ceil(values.length * p) - 1] : null;
const median = values => values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null;

/** Incomplete/legacy runs are visible but excluded from the aggregate denominator. p90 uses nearest rank. */
export function seatTimingReport(records, { since = null } = {}) {
  if (since !== null && !Number.isFinite(instant(since))) throw new TypeError('--since must be an ISO timestamp');
  const runs = [];
  for (const run of records) {
    if (run?.op !== 'review-pr' || !Array.isArray(run.seatTimings) || !run.seatTimings.length) continue;
    const seats = run.seatTimings;
    const starts = seats.map(r => instant(r.startedAt));
    if (since && (!starts.every(Number.isFinite) || Math.min(...starts) < instant(since))) continue;
    const finishes = seats.map(r => instant(r.finishedAt));
    const complete = starts.every(Number.isFinite) && finishes.every((f, i) => Number.isFinite(f) && f >= starts[i]);
    const first = complete ? Math.min(...finishes) : null;
    const last = complete ? Math.max(...finishes) : null;
    const changes = seats.filter(r => ['changes', 'request-changes', 'reject'].includes(r.verdict)).map(r => instant(r.finishedAt)).filter(Number.isFinite);
    const lead = complete && changes.length ? last - Math.min(...changes) : null;
    runs.push({ runId: run.id, repo: run.input?.repo ?? null, pr: run.input?.pr ?? null, seats, complete,
      firstFinishedAt: first === null ? null : new Date(first).toISOString(), lastFinishedAt: last === null ? null : new Date(last).toISOString(),
      spreadMs: complete ? last - first : null, firstChangeRequestLeadMs: lead });
  }
  const completed = runs.filter(r => r.complete);
  const spreads = completed.map(r => r.spreadMs).sort((a, b) => a - b);
  const earlyChanges = completed.filter(r => r.firstChangeRequestLeadMs > 300_000).length;
  return { runs, summary: { runs: runs.length, completeRuns: completed.length, incompleteRuns: runs.length - completed.length,
    medianSpreadMs: median(spreads), p90SpreadMs: percentile(spreads, .9), earlyChangeRequestRuns: earlyChanges,
    earlyChangeRequestShare: completed.length ? earlyChanges / completed.length : null } };
}
