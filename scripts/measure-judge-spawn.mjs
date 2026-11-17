#!/usr/bin/env node
import { agentResumeId, launchAgent } from './lib/agent-launch.mjs';
/**
 * measure-judge-spawn.mjs — argv in, loaded-context and wall clock out (#3028).
 *
 * WHY THIS SCRIPT EXISTS AT ALL, IN ONE PARAGRAPH. #3028's recipe rests on a claim: `--safe-mode --tools ""`
 * cuts a juror's loaded context by roughly an order of magnitude and shortens wall clock with it. Two
 * separate hand measurements of that exact recipe DISAGREED on the absolute numbers and NEITHER recorded
 * its conditions, so both were withdrawn and the item carries only the DIRECTION. This script is the
 * condition under which a figure may exist again: anyone can re-run it, and every number it prints comes
 * back stamped with the cwd, model, effort, prompt, CLI version and commit that produced it. A figure
 * quoted without the block this prints is not a measurement — it is a memory.
 *
 * WHAT IT COMPARES. Two arms, IDENTICAL prompt, model, effort and schema; the ONLY difference is the two
 * flags under test:
 *   • treatment — the real recipe from `we:scripts/lib/judge-spawn.mjs#buildJudgeArgv`, `--safe-mode --tools ""`.
 *   • control   — the same spawn WITHOUT them: repo instructions, skills, plugins and the full tool set.
 * Running the control from inside a repo is the point: the context the flags strip is the repo's own.
 *
 * WHAT "LOADED CONTEXT" MEANS HERE. `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`,
 * read from the CLI's OWN `usage` block — never estimated, never a token-counter approximation. Cache reads
 * are included deliberately: they are context the model was given, and cheapness is not absence. Output
 * tokens are excluded — they are the answer, not the context.
 *
 * READS PER WRITE (#3514). Each arm keeps ONE session id for the whole run, reused by every `--repeat`
 * iteration, so iteration 2+ presents the same session and prefix as iteration 1 and the warm read is actually
 * exercised. Every spawn still carries `--no-session-persistence`, so reuse resumes nothing — the juror stays
 * throwaway; only the cache sees continuity. Per arm the summary then derives, from the same `usage` blocks:
 *   • reads per write — `Σ cache_read_input_tokens / Σ cache_creation_input_tokens` (null when nothing was written);
 *   • cache hit rate  — `Σ cache_read_input_tokens / Σ loaded context` (null when nothing was loaded).
 * With `--repeat=1` there is no second presentation, so a near-zero reads-per-write is the expected cold figure.
 *
 * WHAT IT CANNOT CONTROL, STATED SO THE NUMBER IS READ HONESTLY. Prompt-cache state left by OTHER runs (a
 * cache already warm before iteration 1 moves both wall clock and the cache split), server-side load, model
 * routing, and the repo's size at the commit measured. Wall clock is the NOISIEST figure here and a single pair proves nothing about it — use
 * `--repeat` and read the median. Loaded context is far more stable, because it is a property of what was
 * assembled rather than of how fast the network was.
 *
 * USAGE
 *   node scripts/measure-judge-spawn.mjs                       # one pair, haiku, this cwd
 *   node scripts/measure-judge-spawn.mjs --repeat=3            # three pairs, medians reported
 *   node scripts/measure-judge-spawn.mjs --model=sonnet        # a costlier arm
 *   node scripts/measure-judge-spawn.mjs --json                # machine-readable, conditions included
 *   node scripts/measure-judge-spawn.mjs --treatment-only      # skip the expensive control arm
 *
 * COST. Each pair is two real API calls. The control arm is the expensive one by construction. The default
 * model is `haiku` and every spawn carries `--max-budget-usd`, so a default run is cents; `--model=opus
 * --repeat=5` is not. The script prints the total it actually spent.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildJudgeArgv, deriveSessionId, parseJudgeOutcome, loadedContextTokens } from './lib/judge-spawn.mjs';

// ── The fixed stimulus. Held constant across both arms and across runs, so the only variable is the flags. ──

const MANDATE = 'You are a code reviewer. Answer only through the provided schema. Be terse.';
const INPUT = 'Review this change: a function `half(n)` was added that returns `n / 0`. State one finding.';
const SHAPE = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    finding: { type: 'string' },
  },
  required: ['verdict', 'finding'],
  additionalProperties: false,
};

// ── Argv. The treatment arm is the SHIPPED function, never a copy — a drifted recipe must break this. ──────

/** The recipe under test, straight from the helper every `judge` step calls. */
function treatmentArgv({ model, effort, budget, sessionId }) {
  return buildJudgeArgv({ mandate: MANDATE, shape: SHAPE, model, effort, budget, sessionId });
}

/** The same spawn WITHOUT `--safe-mode` and WITHOUT `--tools ""` — everything else identical. */
function controlArgv({ model, effort, budget, sessionId }) {
  return treatmentArgv({ model, effort, budget, sessionId })
    .filter((tok, i, a) => tok !== '--safe-mode' && tok !== '--tools' && !(i > 0 && a[i - 1] === '--tools'));
}

