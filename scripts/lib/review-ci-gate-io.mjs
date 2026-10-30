import { greenLedgerDir, hasGreenLedger } from './lane-verify.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { ciRedOnHead, fastChecksFor, reviewStartGate, reviewUsesRequiredChecks } from './review-timing.mjs';
import { resolveTimingPolicy } from './review-timing-settings.mjs';
/** Fresh repo-explicit review eligibility, with injectable read-only GitHub IO. */
import { readGh } from './proc-read.mjs';
import { getRequiredStatusChecks } from './required-status-checks.mjs';
import { excuseMergeGateRows, latestFailingMergeGate, loadMergeGateHoldSetting, readMergeGateVerdict as defaultReadMergeGateVerdict } from './merge-gate-hold-class.mjs';
import { readSharedFreeze } from './red-main-freeze-shared.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';

const MAX_STALE_CACHE_AGE_MS = 24 * 60 * 60_000;

const gh = argv => readGh(argv, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
export const readReviewHead = ({ repo, pr, run = gh }) => JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'])).headRefOid;
/** Fetch labels with the head so the default gate needs no separate label request. */
export const readReviewHeadAndLabels = ({ repo, pr, run = gh }) => JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']));
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

export function readReviewCiGate({ repo, pr, readHead, readLabels,
  readHeadAndLabels = readReviewHeadAndLabels,
  readMergeGateVerdict = defaultReadMergeGateVerdict, readFreeze = readSharedFreeze, mergeGateSetting,
  readVerifyGreen = hasGreenLedger, coordinationRoot,
  readChecks = readReviewChecks, readRequired = getRequiredStatusChecks, policy = resolveTimingPolicy().review } = {}) {
  let headSha = null;
  let labels;
  // Keep the existing injected SHA reader; absent label evidence can never excuse a failure.
  const head = readHead ?? (args => {
    const view = readHeadAndLabels(args);
    labels = view.labels;
    return view.headRefOid;
  });
  try {
    if (typeof repo !== 'string' || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('explicit repo required');
    headSha = head({ repo, pr });
    if (typeof headSha !== 'string' || !headSha.trim()) return { ...reviewCiGate({ headSha }), startAfter: policy.startAfter };
    let checks;
    const fast = policy.startAfter === 'fast-checks' ? fastChecksFor(policy.fastChecks, repo) : null;
    // A repo whose CI does not publish fast checks waits on its own required set, exactly as ci-green does.
    const needsRequired = reviewUsesRequiredChecks(policy, repo);
    let required = { source: 'timing-policy', checks: fast ?? [] };
    if (needsRequired) required = readRequired({ repo, ttlMs: 0 });
    else {
      checks = readChecks({ repo, headSha });
      // Early review needs branch-protection discovery only to identify an owner for red CI.
      // Discovery faults retain the fast-check prerequisite, rather than stranding review.
      if (ciRedOnHead({ headSha, checks })) {
        try { required = readRequired({ repo, ttlMs: 0 }); } catch { /* Keep timing policy. */ }
      }
    }
    const stale = required?.source === 'stale-cache';
    const cacheAgeMs = required?.cacheAgeMs;
    const trustedStale = stale && Number.isFinite(cacheAgeMs) && cacheAgeMs >= 0 && cacheAgeMs <= MAX_STALE_CACHE_AGE_MS;
    const withSource = result => ({ ...result, startAfter: policy.startAfter, source: required?.source,
      ...(stale ? { cacheAgeMs, reason: `${result.reason} (stale-cache cache-age-ms=${cacheAgeMs ?? 'unknown'})` } : {}),
    });
    // Repo-declared requirements are code-reviewed policy, not the last-resort fallback.
    const trustedRequired = ['live', 'cache', 'declared', 'timing-policy'].includes(required?.source) || trustedStale;
    if (needsRequired && !trustedRequired) {
      return withSource({ allowed: false, headSha, reason: 'untrusted-required-set' });
    }
    checks ??= readChecks({ repo, headSha });
    const currentHead = head({ repo, pr });
    if (currentHead !== headSha) return withSource({ allowed: false, headSha, currentHead, reason: 'head-changed' });
    try {
      if (latestFailingMergeGate(checks)) {
        const setting = mergeGateSetting ?? loadMergeGateHoldSetting();
        checks = excuseMergeGateRows(checks, { prNumber: Number(pr), headSha,
          labels: readLabels ? readLabels({ repo, pr }) : labels, setting,
          readVerdict: args => readMergeGateVerdict({ ...args, repo }), freeze: () => readFreeze(),
        }).rows;
      }
    } catch { /* Unreadable excusal evidence preserves the original failed checks. */ }
    const requiredChecks = trustedRequired && required.source !== 'timing-policy' ? required.checks : [];
    // `requiredChecks` rides along so a publish-time void judges only healable reds, as review start does.
    let verifyGreen = false;
    if (policy.startBeforeCi) {
      try { verifyGreen = readVerifyGreen({ dir: greenLedgerDir({ coordinationRoot: coordinationRoot ?? resolveCoordinationRoot() }), sha: headSha }) === true; }
      catch { /* Unreadable verification waits on CI. */ }
    }
    return withSource({ ...reviewStartGate({ headSha, repo, requiredChecks, checks, policy, verifyGreen }), checks, requiredChecks });
  } catch (error) {
    return { allowed: false, headSha, startAfter: policy.startAfter, reason: 'unreadable-ci', error: String(error?.message ?? error) };
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
  const affected = Array.isArray(ci?.affected) && ci.affected.length
    ? `: ${ci.affected.map(row => `${row.name}=${row.reason}`).join(', ')}` : '';
  return detail ? `review-ci: ${reason}${affected} (${detail})` : `review-ci: ${reason}${affected}`;
}
