#!/usr/bin/env node
/**
 * @file scripts/conveyor/hung-session-mutation-check.mjs
 * @description #4492: bounded mutation proof for parsed-but-undated transcript entries.
 * Original source is read-only; each independent mutant uses a unique sibling and a Vitest alias.
 * Both process completion and a complete named assertion manifest are required as evidence.
 */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admittedArgv } from '../readiness/heavy-admission.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TEST_FILE = 'scripts/conveyor/__tests__/hung-session.test.mjs';
const SOURCE_FILE = 'scripts/conveyor/hung-session.mjs';
export const NAMED_PREFIX = 'Parsed timestamp fallback';
export const CASES = ['omitted', 'null', 'empty', 'invalid', 'stat-error', 'mixed-forward', 'mixed-reverse'];
export const DEFAULT_MUTATIONS = [
  { name: 'epoch-default', find: "Date.parse(entry?.ts ?? '')", replace: "Date.parse(entry?.ts ?? '1970-01-01T00:00:00.000Z')", kills: ['omitted', 'null'] },
  { name: 'zero-mtime', find: 'lastActivityMs = statFn(file).mtimeMs;', replace: 'lastActivityMs = 0;', kills: ['omitted', 'null', 'empty', 'invalid'] },
  { name: 'always-stat', find: 'if (lastActivityMs === null) {', replace: 'if (true) {', kills: ['mixed-forward', 'mixed-reverse'] },
];

/** Validate collection independently of whether the expected mutant assertions failed. */
function assertions(result, root) {
  if (!result || result.error || result.signal || ![0, 1].includes(result.status)) throw new Error('runner error, signal, or unexpected exit status');
  if (result.runtimeErrors !== 0) throw new Error('missing runtime-error receipt or runner errors');
  const report = result.report;
  if (!report || report.numFailedTestSuites !== 0 || report.numPendingTestSuites !== 0
    || (report.numRuntimeErrorTestSuites ?? 0) !== 0 || (report.unhandledErrors?.length ?? 0) !== 0
    || !Array.isArray(report.testResults) || report.testResults.length !== 1) throw new Error('malformed report or suite-load/collection errors');
  const file = report.testResults[0];
  if (typeof file?.name !== 'string' || resolve(root, file.name) !== resolve(root, TEST_FILE)) throw new Error('wrong-file report');
  if (file.message || file.testExecError || !Array.isArray(file.assertionResults)) throw new Error('suite-load error or missing assertions');
  const named = new Map();
  for (const test of file.assertionResults) {
    if (!test || typeof test.fullName !== 'string') throw new Error('malformed assertion');
    // Vitest 1 includes the empty file-suite title as a leading space in fullName.
    const fullName = test.fullName.trim();
    if (!fullName.startsWith(`${NAMED_PREFIX} `)) {
      if (test.status === 'failed') throw new Error('unexpected assertion failure outside manifest');
      continue; // Vitest also reports unrelated cases skipped by -t.
    }
    const suffix = fullName.slice(NAMED_PREFIX.length + 1);
    if (!CASES.includes(suffix) || named.has(suffix)) throw new Error(`unexpected or duplicate name: ${test.fullName}`);
    if (!['passed', 'failed'].includes(test.status)) throw new Error(`skipped or unfinished case: ${suffix}`);
    if (!Array.isArray(test.failureMessages) || (test.status === 'passed' && test.failureMessages.length)) throw new Error('malformed assertion evidence');
    if (test.status === 'failed' && !test.failureMessages.some((message) => typeof message === 'string' && /^(AssertionError\b|expected\b)/i.test(message))) throw new Error(`no assertion evidence: ${suffix}`);
    named.set(suffix, { ...test, fullName });
  }
  for (const name of CASES) if (!named.has(name)) throw new Error(`missing required case: ${NAMED_PREFIX} ${name}`);
  const failures = [...named.values()].filter((test) => test.status === 'failed').length;
  if (result.status !== (failures ? 1 : 0) || report.success !== !failures
    || report.numFailedTests !== failures || file.status !== (failures ? 'failed' : 'passed')) throw new Error('process/report status inconsistent with assertions');
  return named;
}

