/**
 * review-seat-provider.mjs — WHICH PROVIDER SITS EACH REVIEW SEAT (card 84, review half).
 *
 * THE SETTINGS. Three keys, declared per the
 * [config-extends-platform-default](../../docs/agent/platform-decisions.md#config-extends-platform-default) statute:
 *
 *   - `review.seatProvider.<lens>` = `claude` | `agy` | `shadow`, one per mandatory lens (`correctness`, `security`).
 *       `claude` — the seat runs on Claude only (today's behaviour).
 *       `agy`    — the seat runs on the Antigravity CLI (`agy`) instead. If the agy juror escapes its juror lane, or
 *                  fails, the seat falls back to Claude (see `we:scripts/lib/agy-review-juror.mjs`).
 *       `shadow` — Claude judges and ONLY its verdict counts; an agy juror judges the same seat beside it, both answers
 *                  are recorded, and an agreement row is appended per seat (`review-shadow-agreement.mjs`).
 *   - `review.agyModel` — the agy model for every agy juror (shadow, agy and the advisory seat).
 *   - `review.advisorySeats.agyCorrectness` — seat the ADVISORY `agy-correctness` juror (never blocks).
 *
 * THE CHAIN. `REVIEW_SEAT_PLATFORM_DEFAULT` below is the fully-defined platform flavor: every key has a value, and
 * that value is the native one (Claude on every seat, no extra seat). The project config
 * (`review-seat-provider.json`, next to this file) `extends` it and sets only what it changes. Lookup is
 * nearest-wins, per key, never a destructive merge: the project value if it declares one, else the platform's. The
 * resolver itself holds no defaults — it only walks the chain it is given.
 *
 * A BAD VALUE NEVER SILENTLY CHANGES A SEAT. An unknown provider word, an unknown lens, or a non-boolean switch throws
 * at load — the same posture the review-policy contract takes — so a typo in the project file is a loud failure,
 * never a seat that quietly runs on the wrong provider.
 *
 * PURE apart from {@link loadReviewSeatSettings}'s one file read.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The closed provider vocabulary for a seat. */
export const SEAT_PROVIDERS = Object.freeze(['claude', 'agy', 'shadow']);

/** The lenses a seat provider may be set for: the two mandatory seats `review-pr` declares. */
export const SEAT_PROVIDER_LENSES = Object.freeze(['correctness', 'security']);

/** The project config file, next to this module. */
export const REVIEW_SEAT_PROJECT_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), 'review-seat-provider.json');

/** The name a project config uses in `extends` to point at {@link REVIEW_SEAT_PLATFORM_DEFAULT}. */
export const PLATFORM_FLAVOR = 'platform';

/** The fully-defined platform flavor. Native-first: every seat on Claude, no agy seat. */
export const REVIEW_SEAT_PLATFORM_DEFAULT = Object.freeze({
  review: Object.freeze({
    seatProvider: Object.freeze({ correctness: 'claude', security: 'claude' }),
    agyModel: 'claude-opus-5-5-high',
    advisorySeats: Object.freeze({ agyCorrectness: false }),
  }),
});

const isPlainObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** Read one dotted key off one config layer, or `undefined` when that layer does not declare it. */
function layerValue(layer, path) {
  let node = layer;
  for (const part of path) {
    if (!isPlainObject(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/** Validate one project layer. Throws on anything that is not a known key with a legal value. */
export function validateReviewSeatConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('review-seat-provider: the config must be an object');
  const extendsList = config.extends ?? [PLATFORM_FLAVOR];
  if (!Array.isArray(extendsList) || extendsList.some((e) => e !== PLATFORM_FLAVOR)) {
    throw new TypeError(`review-seat-provider: \`extends\` must be ["${PLATFORM_FLAVOR}"], got ${JSON.stringify(config.extends)}`);
  }
  const review = config.review ?? {};
  if (!isPlainObject(review)) throw new TypeError('review-seat-provider: `review` must be an object');
  for (const key of Object.keys(review)) {
    if (!['seatProvider', 'agyModel', 'advisorySeats'].includes(key)) {
      throw new TypeError(`review-seat-provider: unknown setting \`review.${key}\``);
    }
  }
  for (const [lens, provider] of Object.entries(review.seatProvider ?? {})) {
    if (!SEAT_PROVIDER_LENSES.includes(lens)) {
      throw new TypeError(`review-seat-provider: \`review.seatProvider.${lens}\` — no such seat (one of ${SEAT_PROVIDER_LENSES.join('|')})`);
    }
    if (!SEAT_PROVIDERS.includes(provider)) {
      throw new TypeError(`review-seat-provider: \`review.seatProvider.${lens}\` must be one of ${SEAT_PROVIDERS.join('|')}, got ${JSON.stringify(provider)}`);
    }
  }
  if (review.agyModel !== undefined
      && (typeof review.agyModel !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(review.agyModel))) {
    throw new TypeError(`review-seat-provider: \`review.agyModel\` must be a plain model id, got ${JSON.stringify(review.agyModel)}`);
  }
  for (const [seat, on] of Object.entries(review.advisorySeats ?? {})) {
    if (seat !== 'agyCorrectness') throw new TypeError(`review-seat-provider: unknown advisory seat \`review.advisorySeats.${seat}\``);
    if (typeof on !== 'boolean') throw new TypeError(`review-seat-provider: \`review.advisorySeats.${seat}\` must be true or false`);
  }
  return config;
}

/**
 * Resolve the effective settings: nearest-wins per key over `[project, platform]`. PURE.
 * @param {object} [project] - the project layer (already parsed). Absent = the platform flavor alone.
 * @param {object} [platform]
 * @returns {{seatProvider: {correctness: string, security: string}, agyModel: string, agyCorrectnessAdvisory: boolean}}
 */
export function resolveReviewSeatSettings(project = {}, platform = REVIEW_SEAT_PLATFORM_DEFAULT) {
  validateReviewSeatConfig(project);
  const chain = [project, platform];
  const lookup = (...path) => {
    for (const layer of chain) {
      const v = layerValue(layer, path);
      if (v !== undefined) return v;
    }
    throw new Error(`review-seat-provider: the platform flavor declares no \`${path.join('.')}\``);
  };
  return Object.freeze({
    seatProvider: Object.freeze(Object.fromEntries(SEAT_PROVIDER_LENSES.map((lens) => [lens, lookup('review', 'seatProvider', lens)]))),
    agyModel: lookup('review', 'agyModel'),
    agyCorrectnessAdvisory: lookup('review', 'advisorySeats', 'agyCorrectness'),
  });
}

/**
 * Read the project config and resolve it. A MISSING file is the platform flavor alone; an unreadable or invalid
 * one throws (see the header — a typo must not silently move a seat).
 * @param {{path?: string, read?: Function}} [o]
 */
export function loadReviewSeatSettings({ path = REVIEW_SEAT_PROJECT_CONFIG_PATH, read = readFileSync } = {}) {
  let text;
  try { text = read(path, 'utf8'); } catch (e) {
    if (e?.code === 'ENOENT') return resolveReviewSeatSettings({});
    throw e;
  }
  return resolveReviewSeatSettings(JSON.parse(text));
}

/**
 * The seat-provider directive a mandatory seat's judge request carries, or `null` for a plain Claude seat. PURE.
 * @param {object} settings - from {@link resolveReviewSeatSettings}.
 * @param {string} lens
 */
export function seatProviderDirective(settings, lens) {
  const mode = settings?.seatProvider?.[lens];
  if (!mode || mode === 'claude') return null;
  return Object.freeze({ mode, model: settings.agyModel, onEscape: 'claude' });
}
