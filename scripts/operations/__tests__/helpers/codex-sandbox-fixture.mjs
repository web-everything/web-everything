/**
 * @file codex-sandbox-fixture.mjs — checked subprocess execution + production-shaped clone fixtures for the
 * live `codex sandbox -P locked` proof (`codex-delivery-provider-sandbox.test.mjs`, #4807).
 *
 * TWO DEFECTS THIS CLOSES. (1) The proof suite ran its Git setup through a bare `spawnSync` whose result was
 * never read, and its denial cases accepted any `status !== 0`: a launch failure (ENOENT), a timeout or a
 * signal all yield a null status, which IS `!== 0`, so a broken probe read as "the sandbox denied it". Every
 * process here goes through `checkProcessResult`, which refuses `error`, a signal and a non-integer status
 * BEFORE any caller classifies the result; the helper's sole raw spawn site is held to that by
 * `codex-delivery-provider-sandbox-guards.test.mjs`. (2) Fixtures were `git init` scratch repos, while
 * production lanes are independent clones sharing objects with the primary through `git clone --reference`
 * (`we:scripts/lane-pool.mjs`, `cloneLane`). `createLaneFixture` builds that topology, and
 * `verifyCloneTopology` proves it before any probe runs.
 *
 * Linked worktrees and symlink aliases are deliberately NOT modelled — production lanes are clones.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** Quote one value for a POSIX `sh -c` string (handles spaces and apostrophes). */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Thrown for any process that did not run to a normal, integer exit — never evidence of a sandbox denial. */
export class ProcessCheckError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ProcessCheckError';
    this.details = details;
  }
}

function render(command, args) {
  return [command, ...args].map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : shellQuote(part))).join(' ');
}

function diagnostics(command, args, raw) {
  const text = (value) => (value == null ? '' : String(value)).trim();
  return [
    `command: ${render(command, args)}`,
    `status: ${raw?.status === undefined ? 'undefined' : String(raw.status)}`,
    `signal: ${raw?.signal ?? 'none'}`,
    raw?.error ? `error: ${raw.error.code ?? ''} ${raw.error.message ?? raw.error}`.trim() : null,
    `stdout: ${text(raw?.stdout)}`,
    `stderr: ${text(raw?.stderr)}`,
  ].filter(Boolean).join('\n');
}

/**
 * The checked-result boundary. Returns `{ status, stdout, stderr }` only for a process that launched, was not
 * killed by a signal or timeout, and exited with an integer status; throws `ProcessCheckError` (carrying
 * command, status, signal, stdout and stderr) otherwise. The exit status is NOT judged here — see
 * `expectSuccess` / `expectDenied`.
 */
export function checkProcessResult(command, args, raw) {
  const bad = !raw
    ? 'no result'
    : raw.error ? `process error (${raw.error.code ?? raw.error.message})`
      : raw.signal ? `terminated by signal ${raw.signal}`
        : !Number.isInteger(raw.status) ? `non-integer exit status (${String(raw.status)})`
          : null;
  if (bad) {
    throw new ProcessCheckError(`process did not complete normally: ${bad}\n${diagnostics(command, args, raw)}`, {
      command, args, status: raw?.status ?? null, signal: raw?.signal ?? null,
      error: raw?.error ?? null, stdout: raw?.stdout ?? '', stderr: raw?.stderr ?? '',
    });
  }
  return { status: raw.status, stdout: raw.stdout ?? '', stderr: raw.stderr ?? '' };
}

/** Run a process and return its checked result (any integer exit status). The one raw spawn site. */
export function runChecked(command, args, options = {}) {
  return checkProcessResult(command, args, spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options }));
}

/** Setup / positive-control contract: healthy AND exit status zero. */
export function expectSuccess(command, args, options) {
  const result = runChecked(command, args, options);
  if (result.status !== 0) {
    throw new ProcessCheckError(
      `expected exit status 0\n${diagnostics(command, args, result)}`,
      { command, args, ...result, signal: null, error: null },
    );
  }
  return result;
}

/**
 * Denial contract: healthy AND a nonzero integer exit status. When `signature` is given, stderr must also match it
 * — a bare nonzero status can be a CLI argument error or a missing command, not the sandbox refusing. Callers
 * must still check filesystem state.
 */
