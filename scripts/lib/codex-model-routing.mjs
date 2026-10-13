/**
 * Single source for Codex model AND effort per task kind. Re-ratified by the operator 2026-10-12:
 * supersedes #3635's "one model, vary effort"; its probe-based evidence remains history.
 * Operator-supplied published benchmarks: Sol ~75% DeepSWE v1.1 at ~1/5 Astra cost (Vellum,
 * DataCamp, Emergent GPT-6.1 Sol); Astra ~74–75%, but Terminal-Bench Science 68% vs Sol 57%;
 * Luna ~64–67% at ~$0.22/task (tosea, aicatchup GPT-6 Luna). No in-house graduation probe:
 * operator judged its cost too high. Every launch still names both axes explicitly.
 * Every Codex call site shares this source: three literal copies let a re-ratification land on
 * one and miss the others. It lives in scripts/lib/, not the CLI: a library must not import an executable.
 *
 * #3635 history (superseded 2026-10-12): ratified 2026-09-11.
 * Fork 1: every Codex invocation names its model explicitly, never the CLI implicit default —
 * STILL IN FORCE, now for model AND effort. Forks 2/3: one model (gpt-6-astra), vary effort only,
 * chosen on 89 logged runs across 8 models — SUPERSEDED by the per-task route.
 * Effort movement was mixed; on Astra, low == medium on that probe.
 */
/**
 * IDENTITY, not a clamp: codex-judge-spawn's old clamp to `high` silently downgraded explicit levels.
 * Supported levels are per MODEL — see CODEX_MODEL_CATALOGUE, validated separately.
 */
export const CODEX_EFFORT_MAP = Object.freeze({
  low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max', ultra: 'ultra',
});

/** Registry/probation/dispatch identity and explicit strong rung; no longer every launch's default. */
export const CODEX_MODEL = 'gpt-6-astra';

/** Backward-compatible caller effort rungs. Explicit effort takes precedence over tier. */
export const CODEX_TIER_EFFORT = Object.freeze({ haiku: 'low', sonnet: 'medium', opus: 'high' });

/** Explicit effort wins over tier; neither selects the sonnet rung (`medium`). Throws on unknown effort/tier. */
export function resolveCodexEffort({ tier, effort } = {}) {
  if (effort !== undefined) {
    if (!Object.hasOwn(CODEX_EFFORT_MAP, effort)) {
      throw new TypeError(`codex-direct-task: \`effort\` must be one of ${Object.keys(CODEX_EFFORT_MAP).join('|')}, got ${JSON.stringify(effort)}`);
    }
    return effort;
  }
  if (tier !== undefined) {
    // `Object.hasOwn`, not a truthiness test on the lookup: a bare object literal still inherits
    // `constructor`/`toString`, so `CODEX_TIER_EFFORT['constructor']` is truthy and would sail through.
    const mapped = Object.hasOwn(CODEX_TIER_EFFORT, tier) ? CODEX_TIER_EFFORT[tier] : undefined;
    if (!mapped) {
      throw new TypeError(`codex-direct-task: \`tier\` must be one of ${Object.keys(CODEX_TIER_EFFORT).join('|')}, got ${JSON.stringify(tier)}`);
    }
    return mapped;
  }
  return CODEX_TIER_EFFORT.sonnet;
}

/** Validate and trim a non-empty model operand; reject flag-shaped strings. */
export function assertCodexModel(model, who = 'codex-model-routing') {
  // A dash-leading model would be parsed by Codex as a flag, silently changing the command.
  if (typeof model !== 'string' || !model.trim() || model.trim().startsWith('-')) {
    throw new TypeError(`${who}: \`model\` must be a plain non-empty string, got ${JSON.stringify(model)}`);
  }
  return model.trim();
}

// CLI 0.162.1 catalogue, 2026-10-12. Re-derive from `codex debug models` on a CLI upgrade.
const ALL_EFFORTS = Object.freeze(Object.keys(CODEX_EFFORT_MAP));
const THROUGH_MAX = Object.freeze(ALL_EFFORTS.slice(0, -1));
export const CODEX_MODEL_CATALOGUE = Object.freeze({
  'gpt-6.1-sol': ALL_EFFORTS,
  'gpt-6-astra': ALL_EFFORTS,
  'gpt-6-sol': ALL_EFFORTS,
  'gpt-6-luna': THROUGH_MAX,
  'gpt-5.6-sol': ALL_EFFORTS,
  'gpt-5.6-terra': ALL_EFFORTS,
  'gpt-5.6-luna': THROUGH_MAX,
  'gpt-5.5': Object.freeze(ALL_EFFORTS.slice(0, 4)),
  'gpt-reserve': THROUGH_MAX,
  'codex-auto-review': THROUGH_MAX,
});

