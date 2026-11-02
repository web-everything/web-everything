/**
 * @file Injected prototype admission transaction.
 * WHY (incident 2026-10-22): preserve main, reject incomplete evidence, and retain mutable
 * registrations even after adoption: a containment snapshot cannot authorize deleting a moving ref.
 * R310 (incident 2026-11-01): two daemons froze for hours on a superseded registration and old tops.
 * `--replace=<old>` swaps an old top for a new one that contains all its commits, in one loader command, and
 * every run first retires registrations proved merged, in main, or superseded (prototype-retire.mjs).
 * Real deps bind only in defaultDeps.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import nodeFs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';
import { cloneKey } from '../lib/daemon-overlays.mjs';
import { clearPendingAdoption, recordPendingAdoption, OVERLAY_ADOPTION_MAX_PENDING, OVERLAY_ADOPTION_TTL_MS } from '../lib/overlay-adoption.mjs';
import { isGraphSourceFile, isVitestTestFile } from '../lib/related-test-selection.mjs';
import { safeRef, safeRegistrationRef, validSha, jsonLines, readyEvidence, changedPaths, comparePaths, nextMergeRef, refusal } from './prototype-load.mjs';
import { planRetirements } from './prototype-retire.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Per-test, hook and teardown bounds mitigate a shell-backed runner outliving its wrapper.
const VITEST_BOUNDS = Object.freeze({ testTimeout: 30000, hookTimeout: 60000, teardownTimeout: 10000 });
const ABSOLUTE_POSIX_PATH = /(?<![\w.<>])\/[^\s"'()<>]+/g;
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
const CHILD_PROCESS_NOTE = 'child processes may outlive the timeout; heavy-admission owns them';
// prototypeLoad.combinedTest settings, resolved and recorded through the usual cascade.
// Defaults: ten minutes for admission, twenty minutes before SIGTERM, 16 MiB child output.
const WAIT_ADOPTION_CAP_MS = 160000;
const COMBINED_TEST_DEFAULTS = Object.freeze({ waitMs: 600000, timeoutMs: 1200000, maxBuffer: 16 * 1024 * 1024 });

/** Keep runner diagnostics safe for both terminal output and persisted evidence. */
function sanitizeCombinedOutput(value, env, worktree, preserveLines = false) {
  let message = String(value).replace(ANSI_SEQUENCE, '').replace(/[\p{Cc}\p{Cf}]/gu, (char) => preserveLines && /[\t\n]/.test(char) ? char : '');
  const roots = [[worktree, '<worktree>'], [repo, '<repo>'], [env.HOME, '<home>'], [homedir(), '<home>'],
    [env.TMPDIR, '<tmp>'], [tmpdir(), '<tmp>'], ['/private/tmp', '<tmp>'], ['/tmp', '<tmp>']]
    .filter(([root]) => typeof root === 'string' && root.length > 1)
    .map(([root, placeholder]) => [root.replace(/\/+$/, ''), placeholder])
    .sort(([a], [b]) => b.length - a.length);
  for (const [root, placeholder] of roots) message = message.replaceAll(root, placeholder);
  return message.replace(ABSOLUTE_POSIX_PATH, '<path>');
}

// Candidate and stale-ref tests are untrusted code; git retains its authentication env.
function combinedTestEnv(env) {
  const credentials = /^(?:SSH_AUTH_SOCK|GIT_ASKPASS|GIT_SSH_COMMAND|GH_TOKEN|GITHUB_TOKEN)$|_(?:TOKEN|SECRET|KEY)$/i;
  return Object.fromEntries(Object.entries(env).filter(([key]) => !credentials.test(key)));
}

