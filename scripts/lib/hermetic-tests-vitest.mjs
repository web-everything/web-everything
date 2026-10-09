/**
 * @file hermetic-tests-vitest.mjs — applies we:scripts/lib/hermetic-tests.mjs to one vitest test file (card xcu4cqf).
 * Called from `vitest.setup.ts` (every config), so the unit, integration and soak suites share one mechanism.
 *
 * Per test: `beforeEach` names the test in env (so a child `gh`/`git` shim can attribute itself); `afterEach`
 * gathers every live access the test made — in-process (fs/fetch guard) and in child processes (the shims' TSV
 * log) — and FAILS the test with `live GitHub/backlog access in test`, even if the code under test swallowed the
 * error. Accesses that arrive after their test ended (a detached child) fail the file in `afterAll`.
 */
import fs, { existsSync, readFileSync, realpathSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  DEBT_ENV, HERMETIC_MODE_ENV, LIVE_ACCESS_MESSAGE, hermeticDebtFiles, LIVE_GITHUB_ENV_KEYS, REAL_REPOS_ENV, REPORT_FILE_ENV, TEST_ID_ENV, TEST_NAME_ENV,
  VIOLATIONS_DIR_ENV, VIOLATIONS_FILE, buildGuardContext, hermeticMessage, hermeticMode, installHermeticGuards,
  fakeHomeEnv, loadHermeticSettings, parseViolationLog,
} from './hermetic-tests.mjs';

const HOME_KEY = Symbol.for('we.hermetic.homedir');

/** The REAL home, even after {@link installFakeHomedir} replaced `os.homedir`. */
export function realHomedir() {
  return (os[HOME_KEY] || os.homedir)();
}

/**
 * Make `os.homedir()` follow `process.env.HOME`. Needed because vitest's default `threads` pool gives each worker a
 * virtualized `process.env`, and the native `os.homedir()` never reads it — the reason an earlier fake-HOME attempt
 * (see the note in vitest.setup.ts) silently kept returning the real home. `syncBuiltinESMExports()` makes the
 * replacement reach `import { homedir } from 'node:os'` named imports too. Installed once per worker.
 */
export function installFakeHomedir() {
  if (os[HOME_KEY]) return;
  const orig = os.homedir;
  Object.defineProperty(os, HOME_KEY, { value: orig, enumerable: false });
  os.homedir = function homedir() { return process.env.HOME || orig.call(os); };
  syncBuiltinESMExports();
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };
const expandHome = (p, home) => (p && p.startsWith('~/') ? join(home, p.slice(2)) : p);

/**
 * @param {object} o
 * @param {Function} o.beforeEach @param {Function} o.afterEach @param {Function} o.afterAll
 * @param {{getState: Function}} o.expect vitest's `expect` (for the running test's name/path)
 * @param {string} o.repoRoot the checkout under test
 * @param {Record<string,string|undefined>} o.ambient the LAUNCHING env, captured before any sandbox strip
 * @param {string} o.violationsDir per-file dir the shims append to
 */
