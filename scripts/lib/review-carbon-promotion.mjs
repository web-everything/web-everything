/** Counted Carbon evidence, beside the existing shadow ledger. Unknown outcomes stay pending. */
import { join } from 'node:path';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';
import { appendShadowRow, readShadowRows } from './review-shadow-agreement.mjs';
import { deriveVerdict, findingIdentityEntry, normalizeFindings } from './jury-core.mjs';

export const promotionPath = (env = process.env) => join(daemonConveyorStateRoot(env), '.conveyor', 'agy-carbon-promotion.jsonl');
export const appendPromotionRow = (row, io = {}) => appendShadowRow(row, { path: promotionPath(), ...io });
export const readPromotionRows = (io = {}) => readShadowRows({ path: promotionPath(), ...io });

export function promotionAttempt({ request, directive, agyRun, at }) {
  const valid = agyRun.status === 'ok' && Boolean(agyRun.sessionId);
  return {
    at, repo: directive.repo, pr: directive.pr, head: directive.head, runId: request.runId,
    lens: 'correctness', model: directive.model, status: valid ? 'ok' : agyRun.status === 'ok' ? 'failed' : agyRun.status,
    reasons: (agyRun.reasons ?? []).slice(0, 5).map(r => String(r).slice(0, 300)),
    fallback: !valid, timeout: /tim(?:e|ed)[ -]?out/i.test((agyRun.reasons ?? []).join(' ')),
    agyVerdict: valid ? deriveVerdict({ findings: agyRun.value.findings }) : null,
    agyFindings: valid ? normalizeFindings(agyRun.value.findings).map((f, i) => ({
      ...findingIdentityEntry(f, String(i)), line: f.line ?? null,
    })).filter(f => f.path).map(({ path, normSummary, anchor, line }) => ({ path, normSummary, anchor, line })) : [],
    // These require the final run and subsequent evidence; the report resolves them from stored runs.
    agreement: null, confirmedFindings: null, falsePositives: null,
  };
}

export function buildPromotionReport({ rows, runRecords = new Map(), prRuns = new Map() }) {
  const report = { prs: new Set(rows.map(r => `${r.repo}#${r.pr}`)).size, reviews: rows.length,
    agreement: { agree: 0, compared: 0 }, confirmedFindings: 0, falsePositives: 0, pendingFindings: 0,
    timeouts: 0, fallbacks: 0, pendingVerdicts: 0 };
  for (const row of rows) {
    if (row.fallback) report.fallbacks++;
    if (row.timeout || /tim(?:e|ed)[ -]?out/i.test((row.reasons ?? []).join(' '))) report.timeouts++;
    const record = runRecords.get(row.runId);
    const final = record?.verdict?.verdict;
    if (row.status === 'ok' && ['accept', 'changes', 'needs-human', 'prevention-outstanding'].includes(final)) {
      report.agreement.compared++;
      if (row.agyVerdict === final) report.agreement.agree++;
    } else if (row.status === 'ok') report.pendingVerdicts++;
    const later = prRuns.get(`${row.repo}#${row.pr}`) ?? [];
    for (const f of row.agyFindings ?? []) {
      const confirmed = later.some(r => {
        const fix = r.findings?.read?.latestFix;
        const lines = fix?.files?.[f.path];
        return fix?.priorHead === row.head && Object.hasOwn(fix.files ?? {}, f.path)
          && (f.line == null || lines === null || (Array.isArray(lines) && lines.some(l => Math.abs(l - f.line) <= 5)));
      });
      // Explicit identity + head ruling only. Lack of corroboration is never a false positive.
      const falsePositive = later.some(r => (r.findings?.read?.findingIdentity ?? []).some(e =>
        e.path === f.path && e.normSummary === f.normSummary && Boolean(f.normSummary)
          && (e.rulings ?? []).some(v => v.head === row.head && v.result === 'not-real')));
      if (falsePositive) report.falsePositives++;
      else if (confirmed) report.confirmedFindings++;
      else report.pendingFindings++;
    }
  }
  return report;
}

export function renderPromotionReport(r) {
  const a = r.agreement;
  return `Carbon promotion: agreement ${a.agree}/${a.compared}; confirmed findings ${r.confirmedFindings}; false positives ${r.falsePositives}; timeouts ${r.timeouts}; fallbacks ${r.fallbacks}; ${r.prs} PRs (${r.reviews} reviews; pending verdicts ${r.pendingVerdicts}, findings ${r.pendingFindings})`;
}
