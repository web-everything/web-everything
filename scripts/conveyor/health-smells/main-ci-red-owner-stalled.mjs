// card 302: stalled owners need a fresh operator alert each escalation period.
import { mainCiRedSettings, mainRedState, MINUTE } from '../main-ci-red-core.mjs';

export default {
  id: 'main-ci-red-owner-stalled',
  scope: 'repo',
  cadence: 'every-tick',
  probes: ['mainCiRuns'],
  severity: 'high',
  openAfter: 1,
  closeAfter: 1,
  action: 'alert',
  recommendationHint: 'Approve the safe recovery for a stalled red-main owner.',
  evaluate({ mainCiRuns }, { now, config } = {}) {
    const settings = mainCiRedSettings(config);
    const state = mainRedState(mainCiRuns?.runs, { tip: mainCiRuns?.tip });
    const { ownerStall: stall, escalation, recovery, owner } = mainCiRuns ?? {};
    if (!settings.mainCiRedEnabled || state.status !== 'red' || !stall?.stalled || !escalation) return [];
    const recoveryText = recovery?.kind === 'rerun'
      ? `re-run of main run ${recovery.runId} ${recovery.status}`
      : recovery?.kind === 'revert-proposal'
        ? `review a revert of ${String(recovery.sha).slice(0, 9)} proposed`
        : 'no recovery taken';
    return [{
      subject: `main:${state.firstRed.sha.slice(0, 9)}:escalation-${escalation.n}`,
      breach: true,
      measure: { redForMin: Math.round((now - state.redSinceMs) / MINUTE), owner, ownerStall: stall, escalation, recovery },
      summary: `main CI red for ${Math.round((now - state.redSinceMs) / MINUTE)} min; owner ${owner?.kind} ${owner?.ref} stalled (${stall.reason}) since ${new Date(stall.since).toISOString()}; ${recoveryText}.`,
      recommendation: stall.approval,
    }];
  },
};