export const CODEX_TASK_KINDS = Object.freeze([
  'prepare', 'prepare-complex', 'takeover', 'design', 'fix', 'ci-heal', 'build',
  'worker', 'trivial', 'review', 'review-mandatory',
]);

// Follow-up: shared taskTier (kind → tier → per-vendor model+effort for Claude AND Codex).
// Keep this flat kind → { model, effort } vocabulary so that projection can replace it.
export const CODEX_MODEL_BY_TASK_DEFAULT = Object.freeze(Object.fromEntries([
  ['prepare', 'gpt-6-astra', 'medium'],
  ['prepare-complex', 'gpt-6-astra', 'high'],
  ['takeover', 'gpt-6-astra', 'high'],
  ['design', 'gpt-6-astra', 'high'],
  ...['fix', 'ci-heal', 'build', 'worker', 'review'].map(kind => [kind, 'gpt-6.1-sol', 'medium']),
  ['trivial', 'gpt-6-luna', 'low'],
  ['review-mandatory', 'gpt-6-astra', 'high'],
].map(([kind, model, effort]) => [kind, Object.freeze({ model, effort })])));

const ALIASES = Object.freeze({
  stronger: 'takeover', 'stronger-model': 'takeover', card: 'trivial', 'card-filing': 'trivial',
  'prevention-card': 'trivial', 'card-rename': 'trivial', conflict: 'trivial', delivery: 'build', heal: 'ci-heal',
});

/** PURE: classify task complexity without touching policy or IO. */
export function classifyCodexTask({ kind = 'worker', size, epic, decision, care, mandatoryLens } = {}) {
  if (Object.hasOwn(ALIASES, kind)) kind = ALIASES[kind];
  if (!CODEX_TASK_KINDS.includes(kind)) {
    throw new TypeError(`Unknown Codex task kind ${JSON.stringify(kind)}; allowed kinds: ${CODEX_TASK_KINDS.join('|')}`);
  }
  const elevated = care === 'elevated' || care === 'high';
  if (kind === 'prepare' && (size >= 8 || epic || decision || elevated)) return 'prepare-complex';
  if (kind === 'review' && mandatoryLens && elevated) return 'review-mandatory';
  return kind;
}

/** PURE: unknown caller-pinned slugs defer entitlement to Codex, but never accept unknown effort words. */
export function codexModelSupportsEffort(model, effort) {
  return Object.hasOwn(CODEX_EFFORT_MAP, effort)
    && (!Object.hasOwn(CODEX_MODEL_CATALOGUE, model) || CODEX_MODEL_CATALOGUE[model].includes(effort));
}

// Observed rollout rate_limits.limit_id (Astra runs): 'codex', recorded for these families.
// The catalogue exposes NO per-model bucket field; this is observed attribution, not entitlement metadata.
// Slugs with no observation stay null; launchers can report their own rollout's actual value.
export const CODEX_USAGE_BUCKETS = Object.freeze(Object.fromEntries(
  Object.keys(CODEX_MODEL_CATALOGUE).map(slug => [slug, /^gpt-(6[.-]|5\.6-)/.test(slug) ? 'codex' : null]),
));

/** PURE: last rollout token_count bucket and primary usage, or null when absent. */
export function parseRolloutUsageBucket(jsonlText) {
  let last = null;
  for (const line of String(jsonlText ?? '').split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type !== 'event_msg' || event.payload?.type !== 'token_count') continue;
    const limits = event.payload.rate_limits;
    if (typeof limits?.limit_id === 'string' && limits.limit_id) {
      last = { limit_id: limits.limit_id, used_percent: limits.primary?.used_percent ?? null };
    }
  }
  return last;
}

/** PURE: one operator audit line, including both independent policy sources. */
export function formatCodexRouteLine(route) {
  return `codex-route · kind=${route.kind} model=${route.model} (${route.sources.model}) effort=${route.effort} (${route.sources.effort}) bucket=${route.bucket}`;
}

/** Always emit per launch (no once-per-process deduplication). Logging must never break a launch. */
export function logCodexRoute(route, { log = l => console.error(l) } = {}) {
  try { log(formatCodexRouteLine(route)); } catch { /* best-effort audit sink */ }
}
