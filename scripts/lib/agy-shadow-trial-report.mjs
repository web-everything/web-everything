#!/usr/bin/env node
/** Read-only evidence for one advisory agy model; Claude remains the mandatory seat. */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readShadowRows, isQuotaHeldShadow } from './review-shadow-agreement.mjs';
import { resolveShadowSeatModel, resolveShadowTrialReviews } from './review-seat-settings.mjs';
import { resolveRunsDir, tryReadRun, listRunIds, runPath } from '../operations/run-store.mjs';
import { redTeamForHead } from './red-team-gate.mjs';

const prKey = (row) => `${row.repo}#${row.pr}`;
const headKey = (row) => `${prKey(row)}@${row.head}`;
const rate = (n, d) => d ? n / d : null;
const normalizedPath = (path) => typeof path === 'string' ? path.replace(/^(?:\.\/|a\/|b\/)+/, '') : null;

/**
 * PURE. Counts actual-model attempts and stored finding anchors, without inferring
 * findings from legacy counts. Fix/red-team confirmation is anchor proximity evidence.
 * @param {{rows: object[], model: string, runRecords?: Map<string, object>,
 *   prRuns?: Map<string, object[]>, redTeamByPrHead?: Map<string, object|null>}} input
 */
export function trialProgress(attemptRows, trialReviews = null) {
  // One trial review = one review-pr run (runId) in which this model returned a usable answer on any shadow seat.
  // Quota-held, failed and voided attempts never count. Reporting only: completion never promotes anything.
  const done = new Set(attemptRows.filter((row) => row.status === 'ok').map((row) => row.runId ?? `${row.repo}#${row.pr}@${row.head}`)).size;
  const target = trialReviews?.value ?? null;
  return { reviews: done, target, source: trialReviews?.source ?? 'default', complete: target != null && done >= target };
}

export function buildTrialReport({ rows, model, runRecords = new Map(), prRuns = new Map(), redTeamByPrHead = new Map(), trialReviews = null }) {
  const attempts = rows.filter((row) => row.model === model).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const report = {
    model, attempts: attempts.length, quota: { held: 0, rate: null }, failed: 0, voided: 0, ok: 0, fellBack: 0,
    agreement: { compared: 0, verdictAgree: 0, rate: null, meanJaccard: null, byLens: {} },
    findings: { total: 0, matchedByMandatory: 0, agyOnly: 0, confirmedByFix: 0, confirmedByRedTeam: 0, notConfirmed: 0, pending: 0 },
    runs: [],
    trial: null,
  };
  let overlapSum = 0, overlapCount = 0;
  for (const row of attempts) {
    if (isQuotaHeldShadow(row)) report.quota.held++;
    else if (row.status === 'failed') report.failed++;
    else if (row.status === 'voided') report.voided++;
    else if (row.status === 'ok') report.ok++;
    if (row.fellBackTo != null) report.fellBack++;
    if (row.status === 'ok') {
      if (typeof row.verdictAgree === 'boolean') {
        const lens = report.agreement.byLens[row.lens] ??= { compared: 0, agree: 0, rate: null };
        lens.compared++;
        report.agreement.compared++;
        if (row.verdictAgree) { lens.agree++; report.agreement.verdictAgree++; }
        lens.rate = rate(lens.agree, lens.compared);
      }
      if (typeof row.overlap?.jaccard === 'number' && Number.isFinite(row.overlap.jaccard)) {
        overlapSum += row.overlap.jaccard;
        overlapCount++;
      }
      const fixes = (prRuns.get(prKey(row)) ?? []).map((record) => record.findings?.read?.latestFix)
        .filter((fix) => fix && fix.priorHead === row.head);
      const redTeam = redTeamByPrHead.get(headKey(row));
      for (const anchor of row.agyFindings ?? []) {
        const counts = report.findings;
        counts.total++;
        if (anchor.matched === true) counts.matchedByMandatory++;
        else counts.agyOnly++;
        const byFix = fixes.some((fix) => {
          if (anchor.path == null || !Object.hasOwn(fix.files ?? {}, anchor.path)) return false;
          const lines = fix.files[anchor.path];
          return anchor.line == null || lines === null
            || (Array.isArray(lines) && lines.some((line) => Math.abs(line - anchor.line) <= 5));
        });
        const path = normalizedPath(anchor.path);
        const byRedTeam = path != null && (redTeam?.findings ?? []).some((finding) => finding.confirmed === true
          && normalizedPath(finding.file) === path
          && (anchor.line == null || finding.line == null || Math.abs(finding.line - anchor.line) <= 8));
        if (byFix) counts.confirmedByFix++;
        if (byRedTeam) counts.confirmedByRedTeam++;
        if (!byFix && !byRedTeam) {
          // A head with no red-team comment (null) is not evidence against the finding: still pending.
          if (fixes.length || redTeam) counts.notConfirmed++;
          else counts.pending++;
        }
      }
    }
    const verdicts = runRecords.get(row.runId)?.verdict?.lensVerdicts ?? {};
    report.runs.push({
      at: row.at, pr: prKey(row), head12: String(row.head ?? '').slice(0, 12), seat: row.lens,
      model: row.model, status: row.status, agyVerdict: row.agyVerdict ?? null,
      findings: row.agyFindingsCount ?? row.agyFindings?.length ?? row.overlap?.agyCount ?? null,
      claudeVerdict: row.claudeVerdict ?? null,
      otherVerdicts: Object.fromEntries(Object.entries(verdicts).filter(([lens]) => lens !== row.lens)),
      ...(row.status !== 'ok' && row.reasons?.length ? { reason: String(row.reasons[0]).slice(0, 160) } : {}),
    });
  }
  report.trial = trialProgress(attempts, trialReviews);
  report.quota.rate = rate(report.quota.held, report.attempts);
  report.agreement.rate = rate(report.agreement.verdictAgree, report.agreement.compared);
  report.agreement.meanJaccard = rate(overlapSum, overlapCount);
  return report;
}

