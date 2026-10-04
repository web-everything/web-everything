/** Fresh repo-explicit review eligibility, with injectable read-only GitHub IO. */
import { execFileSync } from 'node:child_process';
import { getRequiredStatusChecks } from './required-status-checks.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';

const MAX_STALE_CACHE_AGE_MS = 24 * 60 * 60_000;

const gh = argv => execFileSync('gh', argv, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
export const readReviewHead = ({ repo, pr, run = gh }) => JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'])).headRefOid;
/**
 * Every check run PLUS every legacy commit status (`{context, state}`) for the SHA: a required context may be
 * published through either, and a reader of check runs alone would call a green commit-status context missing.
 * The combined-status endpoint already reports only the latest state per context.
 */
export const readReviewChecks = ({ repo, headSha, run = gh }) => [
  ...JSON.parse(run([
    'api', '--paginate', '--slurp', `repos/${repo}/commits/${headSha}/check-runs?per_page=100&filter=all`,
  ])).flatMap(page => {
    if (!Array.isArray(page.check_runs)) throw new Error('unreadable check runs');
    return page.check_runs;
  }),
  ...JSON.parse(run([
    'api', '--paginate', '--slurp', `repos/${repo}/commits/${headSha}/status?per_page=100`,
  ])).flatMap(page => {
    if (!Array.isArray(page.statuses)) throw new Error('unreadable commit statuses');
    return page.statuses.map(({ context, state }) => ({ context, state }));
  }),
];

export function readReviewCiGate({ repo, pr, readHead = readReviewHead,
  readChecks = readReviewChecks, readRequired = getRequiredStatusChecks } = {}) {
  let headSha = null;
  try {
    if (typeof repo !== 'string' || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('explicit repo required');
    headSha = readHead({ repo, pr });
    if (typeof headSha !== 'string' || !headSha.trim()) return reviewCiGate({ headSha });
    const required = readRequired({ repo, ttlMs: 0 });
    const stale = required?.source === 'stale-cache';
    const cacheAgeMs = required?.cacheAgeMs;
    const trustedStale = stale && Number.isFinite(cacheAgeMs) && cacheAgeMs >= 0 && cacheAgeMs <= MAX_STALE_CACHE_AGE_MS;
    const withSource = result => ({ ...result, source: required?.source,
      ...(stale ? { cacheAgeMs, reason: `${result.reason} (stale-cache cache-age-ms=${cacheAgeMs ?? 'unknown'})` } : {}),
    });
    // Repo-declared requirements are code-reviewed policy, not the last-resort fallback.
    if (!['live', 'cache', 'declared'].includes(required?.source) && !trustedStale) {
      return withSource({ allowed: false, headSha, reason: 'untrusted-required-set' });
    }
    const checks = readChecks({ repo, headSha });
    const currentHead = readHead({ repo, pr });
    if (currentHead !== headSha) return withSource({ allowed: false, headSha, currentHead, reason: 'head-changed' });
    return withSource(reviewCiGate({ headSha, requiredChecks: required.checks, checks }));
  } catch (error) {
    return { allowed: false, headSha, reason: 'unreadable-ci', error: String(error?.message ?? error) };
  }
}

/**
 * The one-line skip reason for a refused gate. `unreadable-ci` alone hid the real failure (live 2026-10-04:
 * plateauapp/plateau-app#202 skipped every pass while the actual error was a `gh` GraphQL "Could not resolve to
 * a Repository" from a token minted for another org's installation), so the underlying error rides along —
 * first non-empty lines only, single-line, bounded, and with any token-shaped string scrubbed.
 */
export function formatReviewCiSkip(ci) {
  const reason = ci?.reason ?? 'unreadable-ci';
  const raw = typeof ci?.error === 'string' ? ci.error : '';
  const detail = raw.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2).join(' | ')
    .replace(/\b(gh[opsur]_|github_pat_)[A-Za-z0-9_]+/g, '<redacted>')
    .replace(/(authorization:\s*)(token|bearer)?\s*\S+/gi, '$1<redacted>')
    .slice(0, 300);
  return detail ? `review-ci: ${reason} (${detail})` : `review-ci: ${reason}`;
}
