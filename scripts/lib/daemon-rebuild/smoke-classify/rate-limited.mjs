/** Proven external throttling holds the exact plan; no fallback can attribute it to an overlay. */
import { SMOKE_CHECKS } from '../../daemon-live-smoke.mjs';
import { smokeEvidenceProblem } from './evidence.mjs';
import { resolveRecovery } from '../recovery.mjs';

const EXTERNAL = new Set(SMOKE_CHECKS.filter(row => row.mayBeTransient === true).map(row => row.name));
const THROTTLE = /^gh-throttle: throttled — no gh slot within \d+(?:\.\d+)?s \(class=[\w-]+\)(?:; retry next tick)?$(?![\s\S])/;
const RATE_LIMIT = /^(?:HTTP (?:403|429): )?(?:API rate limit exceeded(?: for [\w.:]+)?|You have exceeded a secondary rate limit\. Please wait a few minutes before you try again\.)(?: \(https:\/\/api\.github\.com\/[^\s()]*\))?$(?![\s\S])/i;
const MAX_DIAGNOSTIC_CHARS = 4000;

function provenDiagnostic(text) {
  const line = text.replace(/^gh (?:api|pr list) [^\r\n]*? failed: /, '').replace(/^exited 1: /, '').trim();
  return THROTTLE.test(line) || RATE_LIMIT.test(line);
}

export function rateLimitOnly(result) {
  if (smokeEvidenceProblem(result) || typeof result.smoke?.pass !== 'boolean'
    || !['code', 'transient', 'env-timeout', 'env-unavailable'].includes(result.verdict)) return false;
  const failed = result.smoke.results.filter(row => row.ok === false);
  return failed.length > 0 && failed.every(row => {
    if (!EXTERNAL.has(row.name) || row.mayBeTransient !== true) return false;
    // Check both producer channels, including negative evidence. A stderr code failure cannot be
    // hidden by a rate-limit summary, and a truncated/oversized diagnostic asks for operator inspection.
    const parts = [row.detail, row.stderrTail].filter(text => text !== undefined && text !== '');
    if (!parts.length || parts.some(text => typeof text !== 'string' || text.length > MAX_DIAGNOSTIC_CHARS)) return false;
    let proven = false;
    for (const text of parts) {
      for (const line of text.split(' | ')) {
        // A stderr-only failure has a generic summary; it supplies no proof on its own.
        if (/^gh (?:api|pr list) [^\r\n]* failed: exited 1$(?![\s\S])/.test(line)) continue;
        if (!provenDiagnostic(line)) return false;
        proven = true;
      }
    }
    return proven;
  });
}

export async function holdRateLimited({ failedA, hold, alert, env, log, now, plan, prepAlerts, alertsList }) {
  const state = await hold('smoke-env-timeout', failedA, { cause: 'github-rate-limit' });
  alert('smoke-rate-limited', { target: state.held?.target, retryAt: state.held?.retryAt,
    attempts: state.held?.attempts, message: 'GitHub throttled every failed check; overlays retained; retry the unchanged target after backoff' });
  const settings = resolveRecovery({ env, log: message => log.error?.(message) });
  if (Date.parse(state.held?.retryAt) - now() >= settings.envTimeoutMaxMs) alert('smoke-rate-limit-retry-ceiling', {
    target: state.held?.target, retryAt: state.held?.retryAt, attempts: state.held?.attempts,
    message: 'GitHub throttling reached the recovery backoff ceiling; inspect GitHub quota and gh-throttle capacity; remain on last-good and retry at the capped interval',
  });
  return { moved: false, reason: 'smoke-env-timeout', plan, alerts: [...prepAlerts, ...alertsList] };
}
