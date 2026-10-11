/**
 * @file scripts/lib/red-main-freeze-shared.mjs
 * @description THE SHARED COPY OF THE RED-MAIN FREEZE (card xyd06qo). The freeze marker the drain consults lives
 *   on the drain host only (`we:scripts/readiness/red-main-remediation.mjs`), so the required `merge-gate` CI check
 *   (`we:scripts/merge-gate-check.mjs`) could never see it and failed closed on every PR. Every freeze / unfreeze
 *   now ALSO publishes the state to a shared `ops/*` git branch (same transport as `ops/review-requests`:
 *   `./git-transport-branch.mjs`), and CI reads that branch.
 *
 *   - WRITER: `red-main-remediation.mjs freeze|decide --apply` writes the local marker FIRST (the drain stops at once;
 *     no publish can delay it), THEN calls {@link publishFreezeFromCli} — even when the local write failed.
 *     `unfreeze` clears locally, then publishes an EXPLICIT clear (`clear: true`). `publish` republishes the local
 *     freeze and REFUSES when there is none: "no marker" (a clone without the gitignored file, or a corrupt one) is
 *     never a clear, so only `unfreeze` can publish `frozen:false`. The local marker stays the drain's own source.
 *   - READER: {@link readSharedFreeze} → `facts.redMain = {source, frozen, reason}` for the merge-gate evaluator.
 *     Anything it cannot read or trust (no branch, no file, bad JSON, no boolean `frozen`) is `{source, error}`,
 *     which the evaluator turns into FAIL CLOSED — never into "not frozen".
 *   - The branch name is a policy-cascade knob: `mergeDelivery.redMainFreezeBranch` (default `ops/red-main-freeze`),
 *     validated to `ops/<slug>` so the writer can never push to main or a lane.
 *
 *   A REJECTED push (a raced writer, a refusing hook, a transient blip) is retried, re-fetching the tip each time
 *   ({@link PUBLISH_ATTEMPTS}, within a total deadline), so a transient rejection no longer leaves CI reading a stale
 *   clear. Every git call carries a timeout ({@link GIT_TIMEOUT_MS}), so a hung push or fetch fails instead of
 *   blocking; the reader turns a timeout into `{error}` (fail closed). A
 *   clear is computed against the fresh tip and refuses to wipe a DIFFERENT freeze (another writer's, pushed meanwhile). The
 *   residual is EVERY attempt failing, for any reason (origin unreachable, a push policy that refuses each time): the
 *   local marker stays (the drain still stops) and the CLI exits non-zero with a loud line naming the retry
 *   (`publish` after a raise, `unfreeze` after a clear). The drain-side detect/retry/refuse for that is card x09e2bn.
 *
 *   IMPURE (git, fs) — every side effect is injectable.
 */
import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageOnTransportBranch, readFromTransportBranch } from './git-transport-branch.mjs';
import { loadMergeDeliveryPolicy } from './merge-delivery-policy.mjs';
import { readSettings } from './settings-files.mjs';

export const SHARED_FREEZE_FILE = 'red-main-freeze.json';
/** How many times the CLI hook tries to land one publish before it reports failure. */
export const PUBLISH_ATTEMPTS = 4;
/** Per-git-call ceiling: a hung fetch/push FAILS (writer: reported + exit 1; reader: `{error}`, fail closed). */
export const GIT_TIMEOUT_MS = 20_000;
/** Captured git output cap: the freeze doc is a few hundred bytes; anything near this is not our file (fail). */
const GIT_MAX_BUFFER = 4 * 1024 * 1024;

/** The transport's git runner, with a hard timeout (the transport's own default has none). */
export function timedGit(timeoutMs = GIT_TIMEOUT_MS) {
  return (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER, timeout: timeoutMs, killSignal: 'SIGTERM', ...opts }); // SIGTERM, not SIGKILL: git then removes its ref/packed-refs locks, so a timeout never wedges the next run
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The policy-cascade branch name (standard → platform → tool). Never throws. */
export function resolveFreezeBranch({ toolSettings } = {}) {
  let settings = toolSettings;
  if (settings === undefined) { try { settings = readSettings(); } catch { settings = undefined; } }
  return loadMergeDeliveryPolicy({ toolSettings: settings }).redMainFreezeBranch;
}

/** The shared document for a local marker (`null` ⇒ not frozen). Pure. */
export function buildSharedFreezeDoc(marker, { now = () => new Date().toISOString(), host = hostname() } = {}) {
  const frozen = marker != null;
  return {
    schema: 1,
    frozen,
    reason: frozen ? String(marker.reason ?? 'frozen') : null,
    at: frozen ? (marker.at ?? null) : null,
    redRef: frozen ? (marker.redRef ?? 'main') : null,
    mergeSha: frozen ? (marker.mergeSha ?? null) : null,
    publishedAt: now(),
    publishedBy: host,
  };
}

