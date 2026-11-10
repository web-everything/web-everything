#!/usr/bin/env node
/**
 * @file scripts/conveyor/guard-1c-mutation-check.mjs
 * @description #4331 — targeted MUTATION GATE for `planBackstopCompletion`'s Guard 1(c) (#4306). Proves the
 *   named `Guard 1(c) isolated` tests in `session-reaper.test.mjs` actually go RED when (c) — or its
 *   pass-level wiring in `runSessionReaperPass` — is disabled, so a future edit cannot quietly delete either
 *   without a test noticing. Two mutants of `session-reaper.mjs`: the comparison (`recStartedMs >
 *   lastActivityMs` → `false`) and the wiring (`resolveLastActivityMs(session)` → `null`). Each search string
 *   must occur EXACTLY once or the gate refuses (a rename can never turn it into a silent no-op).
 *
 *   The original file is never swapped: the mutant is a uniquely named sibling (relative imports keep
 *   working), and a generated vitest config aliases the test's `../session-reaper.mjs` import to it. Judgment
 *   is on vitest's `--reporter=json` output, never the exit code: the unmutated run needs >= 3 named tests
 *   PASSED, and under a mutant the expected named tests must be `failed` WITH an assertion message — a suite
 *   that failed to load or collected nothing is refused, not counted as "killed".
 *
 *   `run()` takes an injectable `runVitest` so its own test needs no nested vitest.
 * Usage: node scripts/conveyor/guard-1c-mutation-check.mjs   (exit 0 = both mutants killed)
 */
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { admittedArgv } from '../readiness/heavy-admission.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const REAPER_PATH = join(HERE, 'session-reaper.mjs');
const TEST_FILE = 'scripts/conveyor/__tests__/session-reaper.test.mjs';

export const NAMED_PREFIX = 'Guard 1(c) isolated';
export const MIN_UNMUTATED_PASSES = 3;

/** @typedef {{name:string, find:string, replace:string, mustKill:(title:string)=>boolean}} Mutation */
/** @type {Mutation[]} */
export const DEFAULT_MUTATIONS = [
  { name: 'comparison', find: 'recStartedMs > lastActivityMs', replace: 'false', mustKill: () => true },
  { name: 'wiring', find: 'resolveLastActivityMs(session)', replace: 'null', mustKill: (t) => t.includes('pass-level') },
];

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** The named tests in a vitest JSON report, or `null` when the report shows the suite never loaded. */
function namedTests(report) {
  const files = Array.isArray(report?.testResults) ? report.testResults : [];
  const tests = [];
  for (const f of files) {
    for (const a of f?.assertionResults ?? []) {
      const title = a.fullName ?? a.title ?? '';
      if (title.includes(NAMED_PREFIX)) tests.push({ title, status: a.status, failed: (a.failureMessages ?? []).length > 0 });
    }
  }
  return tests;
}

/**
 * @param {{ readSource:()=>string, runVitest:(mutantSource:string|null)=>object, mutations?:Mutation[], log?:(s:string)=>void }} io
 * @returns {{ok:boolean, problems:string[]}}
 */
export function run({ readSource, runVitest, mutations = DEFAULT_MUTATIONS, log = () => {} }) {
  const problems = [];
  const source = readSource();

  for (const m of mutations) {
    const n = count(source, m.find);
    if (n !== 1) problems.push(`mutation "${m.name}": search string must occur exactly once in the source, found ${n} — refusing (a rename would make this gate a no-op)`);
  }
  if (problems.length) return { ok: false, problems };

  const baseline = namedTests(runVitest(null));
  const passed = baseline.filter((t) => t.status === 'passed').length;
  if (passed < MIN_UNMUTATED_PASSES || baseline.some((t) => t.status !== 'passed')) {
    problems.push(`unmutated run: need >= ${MIN_UNMUTATED_PASSES} "${NAMED_PREFIX}" tests and all PASSED, got ${passed} passed of ${baseline.length}`);
    return { ok: false, problems };
  }
  log(`unmutated: ${passed} named tests passed`);

  for (const m of mutations) {
    const tests = namedTests(runVitest(source.replace(m.find, () => m.replace)));
    if (tests.length === 0) {
      problems.push(`mutant "${m.name}": no "${NAMED_PREFIX}" tests ran (suite failed to load?) — not counted as killed`);
      continue;
    }
    const expected = tests.filter((t) => m.mustKill(t.title));
    if (expected.length === 0) {
      problems.push(`mutant "${m.name}": no expected tests were collected to kill it`);
      continue;
    }
    const survivors = expected.filter((t) => !(t.status === 'failed' && t.failed));
    if (survivors.length) {
      problems.push(`mutant "${m.name}" SURVIVED: ${survivors.map((t) => `${t.title} [${t.status}]`).join('; ')}`);
    } else {
      log(`mutant "${m.name}": KILLED by ${expected.length} named test(s)`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Real vitest spawn: writes the mutant sibling + an aliasing config, runs the named tests, always cleans up. */
function makeRealRunVitest() {
  return (mutantSource) => {
    const tag = `${process.pid}-${Date.now()}`;
    const mutantPath = join(HERE, `session-reaper.guard1c-mutant-${tag}.mjs`);
    const configPath = join(REPO_ROOT, `vitest.guard1c-${tag}.config.mts`);
    const outDir = mkdtempSync(join(tmpdir(), 'guard1c-mutation-'));
    const outFile = join(outDir, 'report.json');
    try {
      let cfg = `import { mergeConfig } from 'vitest/config';\nimport base from './vitest.config.ts';\nexport default base;\n`;
      if (mutantSource !== null) {
        writeFileSync(mutantPath, mutantSource);
        cfg = `import { mergeConfig } from 'vitest/config';\nimport base from './vitest.config.ts';\n`
          + `export default mergeConfig(base, { resolve: { alias: [{ find: /^\\.\\.\\/session-reaper\\.mjs$/, replacement: ${JSON.stringify(mutantPath)} }] } });\n`;
      }
      writeFileSync(configPath, cfg);
      // `-t` takes a regex, so the prefix's parentheses are escaped.
      const admitted = admittedArgv(join(REPO_ROOT, 'node_modules/.bin/vitest'), [
        'run', TEST_FILE, '-t', NAMED_PREFIX.replace(/[()]/g, '\\$&'), '--config', configPath, '--reporter=json', `--outputFile=${outFile}`,
      ]);
      spawnSync(admitted.file, admitted.args, { cwd: REPO_ROOT, stdio: 'ignore' });
      try { return JSON.parse(readFileSync(outFile, 'utf8')); } catch { return {}; }
    } finally {
      rmSync(mutantPath, { force: true });
      rmSync(configPath, { force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { ok, problems } = run({
    readSource: () => readFileSync(REAPER_PATH, 'utf8'),
    runVitest: makeRealRunVitest(),
    log: (s) => console.log(s),
  });
  for (const p of problems) console.error(`FAIL: ${p}`);
  console.log(ok ? 'guard-1c-mutation-check: OK — both mutants killed' : 'guard-1c-mutation-check: FAILED');
  process.exit(ok ? 0 : 1);
}
