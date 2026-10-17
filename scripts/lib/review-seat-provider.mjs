/**
 * review-seat-provider.mjs — WHICH PROVIDER SITS EACH review-pr SEAT (card 84, review half).
 *
 * SEAT AUTHORITY: THE ROUTING POLICY. The setting lives in `we:scripts/lib/dispatch-routing-policy.json`, the same file
 * that routes every other operation, under the existing `review-seat` operation:
 *
 *   - `review-seat:mandatory:<correctness|security>` — the mandatory seat's provider (`review.seatProvider.<lens>`):
 *       entry absent, `inherit`, or provider `claude`  → `claude`  (the seat runs on Claude only — today's behaviour)
 *       provider `agy-claude`/`agy-gemini` + `mode: "shadow"` → `shadow` (Claude judges and alone counts; an agy juror
 *                                                         judges beside it; both recorded; agreement row appended)
 *       provider `agy-claude`/`agy-gemini`, no `mode`     → `agy`    (agy judges; Claude on escape or failure)
 *   - `review-seat:advisory:agy-correctness` — present with an agy provider seats the ADVISORY agy juror.
 * The agy model is the entry's resolved model (aliases from the same file), except an advisory shadow-only
 * override from review.shadowSeats.antigravity.model; the routing model remains its failure fallback.
 *
 * PLATFORM DEFAULT, per [config-extends-platform-default](../../docs/agent/platform-decisions.md#config-extends-platform-default):
 * with no entry the seat is Claude-only and there is no agy seat (native-first). The policy file is the project
 * layer that extends it; this module holds no other default.
 *
 * PURE apart from {@link loadReviewSeatSettings}, which reads the live (last-good, validated) policy.
 */
import { createHash } from 'node:crypto';
import { resolveReviewSeatSafeguards, resolveShadowSeatModel } from './review-seat-settings.mjs';
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
  shadowModelOverride: null,
  agyCorrectnessAdvisory: false,
});

function routeFor(policy, task) {
  return resolveOperationRoute({ operation: REVIEW_SEAT_OPERATION, taskType: task, available: ['claude', ...AGY_PROVIDERS], policy });
}

/**
 * Derive the seat settings from a validated routing policy. PURE.
 * @param {object} policy - a `validateRoutingPolicy` result.
 * @returns {{seatProvider: {correctness: string, security: string}, seatModel: Object<string,string>,
 *   agyModel: string|null, agyCorrectnessAdvisory: boolean, shadowModelOverride: object|null}}
 */
export function settingsFromRoutingPolicy(policy, { shadowModel = null } = {}) {
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
    shadowModelOverride: shadowModel?.value ? Object.freeze({ model: shadowModel.value, source: shadowModel.source }) : null,
  });
}

const loggedShadowMessages = new Set();

/** One-line log boundary shared by seat selection, execution and trial rendering. */
export function sanitizeReviewLog(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ');
}

export function logReviewSeat(log, message) {
  log(sanitizeReviewLog(message));
}

/** The live routing settings plus the advisory shadow model cascade; log each distinct selection once. */
export function loadReviewSeatSettings({ policy = readRoutingPolicy(), shadowModel = resolveShadowSeatModel(), safeguards = null, log = (m) => console.error(m) } = {}) {
  const resolved = safeguards ?? resolveReviewSeatSafeguards({ log });
  const settings = Object.freeze({ ...settingsFromRoutingPolicy(policy, { shadowModel }),
    shadowPolicy: resolved.value, minNonClaudeSeats: resolved.value.minNonClaudeSeats });
  const lenses = SEAT_PROVIDER_LENSES.filter((lens) => settings.seatProvider[lens] === 'shadow');
  if (lenses.length) {
    const sources = { env: 'env WE_REVIEW_SHADOW_AGY_MODEL', settings: 'settings scripts/settings/review.json key shadowSeats.antigravity.model' };
    // Group identical directives; a policy may give the two seats different routing models.
    const groups = new Map();
    for (const lens of lenses) {
      const d = modelDirective(settings, lens, 'shadow');
      const description = `${settings.shadowPolicy.shadowEnabled ? 'enabled (scope selection)' : 'off (setting)'}; model ${d.model} (source: ${sources[d.modelSource] ?? 'routing-policy'}${d.fallbackModel ? `; fallback ${d.fallbackModel} from routing-policy` : ''})`;
      groups.set(description, [...(groups.get(description) ?? []), lens]);
    }
    for (const [description, seats] of groups) {
      const message = `review-seat: agy shadow seats (${seats.join(', ')}) ${description}`;
      if (!loggedShadowMessages.has(message)) {
        loggedShadowMessages.add(message);
        logReviewSeat(log, message);
      }
    }
  }
  return settings;
}

