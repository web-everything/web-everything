/** Writable data-volume space; immediately surface exhaustion to the operator. */
export default {
  id: 'disk-space', scope: 'host', cadence: 'every-tick', probes: ['diskSpace'],
  openAfter: 1, closeAfter: 1, severity: 'high', action: 'alert',
  evaluate({ diskSpace }, { config = {} } = {}) {
    const configured = config.health?.diskFreeMinGb;
    const min = typeof configured === 'number' && Number.isFinite(configured) && configured >= 10 ? configured : 30;
    const free = diskSpace.freeGb;
    if (!Number.isFinite(free) || free < 0) return [];
    const critical = free < 10;
    return [{ subject: 'data-volume', breach: free < min, measure: { freeGb: free, minGb: min, critical },
      summary: `${critical ? 'CRITICAL' : 'Warning'}: data volume has ${free.toFixed(1)} GiB free (warning below ${min}, critical below 10).`,
      recommendation: 'Free disk space and inspect temporary checkout and cache growth.',
      escalation: { humanOnly: true, status: 'needs-you', reason: 'Data volume disk space is low' },
    }];
  },
};
