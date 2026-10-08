#!/usr/bin/env node
/**
 * @file scripts/operations/advisor-trial-report.mjs
 * @description THE ADVISOR TRIAL COMPARISON (we:backlog/x331b7u). Reads the per-run ledger that
 * `../lib/advisor-trial.mjs#recordAdvisorRun` appends at every sampled-kind launch, joins each run to
 *   - its own transcript (`~/.claude/projects/*operations-dispatch-<runId>/*.jsonl` — the run id names the
 *     session's scratch cwd): worker tokens/cost (priced per turn by `run-rating.mjs`, the same way the
 *     scorecards price it), plus the advisor's own calls, tokens and cost (from `usage.iterations[]`
 *     `advisor_message` entries, which the top-level usage does NOT include — so a scorecard alone under-counts
 *     an advisor run's cost);
 *   - the PR's review verdict comments (`✅ review — accepted` / `🔁 review — changes requested` posted by the
 *     `review-pr` operation): the first verdict after the run gives "findings after the fix";
 *   - the other ledger rows for the same PR: later fix runs = rework this run did not prevent;
 * and compares the advisor-on arm with the advisor-off arm.
 *
 * Usage: node scripts/operations/advisor-trial-report.mjs [--since=<iso>] [--json] [--write] [--no-gh]
 *   --write  also saves the markdown next to the perf snapshot store: metrics/perf/<YYYY-MM-DD>/advisor-trial.md
 *
 * Pure core ({@link summarizeAdvisorTrial}, {@link transcriptAdvisorFacts}, {@link parseReviewVerdicts}) / IO
 * shell ({@link collectAdvisorTrialFacts}) split, same as the perf snapshot.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { advisorLedgerPath } from '../lib/advisor-trial.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { usdFromTokens, rateFor } from '../backlog/cost-rates.mjs';
import { computeTurnsCost, extractTurns, sumTokens } from '../conveyor/run-rating.mjs';
import { makeGh } from './coroner-extract.mjs';

// ── pure core ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Ledger text -> rows (bad lines skipped). PURE. */
export function parseLedger(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.schema === 1 && r.runId) rows.push(r); } catch { /* skip */ }
  }
  return rows;
}

function iterationUsd(it) {
  const model = typeof it.model === 'string' ? it.model : null;
  if (!model || !rateFor(model)) return null;
  const cc = it.cache_creation ?? null;
  const cw5 = Number(cc?.ephemeral_5m_input_tokens) || 0;
  const cw1 = cc ? (Number(cc.ephemeral_1h_input_tokens) || 0) : (Number(it.cache_creation_input_tokens) || 0);
  return usdFromTokens({ cw: cw5 }, model, { cacheTier: '5m' })
    + usdFromTokens({ in: Number(it.input_tokens) || 0, cr: Number(it.cache_read_input_tokens) || 0, out: Number(it.output_tokens) || 0, cw: cw1 }, model, { cacheTier: '1h' });
}

/**
 * One run's token facts from its parsed transcript lines. PURE. Advisor usage is read from each assistant
 * message's `usage.iterations[]`, de-duplicated by message id (Claude Code writes one line per content block,
 * each carrying the same message usage).
 */
export function transcriptAdvisorFacts(lines) {
  // One turn per API message: Claude Code writes a line per content block, each repeating the message's usage.
  const firstPerMessage = [];
  const seenTurn = new Set();
  for (const line of Array.isArray(lines) ? lines : []) {
    const id = line?.type === 'assistant' ? line.message?.id : null;
    if (id && seenTurn.has(id)) continue;
    if (id) seenTurn.add(id);
    firstPerMessage.push(line);
  }
  const turns = extractTurns(firstPerMessage);
  const worker = computeTurnsCost(turns);
  const sums = sumTokens(turns);
  const seenMsg = new Set();
  const seenCall = new Set();
  let advisorIn = 0, advisorOut = 0, advisorCost = 0, advisorUnpriced = false, advisorModel = null;
  for (const line of Array.isArray(lines) ? lines : []) {
    if (line?.type !== 'assistant') continue;
    const msg = line.message ?? {};
    for (const block of Array.isArray(msg.content) ? msg.content : []) {
      if (block?.type === 'server_tool_use' && block.name === 'advisor' && block.id) seenCall.add(block.id);
    }
    const id = msg.id ?? null;
    if (id && seenMsg.has(id)) continue;
    if (id) seenMsg.add(id);
    for (const it of Array.isArray(msg.usage?.iterations) ? msg.usage.iterations : []) {
      if (it?.type !== 'advisor_message') continue;
      advisorModel = it.model ?? advisorModel;
      advisorIn += (Number(it.input_tokens) || 0) + (Number(it.cache_read_input_tokens) || 0) + (Number(it.cache_creation_input_tokens) || 0);
      advisorOut += Number(it.output_tokens) || 0;
      const usd = iterationUsd(it);
      if (usd === null) advisorUnpriced = true; else advisorCost += usd;
    }
  }
  return {
    found: turns.length > 0,
    workerTokens: sums.in + sums.out + sums.cacheRead + sums.cacheWrite5m + sums.cacheWrite1h,
    workerCostUsd: worker.costUsd,
    advisorCalls: seenCall.size,
    advisorModel,
    advisorTokens: advisorIn + advisorOut,
    advisorCostUsd: advisorCost,
    advisorCostPartial: advisorUnpriced,
  };
}

