/** Fixed diagnostic vocabulary: never return matched child text. PURE. */
const PATTERNS = [
  ['incomplete-context', /incomplete pass context|pass snapshot unavailable/i],
  ['gh-auth', /bad credentials|http 401|authentication|not logged in|gh auth/i],
  ['gh-not-found', /http 404|not found|could not resolve to a/i],
  ['gh-rate-limit', /rate limit|http 403.*secondary|abuse|http 429/i],
  ['network', /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network/i],
  ['parse', /SyntaxError|unexpected token|JSON/i],
];

export function classifyChildFailure(stderr, { timedOut = false, error } = {}) {
  if (timedOut) return 'timeout';
  if (error) return 'spawn-error';
  const tail = String(stderr ?? '').slice(-8000);
  return PATTERNS.find(([, pattern]) => pattern.test(tail))?.[0] ?? 'unknown';
}
