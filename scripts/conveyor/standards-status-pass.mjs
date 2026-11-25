#!/usr/bin/env node
/**
 * @file scripts/conveyor/standards-status-pass.mjs
 * @description The Studio verifier for plateau-app's Standards gate (VERIFIER-STANDARDS-STATUS). plateau-app CI cannot
 *   run the Standards validator, so each verify tick this pass runs the real harness on every open PR head and posts
 *   the commit status `standards/validate` on that exact sha, AS THE WE APP (never a personal login).
 *
 *   Per open PR: skip when GitHub already holds a trusted terminal status for this sha and validator hash (stateless
 *   dedupe, no local marker); post `pending`; fetch the head into a WE-owned bare mirror and check the fetched sha;
 *   run the harness FROM plateau-app origin/main (never the head's copy: a head could print a fake success) against
 *   the head's protocol files with the Studio's own validator; re-read the PR head; post `success` or `failure` LAST.
 *   A crash leaves `pending`, which never passes. No App token means nothing is posted (the probe runs first).
 *   Auth comes from the daemons' existing path: `redTeamWriterEnv` pins the legacy App role and refuses a personal
 *   fallback; the daemon's tick wrapper (withGithubAppAuth) keeps that token fresh.
 * Usage: node scripts/conveyor/standards-status-pass.mjs [--dry-run]
 */
import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { redTeamWriterEnv, requireRedTeamAppWriter } from '../lib/red-team-check-run.mjs';
import { STANDARDS_CONTEXT, STANDARDS_PAGE_CAP, evaluateStandardsStatus, harnessVerdict, validatorVerdict, statusPayload, validHead } from '../lib/standards-status.mjs';

const SETTINGS_PATH = new URL('../settings/standards-status.json', import.meta.url);
const ioOptions = { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
const DROPPED_CHILD_ENV = ['CI', 'GITHUB_ACTIONS', 'PLATEAU_PROTOCOLS_HERMETIC', 'GH_TOKEN', 'GITHUB_TOKEN'];
const HARNESS = 'protocols/tools/validate-protocols.mjs';
const DRIVER = join(dirname(fileURLToPath(import.meta.url)), 'standards-harness-driver.mjs');

/** Settings: `standardsStatus` {enabled, repos, validatorPath, runTimeoutMs}. Unreadable means disabled. */
export function loadStandardsStatusSettings(path = SETTINGS_PATH) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))?.standardsStatus ?? {};
    const home = homedir();
    return { enabled: value.enabled === true, repos: Array.isArray(value.repos) ? value.repos : [],
      validatorPath: String(value.validatorPath ?? '').replace(/^~(?=\/)/, home), runTimeoutMs: Number(value.runTimeoutMs) || 120_000 };
  } catch { return { enabled: false, repos: [], validatorPath: '', runTimeoutMs: 120_000 }; }
}

const hardenedGitEnv = env => {
  const out = { ...env };
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key];
  return { ...out, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' };
};
const childEnv = env => { const out = { ...env }; for (const key of DROPPED_CHILD_ENV) delete out[key]; return out; };
const gitBase = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never'];
const defaultGit = (args, { env, cwd } = {}) => execFileSync('git', args, { ...ioOptions, env, cwd });

/** Run a child in its own process group; kill the whole group on timeout. Never throws. */
export function defaultSpawn({ cmd, args, cwd, env, timeoutMs, fdInput }) {
  return new Promise(resolve => {
    let stdout = ''; let timedOut = false; let settled = false; let truncated = false;
    // fd 3 carries the per-run nonce (never env or argv); the child reads and closes it before any PR code runs.
    const child = spawnChild(cmd, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(fdInput === undefined ? [] : ['pipe'])] });
    if (fdInput !== undefined) { child.stdio[3].on('error', () => {}); child.stdio[3].end(String(fdInput)); }
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', chunk => { if (stdout.length < 4_000_000) stdout += chunk; else truncated = true; });
    child.stderr.on('data', () => {});
    child.on('error', error => finish({ status: null, error, stdout, truncated }));
    child.on('close', (status, signal) => finish({ status, signal, timedOut, stdout, truncated }));
  });
}

/** Hash of every file under the validator's drafts folder (the tools folder's parent: rules, schemas, vectors, config),
 * skipping node_modules. It THROWS when a file cannot be read, so an unreadable input never becomes a reusable value. */
const defaultValidatorHash = validatorPath => {
  const root = dirname(dirname(validatorPath));
  const hash = createHash('sha256');
  let files = 0;
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && ++files <= 5000) hash.update(full.slice(root.length)).update(readFileSync(full));
    }
  };
  walk(root);
  return hash.digest('hex').slice(0, 8);
};

/** macOS sandbox for the harness child: the harness imports `rules.mjs` from the PR head, so head code runs. No
 * network, no file writes outside the scratch dirs and /dev/null, no reads of the operator's secret folders. */
