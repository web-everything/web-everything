/** Who writes code: routing.builder (claude | codex | auto). Audits and review seats stay on routing.auditProvider. */
import { readDeclaredSettings } from './settings-files.mjs';
import { readCodexQuota } from './codex-usage-ledger.mjs';
import { CAPACITY_DEFAULTS, PROVIDER_DEFAULTS, chooseBuilder } from './provider-capacity.mjs';
import { observeCapacity, recordCapacityDecision } from './provider-capacity-io.mjs';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';

export const BUILDERS = Object.freeze(['claude', 'codex', 'auto']);
/** Dispatch kinds whose code-writing may move off Codex. Review, red-team and audit seats are never in this list. */
export const BUILD_KINDS = Object.freeze(['prepare', 'prepare-item', 'prepare-complex', 'prepare-card', 'takeover', 'design', 'fix', 'ci-heal', 'build', 'worker', 'doc-fix', 'prevention-card']);
const DEFAULTS = Object.freeze({ builder: 'codex', auditProvider: 'codex', codexReserveForAudit: true, autoClaudeAbovePercent: 70 });

export function resolveRoutingSettings({ env = process.env, repo, declared } = {}) {
  const read = repo === undefined ? (declared ?? readDeclaredSettings()) : { settings: repo, errors: [] };
  const file = read.settings?.routing ?? {};
  const out = { ...DEFAULTS, source: 'default' };
  // A malformed settings file fails closed to claude: the quota-safe direction.
  if (read.errors?.length) { out.builder = 'claude'; out.source = 'unreadable-settings'; }
  // An invalid value fails closed to claude (keeps Codex reserved) rather than silently restoring codex.
  if (file.builder !== undefined) { out.builder = BUILDERS.includes(file.builder) ? file.builder : 'claude'; out.source = 'repo'; }
  if (typeof file.auditProvider === 'string' && file.auditProvider) out.auditProvider = file.auditProvider;
  if (typeof file.codexReserveForAudit === 'boolean') out.codexReserveForAudit = file.codexReserveForAudit;
  if (Number.isFinite(file.autoClaudeAbovePercent) && file.autoClaudeAbovePercent >= 0 && file.autoClaudeAbovePercent <= 100) out.autoClaudeAbovePercent = file.autoClaudeAbovePercent;
  const raw = typeof env?.WE_ROUTING_BUILDER === 'string' ? env.WE_ROUTING_BUILDER.trim() : '';
  if (raw) { out.builder = BUILDERS.includes(raw) ? raw : 'claude'; out.source = 'env'; }
  const capacity = cascadePolicy('routing.capacity', file.capacity, {
    standard: { ...CAPACITY_DEFAULTS, enabled: out.builder === 'auto' }, env,
    platform: readPlatformPreferences({ env }).prefs.routing?.capacity ?? {},
    valid: Object.fromEntries(Object.entries({ ...CAPACITY_DEFAULTS, enabled: true }).map(([key, value]) => [key,
      typeof value === 'number' ? v => Number.isFinite(v) && v >= 0 && (!['urgencyHorizonHours', 'staleHours'].includes(key) || v > 0)
        : typeof value === 'boolean' ? v => typeof v === 'boolean'
          : Array.isArray(value) ? v => Array.isArray(v) && v.every(x => typeof x === 'string')
            : key === 'workingHours' ? () => true : v => v === null || typeof v === 'object' || typeof v === 'number' || typeof v === 'string',
    ])),
  });
  const providers = cascadePolicy('providerCapacity', read.settings?.providerCapacity, {
    standard: PROVIDER_DEFAULTS, platform: readPlatformPreferences({ env }).prefs.providerCapacity ?? {}, env,
    valid: { providers: value => Array.isArray(value) && value.length <= 100 && new Set(value.map(p => p?.id)).size === value.length
      && value.every(p => p && /^[a-z][a-z0-9-]*$/.test(p.id) && typeof p.launcher === 'string' && Number.isFinite(p.tier)
        && ['fixed', 'restartOnReset', 'rolling'].includes(p.windowModel) && Array.isArray(p.allowedKinds)
        && Array.isArray(p.windows) && Array.isArray(p.readers) && (!p.accounts || (Array.isArray(p.accounts) && p.accounts.length <= 100))),
      minimumTiers: v => Number.isFinite(v) && v >= 0 },
  });
  out.capacity = { ...capacity.value, ...providers.value };
  out.providerCapacitySources = providers.sources;
  out.capacitySources = capacity.sources;
  return out;
}

/** Explicit builders are unchanged; auto scores capacity and retains the threshold fallback when all usage is unknown. */
export function effectiveBuilder({ env = process.env, repo, declared, quota = readCodexQuota, kind = 'build', capacity, now = Date.now(), records, routeKey, queuedDemand = 0, demandRatePerHour, record = recordCapacityDecision } = {}) {
  const s = resolveRoutingSettings({ env, ...(repo ? { repo } : {}), ...(declared ? { declared } : {}) });
  if (s.builder !== 'auto') return { builder: s.builder, source: s.source, settings: s };
  let q;
  try { q = quota(env); } catch { q = null; }
  const used = Number.isFinite(q?.used_percent) ? q.used_percent : null;
  // Unreadable quota is not "below threshold": the quota-safe direction is claude.
  const fallback = used !== null && used < s.autoClaudeAbovePercent ? 'codex' : 'claude';
  if (!s.capacity.enabled) return { builder: fallback, source: 'auto', usedPercent: used, settings: s };
  const planning = { ...s.capacity, routeKey, queuedDemand, demandRatePerHour };
  const capacities = capacity ?? observeCapacity({ env, now, settings: s.capacity, quota: () => q, records });
  const decision = chooseBuilder({ kind, capacities, settings: { ...planning, now }, fallback });
  try { record(decision, { env, now, kind, capacities, settings: planning }); } catch { /* best effort */ }
  return { builder: decision.provider, account: decision.account, source: 'auto', usedPercent: used, settings: s, capacities, decision };
}