// ── One spawn. Deliberately NOT `judgeSpawn`, because the control arm is not a legal judge call. ────────────

function runOnce(argv, { cwd, cli }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = launchAgent({ mode: 'judge-measurement', resumeId: agentResumeId(argv) }, spawn, cli, argv, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ error: `could not start ${cli}: ${e.message}`, wallMs: Date.now() - startedAt }));
    child.on('close', () => {
      const wallMs = Date.now() - startedAt;
      try {
        const o = parseJudgeOutcome(out, err);
        resolve({ wallMs, tokens: loadedContextTokens(o.usage), costUsd: o.costUsd, apiMs: o.durationMs, usage: o.usage });
      } catch (e) {
        resolve({ error: e.message.slice(0, 400), wallMs });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(INPUT);
  });
}

// ── Conditions. Printed with every number, because a number without them is what got withdrawn. ────────────

/**
 * One session id per arm, for the whole run — seeded by the run's own timestamp so two runs never share one,
 * while every iteration inside a run does.
 */
export function armSessionIds(stamp) {
  return { treatment: deriveSessionId(`measure-t-${stamp}`), control: deriveSessionId(`measure-c-${stamp}`) };
}

export function conditions({ cwd, model, effort, budget, cli, repeat, treatmentOnly = false }, now = new Date()) {
  const safe = (fn, fallback = 'unknown') => { try { return fn(); } catch { return fallback; } };
  // A probe that fails falls back to 'unknown'; its stderr would only be noise ahead of the block.
  const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  const measuredAtUtc = now.toISOString();
  const ids = armSessionIds(measuredAtUtc);
  return {
    measuredAtUtc,
    cwd,
    cwdHasClaudeMd: existsSync(`${cwd}/CLAUDE.md`),
    cwdHasAgentsMd: existsSync(`${cwd}/AGENTS.md`),
    gitHead: safe(() => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], quiet).trim()),
    gitBranch: safe(() => execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], quiet).trim()),
    cli,
    cliVersion: safe(() => launchAgent({ mode: 'agent-version', resumeId: null }, execFileSync, cli, ['--version'], quiet).trim()),
    model,
    effort,
    maxBudgetUsd: budget,
    repeat,
    sessionReuse: 'one session id per arm, reused by every --repeat iteration (--no-session-persistence)',
    treatmentSessionId: ids.treatment,
    controlSessionId: treatmentOnly ? null : ids.control,
    node: process.version,
    os: `${platform()} ${release()}`,
    host: hostname(),
    mandate: MANDATE,
    input: INPUT,
    shape: SHAPE,
    loadedContextDefinition: 'input_tokens + cache_creation_input_tokens + cache_read_input_tokens (from the CLI usage block)',
    readsPerWriteDefinition: 'sum cache_read_input_tokens / sum cache_creation_input_tokens over the arm\'s successful runs',
    cacheHitRateDefinition: 'sum cache_read_input_tokens / sum loaded context over the arm\'s successful runs',
  };
}

/** The cache halves of one `usage` block. A missing or non-numeric field counts as 0, as in `loadedContextTokens`. */
export function cacheSplit(usage = {}) {
  const n = (k) => (typeof usage?.[k] === 'number' && Number.isFinite(usage[k]) ? usage[k] : 0);
  return { read: n('cache_read_input_tokens'), write: n('cache_creation_input_tokens') };
}

/**
 * Reads per write and cache hit rate for one arm, summed over its SUCCESSFUL runs (errored and skipped runs
 * carry no `usage` and would only dilute the ratio). Both ratios are null rather than 0 or Infinity when their
 * denominator is 0 — "nothing was written" is not "no reads per write".
 */
