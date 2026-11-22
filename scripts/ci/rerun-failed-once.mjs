/**
 * A single bounded retry distinguishes intermittent unit failures from reproducible breaks without
 * hiding either: every retried file is recorded, and only allowlisted passing retries can recover a shard.
 * The original coverage is retained; retries use the same coverage mode in a separate directory. Missing evidence, process errors,
 * and widespread failures stay red for operator inspection. This is evidence collection, not quarantine.
 * Requires coverage/first-run-<shard>.json with {runId, sha} matching GITHUB_RUN_ID/GITHUB_SHA.
 * Slice 2 writes that sidecar in the workflow and wires the teardown marker writer in vitest.globalSetup.mjs.
 * Usage (only after a nonzero first run): node scripts/ci/rerun-failed-once.mjs --shard=N --mode=covered|nocov --first-exit=<code> -- [quarantine args]
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readSettingsChecked } from '../lib/settings-files.mjs';
import { cascadePolicy, readPlatformPreferences } from '../lib/policy-cascade.mjs';

export function resolvePolicy({ tool, platform, env = {}, log = console.error,
  readSettings = readSettingsChecked, readPreferences = readPlatformPreferences } = {}) {
  const standard = { enabled: false, maxFiles: 10, flakeAllowlist: [] };
  try {
    if (tool === undefined) {
      const settings = readSettings();
      if (settings.taint.length) throw new Error('settings read/shape error');
      tool = settings.value.ciUnitRerun;
    }
    if (platform === undefined) {
      const preferences = readPreferences({ env });
      if (preferences.errors.length) throw new Error('platform preference read error');
      platform = preferences.prefs.ciUnitRerun;
    }
    const enabled = env.WE_CI_UNIT_RERUN_ENABLED;
    const envValues = {
      enabled: enabled === undefined ? undefined : /^(true|1)$/.test(enabled) ? true : /^(false|0)$/.test(enabled) ? false : enabled,
      maxFiles: env.WE_CI_UNIT_RERUN_MAX_FILES === undefined ? undefined : Number(env.WE_CI_UNIT_RERUN_MAX_FILES),
    };
    const valid = { enabled: v => typeof v === 'boolean', maxFiles: v => Number.isSafeInteger(v) && v > 0,
      flakeAllowlist: v => Array.isArray(v) && v.every(file => typeof file === 'string' && file.length > 0
        && !isAbsolute(file) && !/[\\\x00-\x1f\x7f]/.test(file) && !file.startsWith('-')
        && file.split('/').every(part => part && part !== '.' && part !== '..')) };
    for (const [layer, values] of [['platform', platform], ['tool', tool], ['env', envValues]]) {
      if (values === undefined) continue;
      if (values === null || Object.getPrototypeOf(values) !== Object.prototype) throw new Error(`invalid ${layer} policy object`);
      for (const [key, value] of Object.entries(values)) {
        if (!Object.hasOwn(valid, key) || (value !== undefined && !valid[key](value))) throw new Error(`invalid ${key} (${layer})`);
      }
    }
    return cascadePolicy('ciUnitRerun', tool, {
      standard, platform: platform ?? {}, operatorOverride: {}, envValues, valid,
      env: { ...env, WE_POLICY_CASCADE_LOG: '1' }, log,
    }).value;
  } catch (e) {
    log(`ciUnitRerun: ${String(e.message).replace(/[\x00-\x1f\x7f]/g, ' ')}; enabled=false (fail-closed); inspect settings and original run`);
    return standard;
  }
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
  const files = report.testResults.map(result => {
    if (typeof result.name !== 'string' || !result.name) throw new Error('missing test filename');
    const file = relative(root, resolve(root, result.name)).split('\\').join('/');
    if (!file || isAbsolute(file) || file.startsWith('../') || /[\x00-\x1f\x7f]/.test(file) || file.startsWith('-') || seen.has(file)) throw new Error('invalid or duplicate test filename');
    seen.add(file);
    const collectionError = !!result.testExecError || !!result.message || (Array.isArray(result.errors) && result.errors.length > 0);
    if (!['passed', 'failed', 'pending', 'skipped', 'todo'].includes(result.status) && !(result.status === undefined && collectionError)) throw new Error('unknown file status');
    const assertions = result.assertionResults ?? [];
    if (!Array.isArray(assertions)) throw new Error('invalid assertion evidence');
    const assertionNames = new Set();
    const tests = assertions.map(test => {
      const name = test.fullName || (Array.isArray(test.ancestorTitles)
        ? [...test.ancestorTitles, test.title].join(' ') : test.title);
      if (typeof name !== 'string' || !name || (!test.fullName && typeof test.title !== 'string')
        || assertionNames.has(name) || !['passed', 'failed', 'pending', 'skipped', 'todo'].includes(test.status)) {
        throw new Error('invalid or duplicate assertion evidence');
      }
      assertionNames.add(name);
      return { name, status: test.status };
    });
    const failedTests = tests.filter(t => t.status === 'failed').map(t => t.name);
    const failed = result.status === 'failed' || collectionError || failedTests.length > 0;
    return { file, failed, passed: result.status === 'passed' && !failed, failedTests, tests };
  });
  for (const [key, count] of [['numFailedTests', files.reduce((n, f) => n + f.failedTests.length, 0)],
    ['numFailedTestSuites', files.filter(f => f.failed).length]]) {
    if (report[key] !== undefined && report[key] !== count) throw new Error(`incomplete failure evidence: ${key} mismatch`);
  }
  return files;
}

export function planRetry(text, policy, root) {
  if (!policy.enabled) throw new Error('unit retries disabled; inspect the original failure');
  const files = parseReport(text, root).filter(file => file.failed);
  if (!files.length) throw new Error('no failed files; inspect coverage/process failure');
  if (files.length > policy.maxFiles) throw new Error(`failed-file cap ${policy.maxFiles} exceeded (${files.length}); inspect the original failures and rerun manually`);
  return files;
}

export function retryVerdict(first, rerunText, { shard, sha, runId, root, exitCode, flakeAllowlist = [] }) {
  let results = [];
  try { results = parseReport(rerunText, root); } catch { /* incomplete evidence records failures */ }
  const files = first.map(({ file, failedTests, tests }) => {
    const retry = results.find(r => r.file === file);
    // Every assertion that ran in run 1 (failed OR passed) must pass in the retry: a failed one that recovers,
    // and a passing one that must not vanish or turn skipped while the shard goes green.
    const required = tests.filter(t => t.status === 'passed' || t.status === 'failed').map(t => t.name);
    const recovered = retry?.passed
      && required.every(name => retry.tests.some(t => t.name === name && t.status === 'passed'))
      && (failedTests.length > 0 || retry.tests.some(t => t.status === 'passed'));
    return { file, firstRun: 'failed', rerun: recovered ? 'passed' : 'failed', failedTests };
  });
  return { passed: exitCode === 0 && files.every(f => f.rerun === 'passed' && flakeAllowlist.includes(f.file)),
    record: { shard, sha, runId, files } };
}

