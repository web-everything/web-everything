/**
 * review-seat-provider.mjs — WHICH PROVIDER SITS EACH review-pr SEAT (card 84, review half).
 *
 * ONE SOURCE: THE ROUTING POLICY. The setting lives in `we:scripts/lib/dispatch-routing-policy.json`, the same file
 * that routes every other operation, under the existing `review-seat` operation — never a second config file:
 *
 *   - `review-seat:mandatory:<correctness|security>` — the mandatory seat's provider (`review.seatProvider.<lens>`):
 *       entry absent, `inherit`, or provider `claude`  → `claude`  (the seat runs on Claude only — today's behaviour)
 *       provider `agy-claude`/`agy-gemini` + `mode: "shadow"` → `shadow` (Claude judges and alone counts; an agy juror
 *                                                         judges beside it; both recorded; agreement row appended)
 *       provider `agy-claude`/`agy-gemini`, no `mode`     → `agy`    (agy judges; Claude on escape or failure)
 *   - `review-seat:advisory:agy-correctness` — present with an agy provider seats the ADVISORY agy juror.
 * The agy model is the entry's resolved model (aliases from the same file).
 *
 * PLATFORM DEFAULT, per [config-extends-platform-default](../../docs/agent/platform-decisions.md#config-extends-platform-default):
 * with no entry the seat is Claude-only and there is no agy seat (native-first). The policy file is the project
 * layer that extends it; this module holds no other default.
 *
 * PURE apart from {@link loadReviewSeatSettings}, which reads the live (last-good, validated) policy.
 */
import { readRoutingPolicy } from './dispatch-routing-policy-io.mjs';
import { resolveOperationRoute } from './dispatch-routing-policy.mjs';

/** The closed provider vocabulary for a seat. */
export const SEAT_PROVIDERS = Object.freeze(['claude', 'agy', 'shadow']);

/** The lenses a seat provider may be set for: the two mandatory seats `review-pr` declares. */
export const SEAT_PROVIDER_LENSES = Object.freeze(['correctness', 'security']);

/** The routing-policy operation and task keys. */
export const REVIEW_SEAT_OPERATION = 'review-seat';
export const mandatorySeatTask = (lens) => `mandatory:${lens}`;
export const AGY_ADVISORY_SEAT_TASK = 'advisory:agy-correctness';

/** The agy providers the routing policy knows. */
export const AGY_PROVIDERS = Object.freeze(['agy-claude', 'agy-gemini']);

/** The platform flavor: every seat on Claude, no agy seat. */
export const REVIEW_SEAT_PLATFORM_DEFAULT = Object.freeze({
  seatProvider: Object.freeze({ correctness: 'claude', security: 'claude' }),
  seatModel: Object.freeze({}),
  agyModel: null,
  agyCorrectnessAdvisory: false,
});

function routeFor(policy, task) {
  return resolveOperationRoute({ operation: REVIEW_SEAT_OPERATION, taskType: task, available: ['claude', ...AGY_PROVIDERS], policy });
}

/**
 * Derive the seat settings from a validated routing policy. PURE.
 * @param {object} policy - a `validateRoutingPolicy` result.
 * @returns {{seatProvider: {correctness: string, security: string}, seatModel: Object<string,string>,
 *   agyModel: string|null, agyCorrectnessAdvisory: boolean}}
 */
export function settingsFromRoutingPolicy(policy) {
  const seatProvider = { ...REVIEW_SEAT_PLATFORM_DEFAULT.seatProvider };
  const seatModel = {};
  for (const lens of SEAT_PROVIDER_LENSES) {
    const route = routeFor(policy, mandatorySeatTask(lens));
    if (!route || !AGY_PROVIDERS.includes(route.provider)) continue;
    seatProvider[lens] = route.mode === 'shadow' ? 'shadow' : 'agy';
    seatModel[lens] = route.model;
  }
  const advisory = routeFor(policy, AGY_ADVISORY_SEAT_TASK);
  const advisoryOn = Boolean(advisory && AGY_PROVIDERS.includes(advisory.provider));
  return Object.freeze({
    seatProvider: Object.freeze(seatProvider),
    seatModel: Object.freeze(seatModel),
    agyModel: advisoryOn ? advisory.model : null,
    agyCorrectnessAdvisory: advisoryOn,
  });
}

/** The live settings, off the live routing policy. */
export function loadReviewSeatSettings({ policy = readRoutingPolicy() } = {}) {
  return settingsFromRoutingPolicy(policy);
}

/**
 * The seat-provider directive a mandatory seat's judge request carries, or `null` for a plain Claude seat. PURE.
 * @param {object} settings - from {@link settingsFromRoutingPolicy}.
 * @param {string} lens
 */
export function seatProviderDirective(settings, lens) {
  const mode = settings?.seatProvider?.[lens];
  if (!mode || mode === 'claude') return null;
  if (!SEAT_PROVIDERS.includes(mode)) throw new TypeError(`review-seat-provider: unknown seat provider ${JSON.stringify(mode)}`);
  const model = settings.seatModel?.[lens] ?? settings.agyModel;
  if (typeof model !== 'string' || !model) throw new TypeError(`review-seat-provider: the ${lens} seat names no agy model`);
  return Object.freeze({ mode, model, onEscape: 'claude' });
}
