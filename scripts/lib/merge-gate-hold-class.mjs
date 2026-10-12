/**
 * Candidacy HOLDs are review work, not CI repair work. Only head-bound job evidence may
 * excuse a failed merge-gate for a non-candidate; every unreadable fact stays red.
 * The strict parser mirrors #5013's parsePrResultTable: merge the two when #5013 lands.
 * Deliberately does not import merge-gate-ci or the drain's runtime graph.
 */
import { readFileSync } from 'node:fs';
import { GATE_IDS } from './merge-gate-inventory.mjs';
import { collapseRollupToLatestPerName } from './rollup-collapse.mjs';
import { FAILING_CONCLUSIONS } from '../operations/pr-status.mjs';
import { PLATFORM_PREFERENCES_PATH } from './merge-delivery-policy.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { runGhSync } from './gh-throttle.mjs';

const statuses = new Set(['pass', 'hold', 'fail-closed', 'queue', 'enqueue', 'skipped-by-policy']);
const gates = new Set(GATE_IDS);
const candidacy = new Set(['candidate-label', 'producer-certified', 'review-hold-labels', 'review-acceptance']);
const blocking = r => r.status === 'hold' || r.status === 'fail-closed';
// The evaluator wraps both main-CI failures and manual freezes in `(freeze: ...)`.
// Only combineRedMain's explicit manual origin can be cleared by the shared document.
const manualFreeze = r => r.id === 'red-main-freeze' && r.status === 'hold'
  && /^main is RED \(freeze: manual freeze: .+\)$/.test(r.reason ?? '');

/** Read the LAST table for this PR; malformed newer evidence never falls back to an older table. */
export function parsePrResultTable(log, prNumber) {
  const lines = String(log ?? '').split(/\r?\n/).map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+\s/, ''));
  let start = -1, header;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#(\d+): (\S+)\s*$/.exec(lines[i]);
    if (m && (prNumber === undefined || Number(m[1]) === Number(prNumber))) { start = i; header = m; }
  }
  if (start < 0) return { error: 'missing PR verdict header' };
  if (!['PASS', 'HOLD'].includes(header[2])) return { error: 'unknown verdict' };
  const results = [], seen = new Set();
  for (const line of lines.slice(start + 1)) {
    if (/^#\d+:|^merge-gate:/.test(line)) break;
    if (!line.trim()) continue;
    const m = /^  (\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m || !statuses.has(m[1]) || !gates.has(m[2]) || seen.has(m[2])) return { error: 'invalid status, gate, duplicate or malformed verdict row' };
    seen.add(m[2]);
    results.push({ status: m[1], id: m[2], reason: m[3] });
  }
  // A PR table does not include workflow self-check or other job-level failures.
  // Inspect the entire remaining log (including other PR tables), and authorize
  // excusal only with the known table-only HOLD footer. Missing, duplicate and
  // unknown summaries are insufficient evidence, including truncated logs.
  if (header[2] === 'HOLD') {
    const summaries = lines.slice(start + 1).filter(line => /^merge-gate:/.test(line));
    if (summaries.length !== 1 || summaries[0] !== 'merge-gate: HOLD — held') {
      return { error: 'missing, ambiguous or job-level merge-gate failure' };
    }
  }
  if (!results.length || (header[2] === 'HOLD') !== results.some(blocking)) return { error: 'verdict header disagrees with rows' };
  // A manual freeze takes precedence over main-CI red in combineRedMain. Its
  // table row alone therefore cannot prove main CI passed. Bind the diagnostic
  // to this invocation, never an older table's completed verdict.
  const priorSummary = lines.slice(0, start).findLastIndex(line => /^merge-gate: (?:PASS|HOLD)\b/.test(line));
  const mainCi = lines.slice(priorSummary + 1, start).filter(line => /^main CI\b/.test(line));
  const mainCiGreen = mainCi.length === 1 && /^main CI \(.+\): green$/.test(mainCi[0]);
  return { num: Number(header[1]), ok: header[2] === 'PASS', results, mainCiGreen };
}

