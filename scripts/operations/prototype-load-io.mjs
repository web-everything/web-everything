/**
 * @file Injected prototype admission transaction.
 * WHY (incident 2026-10-22): preserve main, reject incomplete evidence, and retain mutable
 * registrations even after adoption: a containment snapshot cannot authorize deleting a moving ref.
 * Real deps bind only in defaultDeps.
 */
import { execFileSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPlatformPreferences, resolveCascade, formatCascadeSourcesLine } from '../lib/policy-cascade.mjs';
import { spawnToCompletion } from '../lib/spawn-to-completion.mjs';
import { cloneKey } from '../lib/daemon-overlays.mjs';
import { buildReverseImportGraph, selectRelatedTests, testDepths, isVitestTestFile } from '../lib/related-test-selection.mjs';
import { safeRef, safeRegistrationRef, validSha, jsonLines, readyEvidence, changedPaths, comparePaths, nextMergeRef, refusal } from './prototype-load.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Per-test, hook and teardown bounds mitigate a shell-backed runner outliving its wrapper.
const VITEST_BOUNDS = Object.freeze({ testTimeout: 30000, hookTimeout: 60000, teardownTimeout: 10000 });
const CHILD_PROCESS_NOTE = 'child processes may outlive the timeout; heavy-admission owns them';
// prototypeLoad.combinedTest settings, resolved and recorded through the usual cascade.
// Defaults: ten minutes for admission, twenty minutes before SIGTERM, 16 MiB child output.
const COMBINED_TEST_DEFAULTS = Object.freeze({ waitMs: 600000, timeoutMs: 1200000, maxBuffer: 16 * 1024 * 1024 });