/** A deterministic refusal (never a git failure): the CLI hook does not retry it. */
const refusal = (message) => Object.assign(new Error(message), { refusal: true });

/**
 * Push the state to the shared branch. Throws on any git failure (the caller decides what that means).
 * `lifted` (a clear only): the local marker the clear lifts. The clear is computed against the FRESH tip and refused
 * when the tip carries a different freeze — one another writer pushed after this clear's local check, which a plain
 * overwrite would wipe while that writer's local marker stays frozen. `lifted` absent ⇒ an operator clear from a clone
 * with no marker: nothing to compare, so it clears (it is explicit).
 */
export function publishSharedFreeze({ marker, clear = false, lifted, board = REPO_ROOT, branch = resolveFreezeBranch(), gitTimeoutMs = GIT_TIMEOUT_MS, run = timedGit(gitTimeoutMs), now, host, transport = {} } = {}) {
  if (!/^ops\/[a-z0-9][a-z0-9-]{0,63}$/.test(String(branch))) throw refusal(`red-main-freeze-shared: refusing to publish to "${branch}" — only an ops/<slug> branch`);
  // "No marker" is NOT "cleared": a clone without the gitignored local marker (or one holding a corrupt file) reads
  // `null`, and mirroring that would silently clear a standing freeze. Only an explicit clear may publish frozen:false.
  if (marker == null && clear !== true) throw refusal('red-main-freeze-shared: refusing to publish frozen:false without an explicit clear (no local freeze marker is not a clear)');
  const doc = buildSharedFreezeDoc(marker, { ...(now ? { now } : {}), ...(host ? { host } : {}) });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const content = clear === true && lifted != null
    ? ({ existing }) => {
      let tip = null;
      try { tip = existing == null ? null : JSON.parse(existing); } catch { tip = null; } // a corrupt copy is not a freeze to protect
      if (tip?.frozen === true && (tip.at ?? null) !== (lifted.at ?? null)) {
        const flat = (v) => [...String(v ?? '?')].map((c) => { const n = c.charCodeAt(0); return n < 32 || n === 127 || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').slice(0, 120); // branch text is untrusted (newlines, CR, line separators)
        throw refusal(`red-main-freeze-shared: refusing to clear — the shared copy carries a DIFFERENT freeze (at ${flat(tip.at)}: ${flat(tip.reason)}) than the one lifted here (at ${flat(lifted.at)}); if that one should be lifted too, re-run unfreeze (no local marker remains, so it clears)`);
      }
      return text;
    }
    : text;
  const staged = stageOnTransportBranch({
    board,
    branch,
    files: [{ path: SHARED_FREEZE_FILE, content }],
    message: `red-main freeze: ${doc.frozen ? `FROZEN — ${doc.reason}` : 'clear'} (xyd06qo)`,
    createIfAbsent: true,
    allowRef: `refs/heads/${branch}`,
    ...(run ? { run } : {}),
    ...transport, // test seams: mkdir / write / read / rm / now
  });
  return { branch, doc, ...staged };
}

/**
 * The CLI hook (`red-main-remediation.mjs`): mirror the local marker, report, never throw. Skipped inside a test
 * run unless a board is injected, so no test can push the live branch.
 * `onFailedAttempt` (optional) runs after every failed raise attempt, BEFORE any wait; its own throw is reported, never
 * allowed to stop the retries. (The CLI writes its local marker before calling this hook at all.)
 * @returns {Promise<{ok:boolean, skipped?:string, refused?:string, branch?:string, pushed?:boolean, error?:string, attempts?:number}>}
 */
export async function publishFreezeFromCli({ marker, clear = false, lifted, env = process.env, stderr = (s) => process.stderr.write(s), publish = publishSharedFreeze, setExitCode = (c) => { process.exitCode = c; }, attempts = PUBLISH_ATTEMPTS, backoffMs = 250, deadlineMs = 60_000, nowMs = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onFailedAttempt = null } = {}) {
  if ((env.VITEST || env.WE_UNDER_TEST) && !env.WE_RED_MAIN_FREEZE_SHARED_BOARD) return { ok: true, skipped: 'test-run' };
  // Explicit off switch for a child CLI that must clear VITEST/WE_UNDER_TEST (they also pick the freeze-marker path) yet must never push the live ops branch.
  if (env.WE_RED_MAIN_FREEZE_SHARED === 'off' && !env.WE_RED_MAIN_FREEZE_SHARED_BOARD) return { ok: true, skipped: 'disabled' };
  if (marker == null && clear !== true) {
    stderr('red-main freeze: ✗ refusing to publish — no valid local freeze marker here (missing or corrupt), and "no marker" is not a clear. The shared copy is unchanged. To clear it run: node scripts/readiness/red-main-remediation.mjs unfreeze\n');
    setExitCode(1);
    return { ok: false, refused: 'no-marker' };
  }
  // A REJECTED raise (a raced writer, a refusing hook, a blip) must not leave CI reading a stale clear: every attempt
  // re-fetches the tip and re-stages onto it, so a non-fast-forward resolves itself. Bounded by count AND by a total
  // deadline checked between attempts (each git call is separately capped by GIT_TIMEOUT_MS). A deterministic refusal is never retried. A CLEAR is tried once: a
  // rejected clear leaves CI frozen (fail closed), and a clear never overwrites a different freeze (see `lifted`).
  const tries = clear === true ? 1 : Math.max(1, attempts);
  const envMs = (name) => { const n = Number(env[name]); return Number.isInteger(n) && n > 0 ? n : null; };
  const gitTimeoutMs = envMs('WE_RED_MAIN_FREEZE_SHARED_GIT_TIMEOUT_MS') ?? GIT_TIMEOUT_MS;
  deadlineMs = envMs('WE_RED_MAIN_FREEZE_SHARED_DEADLINE_MS') ?? deadlineMs;
  const started = nowMs();
  let error;
  let attempt = 0;
  while (attempt < tries) {
    attempt += 1;
    try {
      const r = publish({ marker, gitTimeoutMs, ...(clear === true ? { clear: true, ...(lifted != null ? { lifted } : {}) } : {}), ...(env.WE_RED_MAIN_FREEZE_SHARED_BOARD ? { board: env.WE_RED_MAIN_FREEZE_SHARED_BOARD } : {}) });
      stderr(`red-main freeze: shared copy ${r.pushed ? 'published' : 'already current'} on ${r.branch} (frozen=${r.doc.frozen})${attempt > 1 ? ` after ${attempt} attempts` : ''}\n`);
      return { ok: true, branch: r.branch, pushed: r.pushed, attempts: attempt };
    } catch (e) {
      error = String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
      if (e?.refusal === true) {
        stderr(`red-main freeze: ✗ ${error}. The shared copy is unchanged.\n`);
        setExitCode(1);
        return { ok: false, refused: 'refusal', error, attempts: attempt };
      }
      if (onFailedAttempt) { try { onFailedAttempt({ attempt, error }); } catch (h) { stderr(`red-main freeze: ✗ ${String(h?.message || h).split('\n')[0].slice(0, 300)}\n`); } }
      if (attempt >= tries) break;
      const wait = backoffMs * attempt;
      if (nowMs() - started + wait > deadlineMs) { stderr(`red-main freeze: shared publish retry deadline (${deadlineMs}ms) reached\n`); break; }
      stderr(`red-main freeze: shared publish attempt ${attempt}/${tries} failed (${error}); retrying\n`);
      await sleep(wait);
    }
  }
  stderr(`red-main freeze: ✗ the SHARED copy was NOT published${attempt > 1 ? ` after ${attempt} attempts` : ''} (${error}); the local marker is as ${clear === true ? 'cleared' : 'written'}. CI's merge-gate may show the previous state — re-run: node scripts/readiness/red-main-remediation.mjs ${clear === true ? 'unfreeze' : 'publish'}\n`);
  setExitCode(1);
  return { ok: false, error, attempts: attempt };
}

/**
 * Read the shared freeze for the merge-gate. Never throws; anything unreadable is `{source, error}` (fail closed).
 * @returns {{source:string, frozen?:boolean, reason?:string|null, at?:string|null, publishedAt?:string|null, error?:string}}
 */
export function readSharedFreeze({ board = REPO_ROOT, branch = resolveFreezeBranch(), run = timedGit() } = {}) {
  const source = `${branch}:${SHARED_FREEZE_FILE}`;
  let text;
  try { text = readFromTransportBranch({ board, branch, paths: [SHARED_FREEZE_FILE], run })[SHARED_FREEZE_FILE]; }
  catch (e) { return { source, error: `branch unreadable: ${String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 200)}` }; }
  if (text == null) return { source, error: `${SHARED_FREEZE_FILE} not on ${branch}` };
  let doc;
  try { doc = JSON.parse(text); } catch { return { source, error: `${SHARED_FREEZE_FILE} is not JSON` }; }
  if (!doc || typeof doc.frozen !== 'boolean') return { source, error: `${SHARED_FREEZE_FILE} has no boolean "frozen"` };
  return { source, frozen: doc.frozen, reason: doc.reason ?? null, at: doc.at ?? null, publishedAt: doc.publishedAt ?? null };
}