const pct = (value) => value == null ? 'n/a' : `${Math.round(value * 100)}%`;
const TRIAL_SOURCE = { env: 'env WE_REVIEW_SHADOW_AGY_TRIAL_REVIEWS', settings: 'settings scripts/settings/review.json key shadowSeats.antigravity.trialReviews', default: 'no trial target set' };
export function renderTrialLine(trial) {
  if (!trial || trial.target == null) return `  trial: ${trial?.reviews ?? 0} completed review(s); no trial length set (shadowSeats.antigravity.trialReviews)`;
  return `  trial: ${trial.reviews} of ${trial.target} reviews${trial.complete ? ' — trial complete (promotion is the operator\'s call; nothing changes automatically)' : ''} (target source: ${TRIAL_SOURCE[trial.source] ?? trial.source})`;
}
function renderReport(report) {
  const { agreement: a, findings: f } = report;
  return [
    `agy shadow trial — model ${report.model} (${report.attempts} attempts since ${report.runs[0]?.at ?? 'n/a'})`,
    renderTrialLine(report.trial),
    `  quota skips: ${report.quota.held}/${report.attempts} (${pct(report.quota.rate)}) held (agy quota); other failures ${report.failed}; voided ${report.voided}; ok ${report.ok}; fell back to routing model ${report.fellBack}`,
    `  agreement with the mandatory (Claude) seat: ${a.verdictAgree}/${a.compared} (${pct(a.rate)}), mean finding overlap ${pct(a.meanJaccard)}; by seat: ${Object.entries(a.byLens).map(([lens, v]) => `${lens} ${v.agree}/${v.compared}`).join(', ') || 'n/a'}`,
    `  findings: ${f.total} raised, ${f.matchedByMandatory} also raised by the mandatory seat, ${f.agyOnly} agy-only; confirmed by fixer change ${f.confirmedByFix}, by red-team re-check ${f.confirmedByRedTeam}, not confirmed ${f.notConfirmed}, pending ${f.pending}`,
    '  runs:',
    ...report.runs.slice(-20).map((run) => `    ${run.at} ${run.pr} ${run.head12} ${run.seat} ${run.model} ${run.status} verdict ${run.agyVerdict ?? 'n/a'} findings ${run.findings ?? 'n/a'} | claude ${run.claudeVerdict ?? 'n/a'}${Object.entries(run.otherVerdicts).map(([lens, verdict]) => ` | ${lens} ${verdict}`).join('')}${run.reason ? ` | ${run.reason.replace(/[\r\n]/g, ' ')}` : ''}`),
  ].join('\n');
}

