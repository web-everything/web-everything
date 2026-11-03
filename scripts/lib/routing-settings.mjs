/** Who writes code: routing.builder (claude | codex | auto). Audits and review seats stay on routing.auditProvider. */
import { readSettings } from './settings-files.mjs';
import { readCodexQuota } from './codex-usage-ledger.mjs';

export const BUILDERS = Object.freeze(['claude', 'codex', 'auto']);
/** Dispatch kinds whose code-writing may move off Codex. Review, red-team and audit seats are never in this list. */
export const BUILD_KINDS = Object.freeze(['prepare', 'prepare-item', 'prepare-complex', 'prepare-card', 'takeover', 'design', 'fix', 'ci-heal', 'build', 'worker', 'doc-fix', 'prevention-card']);
const DEFAULTS = Object.freeze({ builder: 'codex', auditProvider: 'codex', codexReserveForAudit: true, autoClaudeAbovePercent: 70 });

export function resolveRoutingSettings({ env = process.env, repo = readSettings() } = {}) {
  const file = repo?.routing ?? {};
  const out = { ...DEFAULTS, source: 'default' };
  // An invalid value fails closed to claude (keeps Codex reserved) rather than silently restoring codex.
  if (file.builder !== undefined) { out.builder = BUILDERS.includes(file.builder) ? file.builder : 'claude'; out.source = 'repo'; }
  if (typeof file.auditProvider === 'string' && file.auditProvider) out.auditProvider = file.auditProvider;
  if (typeof file.codexReserveForAudit === 'boolean') out.codexReserveForAudit = file.codexReserveForAudit;
  if (Number.isFinite(file.autoClaudeAbovePercent) && file.autoClaudeAbovePercent >= 0 && file.autoClaudeAbovePercent <= 100) out.autoClaudeAbovePercent = file.autoClaudeAbovePercent;
  const raw = typeof env?.WE_ROUTING_BUILDER === 'string' ? env.WE_ROUTING_BUILDER.trim() : '';
  if (raw) { out.builder = BUILDERS.includes(raw) ? raw : 'claude'; out.source = 'env'; }
  return out;
}

/** The effective builder: 'claude' or 'codex'. `auto` reads the newest Codex quota reading; unknown keeps codex. */
export function effectiveBuilder({ env = process.env, repo, quota = readCodexQuota } = {}) {
  const s = resolveRoutingSettings({ env, ...(repo ? { repo } : {}) });
  if (s.builder !== 'auto') return { builder: s.builder, source: s.source, settings: s };
  const q = quota(env);
  const used = Number.isFinite(q?.used_percent) ? q.used_percent : null;
  return { builder: used !== null && used >= s.autoClaudeAbovePercent ? 'claude' : 'codex', source: 'auto', usedPercent: used, settings: s };
}
