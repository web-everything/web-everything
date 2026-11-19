/**
 * @file Bounded, read-only waits for a CI run, daemon-clone adoption, or PR predicates.
 * No run records are persisted; a timeout returns a command the operator can resume.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { ghRepoSlug } from '../lib/constellation-repos.mjs';
import { DAEMON_CLONE_SEED } from '../lib/daemon-clone-registry.mjs';
import { writeLineSync } from '../lib/write-all-sync.mjs';

const MAX_WAIT_MS = 540000;
const POLL_MS = 30000;
const REPO = ghRepoSlug('we');
const USAGE = 'usage: run.mjs await --kind ci-run|adoption|pr [--branch REF] [--sha SHA] [--clone NAME] [--pr NUMBER] [--state open|closed|merged] [--labels-present LABEL] [--labels-absent LABEL] [--wait-ms MS] [--json]';

/** Parse flags without filesystem or subprocess access. Clone values remain names. */
export function parseArgs(argv) {
  const opts = { labelsPresent: [], labelsAbsent: [], waitMs: MAX_WAIT_MS, json: false };
  const fields = { kind: 'kind', branch: 'branch', sha: 'sha', clone: 'clone', pr: 'pr', state: 'state', 'wait-ms': 'waitMs' };
  const labels = { 'label-present': 'labelsPresent', 'labels-present': 'labelsPresent', 'label-absent': 'labelsAbsent', 'labels-absent': 'labelsAbsent' };
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!match) throw new Error('expected a flag');
    const [, flag, inline] = match;
    if (flag === 'json') {
      if (inline !== undefined) throw new Error('--json takes no value');
      opts.json = true;
      continue;
    }
    if (!Object.hasOwn(fields, flag) && !Object.hasOwn(labels, flag)) throw new Error(`unknown flag --${flag}`);
    const value = inline ?? argv[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`--${flag} needs a value`);
    if (Object.hasOwn(labels, flag)) opts[labels[flag]].push(value);
    else opts[fields[flag]] = value;
  }
  if (!['ci-run', 'adoption', 'pr'].includes(opts.kind)) throw new Error('invalid or missing --kind');
  if (!/^\d+$/.test(String(opts.waitMs)) || !Number.isFinite(Number(opts.waitMs))) throw new Error('--wait-ms needs a nonnegative integer');
  opts.waitMs = Math.min(Number(opts.waitMs), MAX_WAIT_MS);
  if (opts.sha !== undefined && !/^[0-9a-f]{7,40}$/i.test(opts.sha)) throw new Error('--sha needs 7–40 hexadecimal characters');
  if (opts.clone !== undefined && (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(opts.clone) || opts.clone.split('/').some(seg => seg === '.' || seg === '..'))) throw new Error('--clone needs a registry clone name (relative, no ..)');
  if (opts.pr !== undefined) {
    if (!/^\d+$/.test(opts.pr) || !Number.isSafeInteger(Number(opts.pr)) || Number(opts.pr) < 1) throw new Error('--pr needs a positive integer');
    opts.pr = Number(opts.pr);
  }
  if (opts.state !== undefined && !['open', 'closed', 'merged'].includes(opts.state)) throw new Error('invalid --state');
  if (opts.kind === 'ci-run' && !opts.branch && !opts.sha) throw new Error('ci-run needs --branch or --sha');
  if (opts.kind === 'adoption' && (!opts.clone || !opts.sha)) throw new Error('adoption needs --clone and --sha');
  if (opts.kind === 'adoption' && !/^[0-9a-f]{40}$/i.test(opts.sha)) throw new Error('adoption needs a full 40-hex --sha (abbreviated refused)');
  // Only registered daemon clones can satisfy an adoption gate; a pool lane or any other checkout never counts.
  if (opts.clone !== undefined && !DAEMON_CLONE_SEED.includes(opts.clone)) throw new Error('--clone must be a registered daemon clone');
  if (opts.kind === 'pr' && (!opts.pr || (!opts.state && !opts.labelsPresent.length && !opts.labelsAbsent.length))) throw new Error('pr needs --pr and a state or label predicate');
  const allowed = { 'ci-run': ['branch', 'sha'], adoption: ['clone', 'sha'], pr: ['state', 'pr', 'labelsPresent', 'labelsAbsent'] }[opts.kind];
  for (const key of ['branch', 'sha', 'clone', 'pr', 'state', 'labelsPresent', 'labelsAbsent']) {
    const supplied = Array.isArray(opts[key]) ? opts[key].length > 0 : opts[key] !== undefined;
    if (supplied && !allowed.includes(key)) throw new Error(`${key} is not valid for ${opts.kind}`);
  }
  return opts;
}

