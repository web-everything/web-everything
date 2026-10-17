/** One repair card per live quarantine episode. */
import { quarantineSafetyNetForTick } from './main-ci-red.mjs';

export default {
  id: 'red-main-quarantined-test',
  scope: 'repo',
  cadence: 'every-tick',
  probes: ['mainCiRuns'],
  openAfter: 1,
  closeAfter: 1,
  severity: 'medium',
  action: 'file',
  recommendationHint: 'Fix or delete the quarantined flaky test before it expires.',
  evaluate({ mainCiRuns }, ctx) {
    const { now } = ctx;
    const out = quarantineSafetyNetForTick(mainCiRuns, ctx);
    if (!out || out.shadow) return [];
    return (out.liveEntries ?? []).filter((entry) => now < entry.expiresAt).map((entry) => ({
      subject: `quarantine:${entry.test}`,
      breach: true,
      measure: { ...entry },
      summary: `Quarantined flaky test ${entry.test}; job ${entry.job ?? 'unit shards'}; broken sha ${entry.brokenSha}; proof ${entry.proof ? JSON.stringify(entry.proof) : 'not recorded'}; expires ${new Date(entry.expiresAt).toISOString()}.`,
      recommendation: `Fix or delete ${entry.test} before ${new Date(entry.expiresAt).toISOString()}.`,
    }));
  },
};