function loadRunEvidence(rows) {
  // resolveRunsDir normally migrates (writes) legacy records. Suppress only that
  // synchronous resolution side effect and restore the caller's environment.
  const previous = process.env.WE_UNDER_TEST;
  let dir;
  try { process.env.WE_UNDER_TEST = '1'; dir = resolveRunsDir(); }
  finally {
    if (previous === undefined) delete process.env.WE_UNDER_TEST;
    else process.env.WE_UNDER_TEST = previous;
  }
  const runRecords = new Map(), prRuns = new Map();
  const involved = new Set(rows.map(prKey));
  const read = (id) => {
    try { return tryReadRun(id, dir); }
    catch { process.stderr.write(`trial report: unreadable run ${id}\n`); return null; }
  };
  for (const id of new Set(rows.map((row) => row.runId).filter(Boolean))) {
    const record = read(id);
    if (record) runRecords.set(id, record);
  }
  if (!rows.length) return { runRecords, prRuns };
  const dates = rows.map((row) => Date.parse(row.at)).filter(Number.isFinite);
  const cutoff = dates.length ? Math.min(...dates) - 60 * 60 * 1000 : -Infinity;
  for (const id of listRunIds(dir)) {
    if (!id.startsWith('review-pr-')) continue;
    try { if (statSync(runPath(id, dir)).mtimeMs < cutoff) continue; }
    catch { continue; }
    const record = runRecords.get(id) ?? read(id);
    if (!record) continue;
    const key = prKey(record.input ?? {});
    if (!involved.has(key)) continue;
    const records = prRuns.get(key) ?? [];
    records.push(record);
    prRuns.set(key, records);
  }
  return { runRecords, prRuns };
}

function loadRedTeam(rows) {
  const byPr = new Map(), result = new Map();
  for (const row of rows.filter((row) => row.status === 'ok')) {
    const group = byPr.get(prKey(row)) ?? [];
    group.push(row);
    byPr.set(prKey(row), group);
  }
  for (const group of byPr.values()) {
    const { repo, pr } = group[0];
    try {
      const pages = JSON.parse(execFileSync('gh', ['api', '--paginate', '--slurp', `repos/${repo}/issues/${pr}/comments?per_page=100`],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
      if (!Array.isArray(pages)) continue;
      const comments = pages.flat().map((comment) => ({ ...comment, createdAt: comment.created_at ?? comment.createdAt }));
      for (const row of group) result.set(headKey(row), redTeamForHead(comments, pr, row.head));
    } catch { /* No fetched evidence for this PR on failure. */ }
  }
  return result;
}

function main(args) {
  let model = resolveShadowSeatModel().value ?? 'gemini-4-argon-high', since = null;
  for (const arg of args) {
    if (arg.startsWith('--model=')) model = arg.slice(8);
    else if (arg.startsWith('--since=')) {
      since = Date.parse(arg.slice(8));
      if (!Number.isFinite(since)) throw new Error('--since must be a valid ISO timestamp');
    } else if (arg !== '--json' && arg !== '--no-gh') throw new Error(`unknown argument: ${arg}`);
  }
  const rows = readShadowRows().filter((row) => row && (since == null || Date.parse(row.at) >= since));
  // Only this model's attempts need run records and red-team comments.
  const own = rows.filter((row) => row.model === model);
  const evidence = loadRunEvidence(own);
  const report = buildTrialReport({
    rows: own, model, ...evidence, redTeamByPrHead: args.includes('--no-gh') ? new Map() : loadRedTeam(own),
    trialReviews: resolveShadowTrialReviews(),
  });
  const models = new Map();
  for (const row of rows) {
    const counts = models.get(row.model) ?? { attempts: 0, held: 0 };
    counts.attempts++;
    if (isQuotaHeldShadow(row)) counts.held++;
    models.set(row.model, counts);
  }
  report.storeWide = Object.fromEntries([...models].map(([id, c]) => [id, c]));
  if (args.includes('--json')) { process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return; }
  process.stdout.write(`${renderReport(report)}\n`);
  process.stdout.write(`store-wide quota${since == null ? '' : ` since ${new Date(since).toISOString()}`}: ${[...models].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([id, c]) => `${id}: ${c.attempts} attempts, ${c.held} held`).join('; ') || 'no attempts'}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`trial report: ${error.message}\n`); process.exitCode = 1; }
}
