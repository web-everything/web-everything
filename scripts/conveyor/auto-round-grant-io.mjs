/**
 * @file scripts/conveyor/auto-round-grant-io.mjs
 * @description IO shell for the automated standing-ruling round grant (`auto-round-grant.mjs`). Called by the
 *   fix-dispatch daemon's notes half the moment it sees a `round-cap-exhausted` note, before the needs-you event.
 *
 *   THE GRANT IS THE `extend-rounds` OPERATION, run as-is (`run.mjs extend-rounds`): its own plan step validates
 *   the record and its own write step refuses unless GitHub authenticates the poster as the operator, then proves
 *   the trusted grant count rose. Nothing here posts a grant comment itself.
 *
 *   CREDENTIAL. A grant only counts when GitHub records the operator as its author, so the one child run posts
 *   under the operator's own `gh` login. That is allowed ONLY when the `github.auth` policy lists the
 *   `standing-ruling-round-grant` personal exception; without it, or without a readable operator login, nothing
 *   is posted and the event stays for a person. Reads stay on the daemon's App identity.
 *
 *   IDEMPOTENT per (PR, head, cap episode): a claim file is created atomically (`wx`) under the coordination root
 *   BEFORE the child runs. A second tick, or a concurrent daemon, sees the claim and never grants again. A claim
 *   whose run failed is kept (never retried automatically) — the event then stays for a person.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExtensionThread } from '../operations/extend-rounds-io.mjs';
import { readHumanSurfaceNetFiles } from '../lib/human-surface-net-diff.mjs';
import { REVIEW_SETTINGS_FILE } from '../lib/review-seat-settings.mjs';
import { platformPreference } from '../lib/policy-cascade.mjs';
import { personalAllowed, readGithubAuthPolicy } from '../lib/github-auth-policy.mjs';
import { personalGhToken } from '../lib/gh-throttle.mjs';
import { resolveRealGhBinary } from '../lib/gh-app-shim.mjs';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import {
  AUTO_GRANT_ACTOR, AUTO_GRANT_CHANNEL, AUTO_GRANT_PERSONAL_EXCEPTION, autoGrantKey, autoGrantReason,
  capReachedReason, countAutoRoundGrants, decideAutoGrant, formatAutoRoundGrantSettings,
  resolveAutoRoundGrantSettings, screenAutoGrantNote,
} from './auto-round-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const firstLine = (e) => String(e?.stderr || e?.message || e).trim().split('\n')[0].slice(0, 300);

let loggedSettingsLine;
/** IO: the live settings (platform preference + review.json), source line logged once per distinct value. */
export function readAutoRoundGrantSettings({ readFile = readFileSync, log = (l) => process.stderr.write(`${l}\n`) } = {}) {
  let tool;
  try { tool = JSON.parse(String(readFile(REVIEW_SETTINGS_FILE, 'utf8'))); } catch { tool = undefined; }
  let platform;
  try { platform = platformPreference('review'); } catch { platform = undefined; }
  const settings = resolveAutoRoundGrantSettings({ platform, tool });
  const line = formatAutoRoundGrantSettings(settings);
  if (line !== loggedSettingsLine) { loggedSettingsLine = line; try { log(line); } catch { /* never fails a tick */ } }
  return settings;
}

/** The claim directory: one operator-owned sidecar shared by every checkout. */
export function claimDir(env = process.env) { return join(resolveCoordinationRoot({ env }), 'auto-round-grant'); }

/**
 * Atomically claim one limit hit. Returns true only for the first claimer; never throws for "already claimed".
 * @returns {boolean}
 */
