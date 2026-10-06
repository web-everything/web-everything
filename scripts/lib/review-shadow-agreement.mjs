#!/usr/bin/env node
/**
 * review-shadow-agreement.mjs — HOW OFTEN DOES THE agy SHADOW JUROR AGREE WITH THE CLAUDE JUROR? (card 84)
 *
 * On a `shadow` seat (`review.seatProvider.<lens>`, `we:scripts/lib/review-seat-provider.mjs`) Claude judges and only
 * its verdict counts; an agy juror judges the same seat beside it. Each such run appends ONE row here, per seat. The
 * report folds the rows per seat so the operator can decide, with evidence, whether to flip a seat to `agy`.
 *
 * WHAT "AGREE" MEANS, and nothing softer:
 *   - VERDICT: both answers reduced by the same `deriveVerdict` (`we:scripts/lib/jury-core.mjs`).
 *   - FINDINGS: the #76a finding identity (`bindFindingIds`: same path, and the same normalized claim or the same quoted
 *     anchor — never text similarity), within one run so lens is ignored, PLUS the PR's own identity table when it is
 *     known: two findings that both bind to one id there (including a wording bound by a declared #76b `sameAs` link)
 *     are the same finding.
 * A voided or failed agy run is recorded too (it is evidence about agy) but is never counted as agreement.
 *
 * STORE: one JSONL file outside every git tree, beside the run-scorecard store
 * (`<conveyor state root>/.conveyor/agy-shadow-agreement.jsonl`), so every checkout, lane and daemon clone appends to
 * and reads the same rows and no checkout is dirtied.
 *
 * USAGE: node scripts/lib/review-shadow-agreement.mjs --report [--json]
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindFindingIds, deriveVerdict, findingIdentityEntry, normalizeFindings } from './jury-core.mjs';
import { daemonConveyorStateRoot } from './daemon-last-good.mjs';

/** The shadow store path. Every reader and writer resolves it here. */
export function resolveShadowAgreementPath(env = process.env) {
  return join(daemonConveyorStateRoot(env), '.conveyor', 'agy-shadow-agreement.jsonl');
}

/**
 * Compare one seat's Claude answer with its agy shadow answer. PURE.
 * @param {object} o
 * @param {{findings?: object[]}} o.claude
 * @param {{findings?: object[]}|null} o.agy - null when the agy run produced no usable answer.
 * @param {Array<object>} [o.prTable] - the PR's finding-identity table (`findingIdentityTable`), when known.
 * @returns {{claudeVerdict: string, agyVerdict: string|null, verdictAgree: boolean|null,
 *   overlap: {claudeCount: number, agyCount: number, matched: number, claudeOnly: number, agyOnly: number, jaccard: number}|null}}
 */
export function compareShadowAnswers({ claude, agy, prTable = [] }) {
  const claudeFindings = normalizeFindings(claude?.findings);
  const claudeVerdict = deriveVerdict({ findings: claudeFindings });
  if (!agy) return { claudeVerdict, agyVerdict: null, verdictAgree: null, overlap: null };
  const agyFindings = normalizeFindings(agy.findings);
  const agyVerdict = deriveVerdict({ findings: agyFindings });
  const table = claudeFindings.map((f, i) => findingIdentityEntry(f, `c${i}`)).filter(Boolean);
  const direct = bindFindingIds(agyFindings, table, { sameHead: true, ignoreLens: true });
  // #76b — both sides bound against the PR's table; one shared id there is one finding, however it was worded.
  const viaPr = Array.isArray(prTable) && prTable.length
    ? { claude: bindFindingIds(claudeFindings, prTable), agy: bindFindingIds(agyFindings, prTable) }
    : null;
  const matchedClaude = new Set();
  let matchedAgy = 0;
  agyFindings.forEach((_f, i) => {
    let hit = direct[i] != null ? Number(direct[i].slice(1)) : -1;
    if (hit < 0 && viaPr && viaPr.agy[i] != null) hit = viaPr.claude.findIndex((id) => id === viaPr.agy[i]);
    if (hit >= 0) { matchedClaude.add(hit); matchedAgy += 1; }
  });
  const union = claudeFindings.length + agyFindings.length - matchedAgy;
  return {
    claudeVerdict,
    agyVerdict,
    verdictAgree: claudeVerdict === agyVerdict,
    overlap: {
      claudeCount: claudeFindings.length,
      agyCount: agyFindings.length,
      matched: matchedClaude.size,
      claudeOnly: claudeFindings.length - matchedClaude.size,
      agyOnly: agyFindings.length - matchedAgy,
      jaccard: union === 0 ? 1 : Number((matchedClaude.size / union).toFixed(3)),
    },
  };
}