/** Inject source and runner for deterministic tests without nested Vitest processes. */
export function run({ readSource, runVitest, mutations = DEFAULT_MUTATIONS, root = ROOT, log = () => {} }) {
  const problems = [];
  try {
    const source = readSource();
    for (const mutation of mutations) {
      const count = mutation.find ? source.split(mutation.find).length - 1 : 0;
      if (count !== 1) throw new Error(`${mutation.name}: replacement target must occur exactly once, found ${count}`);
      if (mutation.find === mutation.replace) throw new Error(`${mutation.name}: no-op mutation`);
    }
    const baseline = assertions(runVitest(null), root);
    if ([...baseline.values()].some((test) => test.status !== 'passed')) throw new Error('baseline failed');
    log(`baseline: ${CASES.length} named cases passed`);
    for (const mutation of mutations) {
      try {
        const tests = assertions(runVitest(source.replace(mutation.find, () => mutation.replace)), root);
        for (const name of mutation.kills) {
          if (tests.get(name)?.status !== 'failed') throw new Error(`SURVIVED: ${NAMED_PREFIX} ${name}`);
        }
        log(`${mutation.name}: KILLED`);
        for (const name of mutation.kills) log(`  ${tests.get(name).fullName}: ${tests.get(name).failureMessages.join('; ')}`);
      } catch (error) { problems.push(`${mutation.name}: ${error.message}`); }
    }
  } catch (error) { problems.push(`baseline/setup: ${error.message}`); }
  return { ok: problems.length === 0, problems };
}

/** IO shell: admit every subprocess, inherit its environment, and always remove temporary artifacts. */
export function makeRealRunVitest({ root = ROOT, filesystem = fs, spawn = spawnSync, tempRoot = tmpdir(), unique = randomUUID } = {}) {
  return (source) => {
    const tag = unique();
    const mutant = join(root, 'scripts/conveyor', `hung-session.mutant-${tag}.mjs`);
    const config = join(root, `vitest.hung-session-${tag}.config.mts`);
    const directory = filesystem.mkdtempSync(join(tempRoot, 'hung-session-mutation-'));
    const reportPath = join(directory, 'report.json');
    const receipt = join(directory, 'runtime.json');
    const reporter = join(directory, 'runtime-reporter.mjs');
    try {
      if (source !== null) filesystem.writeFileSync(mutant, source);
      const alias = source === null ? '' : `resolve: { alias: [{ find: /^\\.\\.\\/hung-session\\.mjs$/, replacement: ${JSON.stringify(mutant)} }] },`;
      filesystem.writeFileSync(config, `import { mergeConfig } from 'vitest/config';\nimport base from './vitest.config.ts';\nexport default mergeConfig(base, { ${alias} });\n`);
      // Vitest's JSON reporter omits unhandled errors; a separate receipt closes that evidence gap.
      filesystem.writeFileSync(reporter, `import { writeFileSync } from 'node:fs';\nexport default class { onFinished(files, errors) { writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ runtimeErrors: errors.length })); } }\n`);
      const command = admittedArgv(join(root, 'node_modules/.bin/vitest'), [
        'run', TEST_FILE, '-t', NAMED_PREFIX, '--config', config,
        '--reporter=json', `--reporter=${reporter}`, `--outputFile=${reportPath}`,
      ]);
      const child = spawn(command.file, command.args, { cwd: root, stdio: 'pipe', encoding: 'utf8' });
      return { status: child.status, signal: child.signal, error: child.error,
        report: JSON.parse(filesystem.readFileSync(reportPath, 'utf8')),
        runtimeErrors: JSON.parse(filesystem.readFileSync(receipt, 'utf8')).runtimeErrors };
    } finally {
      // Attempt every cleanup even if one removal fails.
      try { filesystem.rmSync(mutant, { force: true }); }
      finally {
        try { filesystem.rmSync(config, { force: true }); }
        finally { filesystem.rmSync(directory, { recursive: true, force: true }); }
      }
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = run({ readSource: () => fs.readFileSync(join(ROOT, SOURCE_FILE), 'utf8'), runVitest: makeRealRunVitest(), log: console.log });
  for (const problem of result.problems) console.error(`FAIL: ${problem}`);
  console.log(`hung-session-mutation-check: ${result.ok ? 'OK — three mutants killed' : 'FAILED'}`);
  process.exitCode = result.ok ? 0 : 1;
}