function defaultExec(file, args, { timeout }) {
  const options = { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout, stdio: ['ignore', 'pipe', 'pipe'] };
  if (file === 'gh') {
    const deadline = performance.now() + timeout;
    const remaining = () => {
      const ms = Math.floor(deadline - performance.now());
      if (ms < 1) throw new Error('await command deadline reached');
      return ms;
    };
    return execFileSyncThrottled(file, args, { ...options, throttle: {
      maxAttempts: 1,
      acquireTimeoutMs: timeout,
      // Admission and retry waits share the child's budget rather than adding to it.
      sleep(ms) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, remaining()));
        remaining();
      },
      exec(childArgs, childOptions) {
        return execFileSync('gh', childArgs, { ...childOptions, maxBuffer: 1024 * 1024, timeout: Math.min(timeout, remaining()) });
      },
    } });
  }
  if (file === 'git') {
    // Never inherit repository overrides (GIT_DIR, GIT_WORK_TREE, ...): the probe must read only the named clone.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    env.GIT_NO_REPLACE_OBJECTS = '1'; // replacement refs must not falsify ancestry
    env.GIT_NO_LAZY_FETCH = '1';
    if (args[0] !== '-C') return execFileSync(file, args, { ...options, env });
    const dir = args[1];
    const started = performance.now();
    const real = assertCloneRoot(dir);
    // The named directory must itself be the repository root, never a parent repository git discovered.
    if (execFileSync(file, ['-C', dir, 'rev-parse', '--show-toplevel'], { ...options, env }).trim() !== real) throw new Error('not a repository root');
    // The sha must name a commit object itself, never a branch/tag that happens to look like one.
    const sha = args[4];
    execFileSync(file, ['-C', dir, 'rev-parse', '--verify', `${sha}^{commit}`], { ...options, env });
    // Both git calls share one budget: the second gets only what the first left.
    const left = Math.floor(options.timeout - (performance.now() - started));
    if (left < 1) throw new Error('await command deadline reached');
    return execFileSync(file, args, { ...options, timeout: left, env });
  }
  throw new Error('unsupported executable');
}

/**
 * The registered clone path must be a real directory at its registry location: its realpath must equal the
 * registry-expected root (workspace realpath + the registry-relative name). A symlink pointing elsewhere is refused.
 * @returns {string} the verified realpath
 */
export function assertCloneRoot(dir, { realpath = realpathSync, workspace = join(homedir(), 'workspace') } = {}) {
  const expected = join(realpath(workspace), relative(workspace, dir));
  const real = realpath(dir);
  if (real !== expected) throw new Error('clone path is not its registry root (symlink refused)');
  return real;
}

/** A daemon clone is named by its registry entry (`wev-fix-daemon`, `.lanes/we-drain-daemon/code`), relative to the workspace root. */
export function cloneDir(name) {
  // Same resolution as the registry's own `daemonCloneRoots`: seed name joined directly under the workspace root.
  return join(homedir(), 'workspace', name);
}

function resumeCommand(opts) {
  const args = ['--kind', opts.kind];
  for (const key of ['branch', 'sha', 'clone', 'pr', 'state']) {
    if (opts[key] !== undefined) args.push(`--${key}`, String(opts[key]));
  }
  for (const label of opts.labelsPresent) args.push('--label-present', label);
  for (const label of opts.labelsAbsent) args.push('--label-absent', label);
  args.push('--wait-ms', String(opts.waitMs));
  if (opts.json) args.push('--json');
  const quote = value => /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  return `node scripts/operations/run.mjs await ${args.map(quote).join(' ')}`;
}

