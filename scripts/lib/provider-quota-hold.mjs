/** Shared pre-launch quota hold; pure and independent of launcher imports. */
export const QUOTA_COOLOFF_MS = 60 * 60 * 1000;
export const CODEX_QUOTA_FULL_PERCENT = 98;

export function isQuotaError(text) {
  if (typeof text !== 'string') return false;
  // Strip only provider prefixes at the start; incidental log mentions are not evidence.
  const message = text.replace(/^(?:(?:API Error|Error):\s*)?(?:\d{3}\s+)?/i, '');
  // Resource exhaustion needs an explicit quota reason; the token alone also covers memory failures.
  if (/^(?:rate[ _-]limit(?:_error)?|usage limit reached|insufficient_quota|resource_exhausted:\s*quota exceeded|too many requests|(?:HTTP|status)\s+429|you exceeded your current quota|you['’]ve hit your (?:weekly |daily |monthly |usage )?limit)\b/i.test(message)) return true;
  if (!message.startsWith('{')) return false;
  try {
    const payload = JSON.parse(message);
    return payload?.type === 'error' && payload.error?.type === 'rate_limit_error';
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