/** Pure classification; a candidate must have an actually passing merge-gate. */
export function classifyMergeGateHold({ results, prLabels, freeze, verdictCompletedAt, mainCiGreen } = {}) {
  const unreadable = why => ({ excused: false, kind: 'unreadable', holds: [], others: [], why });
  if (!Array.isArray(results) || !results.length || !Array.isArray(prLabels)
    || prLabels.some(l => typeof (typeof l === 'string' ? l : l?.name) !== 'string')
    || results.some(r => !r || !statuses.has(r.status) || !gates.has(r.id))) return unreadable('unreadable verdict or labels');
  const holds = results.filter(blocking), others = [];
  let hasCandidacy = false, hasStaleFreeze = false;
  for (const r of holds) {
    if (r.status === 'fail-closed') { others.push(r); continue; }
    if (candidacy.has(r.id) || (r.id === 'ledger' && r.reason?.startsWith('labels:'))) { hasCandidacy = true; continue; }
    if (manualFreeze(r) && mainCiGreen === true && freeze?.frozen === false && !freeze.error
      && Number.isFinite(Date.parse(verdictCompletedAt)) && Date.parse(freeze.publishedAt) > Date.parse(verdictCompletedAt)) { hasStaleFreeze = true; continue; }
    others.push(r);
  }
  const candidate = prLabels.some(l => (typeof l === 'string' ? l : l.name) === 'ready-to-merge');
  const excused = holds.length > 0 && !others.length && !candidate;
  const kind = !excused ? 'real' : hasCandidacy && hasStaleFreeze ? 'candidacy+stale-freeze' : hasStaleFreeze ? 'stale-freeze' : 'candidacy';
  return { excused, kind, holds, others, why: candidate ? 'current candidate must pass merge-gate' : excused ? 'only candidacy or cleared shared-freeze holds' : 'real or absent blocking evidence' };
}

/** Latest failing completed run only; success/pending supersedes all older failures. */
export function latestFailingMergeGate(rows) {
  const row = collapseRollupToLatestPerName(rows).find(r => r.name === 'merge-gate');
  return row && String(row.status).toLowerCase() === 'completed'
    && FAILING_CONCLUSIONS.includes(String(row.conclusion).toLowerCase()) ? row : null;
}

/** Pure except injected readers. A lazy freeze reader lets an entire pass share one fresh read. */
export function excuseMergeGateRows(rows, { prNumber, headSha, labels, readVerdict, freeze, setting } = {}) {
  const unchanged = { rows, excused: false };
  try {
    if ((typeof setting === 'string' ? setting : setting?.value) !== 'on') return unchanged;
    const row = latestFailingMergeGate(rows);
    if (!row) return unchanged;
    const jobId = Number(/\/actions\/runs\/\d+\/job\/(\d+)/.exec(row.detailsUrl ?? row.details_url ?? '')?.[1] ?? row.id);
    if (!Number.isSafeInteger(jobId) || jobId <= 0 || !headSha || !Number.isSafeInteger(prNumber)) return unchanged;
    const verdict = readVerdict({ jobId, prNumber });
    if (verdict?.error || verdict?.num !== prNumber || !verdict?.head_sha
      || verdict.head_sha.toLowerCase() !== headSha.toLowerCase() || verdict.ok !== false) return unchanged;
    const currentFreeze = verdict.results?.some(manualFreeze) && typeof freeze === 'function' ? freeze() : freeze;
    const classification = classifyMergeGateHold({ results: verdict.results, prLabels: labels, freeze: currentFreeze, verdictCompletedAt: verdict.completed_at, mainCiGreen: verdict.mainCiGreen });
    if (!classification.excused) return unchanged;
    const replacement = { ...row, conclusion: row.conclusion === row.conclusion.toLowerCase() ? 'success' : 'SUCCESS',
      mergeGateHoldExcused: { kind: classification.kind, holds: classification.holds, jobId } };
    return { rows: rows.filter(r => r.name !== 'merge-gate' || r === row).map(r => r === row ? replacement : r), excused: true };
  } catch { return unchanged; }
}

const jobCache = new Map();
/** Immutable job log + job head/completion metadata, cached by repository/job (never PR). */
export function readMergeGateVerdict({ repo, jobId, prNumber, runGh = runGhSync, cache = jobCache } = {}) {
  try {
    const key = `${repo}/${jobId}`;
    if (!cache.has(key)) {
      const path = `repos/${repo}/actions/jobs/${jobId}`;
      const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], throttle: { op: 'merge-gate-verdict', repo } };
      const job = JSON.parse(runGh(['api', path], options));
      const log = String(runGh(['api', `${path}/logs`], options));
      cache.set(key, { job, log });
    }
    const { job, log } = cache.get(key);
    return { ...parsePrResultTable(log, prNumber), head_sha: job.head_sha, completed_at: job.completed_at };
  } catch (e) { return { error: String(e?.message ?? e) }; }
}

