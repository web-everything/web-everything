import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, verify, forbiddenCredential } from './lib/drain-verdict.mjs';
import { filterOpenPrsByLabel, OPEN_PR_LIST_LIMIT } from './lib/no-search-backed-pr-list.mjs';

/** At most this many labelled PRs are classified per scheduled run (each spawns a full dry-run drain). */
const BATCH_PR_CAP = 10;

/**
 * The one admission-hold decision for a toMerge candidate. A dry-run lands nothing (its `merged` set is empty),
 * so drain-skip-reasons emits a `ready-not-reached` accounting row (source `unaccounted`) for EVERY ready
 * candidate: that row alone is not a hold. Any other row for the target — partner-pending, batching-deferred,
 * red-main-hold, blocked-by, an unknown kind or source — is, and so is any deferred entry. Every matching row is
 * checked: the producer keys rows by `repo ?? ''`, so one target can carry several.
 */
export function heldBeforeAdmission(result, matches) {
  if ((result.deferred || []).some(matches)) return true;
  return result.skipReasons.some(row => matches(row) && !(row.kind === 'ready-not-reached' && row.source === 'unaccounted'));
}

/** Only evidence exposed by the existing dry-run is asserted. */
export function resultToVerdictInputs(result, ctx) {
  if (result?.dryRun !== true || result.ok !== true ||
      (result.failedRepos !== undefined && (!Array.isArray(result.failedRepos) || result.failedRepos.length))) {
    throw new Error('incomplete dry-run; run the local drain');
  }
  for (const key of ['toMerge', 'skipped', 'parked', 'skipReasons']) {
    if (!Array.isArray(result[key])) throw new Error(`missing ${key}; run the local drain`);
  }
  if (result.deferred !== undefined && !Array.isArray(result.deferred)) throw new Error('invalid deferred; run the local drain');
  // Couple evidence may be an aggregate (heldCoupleMembers), a result list (coupleHeld /
  // coupleSplit), or nested candidate metadata. Conservatively refuse even unscoped signals.
  const pending = [result], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (value === null || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      // The real JSON producer always emits this count, including when none are held.
      if (/couple/i.test(key) && !(value === result && key === 'heldCoupleMembers' && child === 0)) {
        throw new Error('couple evidence requires the local drain');
      }
      if (child !== null && typeof child === 'object') pending.push(child);
    }
  }
  const rowRepo = row => row.repo ?? ctx.repo;
  const matches = row => row && Number(row.num) === ctx.pr && rowRepo(row) === ctx.repo;
  const merge = result.toMerge.filter(matches);
  const skipped = result.skipped.filter(matches);
  const parked = result.parked.filter(matches);
  const rows = [...merge, ...skipped, ...parked];
  if (!rows.length) throw new Error('target absent; run the local drain');
  const heads = new Set(rows.map(r => r.headSha));
  if (heads.size !== 1 || !/^[a-f0-9]{40}$/i.test(rows[0].headSha ?? '')) throw new Error('ambiguous headSha/repo; run the local drain');
  if (merge.length && (merge.length !== 1 || skipped.length || parked.length)) throw new Error('contradictory classification; run the local drain');
  // toMerge is captured before dependency planning: deferred candidates are not admitted.
  if (merge.length && heldBeforeAdmission(result, matches)) {
    throw new Error('toMerge candidate deferred or skip-reasoned; run the local drain');
  }
  // --dry-run --json skips planCoupleCascadeStep and cannot detect separated couples:
  // enqueue is only a hint; the local drain must re-check couple-whole before admission.
  return { repo: ctx.repo, pr: ctx.pr, headSha: rows[0].headSha, mainSha: ctx.mainSha,
    computedAt: ctx.computedAt, provenance: ctx.provenance, decision: merge.length ? 'enqueue' : 'local' };
}

function assertSafeEnv(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main' ||
      !['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID || '') ||
      !env.GITHUB_TOKEN || Object.keys(env).some(forbiddenCredential) ||
      (Object.hasOwn(env, 'GH_TOKEN') && env.GH_TOKEN !== env.GITHUB_TOKEN)) {
    throw new Error('unsafe Actions environment; run the local drain');
  }
}