export function sandboxProfile({ writable = [], home = homedir() } = {}) {
  const quote = value => `"${String(value).replace(/["\\]/g, '')}"`;
  return ['(version 1)', '(allow default)', '(deny network*)', '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))', ...writable.map(dir => `(allow file-write* (subpath ${quote(dir)}))`),
    `(deny file-read* ${['.secrets', '.ssh', '.config/gh', '.aws', '.gnupg', '.claude'].map(p => `(subpath ${quote(join(home, p))})`).join(' ')})`].join('\n');
}

function readStatuses({ repo, head, gh, env }) {
  const page = (kind, n) => `repos/${repo}/commits/${head}/${kind}?per_page=100${n > 1 ? `&page=${n}` : ''}`;
  const combined = JSON.parse(gh(['api', page('status', 1)], { ...ioOptions, env }));
  const history = []; let complete = false;
  for (let n = 1; n <= STANDARDS_PAGE_CAP; n++) {
    const batch = JSON.parse(gh(['api', page('statuses', n)], { ...ioOptions, env }));
    if (!Array.isArray(batch)) throw Error('statuses unreadable');
    history.push(...batch);
    if (batch.length < 100) { complete = true; break; }
  }
  return { combined, history, complete };
}

/**
 * One pass over the configured repos. Everything effectful is injected (see the tests); defaults are the real thing.
 * @returns {Promise<{refused?:string, dryRun?:boolean, wouldPost?:object[], posted:object[], skipped:object[], errors:object[]}>}
 */
