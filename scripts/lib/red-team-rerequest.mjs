/**
 * The drain's red-team RE-REQUEST (card 6267): when an owed post-accept red team left NO result on a head past the
 * drain's wait deadline, post one head-bound request and start one detached red-team-only job
 * (`review-job.mjs red-team`) for exactly that head.
 *
 * There was no standing red-team request queue for the review daemon to consume: the review daemon never re-reviews
 * an accepted head, and its auto-fix re-arm path is for `review:changes`. So the request is a file next to the
 * red-team status files, reserved EXCLUSIVELY (`wx`) per (repo, PR, lowercased head, attempt), and the job it starts
 * writes the ordinary red-team status file the drain already reads. The request is never a result: the drain keeps
 * the PR held until a real red-team result (or a proven carry / operator ruling) exists for the head.
 *
 * Settings: `redTeam.rerequest` in we:scripts/settings/red-team.json through the policy cascade
 * (standard < platform < tool < env), sources logged on every read:
 *   - `enabled` (standard true; env `WE_RED_TEAM_REREQUEST` on/off is the kill switch);
 *   - `maxRequestsPerHead` (standard 1; env `WE_RED_TEAM_REREQUEST_MAX_PER_HEAD`), durable across drain restarts.
 * The red team's own kill switch (`redTeamEnabled`) also stops every request.
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCascadeSourcesLine, platformPreference, resolveCascade } from './policy-cascade.mjs';
import { RED_TEAM_SETTINGS_FILE } from './red-team-gate.mjs';
import { redTeamEnabled } from './review-red-team-policy.mjs';
import { redTeamStatusDir } from './drain-red-team-evidence.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REVIEW_JOB = join(REPO_ROOT, 'scripts', 'operations', 'review-job.mjs');
const HEAD_RE = /^[0-9a-f]{40}$/;

export const REREQUEST_ENV = 'WE_RED_TEAM_REREQUEST';
export const REREQUEST_MAX_ENV = 'WE_RED_TEAM_REREQUEST_MAX_PER_HEAD';

const boolEnv = v => {
  if (v === undefined || v === '') return undefined;
  const s = String(v).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes'].includes(s) ? true : ['0', 'false', 'off', 'no'].includes(s) ? false : s;
};
const intEnv = v => (v === undefined || v === '' ? undefined : Number(v));

/** PURE: `redTeam.rerequest` through the cascade. An invalid value in any layer is ignored (the lower layer stands). */
export function resolveRedTeamRerequestPolicy({ file = {}, platform, env = {} } = {}) {
  return resolveCascade({
    standard: { enabled: true, maxRequestsPerHead: 1 },
    platform: platform?.rerequest, tool: file?.redTeam?.rerequest,
    envValues: { enabled: boolEnv(env[REREQUEST_ENV]), maxRequestsPerHead: intEnv(env[REREQUEST_MAX_ENV]) },
    valid: { enabled: v => typeof v === 'boolean', maxRequestsPerHead: v => Number.isInteger(v) && v >= 0 && v <= 5 },
  });
}

export function readRedTeamRerequestPolicy({ env = process.env, path = RED_TEAM_SETTINGS_FILE, log = () => {} } = {}) {
  let file = {};
  try { file = JSON.parse(readFileSync(path, 'utf8')); } catch { /* standard */ }
  let platform;
  try { platform = platformPreference('redTeam', { env }); } catch { platform = undefined; }
  const resolved = resolveRedTeamRerequestPolicy({ file, platform, env });
  log(formatCascadeSourcesLine('redTeam.rerequest', resolved));
  return resolved;
}

export const redTeamRequestDir = (env = process.env) => join(dirname(redTeamStatusDir(env)), 'red-team-requests');
const requestKey = ({ repo, pr, head }) => `${encodeURIComponent(repo)}-${Number(pr)}-${head}`;