const key = 'candidacyHoldIsNotCiFailure';
const envKey = 'MERGE_GATE_CANDIDACY_HOLD_IS_NOT_CI_FAILURE';
/** Settings cascade; an invalid value in ANY layer fails closed, even underneath a valid override. */
export function resolveMergeGateHoldSetting({ platform = {}, repo = {}, env = {}, readErrors = [] } = {}) {
  if (readErrors.length) return { value: 'off', source: 'unreadable', why: readErrors.join('; ') };
  const { ignored, ...result } = resolveHumanGateRemovalSetting({ platform, repo, env, blockName: 'mergeGate', key, envKey });
  return result;
}

/** Shared fail-closed cascade for switches that remove a human/merge hold. */
export function resolveHumanGateRemovalSetting({ platform = {}, repo = {}, env = {}, blockName, key, envKey, errors = [] }) {
  let result = { value: 'on', source: 'standard' };
  const ignored = [...errors];
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  for (const [source, doc] of [['platform', platform], ['repo', repo], ['env', env]]) {
    const block = doc?.[blockName];
    if (source !== 'env' && (!object(doc) || (block !== undefined && !object(block)))) {
      ignored.push({ source, reason: `invalid ${blockName} settings block` });
      continue;
    }
    const value = source === 'env' ? doc?.[envKey] : block?.[key];
    if (value === undefined) continue;
    if (!['on', 'off'].includes(value)) {
      ignored.push({ source, reason: `invalid ${source} ${blockName}.${key}: expected on|off` });
      continue;
    }
    result = { value, source };
  }
  return ignored.length ? { value: 'off', source: ignored[0].source, why: ignored[0].reason, ignored } : { ...result, ignored };
}
let loggedSetting = false;
/** Read declared feature settings and platform preferences; log the effective source once per process. */
export function loadMergeGateHoldSetting({ env = process.env, readFile = readFileSync, readDeclared = readDeclaredSettings, log = line => console.error(line) } = {}) {
  let platform = {}, repo = {};
  const readErrors = [];
  try { platform = JSON.parse(readFile(PLATFORM_PREFERENCES_PATH, 'utf8')); }
  catch (e) { if (e?.code !== 'ENOENT') readErrors.push(`platform unreadable: ${e.message}`); }
  try {
    const declared = readDeclared();
    repo = declared.settings;
    if (declared.errors?.length) readErrors.push('repo settings unreadable');
    if (declared.duplicates?.some(d => /^mergeGate(?:\.|$)/.test(d.path))) readErrors.push('duplicate mergeGate settings');
  } catch (e) { readErrors.push(`repo settings unreadable: ${e.message}`); }
  const result = resolveMergeGateHoldSetting({ platform, repo, env, readErrors });
  if (!loggedSetting) { loggedSetting = true; log(`merge-gate-hold · mergeGate.${key}=${result.value} (source: ${result.source})`); }
  return result;
}

/** One pass, one lazy shared-freeze read; any PR-specific read failure preserves its original rows. */
export function excusePrMergeGateHolds(prs, { repo, readMergeGateVerdict: readVerdict = readMergeGateVerdict, readFreeze, mergeGateSetting, env } = {}) {
  try {
    const setting = mergeGateSetting ?? loadMergeGateHoldSetting({ env });
    let freezeRead = false, freeze;
    const lazyFreeze = () => {
      if (!freezeRead) {
        freezeRead = true;
        try { freeze = readFreeze(); } catch (e) { freeze = { error: String(e?.message ?? e) }; }
      }
      return freeze;
    };
    return prs.map(pr => {
      const out = excuseMergeGateRows(pr.statusCheckRollup, { prNumber: pr.number, headSha: pr.headRefOid, labels: pr.labels,
        readVerdict: args => readVerdict({ ...args, repo }), freeze: lazyFreeze, setting });
      return out.excused ? { ...pr, statusCheckRollup: out.rows } : pr;
    });
  } catch { return prs; }
}