export function setupHermeticTestFile({ beforeEach, afterEach, afterAll, expect, repoRoot, ambient, violationsDir, fakeHome }) {
  const home = realHomedir();
  const settings = loadHermeticSettings(repoRoot);
  const repo = real(repoRoot);
  const ctx = buildGuardContext({ home, repoRoot: repo, settings, ambient });
  // Mode + report file come from the LAUNCHING env: the sandbox strip removed every WE_* key before this runs.
  const enforce = hermeticMode({ ...ambient, CI: process.env.CI ?? ambient.CI, GITHUB_ACTIONS: process.env.GITHUB_ACTIONS ?? ambient.GITHUB_ACTIONS }) === 'enforce';
  if (enforce) delete process.env[HERMETIC_MODE_ENV];
  else process.env[HERMETIC_MODE_ENV] = 'report'; // the git shim reads it
  const reportFile = ambient[REPORT_FILE_ENV];
  const inProcess = [];
  const state = {
    ctx, enforce, enabled: true, settings,
    onViolation: (v) => inProcess.push({ ...v, testId: process.env[TEST_ID_ENV] || 'outside-a-test' }),
    testName: () => process.env[TEST_NAME_ENV],
  };
  // The guard object is shared per worker (installed once); this file's state is copied into it.
  const guard = installHermeticGuards({ fs, fsPromises, syncBuiltinESMExports, state });

  // A private, empty HOME per test file: every home-derived default (~/.claude/*, ~/workspace/.lanes, …) lands in a
  // throwaway fixture. The guard above still fails anything that reaches the REAL roots by another route.
  if (fakeHome) {
    mkdirSync(fakeHome, { recursive: true });
    Object.assign(process.env, fakeHomeEnv({ realHome: home, fakeHome, settings, env: process.env, exists: existsSync }));
    installFakeHomedir();
  }

  for (const key of LIVE_GITHUB_ENV_KEYS) delete process.env[key];
  const primary = real(expandHome(settings.primaryCheckout, home) || '');
  process.env[REAL_REPOS_ENV] = [...new Set([repo, primary].filter(Boolean))].join(':');
  process.env[VIOLATIONS_DIR_ENV] = violationsDir;
  const logFile = join(violationsDir, VIOLATIONS_FILE);

  let seq = 0;
  let current = null;
  let fileLabel = 'this test file';
  const debtFiles = new Set(hermeticDebtFiles(settings));
  let inDebt = false;
  let consumed = 0;
  const readNewLog = () => {
    if (!existsSync(logFile)) return [];
    const text = readFileSync(logFile, 'utf8');
    const fresh = text.slice(consumed);
    consumed = text.length;
    return parseViolationLog(fresh);
  };
  const late = [];

  const settle = (testLabel, violations) => {
    if (!violations.length) return;
    const lines = violations.map((v) => `  - ${v.kind} ${v.target}`).join('\n');
    if (inDebt) {
      // A declared hermeticDebt file: recorded and printed, never failed (the pre-card behaviour) — see the settings.
      process.stderr.write(`[hermetic-debt] ${testLabel}: ${violations.length} live access(es) (listed in hermeticDebt; fix and remove the entry)\n`);
      return;
    }
    if (!enforce) {
      const file = reportFile;
      if (file) {
        try {
          mkdirSync(dirname(file), { recursive: true });
          appendFileSync(file, violations.map((v) => JSON.stringify({ test: testLabel, kind: v.kind, target: v.target })).join('\n') + '\n');
        } catch { /* diagnostic only */ }
      }
      return;
    }
    throw new Error(`${LIVE_ACCESS_MESSAGE}: ${testLabel} made ${violations.length} live access(es):\n${lines}\n`
      + hermeticMessage({ kind: violations[0].kind, target: violations[0].target, test: testLabel }));
  };

  beforeEach(() => {
    const st = expect.getState();
    seq += 1;
    const file = st.testPath ? relative(repo, real(st.testPath)) : '?';
    fileLabel = file;
    inDebt = debtFiles.has(file);
    guard.enforce = enforce && !inDebt;
    if (inDebt) process.env[DEBT_ENV] = '1'; else delete process.env[DEBT_ENV];
    const name = `${file} > ${st.currentTestName ?? '?'}`;
    current = { id: `${process.pid}-${seq}`, name };
    process.env[TEST_ID_ENV] = current.id;
    process.env[TEST_NAME_ENV] = name;
  });

  afterEach(() => {
    if (!current) return;
    const { id, name } = current;
    current = null;
    const mine = [];
    for (let i = inProcess.length - 1; i >= 0; i -= 1) {
      if (inProcess[i].testId === id) mine.unshift(...inProcess.splice(i, 1));
    }
    for (const v of readNewLog()) {
      if (v.testId === id || v.testId === 'unattributed') mine.push(v);
      else late.push(v);
    }
    settle(name, mine);
  });

  afterAll(() => {
    const leftovers = [...inProcess.splice(0), ...late.splice(0), ...readNewLog()];
    try { rmSync(violationsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    settle(`${fileLabel} > (outside any single test, or a child that outlived its test)`, leftovers);
  });

  return state;
}
