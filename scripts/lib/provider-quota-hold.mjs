/** Shared pre-launch quota hold; pure and independent of launcher imports. */
export const QUOTA_COOLOFF_MS = 60 * 60 * 1000;
export const CODEX_QUOTA_FULL_PERCENT = 98;

export function isQuotaError(text) {
  return typeof text === 'string'
    && /\b(rate[ _-]?limit|usage limit|quota|insufficient[_ ]quota|resource[_ ]exhausted|too many requests|429|you['’]ve hit your (?:weekly |daily |monthly )?limit)\b/i.test(text);
}

export function quotaHoldRow({ provider, error, now = Date.now() }) {
  if (!isQuotaError(error)) return null;
  return { provider, status: 'quota-exhausted', scoredAt: new Date(now).toISOString(), quotaResetsAt: null };
}

export function providerQuotaHold(records, provider, now) {
  const rows = (Array.isArray(records) ? records : []).filter((r) => r.provider === provider)
    .sort((a, b) => String(b.scoredAt ?? '').localeCompare(String(a.scoredAt ?? '')));
  const last = rows[0];
  if (!last) return null;
  const resetAt = Date.parse(last.quotaResetsAt ?? '');
  if (last.status === 'quota-exhausted') {
    const until = Number.isFinite(resetAt) ? resetAt : Date.parse(last.scoredAt ?? '') + QUOTA_COOLOFF_MS;
    if (Number.isFinite(until) && now < until) return `quota exhausted on its last seat call (${last.scoredAt}); sitting out until ${new Date(until).toISOString()}`;
    return null;
  }
  if (typeof last.quotaUsedPercent === 'number' && last.quotaUsedPercent >= CODEX_QUOTA_FULL_PERCENT
    && Number.isFinite(resetAt) && now < resetAt) {
    return `quota gauge at ${last.quotaUsedPercent}% on its last seat call; sitting out until ${new Date(resetAt).toISOString()}`;
  }
  return null;
}
