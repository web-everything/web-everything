/** Shared usable-route probe for operator writes and live policy reloads. */
import { resolveOperationRoute } from './dispatch-routing-policy.mjs';
import { OPERATION_PROVIDER_ROSTERS, REVIEW_SEAT_PROVIDERS } from './dispatch-routing-providers.mjs';
import { resolveRoutingProviderCap } from './review-seat-caps.mjs';

/** A task type no policy entry names, so resolution falls back to the bare review-seat entry. */
const ADDED_SEAT_PROBE_TASK = 'added-seat-override-probe';

/** Probe with the launcher's supported candidates, including inherited provider disables and, for the
 *  capped added-seat roster, the same per-provider daily cap the launcher applies (agy-gemini defaults to 0). */
export function resolveRoutingOverrideRoute(key, policy, { env = process.env } = {}) {
  if (!Object.hasOwn(policy.operations, key)) return; // Clearing a retired scoped key.
  const split = key.indexOf(':');
  const operation = split < 0 ? key : key.slice(0, split);
  // The bare review-seat entry is only ever launched as the fallback for an added seat (extra juror or
  // advisory lens) without its own entry, so probe it through that same added-seat resolution path.
  const taskType = split >= 0 ? key.slice(split + 1) : key === 'review-seat' ? ADDED_SEAT_PROBE_TASK : '';
  const entry = policy.operations[key];
  const disabled = entry.disabledProviders ?? [];
  const roster = OPERATION_PROVIDER_ROSTERS[key];
  const capped = roster === REVIEW_SEAT_PROVIDERS;
  const available = roster?.filter(provider => !disabled.includes(provider)
    && (!capped || resolveRoutingProviderCap(provider, env, entry) > 0));
  if (available?.length === 0) throw new TypeError(`routing policy: ${key}: no available route`);
  return resolveOperationRoute({ operation, taskType, available, policy });
}
