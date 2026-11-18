import { greenLedgerDir, hasGreenLedger } from './lane-verify.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { reviewStartGate } from './review-timing.mjs';
import { resolveTimingPolicy } from './review-timing-settings.mjs';
/** Fresh repo-explicit review eligibility, with injectable read-only GitHub IO. */
import { readGh } from './proc-read.mjs';
import { getRequiredStatusChecks } from './required-status-checks.mjs';
import { excuseMergeGateRows, latestFailingMergeGate, loadMergeGateHoldSetting, readMergeGateVerdict as defaultReadMergeGateVerdict } from './merge-gate-hold-class.mjs';
import { readSharedFreeze } from './red-main-freeze-shared.mjs';
import { reviewCiGate } from './review-ci-gate.mjs';

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
    const required = readRequired({ repo, ttlMs: 0 });
    let checks = readChecks({ repo, headSha });
    const provenance = { rowsHead: checks?.rowsHead, rowsComplete: checks?.rowsComplete === true,
      rosterSource: required?.source };
    const withSource = result => ({ ...result, ...provenance, startAfter: policy.startAfter, source: required?.source });
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
    const requiredChecks = required?.checks;
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
