import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, digest, verify } from './lib/drain-verdict.mjs';
import { DRAIN_GATES } from './lib/merge-gate-inventory.mjs';
import { classifySkipReason } from './lib/drain-skip-reasons.mjs';
import { readDeclaredSettings } from './lib/settings-files.mjs';

/** Only evidence exposed by the existing dry-run is asserted; absence never becomes a passing gate. */
export function resultToVerdictInputs(result, ctx) {
  if (result?.dryRun !== true || result.ok !== true || result.failedRepos?.length) throw new Error('incomplete dry-run; run the local drain');
  for (const key of ['toMerge', 'skipped', 'parked']) {
    if (!Array.isArray(result[key])) throw new Error(`missing ${key}; run the local drain`);
  }
  // Local-repo dry-run rows carry repo:null; they belong to ctx.repo (the resolved local slug).
  const rowRepo = row => row.repo ?? ctx.repo;
  const matches = row => Number(row.num) === ctx.pr && (!ctx.repo || rowRepo(row) === ctx.repo);
  const merge = result.toMerge.filter(matches);
  const skipped = result.skipped.filter(matches);
  const parked = result.parked.filter(matches);
  const rows = [...merge, ...skipped, ...parked];
  if (!rows.length) throw new Error('target absent; run the local drain');
  const repo = ctx.repo || rowRepo(rows[0]);
  const heads = new Set(rows.map(r => r.headSha));
  if (heads.size !== 1 || !rows[0].headSha || rows.some(r => rowRepo(r) !== repo)) throw new Error('ambiguous headSha/repo; run the local drain');
  if (merge.length && (skipped.length || parked.length)) throw new Error('contradictory classification; run the local drain');
  // `toMerge` is captured before dependency planning: a deferred or skip-reasoned candidate is NOT admitted.
  if (merge.length && ((result.deferred || []).some(d => typeof d === 'object' ? matches(d) : false) ||
      (result.skipReasons || []).some(r => Number(r.num) === ctx.pr && rowRepo(r) === repo))) {
    throw new Error('toMerge candidate deferred or skip-reasoned; run the local drain');
  }
  const reasons = rows.flatMap(r => [r.reason, ...(r.reasons || [])]).filter(Boolean);
  const skipRows = (result.skipReasons || []).filter(r => Number(r.num) === ctx.pr && rowRepo(r) === repo);
  const hold = rows.some(r => r.humanRequired || r.hold) ||
    skipRows.some(r => /(?:^|-)hold$/.test(r.kind)) ||
    [...reasons, ...skipRows.map(r => r.reason)].some(r => /\bhold\b|review:(?:human|changes|pending)|human.required|awaiting review/i.test(r));
  const decision = merge.length ? 'enqueue' : hold ? 'hold' : 'local';
  const kinds = new Set([...skipRows.map(r => r.kind), ...reasons.map(classifySkipReason)]);
  const gates = DRAIN_GATES.map(g => ({ id: g.id,
    result: g.input !== 'local-only' && g.skipKinds.some(k => kinds.has(k)) ? 'fail' : 'unknown',
    evidence: g.skipKinds.some(k => kinds.has(k)) ? [...reasons, ...skipRows.map(r => r.reason)].join('; ') : 'not exposed by dry-run' }));
  const actions = [];
  if (decision === 'enqueue') actions.push({ type: 'enqueue', repo, pr: ctx.pr, headSha: rows[0].headSha });
  for (const row of parked) actions.push({ type: 'park', repo, pr: ctx.pr, humanRequired: !!row.humanRequired,
    reasons: row.reasons || [] });
  // Preserve reported write plans without inventing writes from a reason string.
  for (const key of ['reconciledLabels', 'jitNumbered', 'rebased', 'healed', 'deferred']) {
    for (const row of result[key] || []) if (typeof row === 'object' && matches(row)) actions.push({ type: key, evidence: row });
  }
  const inputs = { rows, skipReasons: skipRows, labels: rows.map(r => r.labels ?? null),
    checks: rows.map(r => r.statusCheckRollup ?? r.checks ?? null) };
  return { repo, pr: ctx.pr, headSha: rows[0].headSha, mainSha: ctx.mainSha, codeSha: ctx.codeSha,
    gateTree: ctx.gateTree, settingsDigest: ctx.settingsDigest, inputsDigest: digest(inputs),
    decision, gates, actions, computedAt: ctx.computedAt };
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const flags = Object.create(null);
  for (const arg of argv) {
    const m = /^--(only|classify-only|verdict-out|repo|max-age)(?:=(.*))?$/.exec(arg);
    if (!m || Object.hasOwn(flags, m[1])) throw new Error('invalid or repeated argument');
    flags[m[1]] = m[2] ?? true;
  }
  if (flags['classify-only'] !== true || !/^\d+$/.test(flags.only) || Number(flags.only) < 1 ||
      !Number.isSafeInteger(Number(flags.only)) || typeof flags['verdict-out'] !== 'string' || !flags['verdict-out']) {
    throw new Error('usage: --only=N --classify-only --verdict-out=path [--repo=owner/repo] [--max-age=minutes]');
  }
  if (flags.repo !== undefined && (typeof flags.repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(flags.repo))) throw new Error('invalid repo');
  const maxAgeMinutes = flags['max-age'] === undefined ? 10 : Number(flags['max-age']);
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0 || flags['max-age'] === true) throw new Error('invalid max-age');
  const seam = io.execFileSync || execFileSync;
  const exec = (...args) => {
    try { return seam(...args); } catch (cause) {
      throw new Error('classification read failed or exceeded output/time bounds; run the local drain', { cause });
    }
  };
  const env = { ...(io.env || process.env), DRAIN_CLASSIFY_ONLY: '1' };
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, env };
  const started = (io.now || Date.now)();
  const repoSlug = flags.repo || String(exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], options)).trim();
  const git = ref => String(exec('git', ['rev-parse', ref], options)).trim();
  const before = { mainSha: git('origin/main'), codeSha: git('HEAD'), gateTree: git('HEAD:scripts') };
  const readSettings = io.readSettings || readDeclaredSettings;
  const settings = readSettings();
  if (settings.errors?.length || !settings.sources?.length) throw new Error('settings unreadable; run the local drain');
  // Bind declared settings and the environment passed to the drain (including environment overrides).
  const settingsDigest = digest({ settings, env });
  const args = ['--import', fileURLToPath(new URL('./lib/drain-classify-guard.mjs', import.meta.url)),
    fileURLToPath(new URL('./merge-ai-prs.mjs', import.meta.url)), `--only=${flags.only}`, '--dry-run', '--json', '--no-drain-lease',
    ...(flags.repo ? [`--only-repo=${flags.repo}`, `--repos=${flags.repo}`] : ['--this-repo'])];
  const raw = String(exec(process.execPath, args, options));
  if (Buffer.byteLength(raw) > options.maxBuffer) throw new Error('dry-run output oversized; run the local drain');
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('invalid dry-run JSON; run the local drain'); }
  if (before.mainSha !== git('origin/main') || before.codeSha !== git('HEAD') || before.gateTree !== git('HEAD:scripts') ||
      settingsDigest !== digest({ settings: readSettings(), env })) throw new Error('classification inputs changed; run the local drain');
  const now = (io.now || Date.now)();
  const inputs = resultToVerdictInputs(result, { ...before, pr: Number(flags.only), repo: repoSlug,
    settingsDigest, computedAt: new Date(started).toISOString() });
  const verdict = build(inputs);
  if (!verify(verdict, inputs, { maxAgeMinutes, now }).ok) throw new Error('verdict verification failed; run the local drain');
  (io.writeFileSync || writeFileSync)(flags['verdict-out'], `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

const IS_CLI = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (IS_CLI) {
  try { runCli(); } catch (error) {
    process.stderr.write(`${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