/** Real combined-tree proof, rebound by the loader to its resolved settings and injected IO. */
async function defaultCombinedTest({ clone, candidateSha, refs }, { exec, fs, env, settings, queuedExec = exec === execFileSync ? spawnToCompletion : exec }) {
  const limits = settings.combinedTest;
  for (const key of Object.keys(COMBINED_TEST_DEFAULTS)) {
    if (!Number.isSafeInteger(limits?.[key]) || limits[key] <= 0) throw new Error(`invalid combinedTest.${key}; configure a positive bounded value and retry`);
  }
  const run = (command, args, cwd = repo, timeout = 120000) => String(exec(command, args, {
    cwd, env, encoding: 'utf8', timeout, maxBuffer: limits.maxBuffer, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
  }) || '');
  const git = (...args) => run('git', args).trim();
  const head = git('-C', clone, 'rev-parse', 'HEAD');
  if (!validSha(head) || !validSha(candidateSha)) throw new Error('invalid combined-tree parent');
  git('fetch', clone, head);
  if (!Array.isArray(refs) || !refs.length || !refs.every(safeRegistrationRef)) throw new Error('invalid combined-tree refs');
  const containedIn = (tip, parent) => {
    try { git('merge-base', '--is-ancestor', tip, parent); return true; }
    catch (e) { if (e.status === 1) return false; throw e; }
  };
  // Only waive refs whose fetched tips are included in the immutable proof parents.
  // Fetch into this lane, never into the daemon clone; do not trust a cached origin ref.
  for (const ref of new Set(refs)) {
    git('fetch', 'origin', `refs/heads/${ref}`);
    const tip = git('rev-parse', '--verify', 'FETCH_HEAD^{commit}');
    if (!validSha(tip)) throw new Error(`invalid combined-tree ref tip: ${ref}`);
    if (!containedIn(tip, head) && !containedIn(tip, candidateSha)) return {
      ok: false, reason: 'combined-ref-not-contained', testCount: 0,
      result: `Registered ref ${ref} is absent from the combined-tree parents. Include its current tip in a tested replacement or wait for daemon adoption, then retry.`,
    };
  }
  let tree;
  try { tree = git('merge-tree', '--write-tree', head, candidateSha).split(/\r?\n/)[0]; }
  catch (e) { if (e.status === 1) return { ok: false, reason: 'combined-merge-conflict' }; throw e; }
  if (!validSha(tree)) throw new Error('invalid combined tree');
  const commit = git('commit-tree', tree, '-p', head, '-p', candidateSha, '-m', 'Prototype combined-tree test');
  if (!validSha(commit)) throw new Error('invalid combined-tree commit');
  const worktree = fs.mkdtempSync(join(env.TMPDIR || tmpdir(), 'prototype-combined-'));
  let outcome;
  try {
    git('worktree', 'add', '--detach', worktree, commit);
    if (fs.existsSync(join(repo, 'node_modules'))) fs.symlinkSync(join(repo, 'node_modules'), join(worktree, 'node_modules'), 'dir');
    const files = run('git', ['ls-files', '-z'], worktree).split('\0').filter(Boolean);
    // This module loads its own settings: keep it out of injected-only loader construction.
    const { MAX_RELATED_TARGETS } = await import('../lib/verify-lane-gate.mjs');
    // Imports cannot prove which tests depend on filesystem reads, computed paths or
    // subprocesses. Waiving an admission blocker requires the whole tracked test inventory.
    const tests = [...new Set(files.filter(isVitestTestFile))].sort();
    if (tests.length > MAX_RELATED_TARGETS) return outcome = {
      ok: false, reason: 'related-tests-truncated', testCount: 0,
      result: `Incomplete evidence: the complete tracked test inventory has ${tests.length} files, above the ${MAX_RELATED_TARGETS}-file bound. Rebase and retest the overlapping refs or include their tips in a tested replacement before retrying.`,
    };
    if (!tests.length) return outcome = { ok: false, reason: 'no-related-tests', testCount: 0 };
    // Retain fail-closed handling for unreadable tracked sources.
    for (const file of files.filter(isGraphSourceFile)) {
      try { fs.readFileSync(join(worktree, file), 'utf8'); }
      catch { throw new Error('combined-tree sources incomplete; inspect unreadable tracked sources and retry'); }
    }
    const reportPath = join(worktree, '.prototype-vitest-results.json');
    // Admission is shell-backed: terminating its direct wrapper may leave descendants alive.
    // Keep the admission-wait ceiling and bound the direct wrapper separately.
    const args = [join(repo, 'scripts/readiness/heavy-admission.mjs'), 'run', `--wait-ms=${limits.waitMs}`,
      `--ceiling-ms=${limits.timeoutMs}`, '--', 'npx', 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`,
      ...Object.entries(VITEST_BOUNDS).map(([key, value]) => `--${key}=${value}`), ...tests];
    const command = ['node', 'scripts/readiness/heavy-admission.mjs', ...args.slice(1)].map((arg) => JSON.stringify(arg.replaceAll(worktree, '<worktree>'))).join(' ');
    try {
      // A checked-in report (including a symlink) is not evidence from this run.
      // Refuse cleanup errors before launching; a zero exit must leave a fresh report.
      fs.rmSync(reportPath, { force: true });
      await queuedExec('node', args, { cwd: worktree, env: combinedTestEnv(env), encoding: 'utf8', timeout: limits.timeoutMs,
        maxBuffer: limits.maxBuffer, shell: false, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGTERM' });
      let report;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
      catch { return outcome = { ok: false, reason: 'tests-unproven', command, testCount: tests.length,
        result: 'Unproven passed/skipped counts; JSON report missing, unreadable or unparseable' }; }
      const countsValid = ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTests']
        .every((key) => Number.isSafeInteger(report?.[key]) && report[key] >= 0);
      const assertions = { passed: 0, failed: 0, skipped: 0, todo: 0 };
      const selected = new Set(tests);
      const filesProven = Array.isArray(report?.testResults) && report.testResults.length === tests.length
        && report.testResults.every((file) => {
          if (typeof file?.name !== 'string') return false;
          const path = relative(worktree, resolve(worktree, file.name));
          if (!selected.delete(path) || file.status !== 'passed' || !Array.isArray(file.assertionResults)
            || !file.assertionResults.length) return false;
          for (const assertion of file.assertionResults) {
            if (Object.hasOwn(assertions, assertion?.status)) assertions[assertion.status]++;
          }
          return file.assertionResults.every((assertion) => ['passed', 'skipped', 'todo'].includes(assertion?.status))
            && file.assertionResults.some((assertion) => assertion.status === 'passed');
        }) && selected.size === 0;
      // Vitest can count todos as pending and serialize them as skipped assertions.
      // Do not add overlapping aggregate counters or infer a missing todo count.
      const skippedAssertions = assertions.skipped + assertions.todo;
      const countsMatch = countsValid && report.numPassedTests === assertions.passed
        && report.numFailedTests === assertions.failed
        && (report.numPendingTests === assertions.skipped || report.numPendingTests === skippedAssertions)
        && (assertions.todo > 0 ? report.numTodoTests === assertions.todo : report.numTodoTests <= assertions.skipped)
        && report.numTotalTests === Object.values(assertions).reduce((sum, count) => sum + count, 0);
      const proven = report?.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0
        && assertions.passed > 0 && filesProven && countsMatch;
      const summary = countsValid ? `${report.numPassedTests} passed, ${skippedAssertions} skipped`
        : 'Unproven passed/skipped counts';
      return outcome = { ok: proven, command, result: `${summary}${proven ? '' : '; JSON evidence incomplete or counts mismatch'}`,
        testCount: tests.length, ...(proven ? {} : { reason: 'tests-unproven' }) };
    } catch (e) {
      const output = sanitizeCombinedOutput(`${e.stdout || ''}${e.stderr || ''}`, env, worktree, true);
      return outcome = { ok: false, command, result: `exit ${Number.isInteger(e.status) ? e.status : 'unknown'}: ${output.slice(-400)}`, testCount: tests.length, reason: 'tests-failed' };
    }
  } finally {
    try { git('worktree', 'remove', '--force', worktree); }
    finally {
      fs.rmSync(worktree, { recursive: true, force: true });
      if (fs.existsSync(worktree)) throw new Error('combined-test worktree cleanup unproven; remove the temporary worktree and retry');
      if (outcome && !outcome.ok) outcome.result = `${outcome.result || outcome.reason}; temp worktree removed; ${CHILD_PROCESS_NOTE}`;
    }
  }
}

/** Real retirement proof: refresh each registered ref's tracking ref, then decide with git and GitHub evidence. */
function defaultRetirePlanner({ rows, git, gh }) {
  const fetched = rows.filter((row) => git(['fetch', 'origin', `+refs/heads/${row.ref}:refs/remotes/origin/${row.ref}`]).code === 0);
  const unfetched = rows.filter((row) => !fetched.includes(row)).map((row) => ({ ref: row.ref, action: 'keep', reason: 'fetch-failed' }));
  if (!fetched.length) return unfetched;
  const repoName = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  return [...planRetirements({ rows: fetched, git, gh, repo: repoName.code === 0 ? repoName.stdout.trim() : '' }), ...unfetched];
}

/** The sole real IO binding; constructing an injected loader performs no ambient reads. */
export function defaultDeps() {
  return { exec: execFileSync, fs: nodeFs, now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    env: { ...process.env, HOME: homedir() }, settings: undefined, cloneKey, combinedTest: defaultCombinedTest,
    retirePlanner: defaultRetirePlanner };
}
export function createPrototypeLoader({ exec, fs, now, sleep, env, settings, combinedTest, cloneKey: keyForClone = cloneKey,
  retirePlanner = defaultRetirePlanner }) {
  const expand = (p) => p.startsWith('~/') ? join(env.HOME, p.slice(2)) : p;
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };
  const tool = settings || JSON.parse(read(join(repo, 'scripts/settings/prototype-load.json')));
  const platform = readPlatformPreferences({ env, readFile: (p, encoding) => fs.readFileSync(p, encoding) });
  const policy = resolveCascade({ standard: { combinedTest: COMBINED_TEST_DEFAULTS }, platform: platform.prefs.prototypeLoad, tool });
  const config = policy.value;
  // Explicit allowlist: no operator bypasses, credentials, git config injection or NODE_OPTIONS.
  const childEnv = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SSH_AUTH_SOCK', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'XDG_CONFIG_HOME'].filter((key) => typeof env[key] === 'string').map((key) => [key, env[key]]));
  // Preserve a stricter caller policy without forwarding overrides that could weaken file policy.
  if (env.WE_OVERLAY_NO_PR?.trim() === 'refuse') childEnv.WE_OVERLAY_NO_PR = 'refuse';
  // A state location is safe configuration, unlike credential or admission-bypass variables.
  if (env.WE_DAEMON_OVERLAY_DIR) childEnv.WE_DAEMON_OVERLAY_DIR = expand(env.WE_DAEMON_OVERLAY_DIR);
  const runCombinedTest = combinedTest && combinedTest !== defaultCombinedTest ? combinedTest
    : (input) => defaultCombinedTest(input, { exec, fs, env: childEnv, settings: config });
  const execute = (command, args) => {
    try { return { code: 0, stdout: String(exec(command, args, { cwd: repo, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) || '') }; }
    catch (e) { return { code: Number.isInteger(e.status) ? e.status : -1, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), error: String(e.stderr || e.message || e) }; }
  };
  const git = (...args) => execute('git', args);
  const requireGit = (...args) => { const r = git(...args); if (r.code !== 0) throw new Error(r.error || `git ${args[0]} failed (${r.code})`); return r.stdout.trim(); };
  const ancestor = (tip, sha) => { const r = git('merge-base', '--is-ancestor', tip, sha); if (![0, 1].includes(r.code)) throw new Error(r.error || 'ancestry unverifiable'); return r.code === 0; };
  const landedByContent = (ref, candidateSha) => {
    const cherry = git('cherry', 'origin/main', `origin/${ref}`);
    if (cherry.code !== 0 || !cherry.stdout.trimEnd().split(/\r?\n/).every((line) => line.startsWith('-'))) return false;
    // Patch IDs ignore whitespace even inside string literals. Require exact tree
    // entries for every stale-changed path in both targets; a merge result can be
    // influenced by merge drivers. Conservative mismatches use normal stale checks.
    const changed = git('diff', '--name-only', '--no-renames', '--ignore-submodules=none', '--no-ext-diff', '--no-textconv',
      '-z', `origin/main...origin/${ref}`);
    if (changed.code !== 0 || !changed.stdout.endsWith('\0')) return false;
    const paths = changed.stdout.slice(0, -1).split('\0');
    // UTF-8 decoding can replace invalid filename bytes; that pathspec could match
    // nothing and falsely prove equality. Retain normal checking for lossy names.
    if (paths.some((path) => !path || path.includes('\uFFFD'))) return false;
    return ['origin/main', candidateSha].every((target) => {
      const difference = git('--literal-pathspecs', 'diff', '--quiet', '--no-ext-diff', '--no-textconv',
        '--no-renames', '--ignore-submodules=none', target, `origin/${ref}`, '--', ...paths);
      return difference.code === 0 && difference.stdout === '';
    });
  };
  const loader = (action, clone, ref, extra = []) => execute('node', [resolve(repo, config.loaderCli), action, `--clone=${clone}`, ...(ref ? [`--ref=${ref}`] : []), ...extra, ...(action === 'remove' ? [] : ['--json'])]);
  const lastJson = (r) => { try { return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)); } catch { return null; } };
  // A replace check proves containment and checks the new ref against the list without the replaced one.
  const replaceCheck = (clone, ref, expectedSha, old) => {
    const result = loader('replace', clone, ref, ['--check', `--replaces=${old}`, `--expected-sha=${expectedSha}`]);
    const data = lastJson(result);
    if (result.code === 0 && data?.wouldReplace === true && data.check?.ok === true && data.check.clean === true
      && data.check.candSha === expectedSha && data.containment?.contained === true) {
      return { files: [], conflicting: [], ...data.check, exit: 0, wouldRegister: true, containment: data.containment };
    }
    if (data?.refused === 'conflict' && data.check?.ok === true && data.check.clean === false) {
      return { files: [], conflicting: [], ...data.check, exit: result.code, containment: data.containment };
    }
    return { ok: false, ...result, reason: data?.refused || 'incomplete loader check', containment: data?.containment ?? null };
  };
  const check = (clone, ref, expectedSha) => {
    const result = loader('add', clone, ref, ['--check', ...(expectedSha ? [`--expected-sha=${expectedSha}`] : [])]);
    const data = lastJson(result);
    const noPrWarning = result.code === 1 && /\bWARNING\b[^\r\n]*\bNO PR\b/.test(result.stderr || '');
    if (result.code < 0 || data?.check?.ok !== true || typeof data.check.clean !== 'boolean'
      // A clean check carries no `files`/`conflicting` (the loader only adds them on a conflict); default them.
      || (data.check.files !== undefined && (!Array.isArray(data.check.files) || !data.check.files.every((file) => typeof file === 'string')))
      || (data.check.conflicting !== undefined && !Array.isArray(data.check.conflicting))
      || (!data.check.clean && (!Array.isArray(data.check.files) || !Array.isArray(data.check.conflicting)))
      || (expectedSha && data.check.candSha !== expectedSha)
      // Only the known no-PR warning exit may accompany a clean check.
      || (data.check.clean ? result.code !== 0 && !noPrWarning : result.code !== 3)) return { ok: false, ...result, reason: data?.check?.reason || 'incomplete loader check' };
    return { files: [], conflicting: [], ...data.check, exit: result.code, wouldRegister: data.wouldRegister };
  };
  return async function load(input) {
    const out = { ok: false, daemon: input.daemon, clone: null, cloneSource: null, registered: false, adopted: false,
      stopReason: null, branch: input.branch, sha: input.sha, effectiveRef: input.branch, effectiveSha: input.sha,
      dryRun: !!input.dryRun, stale: [], staleTolerated: [], removed: [], removedTips: {}, why: input.why || '',
      retired: [], retireRefused: [], ...(input.replace ? { replace: input.replace } : {}),
      settings: { sources: policy.sources, values: policy.value, log: formatCascadeSourcesLine('prototypeLoad', policy), errors: platform.errors } };
    let stage = 'bad-input';
    let pendingAdoption = null;
    const stop = (reason, details = {}) => { Object.assign(out, details, { stopReason: reason }); return out; };
    // Once the replacement is registered, failures name the retained contained registrations.
    const keptNote = () => {
      if (!out.registered) return '';
      const kept = (out.contained || []).filter((ref) => !out.removed.includes(ref));
      return kept.length ? ` Prior registrations retained: ${kept.join(', ')}.` : '';
    };
    const listRows = () => {
      const listing = loader('list', out.clone);
      const rows = lastJson(listing)?.list;
      if (listing.code !== 0 || !Array.isArray(rows) || rows.some((r) => !safeRegistrationRef(r?.ref))) return { ok: false, listing };
      return { ok: true, rows };
    };
    let stateBase = null;
    const cloneState = () => (stateBase ??= join(expand(env.WE_DAEMON_OVERLAY_DIR || join(env.HOME, '.claude/daemon-overlays')), keyForClone(out.clone)));
    // R310: retire registrations proved merged, in main, or superseded. Never one with work not on main.
    // An interrupted retire/replace leaves a drop intent; settle it BEFORE listing (restored entries must be listed).
    const settleIntents = () => {
      if (input.dryRun || !read(`${cloneState()}.json.drop-pending`)) return true;
      const settled = loader('recover-drops', out.clone);
      out.dropRecovery = lastJson(settled) ?? { code: settled.code, error: settled.error };
      return settled.code === 0 && Array.isArray(out.dropRecovery?.pending) && out.dropRecovery.pending.length === 0;
    };
    const retireStep = (rows, exclude) => {
      const candidates = rows.filter((row) => !exclude.includes(row.ref));
      if (!candidates.length) { out.retirePlan = []; return []; }
      const plan = retirePlanner({ rows: candidates, git: (args) => git(...args), gh: (args) => execute('gh', args) });
      if (!Array.isArray(plan)) throw new Error('retirement plan unreadable');
      out.retirePlan = plan;
      // Only a decision for a listed candidate with a full tip can retire anything.
      const proved = plan.filter((d) => d?.action === 'retire' && candidates.some((row) => row.ref === d.ref) && validSha(d.tip));
      if (input.dryRun) { out.wouldRetire = proved.map(({ ref, reason, tip, pr }) => ({ ref, reason, tip, pr })); return proved.map((d) => d.ref); }
      for (const d of proved) {
        // The CLI re-proves retirement itself and refuses unless the entry is still the one planned here.
        const row = candidates.find((candidate) => candidate.ref === d.ref);
        const result = loader('retire', out.clone, d.ref, [`--expected-tip=${d.tip}`, `--expected-entry=${JSON.stringify(row)}`,
          `--reason=${d.reason}`, '--by=prototype-load']);
        const data = lastJson(result);
        if (result.code === 0 && data?.retired === true) out.retired.push({ ref: d.ref, reason: d.reason, tip: d.tip, pr: d.pr ?? null });
        else out.retireRefused.push({ ref: d.ref, refused: data?.refused || result.error || `exit ${result.code}` });
      }
      return out.retired.map((r) => r.ref);
    };
    try {
      const daemon = Object.hasOwn(config.daemons || {}, input.daemon) ? config.daemons[input.daemon] : null;
      if (!daemon) return stop('unknown-daemon');
      if (daemon.clone) {
        out.clone = resolve(expand(config.workspaceRoot), expand(daemon.clone));
        out.cloneSource = `settings:prototype-load.json#daemons.${input.daemon}.clone`;
      } else {
        const plist = execute('plutil', ['-convert', 'json', '-o', '-', join(expand(config.launchAgentsDir), `${daemon.label}.plist`)]);
        if (plist.code !== 0) return stop('bad-input', { resolution: plist });
        const wd = JSON.parse(plist.stdout).WorkingDirectory;
        if (typeof wd !== 'string' || !wd.startsWith('/')) return stop('bad-input', { resolution: 'missing absolute WorkingDirectory' });
        out.clone = wd; out.cloneSource = `plist:${daemon.label}`;
      }
      if (input.retire) {
        // Retire-only: no candidate, only the registrations proved retired are dropped.
        stage = 'check-unverifiable';
        out.branch = null; out.sha = null; out.effectiveRef = null; out.effectiveSha = null;
        requireGit('fetch', 'origin', 'main');
        if (!settleIntents()) return stop('drop-recovery-failed', { fallback: 'Drop intents are unsettled; run daemon-overlay.mjs recover-drops and inspect them.' });
        const listed = listRows();
        if (!listed.ok) return stop('check-unverifiable', { listing: listed.listing });
        retireStep(listed.rows, []);
        if (out.retireRefused.length) return stop('retire-refused');
        out.ok = true; return out;
      }
      if (input.replace !== undefined && input.replace !== '' && (!safeRegistrationRef(input.replace) || input.replace === input.branch)) return stop('bad-input', { detail: 'invalid --replace ref' });
      if (!safeRef(input.branch)) return stop('bad-input', { detail: 'bad-branch', fallback: 'Pass --branch=lane/<name>: a branch under lane/ with only letters, digits, dot, dash, underscore and slash.' });
      if (!validSha(input.sha)) return stop('bad-input', { detail: 'bad-sha', fallback: 'Use the full 40-character sha (git rev-parse origin/<branch>), not a short sha.' });
      if (!Number.isFinite(config.adoption?.timeoutMs) || config.adoption.timeoutMs < 0
        || !Number.isFinite(config.adoption.pollMs) || config.adoption.pollMs <= 0) return stop('bad-input', { detail: 'bad-adoption-settings', fallback: 'Fix adoption.timeoutMs and adoption.pollMs in scripts/settings/prototype-load.json.' });
      if (input.waitAdoptionMs !== undefined && input.waitAdoptionMs !== '' && (!Number.isFinite(Number(input.waitAdoptionMs)) || Number(input.waitAdoptionMs) < 0)) return stop('bad-input', { detail: 'bad-wait-adoption-ms', fallback: 'Pass --wait-adoption-ms as a number of milliseconds (0 returns right after registration; the cap is 160000).' });
      stage = 'no-ready';
      out.gate = readyEvidence(jsonLines(read(expand(config.readyRecordPath))), input);
      if (!out.gate) return stop('no-ready', { detail: 'no-fix-ready-record', fallback: `No fix-ready record in ${config.readyRecordPath} matches ref=${input.branch} sha=${input.sha}. A record needs the fields {"ref":"${input.branch}","sha":"${input.sha}","tests":"green","audit":"NOT WEAKENED"}; write it after the scoped tests pass and the Codex audit says NOT WEAKENED, or pass --tests-run and --audit="NOT WEAKENED".` });
      requireGit('fetch', 'origin', input.branch);
      const tip = requireGit('rev-parse', `origin/${input.branch}`);
      if (tip !== input.sha) return stop('no-ready', { gate: { ...out.gate, reason: 'sha-not-branch-tip', tip }, fallback: `${input.sha} is not the tip of ${input.branch}: the branch tip is ${tip}. Load the tip (re-run tests and audit if the code changed) or push the branch back to the tested sha.` });
      stage = 'check-unverifiable';
      requireGit('fetch', 'origin', 'main', input.branch);
      const own = changedPaths(requireGit('diff', '--name-status', '-z', `origin/main...${input.sha}`));
      const contains = ancestor('origin/main', input.sha);
      out.mainCheck = { contains, own };
      let comparison = input.sha;
      if (!contains) {
        const merge = git('merge-tree', '--write-tree', 'origin/main', input.sha);
        if (merge.code === 1) {
          const files = merge.stdout.split(/\r?\n/).flatMap((line) => /^\d{6} [a-f0-9]+ [123]\t(.+)$/.exec(line)?.slice(1) || []);
          return stop('behind-main-conflict', { mainCheck: { ...out.mainCheck, files: [...new Set(files)], evidence: merge.stdout, message: 'Resolve with Codex, retest touched files, write fresh readiness evidence, rerun.' } });
        }
        if (merge.code !== 0) throw new Error(merge.error || 'merge-tree unverifiable');
        const tree = merge.stdout.split(/\r?\n/)[0];
        if (!validSha(tree)) throw new Error('invalid merge tree');
        comparison = tree;
        const ref = nextMergeRef(input.branch, requireGit('ls-remote', 'origin', `${input.branch}-m*`));
        out.wouldMerge = { ref, tree };
        // Prove the resulting tree before publishing it; a refused main guard never pushes.
      }
      const effectivePaths = changedPaths(requireGit('diff', '--name-status', '-z', 'origin/main', comparison));
      const difference = comparePaths(own, effectivePaths);
      out.mainCheck = { ...out.mainCheck, effectivePaths, ...difference };
      if (difference.outside.length || difference.missing.length) return stop('reverts-main', { offendingPaths: difference.outside, missingPaths: difference.missing });
      if (out.wouldMerge && !input.dryRun) {
        const commit = requireGit('commit-tree', comparison, '-p', 'origin/main', '-p', input.sha, '-m', `Merge origin/main into ${input.branch}`);
        if (!validSha(commit)) throw new Error('invalid merge commit');
        requireGit('push', 'origin', `${commit}:refs/heads/${out.wouldMerge.ref}`);
        out.effectiveRef = out.wouldMerge.ref; out.effectiveSha = commit;
      }
      if (!input.replace) out.check = check(out.clone, out.effectiveRef, out.effectiveSha);
      if (!settleIntents()) return stop('drop-recovery-failed', { fallback: 'Drop intents are unsettled; run daemon-overlay.mjs recover-drops and inspect them.' });
      const listed = listRows();
      if (!listed.ok) return stop('check-unverifiable', { listing: listed.listing });
      const retiredRefs = retireStep(listed.rows, [out.effectiveRef, input.replace].filter(Boolean));
      if (out.retireRefused.length) return stop('retire-refused', { fallback: 'A proved retirement was refused by the loader (tip moved or entry changed); rerun to re-prove it.' });
      const rows = listed.rows.filter((r) => !retiredRefs.includes(r.ref));
      if (input.replace) {
        if (!rows.some((r) => r.ref === input.replace)) return stop('bad-input', { detail: `replaced ref ${input.replace} is not registered` });
        requireGit('fetch', 'origin', `+refs/heads/${input.replace}:refs/remotes/origin/${input.replace}`);
        if (!ancestor(`origin/${input.replace}`, out.effectiveSha)) {
          return stop('replace-not-contained', { fallback: `${input.replace} has commits that ${out.effectiveRef} lacks. Include its current tip in a tested replacement and retry.` });
        }
        out.check = replaceCheck(out.clone, out.effectiveRef, out.effectiveSha, input.replace);
        if (out.check.ok === false && out.check.reason === 'not-contained') return stop('replace-not-contained');
      }
      const established = [...new Set(rows.map((r) => r.ref))].filter((ref) => ref !== input.replace);
      const contained = [], blocking = [];
      const overlapping = [], combinedChanged = new Set(effectivePaths);
      const blockingReasons = Object.create(null);
      out.staleChecks = {};
      for (const ref of established.filter((ref) => ref !== out.effectiveRef)) {
        if (git('fetch', 'origin', ref).code !== 0) {
          if (git('ls-remote', '--exit-code', 'origin', `refs/heads/${ref}`).code === 2) {
            // Registrations do not pin an authoritative tip. A cached tracking ref may
            // predate deleted work, so even cached containment cannot authorize adoption.
            return stop('check-unverifiable', {
              detail: `could not fetch registered ref ${ref}`,
              fallback: `Remote ref ${ref} was deleted, and its authoritative registered tip is unavailable. Retain the registration; recover and verify its latest work before retrying.`,
            });
          }
          return stop('check-unverifiable', { detail: `could not fetch registered ref ${ref}` });
        }
        const included = ancestor(`origin/${ref}`, out.effectiveSha);
        const landed = landedByContent(ref, out.effectiveSha);
        if (included) {
          contained.push(ref);
          out.staleChecks[ref] = { skipped: 'contained', included, landed };
          continue;
        }
        if (landed) {
          // Exact content containment does not imply tip ancestry in the replacement.
          // Leave these registrations for normal rebuild cleanup, outside the swap path.
          out.staleChecks[ref] = { skipped: 'landed', included, landed };
          out.staleTolerated.push({ ref, landedByContent: true, why: 'exact content already in main and candidate' });
          continue;
        }
        const evidence = check(out.clone, ref);
        out.staleChecks[ref] = evidence;
        if (!evidence.ok) return stop('check-unverifiable');
        if (!evidence.clean) {
          out.stale.push(ref);
          if (!included) {
            let staleChanged = [];
            try {
              const raw = requireGit('diff', '--name-status', '-z', `origin/main...origin/${ref}`);
              // Unterminated NUL output is partial evidence: leave staleChanged empty so the ref stays blocking.
              if (raw.endsWith('\0')) staleChanged = changedPaths(raw);
            } catch { /* Unreadable changed-file evidence keeps this registration blocking. */ }
            const staleFiles = new Set([...staleChanged, ...(Array.isArray(evidence.files) ? evidence.files : [])]);
            const overlap = effectivePaths.filter((file) => staleFiles.has(file));
            const reason = !staleChanged.length ? 'stale-files-unknown'
              : out.check.ok !== true || out.check.clean !== true ? 'candidate-not-clean'
              : overlap.length ? `overlap-with-candidate: ${overlap.join(', ')}` : null;
            if (reason) {
              blocking.push(ref); blockingReasons[ref] = reason;
              if (reason.startsWith('overlap-with-candidate:')) {
                overlapping.push(ref);
                for (const file of staleFiles) combinedChanged.add(file);
              }
            }
            else {
              const landed = landedByContent(ref, out.effectiveSha);
              out.staleTolerated.push({ ref, landedByContent: landed,
                why: 'pre-existing stale registration; candidate clean and file-disjoint'
                  + (landed ? ', exact content already in main and candidate' : '') });
            }
          }
        }
      }
      out.contained = contained;
      if (overlapping.length && blocking.every((ref) => overlapping.includes(ref))) {
        let passed = false;
        let failure;
        try {
          const evidence = await runCombinedTest({ clone: out.clone, candidateSha: out.effectiveSha,
            changedFiles: [...combinedChanged].sort(), refs: overlapping });
          if (!evidence || typeof evidence.ok !== 'boolean') throw new Error('incomplete combined-test evidence');
          const { ok, reason, ...summary } = evidence;
          out.combinedTests = summary;
          passed = ok === true;
          failure = `combined-tests-failed: ${reason || 'tests-failed'}`;
        } catch (e) {
          const message = sanitizeCombinedOutput(e.message || e, env).slice(0, 300);
          out.combinedTests = { result: message };
          failure = `combined-tests-unrunnable: ${message}`;
        }
        for (const ref of overlapping) {
          if (!passed) { blockingReasons[ref] += `; ${failure}`; continue; }
          blocking.splice(blocking.indexOf(ref), 1);
          delete blockingReasons[ref];
          out.staleTolerated.push({ ref, landedByContent: landedByContent(ref, out.effectiveSha), why: 'pre-existing stale registration; combined-tree tests passed', combinedTests: out.combinedTests });
        }
        out.staleTolerated.sort((a, b) => established.indexOf(a.ref) - established.indexOf(b.ref));
      }
      if (blocking.length) return stop('stale-registration', {
        message: blocking.map((ref) => `stale-registration: ${ref} (${blockingReasons[ref]})`).join('; '), blocking, blockingReasons,
        fallback: 'Retain the registrations; rebase and retest the overlapping refs, or resolve the combined-test evidence failure and retry.',
      });
      if (!out.check.ok) return stop('check-unverifiable');
      if (!out.check.clean) return stop('check-conflict');
      out.swap = { contained };
      if (rows.some((row) => row.ref === out.effectiveRef)) out.registered = 'already';
      if (input.dryRun) {
        out.wouldRegister = out.registered !== 'already'; out.wouldRemove = []; out.wouldRetain = contained;
        if (input.replace) out.wouldReplace = input.replace;
        if (contained.length) out.wouldStopReason = 'swap-remove-failed';
        out.ok = true; return out;
      }
      stage = 'register-failed';
      const registeredAt = now();
      stage = 'no-ready';
      requireGit('fetch', 'origin', out.effectiveRef);
      const movedTip = requireGit('rev-parse', `origin/${out.effectiveRef}`);
      if (movedTip !== out.effectiveSha) return stop('no-ready', { detail: 'sha-moved', tip: movedTip });
      stage = 'register-failed';
      if (input.replace) {
        const result = loader('replace', out.clone, out.effectiveRef, [`--replaces=${input.replace}`, `--expected-sha=${out.effectiveSha}`,
          `--reason=${input.why || `prototype-load: ${input.daemon} ${out.effectiveRef} replaces ${input.replace}`}`, `--by=${env.USER || 'unknown'}`]);
        out.registration = result;
        const data = lastJson(result);
        if (data?.registered === true) out.registered = true;
        if (result.code !== 0 || data?.replaced !== true) {
          return stop(out.registered ? 'replace-incomplete' : 'register-failed', { detail: data?.refused || 'replace failed',
            fallback: `The old registration ${input.replace} was kept. Fix the refusal and rerun.` });
        }
        const evidence = data.conflictCheck;
        if (evidence?.ok !== true || evidence.clean !== true || evidence.candSha !== out.effectiveSha) {
          return stop('register-failed', { detail: 'admitted-sha-unverified', fallback: 'Inspect the candidate registration and loader evidence before retrying.' });
        }
        out.replaced = input.replace;
      } else if (out.registered !== 'already') {
        const result = loader('add', out.clone, out.effectiveRef, [`--expected-sha=${out.effectiveSha}`, `--reason=${input.why || `prototype-load: ${input.daemon} ${out.effectiveRef}`}`, `--by=${env.USER || 'unknown'}`]);
        out.registration = result;
        if (result.code !== 0) return stop('register-failed');
        out.registered = true;
        const evidence = lastJson(result)?.conflictCheck;
        if (evidence?.ok !== true || evidence.clean !== true || evidence.candSha !== out.effectiveSha) {
          return stop('register-failed', { detail: 'admitted-sha-unverified', fallback: 'Inspect the candidate registration and loader evidence before retrying; prior registrations were retained.' });
        }
      }
      const finishSwap = (refs) => {
        for (const ref of refs) {
          // The preview predates the real add (which can fetch newer, cleanly merging tips).
          // Refresh for diagnostic evidence only. Even this immutable SHA cannot prove that
          // the mutable registration still names the same work when a later removal executes.
          out.swap = { contained, removed: out.removed, failed: ref };
          requireGit('fetch', 'origin', `+refs/heads/${ref}:refs/remotes/origin/${ref}`);
          const currentTip = requireGit('rev-parse', '--verify', `refs/remotes/origin/${ref}^{commit}`);
          if (!validSha(currentTip)) throw new Error(`invalid current tip for ${ref}`);
          if (!ancestor(currentTip, out.effectiveSha)) {
            return stop('swap-remove-failed', { detail: 'replacement-not-contained', swap: { ...out.swap, tip: currentTip },
              fallback: `Retain the remaining registrations; include their current tips in a new tested replacement and retry.${keptNote()}` });
          }
        }
        out.swap = { contained, removed: out.removed };
        // The loader deletes by name, while branch writers do not hold the registry lock.
        // Neither another fetch nor a registration-identity check can close that race. Until
        // replacement can atomically retire immutable registrations, retain every entry and
        // report an incomplete swap rather than claim that an old SHA was safely removed.
        if (refs.length) return stop('swap-remove-failed', {
          detail: 'mutable-registration', swap: { ...out.swap, retained: refs },
          fallback: `The replacement was adopted, but automatic cleanup cannot safely retire mutable registrations. Keep them registered until their changes land on main and normal rebuild cleanup retires them.${keptNote()}`,
        });
        return null;
      };
      // A stale preview is not proof that the replacement can pass live smoke. Keep every prior
      // registration until adoption; a blocked rebuild times out with recovery guidance below.
      stage = 'check-unverifiable';
      const state = cloneState();
      // The caller may wait for adoption only briefly: a subagent's Bash call is moved to the background after
      // about 180 s. By default return right after registration; the rebuild path emits overlay-adopted later.
      const waitMs = Math.min(WAIT_ADOPTION_CAP_MS, Math.max(0, Number(input.waitAdoptionMs) || 0), config.adoption.timeoutMs);
      const deadline = registeredAt + waitMs;
      pendingAdoption = { ref: out.effectiveRef, sha: out.effectiveSha, at: new Date(registeredAt).toISOString(), loadedBy: env.USER || null, nonce: randomUUID() };
      out.adoptionEventTracked = recordPendingAdoption(out.clone, pendingAdoption, { env: childEnv, fs });
      // Rebuilds currently emit to the self-sync state directory. Also read the requested overlay
      // sibling trail, so both the loader events and rebuild refusals are observed.
      const rebuildAlerts = join(env.WE_DAEMON_STATE_DIR || join(env.HOME, '.claude/daemon-self-sync-state'), `${basename(state)}.alerts.jsonl`);
      for (;;) {
        const alerts = refusal(jsonLines(read(`${state}.alerts.jsonl`)), out.effectiveRef, registeredAt, true)
          || refusal(jsonLines(read(rebuildAlerts)), out.effectiveRef, registeredAt, true)
          || refusal(jsonLines(read(`${state}.events.jsonl`)), out.effectiveRef, registeredAt);
        if (alerts) return stop('adoption-refused', { adoption: { refusal: alerts }, fallback: `Fix the refused replacement and rerun.${keptNote()}` });
        let probe = git('-C', out.clone, 'merge-base', '--is-ancestor', out.effectiveSha, 'HEAD');
        let missing = false;
        if (probe.code === 128) {
          // A newly admitted commit need not exist in the daemon clone until its next fetch.
          // Quiet verification distinguishes that pending object from execution/repository errors.
          const candidate = git('-C', out.clone, 'rev-parse', '--verify', '--quiet', `${out.effectiveSha}^{commit}`);
          if ([0, 1].includes(candidate.code) && git('-C', out.clone, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}').code === 0) {
            missing = candidate.code === 1;
            // Fetch may have completed between the ancestry failure and diagnostic verification.
            if (!missing) probe = git('-C', out.clone, 'merge-base', '--is-ancestor', out.effectiveSha, 'HEAD');
          }
        }
        out.adoption = { code: probe.code, at: new Date(now()).toISOString(), ...(missing ? { pending: 'candidate-object-missing' } : {}) };
        if (probe.code === 0) { out.adopted = true; break; }
        if (probe.code !== 1 && !missing) return stop('check-unverifiable', { adoption: probe, fallback: `Inspect the daemon clone adoption probe and rerun.${keptNote()}` });
        const remaining = deadline - now();
        if (remaining <= 0) {
          let reason = 'rebuild-state-unreadable';
          let detail = 'Daemon rebuild state is unreadable; inspect the rebuild state and daemon before retrying.';
          try {
            const rebuild = JSON.parse(read(join(env.WE_DAEMON_STATE_DIR || join(env.HOME, '.claude/daemon-self-sync-state'), `${basename(state)}.rebuild.json`)));
            if (!rebuild || typeof rebuild !== 'object' || Array.isArray(rebuild)) throw new Error('invalid rebuild state');
            if (rebuild.building) {
              if (typeof rebuild.building.target !== 'string' || typeof rebuild.building.startedAt !== 'string') throw new Error('incomplete build state');
              reason = 'rebuild-building';
              detail = `Daemon is building ${rebuild.building.target.slice(0, 7)} (started ${rebuild.building.startedAt}); check the build and rerun after it finishes.`;
            } else {
              reason = 'daemon-not-refreshing';
              detail = `Daemon is not refreshing (last adoption: ${rebuild.adopted?.at || 'unknown'}); check daemon catch-up and rerun.`;
            }
          } catch { /* Unreadable evidence retains the timeout and every registration. */ }
          out.adoption.reason = reason;
          // Registered and waiting for the next rebuild is not a failure: it succeeded, adoption is pending.
          Object.assign(out, { ok: true, result: 'registered-pending', adopted: false,
            message: `Registered ${out.effectiveRef}@${out.effectiveSha.slice(0, 7)} on ${input.daemon}; not adopted yet. ${detail} The rebuild emits an overlay-adopted daemon event when it lands (overlay-adoption-overdue if it takes over 15 minutes). Event tracking lasts up to ${OVERLAY_ADOPTION_TTL_MS / 86400000} days and retains the newest ${OVERLAY_ADOPTION_MAX_PENDING} registrations per clone; if tracking expires or is displaced, check the daemon rebuild state. Do not wait or poll for it.${out.adoptionEventTracked ? '' : ' Warning: the pending-adoption record could not be written, so no overlay-adopted event will follow; check the daemon rebuild state instead.'}`,
            fallback: `${detail}${keptNote()}` });
          return out;
        }
        await sleep(Math.min(config.adoption.pollMs, remaining));
      }
      stage = 'swap-remove-failed';
      const unswapped = finishSwap(contained);
      if (unswapped) return unswapped;
      out.ok = true;
      return out;
    } catch (e) { return stop(stage, { error: String(e.message || e), fallback: `Inspect the failed step evidence and rerun after resolving it.${keptNote()}` }); }
    finally {
      const record = { at: new Date(now()).toISOString(), ...out };
      try { const file = expand(config.recordPath); fs.mkdirSync(dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8'); }
      catch (e) { out.ok = false; out.stopReason ||= 'check-unverifiable'; out.recordError = String(e.message || e); }
      // Pending is the only outcome that delegates its adoption notice to the rebuild path. Do not leave
      // refused/unverifiable loads or a load already adopted during its wait to emit misleading notices.
      if (out.adoptionEventTracked && (out.result !== 'registered-pending' || !out.ok)) {
        clearPendingAdoption(out.clone, pendingAdoption, { env: childEnv, fs });
      }
    }
  };
}
