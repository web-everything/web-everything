/** Shared pre-launch quota hold; pure and independent of launcher imports. */
export const QUOTA_COOLOFF_MS = 60 * 60 * 1000;
export const CODEX_QUOTA_FULL_PERCENT = 98;

export function isQuotaError(text) {
  if (typeof text !== 'string') return false;
  // Only direct provider messages qualify; arbitrary wrappers and logs are not evidence.
  if (/^(?:you exceeded your current quota|you['’]ve hit your (?:weekly|daily|monthly|usage|session|hourly|5-hour) limit)\b/i.test(text)) return true;
  // The CLI may wrap a structured provider response with its API status prefix.
  const message = text.replace(/^API Error: \d{3} /, '');
  if (!message.startsWith('{')) return false;
  try {
    const payload = JSON.parse(message);
    return ['rate_limit_error', 'insufficient_quota'].includes(payload?.type)
      || ['rate_limit_error', 'insufficient_quota'].includes(payload?.error?.type);
  } catch {
    return false;
  }
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