/** All polling IO is injectable; missing or unreadable evidence remains pending. */
export function awaitCondition(opts, {
  exec = defaultExec,
  now = () => performance.now(),
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
} = {}) {
  const deadline = now() + Math.min(opts.waitMs, MAX_WAIT_MS);
  let result = { done: false, kind: opts.kind, ...(opts.kind === 'adoption' ? { adopted: false } : {}) };
  while (true) {
    const timeout = Math.floor(Math.min(POLL_MS, deadline - now()));
    // Node treats timeout=0 as unlimited, so never launch with an exhausted budget.
    if (timeout < 1) break;
    const commandOptions = { timeout };
    try {
      if (opts.kind === 'adoption') {
        exec('git', ['-C', cloneDir(opts.clone), 'merge-base', '--is-ancestor', opts.sha, 'HEAD'], commandOptions);
        result = { ...result, done: true, adopted: true };
      } else if (opts.kind === 'ci-run') {
        const args = ['run', 'list'];
        if (opts.branch) args.push('--branch', opts.branch);
        if (opts.sha) args.push('--commit', opts.sha);
        args.push('--limit', '1', '--json', 'databaseId,status,conclusion,url,headSha');
        const runs = JSON.parse(exec('gh', args, commandOptions));
        const run = Array.isArray(runs) && runs.length === 1 ? runs[0] : null;
        if (run?.status === 'completed' && typeof run.conclusion === 'string' && run.conclusion.length > 0
          && Number.isSafeInteger(run.databaseId) && run.databaseId > 0 && typeof run.url === 'string' && run.url.length > 0
          && typeof run.headSha === 'string' && /^[0-9a-f]{7,40}$/i.test(run.headSha)
          && (!opts.sha || run.headSha.toLowerCase().startsWith(opts.sha.toLowerCase()))) {
          result = { ...result, done: true, conclusion: run.conclusion, runId: run.databaseId, url: run.url };
        }
      } else {
        const pr = JSON.parse(exec('gh', ['pr', 'view', String(opts.pr), '--repo', REPO, '--json', 'state,labels'], commandOptions));
        if (pr && ['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) && Array.isArray(pr.labels)
          && pr.labels.every(label => label && typeof label.name === 'string' && label.name.length > 0)) {
          const names = new Set(pr.labels.map(label => label.name));
          result.done = (!opts.state || pr.state === opts.state.toUpperCase())
            && opts.labelsPresent.every(label => names.has(label)) && opts.labelsAbsent.every(label => !names.has(label));
        }
      }
    } catch {
      // A failed command or malformed response cannot establish completion.
    }
    // A probe that finished after the budget ran out cannot certify completion.
    if (result.done && now() > deadline) result = { ...result, done: false, ...(opts.kind === 'adoption' ? { adopted: false } : {}) };
    if (result.done) return result;
    const remaining = deadline - now();
    // Less than one poll gap left: the next poll cannot happen inside the budget, so time out without pausing.
    if (remaining < POLL_MS) break;
    sleep(POLL_MS);
    if (remaining <= POLL_MS) break;
  }
  return { ...result, timedOut: true, resumeWith: resumeCommand(opts) };
}

/** CLI exit codes: completed=0, timeout=75, invalid usage=2. */
export function main(argv, { out = text => writeLineSync(1, text), ...io } = {}) {
  let opts;
  try { opts = parseArgs(argv); }
  catch (error) { out(`error: ${error.message}\n${USAGE}`); return 2; }
  const result = awaitCondition(opts, io);
  out(opts.json ? JSON.stringify(result) : result.done
    ? `${result.kind} done${result.conclusion ? `: ${result.conclusion}` : ''}`
    : `${result.kind} timed out; resumeWith: ${result.resumeWith}`);
  return result.done ? 0 : 75;
}