export function expectDenied(command, args, options, signature) {
  const result = runChecked(command, args, options);
  if (result.status === 0) {
    throw new ProcessCheckError(
      `expected a nonzero exit status (denial) but the command succeeded\n${diagnostics(command, args, result)}`,
      { command, args, ...result, signal: null, error: null },
    );
  }
  if (signature && !signature.test(result.stderr)) {
    throw new ProcessCheckError(
      `nonzero exit without the expected denial signature ${signature}\n${diagnostics(command, args, result)}`,
      { command, args, ...result, signal: null, error: null },
    );
  }
  return result;
}

// Hermetic per-invocation Git identity: a developer's global config may demand an unavailable signing program.
const GIT_HERMETIC = ['-c', 'commit.gpgsign=false', '-c', 'user.name=sandbox-fixture', '-c', 'user.email=fixture@example.invalid'];
export const git = (cwd, ...args) => expectSuccess('git', [...GIT_HERMETIC, ...args], { cwd });

/**
 * Prove the lane is the production topology before any probe: directory-shaped `.git`, resolved git dir and
 * common dir both that directory, and `objects/info/alternates` pointing at the reference primary's objects.
 */
export function verifyCloneTopology(lane, primary) {
  const dotGit = join(lane, '.git');
  if (!lstatSync(dotGit).isDirectory()) throw new Error(`topology: ${dotGit} is not a directory`);
  const resolved = (flag) => realpathSync(resolve(lane, git(lane, 'rev-parse', flag).stdout.trim()));
  const gitDir = resolved('--git-dir');
  const commonDir = resolved('--git-common-dir');
  const expected = realpathSync(dotGit);
  if (gitDir !== expected || commonDir !== expected) {
    throw new Error(`topology: git-dir ${gitDir} / common-dir ${commonDir} must both equal ${expected}`);
  }
  const alternates = readFileSync(join(dotGit, 'objects/info/alternates'), 'utf8').split('\n').map((l) => l.trim());
  const primaryObjects = join(realpathSync(primary), '.git/objects');
  if (!alternates.some((line) => line && realpathSync(line) === primaryObjects)) {
    throw new Error(`topology: alternates ${JSON.stringify(alternates)} do not reference ${primaryObjects}`);
  }
  return { gitDir, commonDir, alternates };
}

/** Seed a committed primary repo, then `git clone --reference <primary> <primary> <lane>` — what `cloneLane` does. */
function createClonedLane(base, name, files) {
  const primary = join(base, `${name}-primary`);
  const lane = join(base, name);
  mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(primary, rel, '..'), { recursive: true });
    writeFileSync(join(primary, rel), body);
  }
  git(primary, 'add', '-A');
  git(primary, 'commit', '-q', '-m', 'seed');
  git(base, 'clone', '--quiet', '--reference', primary, primary, lane);
  return { primary, lane, topology: verifyCloneTopology(lane, primary) };
}

/**
 * Disposable proof fixture below the REAL home directory (ambient temp dirs are writable under the sandbox and
 * would confound the ungranted-sibling control): independent `impl` and `we` lane clones, an ungranted sibling
 * directory, and a read-denied target. `cleanup()` removes only the fixture-owned root; it is also run
 * automatically if setup throws.
 */
export function createLaneFixture({ prefix = '.we-4807-', home = homedir(), onBase } = {}) {
  const base = realpathSync(mkdtempSync(join(home, prefix)));
  const cleanup = () => rmSync(base, { recursive: true, force: true });
  try {
    onBase?.(base); // test seam: lets a guard test observe the owned root and inject a setup failure
    const impl = createClonedLane(base, 'impl', { 'README.md': 'impl\n' });
    const we = createClonedLane(base, 'we', { 'backlog/.keep': '', 'README.md': 'we\n' });
    mkdirSync(join(we.lane, '.git/hooks'), { recursive: true });
    writeFileSync(join(we.lane, '.git/hooks/pre-commit'), 'orig\n');
    const sibling = join(base, 'sib');
    mkdirSync(sibling);
    const denyDir = join(base, 'deny');
    mkdirSync(denyDir);
    const secret = join(denyDir, 'secret.txt');
    writeFileSync(secret, 'secret\n');
    return { base, impl: impl.lane, we: we.lane, wePrimary: we.primary, sibling, denyDir, secret, topology: { impl: impl.topology, we: we.topology }, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
