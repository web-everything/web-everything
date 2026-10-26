/** Human-gated delivery policy values (#5113). Only type imports may enter this value source. */
import type {
  PrCiPolicyValue,
  MergeGatePolicyValue,
  DispatchGatePolicyValue,
  HeavyQueuePolicyValue,
  DrainPolicyValue,
} from './defineConfig';

export const PLATFORM_DELIVERY_POLICY_DEFAULTS = {
  prCi: { mainStateParity: 'on' },
  mergeGate: {
    recheckWhenMainMoved: 'if-older-than-N-min',
    recheckMaxAgeMin: 30,
    onMainRed: 'halt',
  },
  dispatchGate: { overlapOverride: 'off' },
  heavyQueue: {
    priority: 'repairs-first',
    reservedForRepairs: 1,
    reservedBorrowAfterMin: 10,
  },
  drain: { onStepRefusal: 'alert' },
} as const satisfies {
  prCi: PrCiPolicyValue;
  mergeGate: MergeGatePolicyValue;
  dispatchGate: DispatchGatePolicyValue;
  heavyQueue: HeavyQueuePolicyValue;
  drain: DrainPolicyValue;
};
