/** A missed nightly report or repeatedly failing supervisor must reach the operator. */
export default {
  id: 'nightly-coroner-failed', scope: 'host', cadence: 'every-tick',
  probes: ['nightlyCoronerStatus'], openAfter: 1, closeAfter: 1,
  severity: 'high', action: 'alert',
  evaluate({ nightlyCoronerStatus: status }, { probeErrors }) {
    const failures = status.alerts.map((r) => ({ subject: r.id, breach: true, measure: r,
      summary: `${r.id}: ${r.error}; ${r.attempts}/${r.maxAttempts} attempts; ${r.reason}`,
      recommendation: 'Inspect the nightly-coroner job record and restore nightly report extraction.' }));
    const probe = probeErrors.nightlyCoronerJob;
    failures.push({ subject: 'nightlyCoronerJob', breach: (probe?.count ?? 0) >= status.threshold,
      measure: { count: probe?.count ?? 0, error: probe?.last },
      summary: `nightly-coroner supervisor probe nightlyCoronerJob failed ${probe?.count ?? 0} times: ${probe?.last ?? 'healthy'}`,
      recommendation: 'Inspect the nightly-coroner supervisor error and job attempts.' });
    return failures;
  },
};