export function cacheSummary(runs = []) {
  const ok = runs.filter((r) => r && !r.error);
  let read = 0;
  let write = 0;
  let loaded = 0;
  for (const r of ok) {
    const c = cacheSplit(r.usage);
    read += c.read;
    write += c.write;
    loaded += loadedContextTokens(r.usage ?? {});
  }
  return {
    cacheReadTokens: read,
    cacheWriteTokens: write,
    readsPerWrite: write > 0 ? Number((read / write).toFixed(2)) : null,
    cacheHitRate: loaded > 0 ? Number((read / loaded).toFixed(3)) : null,
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// ── Measure. The loop, separable from argv and stdout so the reuse and the summary are testable. ────────────

/**
 * Runs `repeat` iterations of both arms and summarizes them. `run` is `runOnce` unless a test substitutes it;
 * `onPair` sees each pair as it lands.
 */
export async function measure(opts, { run = runOnce, cond = conditions(opts), onPair = () => {} } = {}) {
  const { cwd, model, effort, budget, cli, repeat, treatmentOnly } = opts;
  const pairs = [];

  // ONE session id per arm, taken from the conditions block and reused by every iteration (#3514): a fresh id
  // per iteration never presents the same session twice, so no warm read was ever measured.
  const tArgv = treatmentArgv({ model, effort, budget, sessionId: cond.treatmentSessionId });
  const cArgv = treatmentOnly ? null : controlArgv({ model, effort, budget, sessionId: cond.controlSessionId });

  for (let i = 0; i < repeat; i += 1) {
    const t = await run(tArgv, { cwd, cli });
    const c = cArgv ? await run(cArgv, { cwd, cli }) : null;
    const pair = { iteration: i + 1, treatment: t, control: c };
    pairs.push(pair);
    onPair(pair);
  }

  const okT = pairs.map((p) => p.treatment).filter((r) => r && !r.error);
  const okC = pairs.map((p) => p.control).filter((r) => r && !r.error);
  const summary = {
    treatment: { runs: okT.length, medianTokens: median(okT.map((r) => r.tokens)), medianWallMs: median(okT.map((r) => r.wallMs)), ...cacheSummary(okT) },
    control: { runs: okC.length, medianTokens: median(okC.map((r) => r.tokens)), medianWallMs: median(okC.map((r) => r.wallMs)), ...cacheSummary(okC) },
    totalCostUsd: Number([...okT, ...okC].reduce((a, r) => a + (r.costUsd ?? 0), 0).toFixed(4)),
  };
  if (summary.treatment.medianTokens != null && summary.control.medianTokens) {
    summary.contextRatio = Number((summary.control.medianTokens / summary.treatment.medianTokens).toFixed(2));
  }
  if (summary.treatment.medianWallMs != null && summary.control.medianWallMs) {
    summary.wallRatio = Number((summary.control.medianWallMs / summary.treatment.medianWallMs).toFixed(2));
  }
  return { conditions: cond, pairs, summary };
}

// ── Main ────────────────────────────────────────────────────────────────────────────────────────────────────

const fmtRatio = (v, pct = false) => (v == null ? 'n/a' : pct ? `${(v * 100).toFixed(1)}%` : `${v}`);

async function main() {
  const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };
  const has = (name) => process.argv.includes(`--${name}`);

  const opts = {
    cwd: arg('cwd', process.cwd()),
    model: arg('model', 'haiku'),
    effort: arg('effort', 'medium'),
    budget: Number(arg('budget', '0.5')),
    cli: arg('cli', 'claude'),
    repeat: Math.max(1, Number(arg('repeat', '1'))),
    treatmentOnly: has('treatment-only'),
  };
  const asJson = has('json');
  const out = (line) => process.stdout.write(line);

  const cond = conditions(opts);

  // The conditions block prints FIRST, so not even a per-run line reaches the reader ahead of the block that
  // produced it — a run that dies halfway still leaves its figures stamped.
  if (!asJson) {
    out('── conditions ──────────────────────────────────────────────\n');
    for (const [k, v] of Object.entries(cond)) {
      if (k === 'shape') continue;
      out(`  ${k.padEnd(26)} ${typeof v === 'string' ? v : JSON.stringify(v)}\n`);
    }
    out('\n── runs ────────────────────────────────────────────────────\n');
  }

  const fmt = (r) => {
    if (!r) return 'skipped';
    if (r.error) return `ERROR ${r.error}`;
    const c = cacheSplit(r.usage);
    return `${r.tokens} tok (cache read ${c.read}, write ${c.write}), ${r.wallMs} ms wall, ${r.apiMs} ms api, $${(r.costUsd ?? 0).toFixed(4)}`;
  };
  const onPair = asJson ? undefined : (p) => {
    out(`  run ${p.iteration}  treatment: ${fmt(p.treatment)}\n`);
    out(`  run ${p.iteration}  control  : ${fmt(p.control)}\n`);
  };

  const { pairs, summary } = await measure(opts, { cond, onPair });

  if (asJson) {
    out(`${JSON.stringify({ conditions: cond, pairs, summary }, null, 2)}\n`);
    return;
  }

  out('\n── result (medians) ────────────────────────────────────────\n');
  out(`  treatment (--safe-mode --tools "")   ${summary.treatment.medianTokens} tok   ${summary.treatment.medianWallMs} ms\n`);
  out(`  control   (neither flag)             ${summary.control.medianTokens} tok   ${summary.control.medianWallMs} ms\n`);
  if (summary.contextRatio) out(`  context ratio  control / treatment = ${summary.contextRatio}x\n`);
  if (summary.wallRatio) out(`  wall ratio     control / treatment = ${summary.wallRatio}x\n`);
  out('\n── cache (summed over successful runs, one session id per arm) ─\n');
  for (const [label, arm] of [['treatment', summary.treatment], ['control  ', summary.control]]) {
    if (!arm.runs) { out(`  ${label}  no successful runs\n`); continue; }
    out(`  ${label}  reads per write ${fmtRatio(arm.readsPerWrite)}   hit rate ${fmtRatio(arm.cacheHitRate, true)}   (read ${arm.cacheReadTokens}, write ${arm.cacheWriteTokens})\n`);
  }
  out(`  spent on this measurement            $${summary.totalCostUsd}\n`);
  out('\n  These numbers are valid ONLY with the conditions block above. #3028: a figure quoted\n');
  out('  without its conditions is what got withdrawn twice. Re-run rather than re-cite.\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { process.stderr.write(`${e.stack}\n`); process.exitCode = 1; });
}
