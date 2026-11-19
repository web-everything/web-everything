/**
 * A single bounded retry distinguishes intermittent unit failures from reproducible breaks without
 * hiding either: every retried file is recorded, and only proven passing retries can recover a shard.
 * The original coverage is retained; retries run without coverage. Missing evidence, process errors,
 * and widespread failures stay red for operator inspection. This is evidence collection, not quarantine.
 * Usage (only after a nonzero first run): node scripts/ci/rerun-failed-once.mjs --shard=N -- [quarantine args]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSettings } from '../lib/settings-files.mjs';
import { cascadePolicy } from '../lib/policy-cascade.mjs';

export function resolvePolicy({ tool, platform, env = {}, log = console.error } = {}) {
  const enabled = env.WE_CI_UNIT_RERUN_ENABLED;
  return cascadePolicy('ciUnitRerun', tool, {
    standard: { enabled: true, maxFiles: 10 }, platform, operatorOverride: {},
    envValues: {
      enabled: enabled === undefined ? undefined : /^(true|1)$/.test(enabled) ? true : /^(false|0)$/.test(enabled) ? false : enabled,
      maxFiles: env.WE_CI_UNIT_RERUN_MAX_FILES === undefined ? undefined : Number(env.WE_CI_UNIT_RERUN_MAX_FILES),
    },
    valid: { enabled: v => typeof v === 'boolean', maxFiles: v => Number.isSafeInteger(v) && v > 0 },
    env: { ...env, WE_POLICY_CASCADE_LOG: '1' }, log,
  }).value;
}

/** PURE: validate JSON evidence and normalize runner-absolute filenames to portable record keys. */
export function parseReport(text, root = process.cwd()) {
  const report = JSON.parse(text);
  if (!Array.isArray(report?.testResults)) throw new Error('missing testResults');
  // The CI JSON reporter supplies this even when zero. Legacy/missing evidence cannot
  // rule out independent global errors, which a file-only retry cannot repair.
  if (report.numUnhandledErrors !== 0
    || (report.numRuntimeErrorTestSuites !== undefined && report.numRuntimeErrorTestSuites !== 0)
    || ['unhandledErrors', 'errors'].some(key => report[key] !== undefined
      && (!Array.isArray(report[key]) || report[key].length > 0))) {
    throw new Error('global error evidence is missing, invalid or nonzero; inspect original run');
  }
  const seen = new Set();
  return report.testResults.map(result => {
    if (typeof result.name !== 'string' || !result.name) throw new Error('missing test filename');
    const file = relative(root, resolve(root, result.name)).split('\\').join('/');
    if (!file || isAbsolute(file) || file.startsWith('../') || /[\x00-\x1f\x7f]/.test(file) || file.startsWith('-') || seen.has(file)) throw new Error('invalid or duplicate test filename');
    seen.add(file);
    const collectionError = !!result.testExecError || !!result.message || (Array.isArray(result.errors) && result.errors.length > 0);
    if (!['passed', 'failed', 'pending', 'skipped', 'todo'].includes(result.status) && !(result.status === undefined && collectionError)) throw new Error('unknown file status');
    const failedTests = (result.assertionResults ?? []).filter(t => t.status === 'failed').map(t => t.fullName || t.title);
    if (failedTests.some(name => typeof name !== 'string')) throw new Error('missing failed test name');
    const failed = result.status === 'failed' || collectionError || failedTests.length > 0;
    return { file, failed, passed: result.status === 'passed' && !failed, failedTests };
  });
}

export function planRetry(text, policy, root) {
  if (!policy.enabled) throw new Error('unit retries disabled; inspect the original failure');
  const files = parseReport(text, root).filter(file => file.failed);
  if (!files.length) throw new Error('no failed files; inspect coverage/process failure');
  if (files.length > policy.maxFiles) throw new Error(`failed-file cap ${policy.maxFiles} exceeded (${files.length}); inspect the original failures and rerun manually`);
  return files;
}

export function retryVerdict(first, rerunText, { shard, sha, runId, root, exitCode }) {
  let results = [];
  try { results = parseReport(rerunText, root); } catch { /* incomplete evidence records failures */ }
  const files = first.map(({ file, failedTests }) => ({ file, firstRun: 'failed',
    rerun: results.find(r => r.file === file)?.passed ? 'passed' : 'failed', failedTests }));
  return { passed: exitCode === 0 && files.every(f => f.rerun === 'passed'),
    record: { shard, sha, runId, files } };
}

/** IO boundary, injectable so orchestration and fail-closed reads can be exercised hermetically. */
export async function rerunOnce({ shard, skipArgs = [], env = process.env, root = process.cwd(),
  policy, read = file => readFileSync(file, 'utf8'), write = (file, data) => writeFileSync(file, data),
  remove = file => rmSync(file, { force: true }), run = args => spawnSync('npm', args, { cwd: root, env, stdio: 'inherit' }),
  listFiles, warn = console.log, error = console.error } = {}) {
  try {
    if (!/^\d+$/.test(String(shard))) throw new Error('invalid shard');
    const first = planRetry(read(`coverage/timing-unit-${shard}.json`), policy, root);
    // Vitest positional filters are substrings: refuse ambiguous filters rather than run extra files.
    const all = await listFiles();
    if (first.some(f => !all.includes(f.file) || all.some(other => other !== f.file && other.includes(f.file)))) throw new Error('ambiguous/unknown retry filter; inspect files and rerun manually');
    const output = `coverage/rerun-unit-${shard}.json`;
    remove(output); // A crashed retry must never reuse an earlier passing report.
    const result = run(['run', 'test:unit', '--', '--reporter=default', '--reporter=./scripts/ci/unit-json-reporter.mjs', `--outputFile.json=${output}`, ...first.map(f => f.file), ...skipArgs]);
    let text;
    try { text = read(output); } catch { /* record all files as failed */ }
    const verdict = retryVerdict(first, text, { shard, sha: env.GITHUB_SHA ?? '', runId: env.GITHUB_RUN_ID ?? '', root, exitCode: result.status });
    write(`coverage/flaky-unit-${shard}.json`, `${JSON.stringify(verdict.record, null, 2)}\n`);
    for (const file of verdict.record.files.filter(f => f.rerun === 'passed')) warn(`::warning::flaky test file ${file.file.replaceAll('%', '%25')}`);
    return verdict.passed ? 0 : 1;
  } catch (e) {
    error(`unit retry refused: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ')}; shard remains failed, inspect original run`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const shard = args[0]?.match(/^--shard=(\d+)$/)?.[1];
  const { listUnitTestFiles } = await import('./shard-assign.mjs');
  mkdirSync('coverage', { recursive: true });
  const policy = resolvePolicy({ tool: readSettings().ciUnitRerun, env: process.env });
  process.exitCode = await rerunOnce({ shard, policy, skipArgs: args.includes('--') ? args.slice(args.indexOf('--') + 1) : [], listFiles: listUnitTestFiles });
}
