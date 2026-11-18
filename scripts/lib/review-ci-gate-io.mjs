import { greenLedgerDir, hasGreenLedger } from './lane-verify.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { ciRedOnHead, fastChecksFor, reviewStartGate, reviewUsesRequiredChecks } from './review-timing.mjs';
import { resolveTimingPolicy } from './review-timing-settings.mjs';
/** Fresh repo-explicit review eligibility, with injectable read-only GitHub IO. */
import { readGh } from './proc-read.mjs';
import { getRequiredStatusChecks } from './required-status-checks.mjs';
import { excuseMergeGateRows, isCandidacyHold, latestFailingMergeGate, loadMergeGateHoldSetting, readMergeGateVerdict as defaultReadMergeGateVerdict } from './merge-gate-hold-class.mjs';
import { HUMAN_REVIEW_HOLD_GATES } from './merge-gate-verdict.mjs';
import { readSharedFreeze } from './red-main-freeze-shared.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';

const MAX_STALE_CACHE_AGE_MS = 24 * 60 * 60_000;

const provenanceOf = (checks, source) => ({ rowsHead: checks?.rowsHead, rowsComplete: checks?.rowsComplete === true,
  // Only a live or cache roster is a trusted provenance for the contract; any other source fails closed.
  rosterSource: ['live', 'cache'].includes(source) ? source : undefined });