export async function runStandardsStatusPass({
  repos = [], dryRun = false, env = process.env, gh = runGhSync, git = defaultGit, spawn = defaultSpawn,
  validatorPath = '', validatorHash, appWriterProbe, sandbox = process.platform === 'darwin', allowUnsandboxed = false, nonce = () => randomBytes(16).toString('hex'), exists = existsSync, runId = () => randomBytes(4).toString('hex'),
  makeDir = label => mkdtempSync(join(tmpdir(), `standards-${label}-`)), runTimeoutMs = 120_000,
  mirrorRoot = join(homedir(), '.local', 'state', 'we', 'standards-status'), log = () => {},
} = {}) {
  const result = { posted: [], skipped: [], errors: [], wouldPost: [] };
  if (!repos.length) return result;
  const rawGit = git;
  git = (args, options) => rawGit([...gitBase, ...args], options); // hooks off and no file protocol on every call
  const writerEnv = redTeamWriterEnv(env);
  const probe = requireRedTeamAppWriter({ gh, env, appWriterProbe });
  if (!probe.ok) { log(`standards-status: ${probe.reason}`); return { ...result, refused: `WE App token unavailable: ${probe.reason}` }; }
  let hash;
  try { hash = validatorHash ?? defaultValidatorHash(validatorPath); }
  catch (error) { return { ...result, refused: `validator inputs unreadable: ${String(error?.message ?? error).slice(0, 120)}` }; }
  const post = (repo, head, payload) =>
    gh(['api', `repos/${repo}/statuses/${head}`, '--method', 'POST', '--input', '-'], { ...ioOptions, input: JSON.stringify(payload), env: writerEnv });

  for (const repo of repos) {
    let prs;
    try { prs = JSON.parse(gh(['api', `repos/${repo}/pulls?state=open&per_page=100`], { ...ioOptions, env })); if (!Array.isArray(prs)) throw Error('pulls unreadable'); }
    catch (error) { result.errors.push({ repo, error: String(error?.message ?? error) }); continue; }
    // The cache key covers the validator inputs AND the main harness sha, so fixing either re-runs every open head.
    let mainNow;
    try { mainNow = String(gh(['api', `repos/${repo}/git/ref/heads/main`, '--jq', '.object.sha'], { ...ioOptions, env })).trim(); if (!validHead(mainNow)) throw Error('main sha unreadable'); }
    catch (error) { result.errors.push({ repo, error: String(error?.message ?? error) }); continue; }
    const key = `${hash}.${mainNow.slice(0, 8)}`;
    for (const pr of prs) {
      const head = pr?.head?.sha; const number = pr?.number;
      if (!validHead(head) || !Number.isSafeInteger(number)) { result.skipped.push({ repo, pr: number, reason: 'invalid head' }); continue; }
      const dirs = [];
      const mirror = join(mirrorRoot, `${repo.replace('/', '__')}.git`);
      const hardened = hardenedGitEnv(env);
      const inMirror = (...args) => git(['--git-dir', mirror, ...args], { env: hardened });
      try {
        const { combined, history, complete } = readStatuses({ repo, head, gh, env });
        const seen = evaluateStandardsStatus({ combined, history, historyComplete: complete, head });
        const done = seen.latestTrusted;
        if (done && done.id === seen.newestId && String(done.description ?? '').includes(`validator ${key} `)) {
          result.skipped.push({ repo, pr: number, reason: `already ${done.state} for this validator` }); continue;
        }
        if (dryRun) { result.wouldPost.push({ repo, pr: number, head }); continue; }
        const id = runId();
        post(repo, head, statusPayload({ state: 'pending', runId: id }));
        // Mirror + exact-sha checks. A fetch or sha problem posts nothing further: the `pending` stays and holds.
        try { inMirror('rev-parse', '--git-dir'); } catch {
          git(['init', '--bare', mirror], { env: hardened });
          git(['--git-dir', mirror, 'remote', 'add', 'origin', `https://github.com/${repo}.git`], { env: hardened });
        }
        const fetchArgs = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
        git(['--git-dir', mirror, ...fetchArgs, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/pull/${number}/head`], { env: hardened });
        if (inMirror('rev-parse', 'FETCH_HEAD').trim() !== head) throw Error('fetched sha differs from the PR head');
        git(['--git-dir', mirror, ...fetchArgs, 'fetch', '--no-tags', '--no-recurse-submodules', 'origin', '+refs/heads/main:refs/heads/main'], { env: hardened });
        const mainSha = inMirror('rev-parse', 'refs/heads/main').trim();
        if (!validHead(mainSha)) throw Error('origin/main sha unreadable');
        const addTree = (label, sha) => {
          const dir = makeDir(label); dirs.push(dir);
          git(['--git-dir', mirror, 'worktree', 'add', '--detach', dir, sha], { env: hardened });
          if (git(['-C', dir, 'rev-parse', 'HEAD'], { env: hardened }).trim() !== sha) throw Error(`${label} is not at ${sha}`);
          return dir;
        };
        const headTree = addTree('head-wt', head);
        const mainTree = addTree('main-wt', mainSha);
        let verdict;
        if (!validatorPath || !exists(validatorPath)) verdict = { state: 'failure', reason: 'validator missing on the Studio' };
        else {
          // 1. The Studio's own validator, run here: it reads nothing from the PR.
          verdict = validatorVerdict(await spawn({ cmd: process.execPath, cwd: mainTree, env: childEnv(env), timeoutMs: 30_000, args: [validatorPath] }));
          // 2. The PR's protocol rules run in a CHILD driver (main's harness, the head's protocols folder, which is the
          // harness's --root, not the repo root). The verdict is the child's structured, nonce-carrying result only.
          if (verdict.state === 'success') {
            if (!sandbox && !allowUnsandboxed) verdict = { state: 'failure', reason: 'no sandbox on this host; PR rules not run' };
            else {
              const runNonce = nonce();
              const driverArgs = [DRIVER, `--harness=${join(mainTree, HARNESS)}`, `--root=${join(headTree, 'protocols')}`];
              const run = await spawn(sandbox
                ? { cmd: '/usr/bin/sandbox-exec', cwd: mainTree, env: childEnv(env), timeoutMs: runTimeoutMs, fdInput: runNonce,
                  args: ['-p', sandboxProfile(), process.execPath, ...driverArgs] }
                : { cmd: process.execPath, cwd: mainTree, env: childEnv(env), timeoutMs: runTimeoutMs, fdInput: runNonce, args: driverArgs });
              verdict = harnessVerdict(run, runNonce);
            }
          }
        }
        const live = JSON.parse(gh(['api', `repos/${repo}/pulls/${number}`], { ...ioOptions, env }))?.head?.sha;
        if (live !== head) { result.skipped.push({ repo, pr: number, reason: 'head moved during the run' }); continue; }
        post(repo, head, statusPayload({ state: verdict.state, runId: id, validatorHash: `${hash}.${mainSha.slice(0, 8)}`, reason: verdict.reason }));
        result.posted.push({ repo, pr: number, head, state: verdict.state });
      } catch (error) {
        result.errors.push({ repo, pr: number, error: String(error?.message ?? error).slice(0, 200) });
        log(`standards-status: ${repo}#${number} not completed (${String(error?.message ?? error).split('\n')[0]})`);
      } finally {
        for (const dir of dirs) { try { git(['--git-dir', mirror, 'worktree', 'remove', '--force', dir], { env: hardened }); } catch { /* best effort */ } }
      }
    }
  }
  if (dryRun) return { ...result, dryRun: true };
  return result;
}

/** Settings-driven entry used by the verify tick. Disabled means a no-op. */
export async function runStandardsStatusPassFromSettings({ dryRun = false, settings = loadStandardsStatusSettings(), ...rest } = {}) {
  if (!settings.enabled) return { posted: [], skipped: [], errors: [], wouldPost: [], disabled: true };
  return runStandardsStatusPass({ repos: settings.repos, validatorPath: settings.validatorPath, runTimeoutMs: settings.runTimeoutMs, dryRun, ...rest });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  // The daemons' own App-auth path (a tick wrapper does this for the verify daemon); the CLI does it itself.
  import('../lib/github-app-auth-env.mjs').then(({ ensureFreshGithubAppEnv }) => ensureFreshGithubAppEnv({}))
    .then(() => runStandardsStatusPassFromSettings({ dryRun, log: line => process.stdout.write(`${line}\n`) }))
    .then(result => { process.stdout.write(`${JSON.stringify({ context: STANDARDS_CONTEXT, postsAs: 'web-everything[bot] (WE App writer env, no personal fallback)', ...result })}\n`); })
    .catch(error => { process.stderr.write(`standards-status: ${error?.message ?? error}\n`); process.exitCode = 1; });
}