/** The request files already reserved for this exact (repo, PR, head), oldest attempt first. */
export function listRedTeamRequests({ repo, pr, head, env = process.env, dir = redTeamRequestDir(env) }) {
  const prefix = `${requestKey({ repo, pr, head: String(head).toLowerCase() })}-`;
  let names = [];
  try { names = readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return names.filter(n => n.startsWith(prefix) && /^\d+\.json$/.test(n.slice(prefix.length)))
    .map(n => ({ attempt: Number(n.slice(prefix.length, -5)), path: join(dir, n) })).sort((a, b) => a.attempt - b.attempt);
}

/** The real detached spawn (the shape of `defaultSpawnJob` in we:scripts/operations/review-job.mjs). */
export function defaultSpawnRedTeamJob({ argv, cwd, env, logPath, onError }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const fd = openSync(logPath, 'a');
  try {
    const child = spawn(process.execPath, argv, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
    child.once('error', e => onError?.(e));
    child.unref();
    return child.pid;
  } finally { closeSync(fd); }
}

/**
 * Post ONE red-team re-request for `repo#pr` at `head` and start the red-team-only job. Never waits on the job.
 * @returns {{requested:boolean, reason?:string, attempt?:number, path?:string, jobPid?:number}}
 */
export function requestRedTeamRerun({ repo, pr, head, loopPayload, reason = 'no red-team result on this head past the drain deadline' }, {
  env = process.env, policy, dir = redTeamRequestDir(env), spawnJob = defaultSpawnRedTeamJob, now = () => new Date().toISOString(),
  log = line => process.stderr.write(`${line}\n`), root = REPO_ROOT,
} = {}) {
  const h = String(head ?? '').toLowerCase();
  if (!HEAD_RE.test(h) || !Number.isInteger(Number(pr)) || !/^[\w.-]+\/[\w.-]+$/.test(String(repo ?? ''))) return { requested: false, reason: 'bad request identity' };
  const judged = String(loopPayload?.findings?.read?.netBasis?.rev ?? '').toLowerCase();
  if (judged !== h) return { requested: false, reason: `no recorded review read for head ${h.slice(0, 12)}` };
  if (!redTeamEnabled(env)) return { requested: false, reason: 'red team kill switch thrown' };
  const p = policy ?? readRedTeamRerequestPolicy({ env, log });
  if (p.value?.enabled !== true) return { requested: false, reason: `redTeam.rerequest.enabled=false (${p.sources?.enabled ?? 'standard'})` };
  const max = p.value?.maxRequestsPerHead ?? 1;
  const prior = listRedTeamRequests({ repo, pr, head: h, dir });
  if (prior.length >= max) return { requested: false, reason: `redTeam.rerequest.maxRequestsPerHead=${max} reached for this head (${p.sources?.maxRequestsPerHead ?? 'standard'})` };
  const attempt = (prior.at(-1)?.attempt ?? 0) + 1;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${requestKey({ repo, pr, head: h })}-${attempt}.json`);
  const nonce = randomUUID();
  let fd;
  // Exclusive reservation: a concurrent caller that lost the race gets EEXIST and starts nothing.
  try { fd = openSync(path, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') return { requested: false, reason: 'already requested for this head' }; throw e; }
  try {
    writeSync(fd, JSON.stringify({ repo, pr: Number(pr), head: h, attempt, nonce, requestedBy: 'drain', reason: String(reason).slice(0, 300),
      requestedAt: now(), loopPayload }));
  } finally { closeSync(fd); }
  const release = why => {
    try { if (JSON.parse(readFileSync(path, 'utf8')).nonce === nonce) rmSync(path, { force: true }); } catch { /* gone already */ }
    log(`red-team re-request ${repo}#${pr}@${h.slice(0, 12)}: start failed (${why}) — reservation released, PR stays held`);
  };
  let jobPid;
  try {
    jobPid = spawnJob({ argv: [REVIEW_JOB, 'red-team', `--pr=${Number(pr)}`, `--repo=${repo}`, `--head=${h}`, `--request=${path}`],
      cwd: root, env, logPath: join(dir, 'logs', `${requestKey({ repo, pr, head: h })}-${attempt}.log`), onError: e => release(e?.message ?? e) });
  } catch (e) { release(e?.message ?? e); return { requested: false, reason: `red-team job did not start: ${String(e?.message ?? e).slice(0, 200)}` }; }
  if (!Number.isInteger(jobPid)) { release('no pid'); return { requested: false, reason: 'red-team job did not start (no pid)' }; }
  log(`red-team re-request ${repo}#${pr}@${h.slice(0, 12)}: attempt ${attempt}/${max} posted by the drain, red-team-only job pid ${jobPid} (${reason})`);
  return { requested: true, attempt, path, jobPid };
}
