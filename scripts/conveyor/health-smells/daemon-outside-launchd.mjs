/** Live lease holders missing from launchd require operator attention, never process termination. */
export default {
  id: 'daemon-outside-launchd', scope: 'host', cadence: 'every-tick', probes: ['leases'],
  openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert',
  evaluate({ leases }) {
    return leases.filter(l => l.outsideLaunchd !== false && l.outsideLaunchd !== undefined).map(l => ({
      subject: l.log, breach: true,
      measure: { pid: l.pid, livenessKnown: l.outsideLaunchd === true },
      summary: l.outsideLaunchd === true
        ? `${l.log}: live lease holder pid ${l.pid} has no observed launchd pid for its label.`
        : `${l.log}: lease holder pid ${l.pid} has no observed launchd pid; process liveness is unreadable.`,
      recommendation: 'Inspect the lease holder and launchd label, then restore supervision manually. No automatic termination.',
    }));
  },
};