/** Real combined-tree proof, rebound by the loader to its resolved settings and injected IO. */
async function defaultCombinedTest({ clone, candidateSha, changedFiles, refs }, { exec, fs, env, settings, queuedExec = exec === execFileSync ? spawnToCompletion : exec }) {
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
    // The shared graph skips unreadable sources; refuse incomplete reads here instead.
    const readErrors = [];
    const reverse = buildReverseImportGraph({ files, readFile: (file) => {
      try { return fs.readFileSync(join(worktree, file), 'utf8'); }
      catch (e) { readErrors.push(file); throw e; }
    } });
    if (readErrors.length) throw new Error('combined-tree graph incomplete; inspect unreadable tracked sources and retry');
    // This module loads its own settings: keep it out of injected-only loader construction.
    const { MAX_RELATED_TARGETS } = await import('../lib/verify-lane-gate.mjs');
    const selection = selectRelatedTests({ changedFiles, reverse, maxTests: MAX_RELATED_TARGETS, maxDepth: 2 });
    // A local gate's bounded subset is insufficient to waive an admission blocker.
    if (selection.status === 'selection-truncated') return outcome = {
      ok: false, reason: 'related-tests-truncated', testCount: 0,
      result: `Incomplete evidence: selection omits ${selection.droppedCount} of ${selection.fullTestCount} related tests. Narrow the candidate or rebase and retest the overlapping refs before retrying.`,
    };
    const tests = [...testDepths(changedFiles, reverse).keys()].filter(isVitestTestFile).sort();
    if (!tests.length) return outcome = { ok: false, reason: 'no-related-tests', testCount: 0 };
    const reportPath = join(worktree, '.prototype-vitest-results.json');
    // Admission is shell-backed: terminating its direct wrapper may leave descendants alive.
    // Keep the admission-wait ceiling and bound the direct wrapper separately.
    const args = [join(repo, 'scripts/readiness/heavy-admission.mjs'), 'run', `--wait-ms=${limits.waitMs}`,
      `--ceiling-ms=${limits.timeoutMs}`, '--', 'npx', 'vitest', 'run', '--reporter=json', `--outputFile=${reportPath}`,
      ...Object.entries(VITEST_BOUNDS).map(([key, value]) => `--${key}=${value}`), ...tests];
    const command = ['node', 'scripts/readiness/heavy-admission.mjs', ...args.slice(1)].map((arg) => JSON.stringify(arg.replaceAll(worktree, '<worktree>'))).join(' ');
    try {
      await queuedExec('node', args, { cwd: worktree, env, encoding: 'utf8', timeout: limits.timeoutMs,
        maxBuffer: limits.maxBuffer, shell: false, stdio: ['ignore', 'pipe', 'pipe'], killSignal: 'SIGTERM' });
      let report;
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf8')); }
      catch { return outcome = { ok: false, reason: 'tests-unproven', command, testCount: tests.length,
        result: 'unknown passed, unknown skipped; JSON report missing, unreadable or unparseable' }; }
      const passed = Number.isSafeInteger(report?.numPassedTests) && report.numPassedTests >= 0 ? report.numPassedTests : 'unknown';
      const skipped = Number.isSafeInteger(report?.numPendingTests) && report.numPendingTests >= 0 ? report.numPendingTests : 'unknown';
      const selected = new Set(tests);
      const filesProven = Array.isArray(report?.testResults) && report.testResults.length === tests.length
        && report.testResults.every((file) => {
          if (typeof file?.name !== 'string') return false;
          const path = relative(worktree, resolve(worktree, file.name));
          if (!selected.delete(path) || file.status !== 'passed' || !Array.isArray(file.assertionResults)
            || !file.assertionResults.length) return false;
          return file.assertionResults.every((assertion) => ['passed', 'skipped', 'todo'].includes(assertion?.status))
            && file.assertionResults.some((assertion) => assertion.status === 'passed');
        }) && selected.size === 0;
      const proven = report?.success === true && report.numFailedTests === 0 && report.numFailedTestSuites === 0
        && passed !== 'unknown' && passed > 0 && filesProven;
      return outcome = { ok: proven, command, result: `${passed} passed, ${skipped} skipped${proven ? '' : '; JSON evidence incomplete or counts mismatch'}`,
        testCount: tests.length, ...(proven ? {} : { reason: 'tests-unproven' }) };
    } catch (e) {
      const output = `${e.stdout || ''}${e.stderr || ''}`.replaceAll(worktree, '<worktree>').replaceAll(repo, '<repo>').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
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

/** The sole real IO binding; constructing an injected loader performs no ambient reads. */
export function defaultDeps() {
  return { exec: execFileSync, fs: nodeFs, now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    env: { ...process.env, HOME: homedir() }, settings: undefined, cloneKey, combinedTest: defaultCombinedTest };
}
export function createPrototypeLoader({ exec, fs, now, sleep, env, settings, combinedTest, cloneKey: keyForClone = cloneKey }) {
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
    catch (e) { return { code: Number.isInteger(e.status) ? e.status : -1, stdout: String(e.stdout || ''), error: String(e.stderr || e.message || e) }; }
  };
  const git = (...args) => execute('git', args);
  const requireGit = (...args) => { const r = git(...args); if (r.code !== 0) throw new Error(r.error || `git ${args[0]} failed (${r.code})`); return r.stdout.trim(); };
  const ancestor = (tip, sha) => { const r = git('merge-base', '--is-ancestor', tip, sha); if (![0, 1].includes(r.code)) throw new Error(r.error || 'ancestry unverifiable'); return r.code === 0; };
  const loader = (action, clone, ref, extra = []) => execute('node', [resolve(repo, config.loaderCli), action, `--clone=${clone}`, ...(ref ? [`--ref=${ref}`] : []), ...extra, ...(action === 'remove' ? [] : ['--json'])]);
  const lastJson = (r) => { try { return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)); } catch { return null; } };
  const check = (clone, ref, expectedSha) => {
    const result = loader('add', clone, ref, ['--check', ...(expectedSha ? [`--expected-sha=${expectedSha}`] : [])]);
    const data = lastJson(result);
    if (![0, 3].includes(result.code) || data?.check?.ok !== true || typeof data.check.clean !== 'boolean'
      // A clean check carries no `files`/`conflicting` (the loader only adds them on a conflict); default them.
      || (data.check.files !== undefined && (!Array.isArray(data.check.files) || !data.check.files.every((file) => typeof file === 'string')))
      || (data.check.conflicting !== undefined && !Array.isArray(data.check.conflicting))
      || (!data.check.clean && (!Array.isArray(data.check.files) || !Array.isArray(data.check.conflicting)))
      || (expectedSha && data.check.candSha !== expectedSha)
      || result.code !== (data.check.clean ? 0 : 3)) return { ok: false, ...result, reason: data?.check?.reason || 'incomplete loader check' };
    return { files: [], conflicting: [], ...data.check, exit: result.code, wouldRegister: data.wouldRegister };
  };
  return async function load(input) {
    const out = { ok: false, daemon: input.daemon, clone: null, cloneSource: null, registered: false, adopted: false,
      stopReason: null, branch: input.branch, sha: input.sha, effectiveRef: input.branch, effectiveSha: input.sha,
      dryRun: !!input.dryRun, stale: [], staleTolerated: [], removed: [], removedTips: {}, why: input.why || '',
      settings: { sources: policy.sources, values: policy.value, log: formatCascadeSourcesLine('prototypeLoad', policy), errors: platform.errors } };
    let stage = 'bad-input';
    const stop = (reason, details = {}) => { Object.assign(out, details, { stopReason: reason }); return out; };
    // Once the replacement is registered, failures name the retained registrations and explain
    // how to recover if a stale registration prevents the daemon from adopting the replacement.
    const keptNote = () => {
      if (!out.registered) return '';
      const kept = (out.contained || []).filter((ref) => !out.removed.includes(ref));
      const stale = out.adopted ? [] : kept.filter((ref) => out.stale.includes(ref));
      return (kept.length ? ` Prior registrations retained: ${kept.join(', ')}.` : '')
        + (stale.length ? ` If stale registrations block adoption, rebase and retest them, include their new tips in a tested replacement, and rerun: ${stale.join(', ')}.` : '');
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
      if (!safeRef(input.branch) || !validSha(input.sha) || !Number.isFinite(config.adoption?.timeoutMs) || config.adoption.timeoutMs < 0
        || !Number.isFinite(config.adoption.pollMs) || config.adoption.pollMs <= 0) return stop('bad-input');
      stage = 'no-ready';
      out.gate = readyEvidence(jsonLines(read(expand(config.readyRecordPath))), input);
      if (!out.gate) return stop('no-ready');
      requireGit('fetch', 'origin', input.branch);
      const tip = requireGit('rev-parse', `origin/${input.branch}`);
      if (tip !== input.sha) return stop('no-ready', { gate: { ...out.gate, reason: 'sha-not-branch-tip', tip } });
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
      out.check = check(out.clone, out.effectiveRef, out.effectiveSha);
      const listing = loader('list', out.clone);
      const rows = lastJson(listing)?.list;
      if (listing.code !== 0 || !Array.isArray(rows) || rows.some((r) => !safeRegistrationRef(r?.ref))) return stop('check-unverifiable', { listing });
      const established = [...new Set(rows.map((r) => r.ref))];
      const contained = [], blocking = [];
      const overlapping = [], combinedChanged = new Set(effectivePaths);
      const blockingReasons = Object.create(null);
      out.staleChecks = {};
      for (const ref of established.filter((ref) => ref !== out.effectiveRef)) {
        const evidence = check(out.clone, ref);
        out.staleChecks[ref] = evidence;
        if (!evidence.ok) return stop('check-unverifiable');
        if (git('fetch', 'origin', ref).code !== 0) return stop('check-unverifiable', { detail: `could not fetch registered ref ${ref}` });
        const included = ancestor(`origin/${ref}`, out.effectiveSha);
        if (included) contained.push(ref);
        if (!evidence.clean) {
          out.stale.push(ref);
          if (!included) {
            let staleChanged = [];
            try {
              staleChanged = changedPaths(requireGit('diff', '--name-status', '-z', `origin/main...origin/${ref}`));
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
              const cherry = git('cherry', 'origin/main', `origin/${ref}`);
              const lines = cherry.stdout.trimEnd().split(/\r?\n/);
              const landedByContent = cherry.code === 0 && lines.every((line) => line.startsWith('-'));
              out.staleTolerated.push({ ref, landedByContent,
                why: 'pre-existing stale registration; candidate clean and file-disjoint'
                  + (landedByContent ? ', commits already on main by patch-id' : '') });
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
          let message = String(e.message || e).replace(/[\p{Cc}\p{Cf}]/gu, '');
          const roots = [[repo, '<repo>'], [env.HOME, '<home>'], [homedir(), '<home>'],
            [env.TMPDIR, '<tmp>'], [tmpdir(), '<tmp>'], ['/private/tmp', '<tmp>'], ['/tmp', '<tmp>']]
            .filter(([root]) => typeof root === 'string' && root.length > 1)
            .map(([root, placeholder]) => [root.replace(/\/+$/, ''), placeholder])
            .sort(([a], [b]) => b.length - a.length);
          for (const [root, placeholder] of roots) message = message.replaceAll(root, placeholder);
          message = message.slice(0, 300);
          out.combinedTests = { result: message };
          failure = `combined-tests-unrunnable: ${message}`;
        }
        for (const ref of overlapping) {
          if (!passed) { blockingReasons[ref] += `; ${failure}`; continue; }
          blocking.splice(blocking.indexOf(ref), 1);
          delete blockingReasons[ref];
          const cherry = git('cherry', 'origin/main', `origin/${ref}`);
          const landedByContent = cherry.code === 0 && cherry.stdout.trimEnd().split(/\r?\n/).every((line) => line.startsWith('-'));
          out.staleTolerated.push({ ref, landedByContent, why: 'pre-existing stale registration; combined-tree tests passed', combinedTests: out.combinedTests });
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
      if (out.registered !== 'already') {
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
      const state = join(expand(env.WE_DAEMON_OVERLAY_DIR || join(env.HOME, '.claude/daemon-overlays')), keyForClone(out.clone));
      const deadline = registeredAt + config.adoption.timeoutMs;
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
        if (remaining <= 0) return stop('adoption-timeout', { fallback: `Check the daemon rebuild for the replacement and rerun.${keptNote()}` });
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
    }
  };
}