/**
 * The durable row for one shadow seat run. PURE. Carries counts and identities, never finding text.
 * @param {object} o
 */
export function buildShadowRow({ at, repo, pr, head, lens, runId, model, agyRun, comparison }) {
  return {
    at, repo: repo ?? null, pr: pr ?? null, head: head ?? null, lens, runId: runId ?? null,
    provider: 'agy', model,
    status: agyRun.status,
    ...(agyRun.reasons?.length ? { reasons: agyRun.reasons.slice(0, 5).map((r) => String(r).slice(0, 300)) } : {}),
    agySessionId: agyRun.sessionId ?? null,
    claudeSessionId: agyRun.claudeSessionId ?? null,
    agyWallMs: agyRun.wallMs ?? null,
    ...comparison,
  };
}

/** Append one row. Never throws: a store failure must not fail a review. Returns whether it landed. */
export function appendShadowRow(row, { path = resolveShadowAgreementPath(), append = appendFileSync, mkdir = mkdirSync } = {}) {
  try {
    mkdir(dirname(path), { recursive: true });
    append(path, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Read every row; a missing file is no rows, a malformed line is skipped. */
export function readShadowRows({ path = resolveShadowAgreementPath(), read = readFileSync } = {}) {
  let text = '';
  try { text = read(path, 'utf8'); } catch { return []; }
  return text.split('\n').flatMap((line) => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}

/**
 * The agreement report, per seat (lens). PURE.
 * @returns {Array<{lens: string, runs: number, compared: number, voided: number, failed: number,
 *   verdictAgreement: number|null, meanFindingOverlap: number|null, prs: number}>}
 */
export function summarizeShadowAgreement(rows = []) {
  const byLens = new Map();
  for (const row of rows) {
    if (!row || typeof row.lens !== 'string') continue;
    const s = byLens.get(row.lens) ?? { lens: row.lens, runs: 0, compared: 0, voided: 0, failed: 0, agree: 0, overlapSum: 0, prs: new Set() };
    s.runs += 1;
    if (row.pr != null) s.prs.add(`${row.repo}#${row.pr}`);
    if (row.status === 'voided') s.voided += 1;
    else if (row.status !== 'ok') s.failed += 1;
    else if (row.overlap) {
      s.compared += 1;
      if (row.verdictAgree) s.agree += 1;
      s.overlapSum += Number(row.overlap.jaccard) || 0;
    }
    byLens.set(row.lens, s);
  }
  return [...byLens.values()].sort((a, b) => a.lens.localeCompare(b.lens)).map((s) => ({
    lens: s.lens,
    runs: s.runs,
    compared: s.compared,
    voided: s.voided,
    failed: s.failed,
    verdictAgreement: s.compared ? Number((s.agree / s.compared).toFixed(3)) : null,
    meanFindingOverlap: s.compared ? Number((s.overlapSum / s.compared).toFixed(3)) : null,
    prs: s.prs.size,
  }));
}

/** The report as text lines. PURE. */
export function renderShadowReport(summary) {
  if (!summary.length) return ['agy shadow agreement: no shadow runs recorded yet'];
  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);
  return [
    'agy shadow agreement, per seat (only the Claude verdict counted on these runs):',
    ...summary.map((s) => `  ${s.lens}: ${s.runs} run(s) on ${s.prs} PR(s) — ${s.compared} compared, `
      + `${s.voided} voided (escaped its lane), ${s.failed} failed; verdict agreement ${pct(s.verdictAgreement)}, `
      + `mean finding overlap ${pct(s.meanFindingOverlap)}`),
  ];
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const summary = summarizeShadowAgreement(readShadowRows());
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(`${renderShadowReport(summary).join('\n')}\n`);
}