const gh = argv => readGh(argv, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
export const readReviewHead = ({ repo, pr, run = gh }) => JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'])).headRefOid;
/** Fetch labels with the head so the default gate needs no separate label request. */
export const readReviewHeadAndLabels = ({ repo, pr, run = gh }) => JSON.parse(run(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,labels']));
/**
 * Every check run PLUS every legacy commit status (`{context, state, target_url}`) for the SHA: a required context may be
 * published through either, and a reader of check runs alone would call a green commit-status context missing.
 * The combined-status endpoint already reports only the latest state per context.
 */
export const readReviewChecks = ({ repo, headSha, run = gh }) => {
  let rowsComplete = /^[a-f0-9]{40}$/i.test(headSha ?? '');
  const rows = [];
  for (const [feed, key] of [['check-runs', 'check_runs'], ['status', 'statuses']]) {
    const pages = JSON.parse(run(['api', '--paginate', '--slurp',
      `repos/${repo}/commits/${headSha}/${feed}?per_page=100${feed === 'check-runs' ? '&filter=all' : ''}`]));
    if (!Array.isArray(pages) || !pages.length) rowsComplete = false;
    let seen = 0, total = 0;
    for (const page of pages) {
      if (!Array.isArray(page?.[key])) throw new Error(`unreadable ${feed === 'status' ? 'commit statuses' : 'check runs'}`);
      const batch = page[key];
      seen += batch.length;
      if (!Number.isSafeInteger(page.total_count) || page.total_count < 0
        || batch.length > 100 || page.truncated || page.error || page.errors
        || (page.sha !== undefined && page.sha !== headSha)) rowsComplete = false;
      total = Math.max(total, page.total_count ?? 0);
      for (const row of batch) {
        if ((row?.head_sha ?? row?.sha ?? headSha) !== headSha) rowsComplete = false;
        rows.push(feed === 'status' && row ? { context: row.context, state: row.state, target_url: row.target_url } : row);
      }
    }
    if (seen < total) rowsComplete = false;
  }
  return Object.defineProperties(rows, { rowsHead: { value: headSha }, rowsComplete: { value: rowsComplete } });
};

export function readReviewCiGate({ repo, pr, readHead, readLabels,
  readHeadAndLabels = readReviewHeadAndLabels,
  readMergeGateVerdict = defaultReadMergeGateVerdict, readFreeze = readSharedFreeze, mergeGateSetting,
  readVerifyGreen = hasGreenLedger, coordinationRoot,
  log = line => console.error(line),
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
    const fast = ['fast-checks', 'push'].includes(policy.startAfter) ? fastChecksFor(policy.fastChecks, repo) : null;
    // A repo whose CI does not publish fast checks waits on its own required set, exactly as ci-green does.
    const needsRequired = reviewUsesRequiredChecks(policy, repo);
    let required = { source: 'timing-policy', checks: fast ?? [] };
    if (needsRequired) {
      try { required = readRequired({ repo, ttlMs: 0 }); }
      catch (error) {
        if (policy.startAfter !== 'push') throw error;
        // Keep reading head-bound checks so a discovery failure cannot hide red CI.
        required = { source: 'fallback', checks: [] };
      }
    }
    else {
      checks = readChecks({ repo, headSha });
      // Early review needs branch-protection discovery only to identify an owner for red CI.
      // Discovery faults retain the fast-check prerequisite, rather than stranding review.
      if (ciRedOnHead({ headSha, checks, ...provenanceOf(checks, required?.source) })) {
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
    if (needsRequired && !trustedRequired && policy.startAfter !== 'push') {
      return withSource({ allowed: false, headSha, reason: 'untrusted-required-set' });
    }
    checks ??= readChecks({ repo, headSha });
    // Captured before merge-gate excusal rewrites the rows (the rewritten array no longer carries the read metadata).
    const provenance = provenanceOf(checks, required?.source);
    const currentHead = head({ repo, pr });
    if (currentHead !== headSha) return withSource({ allowed: false, headSha, currentHead, reason: 'head-changed' });
    let excusalEnabled = false;
    try {
      if (latestFailingMergeGate(checks)) {
        const setting = mergeGateSetting ?? loadMergeGateHoldSetting();
        excusalEnabled = (typeof setting === 'string' ? setting : setting?.value) === 'on';
        labels = readLabels ? readLabels({ repo, pr }) : labels;
        checks = excuseMergeGateRows(checks, { prNumber: Number(pr), headSha,
          labels, setting,
          readVerdict: args => readMergeGateVerdict({ ...args, repo }), freeze: () => readFreeze(),
        }).rows;
      }
    } catch { /* Unreadable excusal evidence preserves the original failed checks. */ }
    let requiredChecks = trustedRequired && required.source !== 'timing-policy' ? required.checks : [];
    // Review work must not deadlock its own review. Recheck the annotation against
    // THIS Actions job and head; the strict check-state contract still sees a failure.
    const mergeRows = checks.filter(row => row?.name === 'merge-gate');
    const boundReviewHold = row => {
      const jobId = Number(/\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(row.detailsUrl ?? row.details_url ?? '')?.[1]);
      return excusalEnabled && (row.head_sha === undefined || row.head_sha?.toLowerCase() === headSha.toLowerCase())
        && Array.isArray(labels) && labels.every(label => typeof (typeof label === 'string' ? label : label?.name) === 'string')
        && !labels.some(label => (typeof label === 'string' ? label : label.name) === 'ready-to-merge')
        && Number.isSafeInteger(jobId) && jobId > 0
        && [row.mergeGateHoldExcused, row.mergeGateReviewHold].some(annotation => {
          if (annotation?.jobId !== jobId || typeof annotation.headSha !== 'string'
            || annotation.headSha.toLowerCase() !== headSha.toLowerCase()
            || !Array.isArray(annotation.holdIds) || !annotation.holdIds.length) return false;
          if (annotation === row.mergeGateReviewHold)
            return annotation.holdIds.every(id => HUMAN_REVIEW_HOLD_GATES.includes(id));
          return ['candidacy', 'stale-freeze', 'candidacy+stale-freeze'].includes(annotation.kind)
            && Array.isArray(annotation.holds) && annotation.holds.length === annotation.holdIds.length
            && annotation.holds.every((hold, i) => hold?.status === 'hold' && hold.id === annotation.holdIds[i]
              && (isCandidacyHold(hold) || (hold.id === 'red-main-freeze' && annotation.kind.includes('stale-freeze'))));
        });
    };
    if (mergeRows.length && mergeRows.every(boundReviewHold) && Array.isArray(requiredChecks))
      requiredChecks = requiredChecks.filter(name => name !== 'merge-gate');
    // A discovery fault or untrusted/empty set cannot excuse healable red in push mode.
    if (policy.startAfter === 'push' && ciRedOnHead({ headSha, checks,
      requiredChecks: Array.isArray(requiredChecks) && requiredChecks.length ? requiredChecks : null, ...provenance }))
      return withSource({ allowed: false, headSha, reason: 'ci-red', affected: [], checks, requiredChecks });
    // `requiredChecks` rides along so a publish-time void judges only healable reds, as review start does.
    let verifyGreen = false;
    if (policy.startBeforeCi) {
      try { verifyGreen = readVerifyGreen({ dir: greenLedgerDir({ coordinationRoot: coordinationRoot ?? resolveCoordinationRoot() }), sha: headSha }) === true; }
      catch { /* Unreadable verification waits on CI. */ }
    }
    const gate = reviewStartGate({ headSha, repo, requiredChecks, checks, policy, verifyGreen, ...provenance });
    if (gate.earlyStartNote) {
      // console is wrapped by the project's daemon logger; injected loggers keep fixtures hermetic.
      try { log(gate.earlyStartNote.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 2000)); }
      catch { /* Diagnostics cannot change permission. */ }
    }
    return withSource({ ...gate, checks, requiredChecks });
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