export function runCli(argv = process.argv.slice(2), io = {}) {
  const flags = Object.create(null);
  for (const arg of argv) {
    const match = /^--(only|verdict-out|repo)=(.*)$/.exec(arg);
    if (!match || Object.hasOwn(flags, match[1])) throw new Error('invalid or repeated argument; run the local drain');
    flags[match[1]] = match[2];
  }
  if (!/^[1-9]\d*$/.test(flags.only) || !Number.isSafeInteger(Number(flags.only)) || !flags['verdict-out'] ||
      (flags.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(flags.repo))) {
    throw new Error('usage: --only=N --verdict-out=path [--repo=owner/repo]; run the local drain');
  }
  const env = { ...(io.env || process.env) };
  assertSafeEnv(env);
  const repoSlug = flags.repo || env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug || '') ||
      (flags.repo && flags.repo !== env.GITHUB_REPOSITORY)) throw new Error('unbound repository; run the local drain');
  const options = { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000, env };
  const exec = (cmd, args) => {
    try {
      const raw = String((io.execFileSync || execFileSync)(cmd, args, options));
      if (Buffer.byteLength(raw) > options.maxBuffer) throw new Error('oversized output');
      return raw;
    } catch (cause) { throw new Error('classification read failed or exceeded output/time bounds; run the local drain', { cause }); }
  };
  const started = (io.now || Date.now)();
  const mainSha = exec('git', ['rev-parse', 'origin/main']).trim();
  const args = [fileURLToPath(new URL('./merge-ai-prs.mjs', import.meta.url)), `--only=${flags.only}`,
    '--dry-run', '--json', '--no-drain-lease', '--label=ready-to-merge',
    ...(flags.repo ? [`--only-repo=${flags.repo}`, `--repos=${flags.repo}`] : ['--this-repo'])];
  const raw = exec(process.execPath, args);
  let result;
  try { result = JSON.parse(raw); } catch { throw new Error('invalid dry-run JSON; run the local drain'); }
  if (mainSha !== exec('git', ['rev-parse', 'origin/main']).trim()) throw new Error('main changed; run the local drain');
  const inputs = resultToVerdictInputs(result, { pr: Number(flags.only), repo: repoSlug, mainSha,
    computedAt: new Date(started).toISOString(), provenance: { runId: env.GITHUB_RUN_ID,
      event: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, workflow: 'drain-verdict' } });
  const verdict = build(inputs);
  if (!verify(verdict, inputs, { now: (io.now || Date.now)() }).ok) throw new Error('verdict verification failed; run the local drain');
  (io.writeFileSync || writeFileSync)(flags['verdict-out'], `${JSON.stringify(verdict, null, 2)}\n`);
  return verdict;
}

/** Owns the loop, counting and exit code: failures fail; an empty scheduled list is a no-op. */
export function runBatch(argv = process.argv.slice(2), io = {}) {
  const flags = Object.create(null);
  for (const arg of argv) {
    const match = /^--(batch|verdict-dir|repo)(?:=(.*))?$/.exec(arg);
    if (!match || Object.hasOwn(flags, match[1]) || (match[1] === 'batch') !== (match[2] === undefined)) {
      throw new Error('invalid or repeated argument; run the local drain');
    }
    flags[match[1]] = match[2] ?? true;
  }
  if (flags.batch !== true || !/^[\w./-]+$/.test(flags['verdict-dir'] || '') || flags['verdict-dir'].includes('..')) {
    throw new Error('usage: --batch --verdict-dir=dir [--repo=owner/repo]; run the local drain');
  }
  const env = { ...(io.env || process.env) };
  assertSafeEnv(env);
  const fail = reason => { process.stderr.write(`${reason}; run the local drain\n`); return { written: 0, failed: 1 }; };
  let prs;
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') prs = [env.REQUESTED_PR ?? ''];
  else {
    // List open PRs plainly and filter the label client-side: a label-filtered list is search-backed and
    // exhausts the small search budget (#no-label-search). A possibly-truncated listing fails closed.
    let listing;
    try {
      listing = JSON.parse(String((io.execFileSync || execFileSync)('gh', ['pr', 'list', '--repo', flags.repo || env.GITHUB_REPOSITORY,
        '--state', 'open', '--limit', String(OPEN_PR_LIST_LIMIT), '--json', 'number,labels'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000, env })));
    } catch { return fail('open PR list unreadable'); }
    if (!Array.isArray(listing)) return fail('open PR list unreadable');
    const { prs: labelled, truncated } = filterOpenPrsByLabel(listing, 'ready-to-merge');
    if (truncated) return fail('open PR list possibly truncated');
    prs = labelled.slice(0, BATCH_PR_CAP).map(row => String(row?.number ?? ''));
  }
  if (!prs.length) return { written: 0, failed: 0 };
  (io.mkdirSync || mkdirSync)(flags['verdict-dir'], { recursive: true });
  let written = 0, failed = 0;
  for (const pr of prs) {
    try {
      if (!/^[1-9]\d*$/.test(pr)) throw new Error('invalid PR number');
      runCli([`--only=${pr}`, `--verdict-out=${flags['verdict-dir']}/pr-${pr}.json`, ...(flags.repo ? [`--repo=${flags.repo}`] : [])], io);
      written++;
    } catch (error) {
      failed++;
      process.stderr.write(`#${String(pr).replace(/[^\w-]/g, '?')}: ${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}\n`);
    }
  }
  if (!written && !failed) failed = 1;
  return { written, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.includes('--batch')) {
      const { failed } = runBatch();
      if (failed) process.exitCode = 1;
    } else runCli();
  } catch (error) {
    process.stderr.write(`${String(error.message).replace(/[\x00-\x1f\x7f]/g, ' ')}\n`);
    process.exitCode = 1;
  }
}