/**
 * The review-pr verdict comments on one PR, oldest first. PURE. Mechanical bounces (conflict watch and the like,
 * which carry no panel) are not reviews of the fix and are skipped.
 * @param {{createdAt:string, body:string}[]} comments
 */
export function parseReviewVerdicts(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const body = String(c?.body ?? '');
    const m = /^(✅|🔁) review — (accepted|changes requested)/u.exec(body);
    if (!m || !/### Panel verdicts|\*\*Verdict:\*\*/.test(body)) continue;
    const f = /### Findings \((\d+)\)/.exec(body);
    out.push({ at: c.createdAt, verdict: m[2] === 'accepted' ? 'accepted' : 'changes', findings: f ? Number(f[1]) : 0 });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

const mean = (xs) => { const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

/**
 * THE COMPARISON. PURE.
 * @param {{rows:object[], transcripts:Record<string,object>, reviews:Record<string,object[]>}} facts
 *   `transcripts[runId]` = {@link transcriptAdvisorFacts}; `reviews["<repo>#<pr>"]` = {@link parseReviewVerdicts}.
 */
export function summarizeAdvisorTrial({ rows, transcripts = {}, reviews = {} }) {
  const fixRows = rows.filter((r) => r.kind === 'fix' && r.pr != null).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const prKey = (r) => `${r.repo ?? 'we'}#${r.pr}`;
  const runs = fixRows.map((r) => {
    const key = prKey(r);
    const t = transcripts[r.runId] ?? null;
    const next = (reviews[key] ?? []).find((v) => Date.parse(v.at) > Date.parse(r.at)) ?? null;
    const later = fixRows.filter((o) => prKey(o) === key && Date.parse(o.at) > Date.parse(r.at)).length;
    const total = t?.found ? (t.workerCostUsd ?? 0) + (t.advisorCostUsd ?? 0) : null;
    return {
      runId: r.runId, at: r.at, pr: key, advisor: r.advisor, laterFixRuns: later,
      nextVerdict: next?.verdict ?? null, findingsAfter: next ? next.findings : null,
      workerCostUsd: t?.found ? t.workerCostUsd : null, advisorCostUsd: t?.found ? t.advisorCostUsd : null,
      totalCostUsd: total, workerTokens: t?.found ? t.workerTokens : null, advisorTokens: t?.found ? t.advisorTokens : null,
      advisorCalls: t?.found ? t.advisorCalls : null,
    };
  });
  // Fix rounds per PR, grouped by the arm of the PR's FIRST trial run (a PR whose runs landed in both arms is
  // counted under `mixed` too, so the pure arms stay clean).
  const byPr = new Map();
  for (const r of fixRows) { const k = prKey(r); if (!byPr.has(k)) byPr.set(k, []); byPr.get(k).push(r); }
  const prs = [...byPr.entries()].map(([pr, rs]) => ({ pr, rounds: rs.length, arm: rs.every((x) => x.advisor) ? 'on' : rs.every((x) => !x.advisor) ? 'off' : 'mixed' }));
  const arm = (on) => {
    const rs = runs.filter((r) => r.advisor === on);
    const reviewed = rs.filter((r) => r.nextVerdict);
    const ps = prs.filter((p) => p.arm === (on ? 'on' : 'off'));
    return {
      runs: rs.length,
      prs: ps.length,
      fixRoundsPerPr: mean(ps.map((p) => p.rounds)),
      laterFixRunsPerRun: mean(rs.map((r) => r.laterFixRuns)),
      reviewedAfter: reviewed.length,
      acceptedNextReviewPct: reviewed.length ? (100 * reviewed.filter((r) => r.nextVerdict === 'accepted').length) / reviewed.length : null,
      findingsAfterFix: mean(reviewed.map((r) => r.findingsAfter)),
      withTranscript: rs.filter((r) => r.totalCostUsd !== null).length,
      workerCostUsd: mean(rs.map((r) => r.workerCostUsd)),
      advisorCostUsd: mean(rs.map((r) => r.advisorCostUsd)),
      totalCostUsd: mean(rs.map((r) => r.totalCostUsd)),
      advisorCallsPerRun: mean(rs.map((r) => r.advisorCalls)),
      tokensPerRun: mean(rs.map((r) => (r.workerTokens === null ? null : r.workerTokens + (r.advisorTokens ?? 0)))),
    };
  };
  return { on: arm(true), off: arm(false), mixedPrs: prs.filter((p) => p.arm === 'mixed').length, runs };
}

const fmt = (v, d = 2, unit = '') => (v === null || v === undefined ? 'n/a' : `${Number(v).toFixed(d)}${unit}`);

/** Markdown for a summary. PURE. */
export function renderAdvisorTrial(summary, { generatedAt, since = null }) {
  const { on, off } = summary;
  const row = (label, a, b) => `| ${label} | ${a} | ${b} |`;
  const lines = [
    `# Advisor trial — Sonnet fix workers, Opus advisor on vs off`,
    '',
    `Generated ${generatedAt}${since ? ` · runs since ${since}` : ''}. Source: the per-run ledger (advisor-trial.jsonl), each run's transcript, and the PR's review-pr verdicts.`,
    '',
    '| Metric | Advisor on | Advisor off |',
    '|---|---|---|',
    row('Runs (with transcript)', `${on.runs} (${on.withTranscript})`, `${off.runs} (${off.withTranscript})`),
    row('PRs (all runs in this arm)', on.prs, off.prs),
    row('Fix rounds per PR', fmt(on.fixRoundsPerPr), fmt(off.fixRoundsPerPr)),
    row('Later fix runs on the same PR, per run', fmt(on.laterFixRunsPerRun), fmt(off.laterFixRunsPerRun)),
    row('Next review accepted', fmt(on.acceptedNextReviewPct, 0, '%'), fmt(off.acceptedNextReviewPct, 0, '%')),
    row('Findings in the next review', fmt(on.findingsAfterFix), fmt(off.findingsAfterFix)),
    row('Advisor calls per run', fmt(on.advisorCallsPerRun), fmt(off.advisorCallsPerRun)),
    row('Tokens per run (worker + advisor)', fmt(on.tokensPerRun, 0), fmt(off.tokensPerRun, 0)),
    row('Worker cost per run', fmt(on.workerCostUsd, 3, ' $'), fmt(off.workerCostUsd, 3, ' $')),
    row('Advisor cost per run', fmt(on.advisorCostUsd, 3, ' $'), fmt(off.advisorCostUsd, 3, ' $')),
    row('Total cost per run', fmt(on.totalCostUsd, 3, ' $'), fmt(off.totalCostUsd, 3, ' $')),
    '',
    `PRs with runs in both arms (left out of the per-PR rows): ${summary.mixedPrs}.`,
    '',
    'Pays for itself when the on arm\'s extra total cost per run is smaller than the off arm\'s later-fix-runs-per-run gap times the cost of one fix run.',
  ];
  return `${lines.join('\n')}\n`;
}

// ── io shell ──────────────────────────────────────────────────────────────────────────────────────────────────

function readJsonl(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* skip */ } }
  return out;
}

/** Real facts for the summary: ledger rows, transcripts, review verdicts (one gh call per PR). */
export function collectAdvisorTrialFacts({ env = process.env, home = homedir(), since = null, gh = makeGh({ home, env }), useGh = true } = {}) {
  const ledger = advisorLedgerPath(env, home);
  const rows = existsSync(ledger) ? parseLedger(readFileSync(ledger, 'utf8')).filter((r) => !since || Date.parse(r.at) >= Date.parse(since)) : [];
  const projects = join(home, '.claude', 'projects');
  const dirs = existsSync(projects) ? readdirSync(projects) : [];
  const transcripts = {};
  for (const r of rows) {
    const dir = dirs.find((d) => d.endsWith(`-${r.runId}`));
    if (!dir) continue;
    const lines = [];
    for (const f of readdirSync(join(projects, dir))) if (f.endsWith('.jsonl')) lines.push(...readJsonl(join(projects, dir, f)));
    transcripts[r.runId] = transcriptAdvisorFacts(lines);
  }
  const reviews = {};
  if (useGh) {
    for (const key of new Set(rows.filter((r) => r.pr != null).map((r) => `${r.repo ?? 'we'}#${r.pr}`))) {
      const [repo, pr] = key.split('#');
      const slug = CONSTELLATION_REPOS[repo]?.slug;
      if (!slug) continue;
      const data = gh(['pr', 'view', pr, '--repo', slug, '--json', 'comments']);
      reviews[key] = parseReviewVerdicts(data?.comments ?? []);
    }
  }
  return { rows, transcripts, reviews, ledger };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const arg = (n) => process.argv.slice(2).find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  const since = arg('since')?.split('=')[1] ?? null;
  const facts = collectAdvisorTrialFacts({ since, useGh: !arg('no-gh') });
  const summary = summarizeAdvisorTrial(facts);
  const generatedAt = new Date().toISOString();
  const md = renderAdvisorTrial(summary, { generatedAt, since });
  if (arg('write')) {
    const out = join(dirname(facts.ledger), generatedAt.slice(0, 10), 'advisor-trial.md');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, md);
    console.error(`advisor-trial-report: wrote ${out}`);
  }
  process.stdout.write(arg('json') ? `${JSON.stringify({ ledger: facts.ledger, ...summary }, null, 2)}\n` : md);
}
