/** Historical explicit escalation routes, independent of live quota and current inherited defaults. */
import { DEFAULT_ROUTING_POLICY } from '../../lib/dispatch-routing-policy.mjs';
export const fixPolicy = structuredClone(DEFAULT_ROUTING_POLICY);
fixPolicy.operations.fix = { provider: 'claude', model: 'sonnet', effort: 'high', fallback: [] };
fixPolicy.operations['fix:ruling-escalation-stronger'] = { ...fixPolicy.operations.fix };
fixPolicy.operations['fix:ruling-escalation-cross-provider'] = { provider: 'codex', model: 'astra', effort: 'high',
  fallback: [{ provider: 'claude', model: 'sonnet', effort: 'high' }] };
export const fixCapacity = { minimumTiers: { 'fix:critical-work': 3, 'fix:ruling-escalation-stronger': 2 },
  providers: [{ id: 'claude', launcher: 'claude', model: 'claude-sonnet-5-5', tier: 3 }] };
