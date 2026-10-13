/**
 * Read-only promotion evidence. This report never changes mergeGate.reviewAuthority.
 * Defaults mirror PLATFORM_VERDICT_LEDGER_DEFAULTS.promotion; tests pin the mirror.
 */
import { readCheckRuns, etDay, dayBefore, SHADOW_OP } from './review-ledger-history.mjs';
import { classifyHoldCodes } from './drain-ledger-shadow.mjs';

export const PROMOTION_DEFAULTS = Object.freeze({
  windowDays: 7, minShadowDays: 7, minComparedPRs: 100, minAgreementPct: 99, maxUnsafeDisagreements: 0,
});
const ENV_KEYS = {
  windowDays: 'WE_LEDGER_PROMOTION_WINDOW_DAYS',
  minShadowDays: 'WE_LEDGER_PROMOTION_MIN_SHADOW_DAYS',
  minComparedPRs: 'WE_LEDGER_PROMOTION_MIN_COMPARED_PRS',
  minAgreementPct: 'WE_LEDGER_PROMOTION_MIN_AGREEMENT_PCT',
  maxUnsafeDisagreements: 'WE_LEDGER_PROMOTION_MAX_UNSAFE_DISAGREEMENTS',
};
const valid = (k, v) => typeof v === 'number' && Number.isFinite(v) && (k === 'minAgreementPct'
  ? v >= 0 && v <= 100 : Number.isSafeInteger(v) && v >= (k === 'maxUnsafeDisagreements' ? 0 : 1));

/** Pure cascade: invalid higher layers are reported and leave the valid lower layer in place. */
export function resolvePromotionSettings({ repo, env } = {}) {
  const settings = { ...PROMOTION_DEFAULTS }, sources = {}, invalid = [];
  for (const k of Object.keys(settings)) {
    sources[k] = 'standard';
    const layer = repo?.verdictLedger?.promotion;
    if (layer && Object.hasOwn(layer, k)) {
      if (valid(k, layer[k])) { settings[k] = layer[k]; sources[k] = 'repo'; }
      else invalid.push(`repo.verdictLedger.promotion.${k}`);
    }
    const raw = env?.[ENV_KEYS[k]];
    if (raw !== undefined && raw !== '') {
      const n = /^\d+(?:\.\d+)?$/.test(String(raw).trim()) ? Number(String(raw).trim()) : NaN;
      if (valid(k, n)) { settings[k] = n; sources[k] = 'env'; }
      else invalid.push(`env.${ENV_KEYS[k]}`);
    }
  }
  return { settings, sources, invalid };
}

export function formatPromotionSettings(s) {
  return Object.keys(PROMOTION_DEFAULTS).map(k => `${k}=${s.settings[k]} (${s.sources[k]})`).join(', ')
    + (s.invalid?.length ? ` · ignored invalid: ${s.invalid.join(', ')}` : '');
}

/** Legacy label-clear rows prove the drain's mechanical facts cleared; schema-2 rows already carry evidence. */
export function reclassifyRow(row) {
  if (row?.schema === 2 || row?.status !== 'disagree' || row?.direction !== 'ledger-holds-label-clears'
    || typeof row.reason !== 'string' || !row.reason.startsWith('ledger holds: ')) return row;
  const codes = row.reason.slice('ledger holds: '.length).split(', ').map(c => c.trim());
  if (!classifyHoldCodes(codes)) return row;
  return { ...row, status: 'transient', direction: null, transient: 'stale-drain-mechanical-hold' };
}

/** IO is inherited from the history reader and injectable. */
export function readShadowRuns(options = {}) {
  return readCheckRuns({ ...options, op: SHADOW_OP });
}

/** Pure trailing ET-day measure. Truncated evidence cannot establish readiness. */
export function measureReadiness(runs = [], { now = new Date(), settings = PROMOTION_DEFAULTS } = {}) {
  const s = { ...PROMOTION_DEFAULTS, ...settings };
  const to = etDay(now);
  if (!to) throw new TypeError('invalid readiness time');
  const from = dayBefore(to, s.windowDays - 1);
  const selected = runs.filter(r => {
    const day = etDay(r?.input?.at);
    return day && day >= from && day <= to;
  });
  const days = new Set(), prs = new Set(), reasons = new Map();
  const m = { window: { from, to }, records: selected.length, shadowDays: 0, comparedPRs: 0,
    rows: 0, agree: 0, disagree: 0, unreadable: 0, transient: 0, unsafe: 0 };
  let incomplete = 0;
  for (const run of selected) {
    days.add(etDay(run.input.at));
    if (run.findings?.rowsTruncated || !Array.isArray(run.findings?.rows)) incomplete++;
    for (const stored of run.findings?.rows ?? []) {
      const row = reclassifyRow({ ...stored, schema: run.input.schema ?? stored.schema });
      m.rows++;
      if (['agree', 'disagree', 'unreadable', 'transient'].includes(row.status)) m[row.status]++;
      else { m.unreadable++; incomplete++; }
      if (row.repo && Number.isInteger(row.pr)) prs.add(`${row.repo.trim().toLowerCase()}#${row.pr}`);
      if (row.direction === 'ledger-clears-label-holds') m.unsafe++;
      if (row.status === 'disagree') {
        const reason = row.reason || 'unknown';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
  }
  m.shadowDays = days.size;
  m.comparedPRs = prs.size;
  const denominator = m.agree + m.disagree + m.unreadable;
  m.agreementPct = denominator ? m.agree / denominator * 100 : 0;
  m.checks = [
    { name: 'shadowDays', value: m.shadowDays, threshold: s.minShadowDays, pass: m.shadowDays >= s.minShadowDays },
    { name: 'comparedPRs', value: m.comparedPRs, threshold: s.minComparedPRs, pass: m.comparedPRs >= s.minComparedPRs },
    { name: 'agreementPct', value: m.agreementPct, threshold: s.minAgreementPct, pass: denominator > 0 && m.agreementPct >= s.minAgreementPct },
    { name: 'unsafe', value: m.unsafe, threshold: s.maxUnsafeDisagreements, pass: m.unsafe <= s.maxUnsafeDisagreements },
  ];
  if (incomplete) m.checks.push({ name: 'incompleteRecords', value: incomplete, threshold: 0, pass: false });
  m.blockers = m.checks.filter(c => !c.pass).map(c => c.name);
  m.ready = m.blockers.length === 0;
  m.topDisagreeReasons = [...reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
  return m;
}

export function formatReadinessLine(m, settingsResult = resolvePromotionSettings()) {
  const s = settingsResult.settings;
  return `merge-ai-prs · ledger readiness: ${m.ready ? 'READY (operator flips mergeGate.reviewAuthority; nothing here flips it)' : 'NOT READY'}`
    + ` · agreement ${m.agreementPct.toFixed(1)}% (need ≥${s.minAgreementPct}) · PRs ${m.comparedPRs}/${s.minComparedPRs}`
    + ` · days ${m.shadowDays}/${s.minShadowDays} · unsafe ${m.unsafe}/≤${s.maxUnsafeDisagreements} · transient ${m.transient}`
    + ` · settings ${formatPromotionSettings(settingsResult)}`;
}
