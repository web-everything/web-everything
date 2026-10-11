/**
 * Seed smell 14 / #4066 — GitHub App token trouble and REST rate-limit headroom. Two subjects:
 *
 *   - `app-token`: the shared App token cache (`~/.claude/github-app-token/web-everything.json`) is past its
 *     expiry, or the last recorded refresh attempt (`status.json#checkedAt`) is older than `refreshStaleMs`.
 *     Every `ensureFreshGithubAppEnv` call refreshes the token `REFRESH_BUFFER_MS` (10 min) before it expires, so
 *     an expired cache means refresh is failing or nothing is calling it, and the next gh call that trusts the
 *     cached token gets a 401.
 *   Configured roles use `app-token:<role>` and their own expiry/per-caller refresh time. The legacy
 *   subject remains only with no configured roles or a caller still using legacy auth. Missing role caches
 *   breach; legacy fixture probes retain their original no-cache behavior.
 *
 *   - `rest-core`: the REST `core` bucket has less than `minRemainingFraction` (10%) left.
 *
 * Neighbours, so this never double-alerts: an App token that is refused outright (`status.applied === false`:
 * mint-failed, insufficient-access) and 401s in the daemon logs are `bad-credentials`; the GraphQL bucket is
 * `gh-graphql-budget` (read in-band, because the REST endpoint's `graphql` entry disagreed with it live).
 *
 * The `appToken` probe reads only the cache's `expiresAt` — never the token itself. `restBudget` is
 * `gh api rate_limit` (free: that endpoint does not count against the limit).
 *
 * INHIBITS agent dispatch (`health-investigate-plan.mjs#INHIBITING_SMELLS`): an investigator started now would
 * hit the same expired token or empty bucket through the gh shim. Deterministic diagnosis + alert, high.
 */
import { MINUTE, fmtAge } from '../health-watch-core.mjs';

export default {
  id: 'github-app-token',
  scope: 'host',
  cadence: 'every-tick',
  probes: ['appToken', 'restBudget'],
  openAfter: 1,
  closeAfter: 2,
  severity: 'high',
  action: 'alert',
  minRemainingFraction: 0.1,
  refreshStaleMs: 30 * MINUTE,
  diagnose: { command: 'node', args: ['scripts/conveyor/github-app-status.mjs'], timeoutMs: 15_000 },
  recommendationHint: 'The GitHub App token is not being refreshed, or the REST rate limit is nearly spent.',
  evaluate({ appToken, restBudget, appStatus }, { now }) {
    const out = [];
    const roles = appStatus?.roleCaches ?? [];
    const subjects = roles.map((cache) => ({ subject: `app-token:${cache.role}`, token: cache, status: cache }));
    if ((!roles.length || appStatus?.legacyInUse) && appToken?.present) {
      subjects.push({ subject: 'app-token', token: appToken, status: appStatus });
    }
    for (const { subject, token: appToken, status: appStatus } of subjects) {
      const exp = Date.parse(appToken.expiresAt ?? '');
      const checked = Date.parse(appStatus?.checkedAt ?? '');
      const expired = !Number.isFinite(exp) || exp <= now;
      const refreshStale = Number.isFinite(checked) && now - checked > this.refreshStaleMs;
      const why = [
        ...(expired ? [Number.isFinite(exp) ? `cached token expired ${fmtAge(now - exp)} ago` : 'cached token has no readable expiry'] : []),
        ...(refreshStale ? [`last refresh attempt ${fmtAge(now - checked)} ago`] : []),
      ];
      out.push({
        subject,
        breach: expired || refreshStale,
        measure: {
          expiresAt: appToken.expiresAt ?? null, expiresInMs: Number.isFinite(exp) ? exp - now : null,
          lastRefreshAt: appStatus?.checkedAt ?? null, lastRefreshReason: appStatus?.reason ?? null,
        },
        summary: `App token: ${Number.isFinite(exp) ? (exp > now ? `expires in ${fmtAge(exp - now)}` : `EXPIRED ${fmtAge(now - exp)} ago`) : 'no expiry'}`
          + `; last refresh attempt ${Number.isFinite(checked) ? `${fmtAge(now - checked)} ago (${appStatus?.reason ?? '?'})` : 'never recorded'}.`,
        recommendation: why.length
          ? `The App token is not being refreshed (${why.join('; ')}). Check that the daemons are ticking (they refresh it), `
            + 'then run `node scripts/conveyor/github-app-status.mjs`; gh calls on the cached token will 401 until a refresh succeeds.'
          : 'ok',
      });
    }
    if (restBudget && Number.isFinite(restBudget.limit) && restBudget.limit > 0 && Number.isFinite(restBudget.remaining)) {
      const fraction = restBudget.remaining / restBudget.limit;
      const resetMs = Number.isFinite(restBudget.reset) ? restBudget.reset * 1000 : null;
      const breach = fraction < this.minRemainingFraction;
      out.push({
        subject: 'rest-core',
        breach,
        measure: {
          remaining: restBudget.remaining, limit: restBudget.limit, used: restBudget.used ?? null,
          remainingFraction: Math.round(fraction * 1000) / 1000, resetAt: resetMs ? new Date(resetMs).toISOString() : null,
        },
        summary: `REST core rate limit: ${restBudget.remaining}/${restBudget.limit} left${resetMs ? `, resets in ${fmtAge(Math.max(0, resetMs - now))}` : ''}.`,
        recommendation: breach
          ? `The REST core bucket is ${Math.round(fraction * 100)}% full — gh REST calls fail until the reset${resetMs ? ` in ${fmtAge(Math.max(0, resetMs - now))}` : ''}. `
            + 'The top gh callers are in the `gh-graphql-budget` episode\'s measurements (same call log); move the heaviest poller onto the shared open-PR snapshot or lengthen its interval.'
          : 'ok',
      });
    }
    return out;
  },
};
