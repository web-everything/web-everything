/** R247 IO: reuse daemon exports; never synthesize a fix plan or verify an unrelated PR. */
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { daemonEventsPath } from '../lib/daemon-events.mjs';
import { assertOperatorCliFresh } from '../lib/main-staleness.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';
import { assessDaemonStatus } from './daemon-status.mjs';
import { collectDaemonStatus } from './daemon-status-io.mjs';
import { MANUAL_DAEMON_PASS_EFFECT, assertManualPassAllowed, validateManualPass } from './manual-daemon-pass.mjs';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MISSING_MANUAL_ENTRY_POINTS = Object.freeze({
  fix: 'missing a single-PR fix daemon entry point accepting repo/pr: fix-run.mjs#runFixCli requires session, ref and prompt-file; reconcile-fix-dispatch.mjs#dispatchFix requires a prepared plan (runReconcileFixDispatch is a repo sweep)',
  verify: 'missing a single-PR verify daemon entry point accepting repo/pr: verify.mjs/createChecksRunner accepts a checkout; verify-dispatch.mjs#runVerifyDispatch scans pools, and runLaneGate/createVerifyGateJobs.launch require prepared lane, head and marker evidence',
});

/** Preserve the shared event path, at/kind/repo envelope and one-line append convention, plus R247 fields. */
export async function writeManualPassEvent(event, { env = process.env, home = homedir(), path = daemonEventsPath({ env, home }) } = {}) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`);
}

export function readManualDaemonStatus({ exec = execFileSync, env = process.env } = {}) {
  let launchctlFailed = false;
  const snapshot = collectDaemonStatus({ env, exec: (file, args, options) => {
    try { return exec(file, args, options); }
    catch (error) { if (file === 'launchctl') launchctlFailed = true; throw error; }
  } });
  // daemon-status is an informational fail-soft reader; mutation admission must preserve unknown liveness.
  if (launchctlFailed) throw new Error('manual-daemon-pass: launchctl unavailable; restore daemon-status evidence before retrying');
  return assessDaemonStatus(snapshot);
}

export async function dispatchManualPass(input, { env, load = () => import('./review-job.mjs') } = {}) {
  const { dispatchReviewByMode, dispatchReviewJob } = await load();
  // The daemon leaves root to the shared dispatcher's module checkout default.
  const options = { pr: input.pr, repo: input.repo, env };
  return input.daemon === 'red-team' ? dispatchReviewJob({ ...options, redTeamOnly: true }) : dispatchReviewByMode(options);
}

export function createManualDaemonPassSinks({
  cwd = MODULE_ROOT, env = process.env,
  assertFresh = root => assertOperatorCliFresh(root, { label: 'manual-daemon-pass', skipUnderVitest: false,
    env: { ...env, WE_DAEMON_MANAGED_CLONE: '0', WE_OPERATOR_CLI_FRESH_FALLBACK: 'off' } }),
  readSha = () => execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10_000, maxBuffer: 4096 }).trim(),
  readStatus = () => readManualDaemonStatus({ env }),
  postComment = ({ repo, pr, body }) => {
    const cleanEnv = { ...env }; delete cleanEnv.GH_TOKEN; delete cleanEnv.GITHUB_TOKEN;
    return runGhSync(['pr', 'comment', String(pr), '--repo', repo, '--body-file', '-'], {
      cwd, env: cleanEnv, input: body, encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024,
    });
  },
  dispatch = input => dispatchManualPass(input, { env }),
  appendEvent = event => writeManualPassEvent(event, { env }),
  now = () => new Date(),
} = {}) {
  return { [MANUAL_DAEMON_PASS_EFFECT]: async raw => {
    let sha = null, result = { status: 'refused' };
    try {
      const input = validateManualPass(raw);
      sha = readSha();
      if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error('manual-daemon-pass: unreadable checkout HEAD');
      assertFresh(cwd);
      if (MISSING_MANUAL_ENTRY_POINTS[input.daemon]) {
        throw new Error(`manual-daemon-pass: no entry point for ${input.daemon}: ${MISSING_MANUAL_ENTRY_POINTS[input.daemon]}`);
      }
      assertManualPassAllowed(input, readStatus());
      result = { status: 'dispatching' };
      const outcome = await dispatch(input);
      await postComment({ ...input, body: `Manual R247 pass — daemon: ${input.daemon}; reason: ${input.reason}; checkout sha: ${sha}.` });
      result = { status: 'returned', outcome: outcome ?? null };
      return result;
    } catch (error) {
      result = { status: result.status === 'dispatching' ? 'error' : 'refused', error: String(error?.message ?? error) };
      throw error;
    } finally {
      const ts = now().toISOString();
      await appendEvent({ at: ts, ts, kind: 'manual-daemon-pass', repo: raw.repo ?? null,
        daemon: raw.daemon ?? null, pr: raw.pr ?? null, reason: raw.reason ?? null, sha, result });
    }
  } };
}