export function claimLimitHit(key, { dir = claimDir(), now = () => new Date().toISOString() } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`);
  try {
    writeFileSync(path, `${JSON.stringify({ key, claimedAt: now(), pid: process.pid })}\n`, { flag: 'wx' });
    return { claimed: true, path };
  } catch (e) {
    if (e?.code === 'EEXIST') return { claimed: false, path };
    throw e;
  }
}

/** Record the outcome on the claim (best effort: the claim's existence alone already blocks a second grant). */
function recordOutcome(path, data) {
  try {
    const prev = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, `${JSON.stringify({ ...prev, ...data })}\n`);
  } catch { /* the claim stays; that is what matters */ }
}

/**
 * The child env that makes `gh` act as the operator: the real `gh` first on PATH (no App shim, which would
 * swap the App token back in), the operator's stored login token as GH_TOKEN, no GITHUB_TOKEN.
 * @returns {{ok:true, env:object} | {ok:false, why:string}}
 */
export function operatorGhEnv({ env = process.env, home = homedir(), realGh = resolveRealGhBinary(), token } = {}) {
  if (!realGh) return { ok: false, why: 'no real gh binary on PATH' };
  const personal = token !== undefined ? token : personalGhToken({ bin: realGh });
  if (!personal) return { ok: false, why: "no operator gh login token" };
  const shimRoot = join(home, '.claude', 'github-app-token');
  const path = [dirname(realGh), ...String(env.PATH ?? '').split(delimiter)
    .filter((d) => d && !resolve(d).startsWith(`${shimRoot}`))].join(delimiter);
  const out = { ...env, PATH: path, GH_TOKEN: personal };
  delete out.GITHUB_TOKEN;
  return { ok: true, env: out };
}

/** Run the declared `extend-rounds` operation once, synchronously, as the operator. */
export function runExtendRounds({ repo, pr, reason, env, exec = execFileSync, root = ROOT }) {
  const out = exec(process.execPath, [join(root, 'scripts/operations/run.mjs'), 'extend-rounds',
    `--repo=${repo}`, `--pr=${pr}`, '--by=1', `--actor=${AUTO_GRANT_ACTOR}`, `--channel=${AUTO_GRANT_CHANNEL}`,
    `--reason=${reason}`, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  const result = JSON.parse(String(out));
  if (result?.applied !== 1) throw new Error(`extend-rounds run ${result?.runId ?? '?'} applied ${result?.applied ?? 'no'} effect(s)`);
  return { runId: result.runId };
}

/**
 * The hook. Returns null when the note is not one the ruling covers at all (no reads made), else one of:
 *   { action: 'granted', count, max, key, runId }        — skip the needs-you event; the cap is raised
 *   { action: 'cap-reached', used, max, reason }          — publish with this reason
 *   { action: 'skip', why }                               — publish unchanged
 *   { action: 'failed', why }                             — publish unchanged (claim kept; a person decides)
 */
export function autoRoundGrant({ repo, note, pr }, {
  settings = readAutoRoundGrantSettings(), readThread = readExtensionThread, readNet = readHumanSurfaceNetFiles,
  claim = claimLimitHit, policy = () => readGithubAuthPolicy(), ghEnv = operatorGhEnv, extend = runExtendRounds,
} = {}) {
  const screen = screenAutoGrantNote({ note, repo, pr, settings });
  if (!screen.ok) return screen.why === 'not a round-cap note' || screen.why === 'disabled' ? null : { action: 'skip', why: screen.why };
  const { slug } = screen;
  const head = pr.headRefOid;
  let thread;
  try { thread = readThread(slug, note.prNumber); } catch (e) { return { action: 'skip', why: `thread unreadable: ${firstLine(e)}` }; }
  const netRead = readNet({ repo: slug, number: note.prNumber, headRefOid: head });
  const used = countAutoRoundGrants(thread?.comments, { repo: slug, pr: note.prNumber });
  const verdict = decideAutoGrant({ netRead, used, max: settings.maxPerPr, state: thread?.state });
  if (verdict.action === 'skip') return verdict;
  if (verdict.action === 'cap-reached') return { ...verdict, reason: capReachedReason({ used, max: settings.maxPerPr, text: note.text }) };
  if (!personalAllowed(policy(), AUTO_GRANT_PERSONAL_EXCEPTION)) {
    return { action: 'skip', why: `github.auth has no "${AUTO_GRANT_PERSONAL_EXCEPTION}" personal exception` };
  }
  const operator = ghEnv();
  if (!operator.ok) return { action: 'skip', why: operator.why };
  const key = autoGrantKey({ repo: slug, note, head });
  const claimed = claim(key);
  if (!claimed.claimed) return { action: 'skip', why: `already claimed: ${key}` };
  const reason = autoGrantReason({ note, head, count: verdict.count, max: verdict.max });
  try {
    const { runId } = extend({ repo: slug, pr: note.prNumber, reason, env: operator.env });
    recordOutcome(claimed.path, { outcome: 'granted', runId, count: verdict.count, max: verdict.max });
    return { action: 'granted', count: verdict.count, max: verdict.max, key, runId };
  } catch (e) {
    recordOutcome(claimed.path, { outcome: 'failed', error: firstLine(e) });
    return { action: 'failed', why: firstLine(e), key };
  }
}