/** IO boundary, injectable so orchestration and fail-closed reads can be exercised hermetically. */
export async function rerunOnce({ shard, mode, firstExit, teardownFailed = file => existsSync(file), skipArgs = [], env = process.env, root = process.cwd(),
  policy, exists = existsSync, read = file => readFileSync(file, 'utf8'), write = writeFileSync,
  remove = file => rmSync(file, { force: true }), run = args => spawnSync('npm', args, { cwd: root, env, stdio: 'inherit' }),
  listFiles, warn = console.log, error = console.error } = {}) {
  try {
    if (!/^\d+$/.test(String(shard))) throw new Error('invalid shard');
    if (!['covered', 'nocov'].includes(mode)) throw new Error('invalid or missing retry mode');
    // Vitest exits 1 for test failures. Any other first-run exit (a crash, a kill, a coverage or teardown error)
    // is a process failure a file retry cannot clear, even when the report also lists failed files.
    if (String(firstExit) !== '1') throw new Error(`first run exit ${firstExit} is not a plain test failure (1)`);
    // Exit 1 is also what the global teardown's tmp-leak policy sets (vitest.globalSetup.mjs); it leaves this marker.
    if (teardownFailed(`coverage/teardown-failed-unit-${shard}`)) throw new Error('first run failed in global teardown; a file retry cannot clear it');
    const identity = JSON.parse(read(`coverage/first-run-${shard}.json`));
    if (!env.GITHUB_RUN_ID?.trim() || !env.GITHUB_SHA?.trim()
      || identity?.runId !== env.GITHUB_RUN_ID || identity?.sha !== env.GITHUB_SHA) throw new Error('missing/stale first-run identity');
    const first = planRetry(read(`coverage/timing-unit-${shard}.json`), policy, root);
    // Vitest positional filters are substrings: refuse ambiguous filters rather than run extra files.
    const all = await listFiles();
    if (first.some(f => !all.includes(f.file) || all.some(other => other !== f.file && other.includes(f.file)))) throw new Error('ambiguous/unknown retry filter; inspect files and rerun manually');
    const marker = `coverage/rerun-used-${shard}.json`;
    if (exists(marker)) throw new Error('retry allowance already used');
    write(marker, JSON.stringify(identity), { flag: 'wx' });
    const output = `coverage/rerun-unit-${shard}.json`;
    remove(output); // A crashed retry must never reuse an earlier passing report.
    const coverageArgs = mode === 'covered' ? ['--coverage.reportOnFailure=true', `--coverage.reportsDirectory=coverage-rerun-${shard}`] : [];
    const result = run(['run', mode === 'covered' ? 'test:coverage:shard' : 'test:unit', '--', ...coverageArgs, '--reporter=default', '--reporter=./scripts/ci/unit-json-reporter.mjs', `--outputFile.json=${output}`, ...first.map(f => f.file), ...skipArgs]);
    let text;
    try { text = read(output); } catch { /* record all files as failed */ }
    const verdict = retryVerdict(first, text, { shard, sha: env.GITHUB_SHA ?? '', runId: env.GITHUB_RUN_ID ?? '', root, exitCode: result.status, flakeAllowlist: policy.flakeAllowlist });
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
  const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  const shard = options.find(arg => arg.startsWith('--shard='))?.slice('--shard='.length);
  const mode = options.find(arg => arg.startsWith('--mode='))?.slice('--mode='.length);
  const firstExit = options.find(arg => arg.startsWith('--first-exit='))?.slice('--first-exit='.length);
  const { listUnitTestFiles } = await import('./shard-assign.mjs');
  mkdirSync('coverage', { recursive: true });
  const policy = resolvePolicy({ env: process.env });
  process.exitCode = await rerunOnce({ shard, mode, firstExit, policy, skipArgs: args.includes('--') ? args.slice(args.indexOf('--') + 1) : [], listFiles: listUnitTestFiles });
}