/**
 * The seat-provider directive a mandatory seat's judge request carries, or `null` for a plain Claude seat. PURE.
 * @param {object} settings - from {@link settingsFromRoutingPolicy}.
 * @param {string} lens
 */
export function seatProviderDirective(settings, lens, context) {
  const mode = settings?.seatProvider?.[lens];
  if (!mode || mode === 'claude') return null;
  if (mode === 'shadow' && shadowSeatStatus(settings, context) !== 'sampled') return null;
  if (!SEAT_PROVIDERS.includes(mode)) throw new TypeError(`review-seat-provider: unknown seat provider ${JSON.stringify(mode)}`);
  return modelDirective(settings, lens, mode);
}

// Model selection is also used for logging disabled seats; it does not grant admission.
function modelDirective(settings, lens, mode) {
  const model = settings.seatModel?.[lens] ?? settings.agyModel;
  if (typeof model !== 'string' || !model) throw new TypeError(`review-seat-provider: the ${lens} seat names no agy model`);
  const budget = mode === 'shadow' && settings.shadowPolicy ? { dailyCap: settings.shadowPolicy.dailyCap ?? 100 } : {};
  const override = settings.shadowModelOverride;
  if (mode === 'shadow' && override?.model && override.model !== model) {
    return Object.freeze({ ...budget, mode, model: override.model, fallbackModel: model, modelSource: override.source, onEscape: 'claude' });
  }
  // No override: today's directive, unchanged. The runner reads an absent `modelSource` as `routing-policy`.
  return Object.freeze({ ...budget, mode, model, onEscape: 'claude' });
}

/** Stable PR-level sampling, shared across both mandatory lenses and all review rounds.
 * Missing identity refuses sampling. Rates at or above 1 are never eligible.
 * A routing-policy projection alone does not enable shadows; operational policy is required.
 */
export function shadowSeatStatus(settings, { repo, pr, earnedShape, careLevel, reasons = [], humanRequired } = {}) {
  const policy = settings?.shadowPolicy;
  if (!policy) return 'off (setting)';
  if (!policy.shadowEnabled) return 'off (setting)';
  if (typeof repo !== 'string' || !repo.trim() || !Number.isSafeInteger(Number(pr)) || Number(pr) < 1) return 'off (missing PR identity)';
  if ((policy.scope ?? 'high-care') === 'high-care') {
    const shape = earnedShape ?? { careLevel, reasons, humanRequired };
    const sensitive = shape.humanRequired === true || (shape.reasons ?? []).some((r) =>
      /^(gate-self|gate-derivation|permission-change|principle-surface|statute|security|merge-gate|review|human-only)(?:\s|$)/.test(r));
    return ['elevated', 'high'].includes(shape.careLevel) || sensitive ? 'sampled' : 'off (routine PR)';
  }
  const rate = policy.sampleRate;
  if (typeof rate !== 'number' || rate < 0 || rate >= 1) return 'off (invalid sample rate)';
  const bucket = createHash('sha256').update(`${repo.trim().toLowerCase()}#${Number(pr)}`).digest().readUInt32BE(0);
  // Integer threshold always leaves at least one hash bucket out, even for a rate just below 1.
  return bucket < Math.floor(rate * 2 ** 32) ? 'sampled' : 'off (sample)';
}
