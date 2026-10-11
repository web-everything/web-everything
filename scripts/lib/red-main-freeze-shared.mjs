/**
 * @file scripts/lib/red-main-freeze-shared.mjs
 * @description THE SHARED COPY OF THE RED-MAIN FREEZE (card xyd06qo). The freeze marker the drain consults lives
 *   on the drain host only (`we:scripts/readiness/red-main-remediation.mjs`), so the required `merge-gate` CI check
 *   (`we:scripts/merge-gate-check.mjs`) could never see it and failed closed on every PR. Every freeze / unfreeze
 *   now ALSO publishes the state to a shared `ops/*` git branch (same transport as `ops/review-requests`:
 *   `./git-transport-branch.mjs`), and CI reads that branch.
 *
 *   - WRITER: `red-main-remediation.mjs freeze` (the operator's MANUAL stop) writes the local marker FIRST (the drain
 *     stops at once; no publish can delay it), THEN calls {@link publishFreezeFromCli} — even when the local write
 *     failed. `decide --apply` (an AUTOMATIC freeze) writes the local marker only and publishes nothing: main's own CI
 *     is the merge-gate's authority for a red main, and a published copy would hold even the main-fix PR.
 *     `unfreeze` clears locally, then publishes an EXPLICIT clear (`clear: true`). `publish` republishes the local
 *     freeze and REFUSES when there is none: "no marker" (a clone without the gitignored file, or a corrupt one) is
 *     never a clear, so only `unfreeze` can publish `frozen:false`. The local marker stays the drain's own source.
 *   - READER: {@link readSharedFreeze} → the merge-gate's MANUAL-freeze input. Since the operator ruling of 2026-10-11
 *     the gate's authority for "is main red" is main's OWN CI status, read from GitHub (`merge-gate-check.mjs`
 *     `readMainCiFact`), so a publisher that keeps failing can never hide a red main; this copy only adds manual
 *     freezes. Anything it cannot read or trust (no branch, no file, bad JSON, no boolean `frozen`) is
 *     `{source, error}`, which the evaluator turns into FAIL CLOSED — never into "not frozen". Its text fields are
 *     flattened ({@link flatText}) before they reach a log.
 *   - The branch name is a policy-cascade knob: `mergeDelivery.redMainFreezeBranch` (default `ops/red-main-freeze`),
 *     validated to `ops/<slug>` so the writer can never push to main or a lane.
 *
 *   A REJECTED push (a raced writer, a refusing hook, a transient blip) is retried, re-fetching the tip each time
 *   ({@link PUBLISH_ATTEMPTS}, within a total deadline), so a transient rejection no longer leaves CI reading a stale
 *   clear. Every git call carries a timeout ({@link GIT_TIMEOUT_MS}), capped by the time left before the publish deadline,
 *   so a hung push or fetch — the first one included — fails by the deadline instead of blocking; the reader turns a
 *   timeout into `{error}` (fail closed). A
 *   clear is computed against the fresh tip and refuses to wipe a DIFFERENT freeze (another writer's, pushed meanwhile). The
 *   residual is EVERY attempt failing, for any reason (origin unreachable, a push policy that refuses each time): the
 *   local marker stays (the drain still stops) and the CLI exits non-zero with a loud line naming the retry
 *   (`publish` after a raise, `unfreeze` after a clear). The drain-side detect/retry/refuse for that is card x09e2bn.
 *
 *   IMPURE (git, fs) — every side effect is injectable.
 */
import { execFileSync } from 'node:child_process';
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

/**
 * The transport's git runner, with a hard timeout (the transport's own default has none). `deadlineAt` (epoch ms, the
 * publish's total deadline) caps each call at the time LEFT, so even a hung FIRST call ends at the deadline, and a call
 * that would start past it throws at once. `worktree prune` (local cleanup in the transport's `finally`) keeps the plain
 * per-call timeout: skipping it would leave a stale worktree registration for the next run.
 */
export function timedGit(timeoutMs = GIT_TIMEOUT_MS, { deadlineAt = null, now = Date.now, exec = execFileSync } = {}) {
  return (args, opts = {}) => {
    const cleanup = args[0] === 'worktree' && args[1] === 'prune';
    const left = deadlineAt == null || cleanup ? timeoutMs : Math.min(timeoutMs, deadlineAt - now());
    if (left <= 0) throw new Error(`red-main-freeze-shared: publish deadline reached before git ${String(args[0])}`);
    return exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER, killSignal: 'SIGTERM', ...opts, timeout: left }); // SIGTERM, not SIGKILL: git then removes its ref/packed-refs locks, so a timeout never wedges the next run
  };
}
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The policy-cascade branch name (standard → platform → tool). Never throws. */
export function resolveFreezeBranch({ toolSettings } = {}) {
  let settings = toolSettings;
  if (settings === undefined) { try { settings = readSettings(); } catch { settings = undefined; } }
  return loadMergeDeliveryPolicy({ toolSettings: settings }).redMainFreezeBranch;
}

/** Who the shared doc says published it: a coarse actor label, never the drain host's name (the branch is repo-readable). */
export const SHARED_FREEZE_ACTOR = 'red-main-remediation';

/** The `reason` the pre-`kind` `decide --apply` stamped on its (automatic) marker. */
const LEGACY_AUTO_REASON = 'decide --apply';

/**
 * A LOCAL marker's kind, the one rule every reader uses. An explicit `kind` wins. A marker written before `kind` existed
 * is automatic only when it is the old `decide --apply` marker (that exact reason); any other kind-less marker is an
 * operator `freeze` and stays MANUAL (fail closed). Pure.
 * @returns {'auto'|'manual'}
 */
export function freezeKindOf(marker) {
  if (marker?.kind === 'auto') return 'auto';
  if (marker?.kind == null && marker?.reason === LEGACY_AUTO_REASON) return 'auto';
  return 'manual';
}

/** The shared document for a local marker (`null` ⇒ not frozen). Pure. */
export function buildSharedFreezeDoc(marker, { now = () => new Date().toISOString(), host = SHARED_FREEZE_ACTOR } = {}) {
  const frozen = marker != null;
  return {
    schema: 1,
    frozen,
    reason: frozen ? String(marker.reason ?? 'frozen') : null,
    at: frozen ? (marker.at ?? null) : null,
    redRef: frozen ? (marker.redRef ?? 'main') : null,
    mergeSha: frozen ? (marker.mergeSha ?? null) : null,
    kind: frozen ? 'manual' : null, // the shared copy carries MANUAL freezes only (operator ruling 2026-10-11)
    publishedAt: now(),
    publishedBy: host,
  };
}

/** A deterministic refusal (never a git failure): the CLI hook does not retry it. */
const refusal = (message) => Object.assign(new Error(message), { refusal: true });

/**
 * Branch text is untrusted (anyone who can push the ops branch): control characters, CR/LF and U+2028/2029 become
 * spaces (no `::workflow-command::` line can start inside a log line) and the length is capped. Pure.
 */
export function flatText(v, max = 200) {
  return [...String(v)].map((c) => { const n = c.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159) || n === 0x2028 || n === 0x2029 ? ' ' : c; }).join('').slice(0, max);
}

/**
 * Push the state to the shared branch. Throws on any git failure (the caller decides what that means).
 * `lifted` (a clear only): the local marker the clear lifts. The clear is computed against the FRESH tip and refused
 * when the tip carries a different freeze — one another writer pushed after this clear's local check, which a plain
 * overwrite would wipe while that writer's local marker stays frozen. `lifted` absent ⇒ an operator clear from a clone
 * with no marker: nothing to compare, so it clears (it is explicit).
 */
export function publishSharedFreeze({ marker, clear = false, lifted, board = REPO_ROOT, branch = resolveFreezeBranch(), gitTimeoutMs = GIT_TIMEOUT_MS, deadlineAt = null, run = timedGit(gitTimeoutMs, { deadlineAt }), now, host, transport = {} } = {}) {
  if (!/^ops\/[a-z0-9][a-z0-9-]{0,63}$/.test(String(branch))) throw refusal(`red-main-freeze-shared: refusing to publish to "${branch}" — only an ops/<slug> branch`);
  // "No marker" is NOT "cleared": a clone without the gitignored local marker (or one holding a corrupt file) reads
  // `null`, and mirroring that would silently clear a standing freeze. Only an explicit clear may publish frozen:false.
  if (marker == null && clear !== true) throw refusal('red-main-freeze-shared: refusing to publish frozen:false without an explicit clear (no local freeze marker is not a clear)');
  // An automatic freeze is never published: it would read as a manual stop and hold even the main-fix PR.
  if (marker != null && freezeKindOf(marker) === 'auto') throw refusal('red-main-freeze-shared: refusing to publish an automatic freeze (the shared copy carries manual freezes only; main CI is the authority)');
  const doc = buildSharedFreezeDoc(marker, { ...(now ? { now } : {}), ...(host ? { host } : {}) });
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  const content = clear === true && lifted != null
    ? ({ existing }) => {
      let tip = null;
      try { tip = existing == null ? null : JSON.parse(existing); } catch { tip = null; } // a corrupt copy is not a freeze to protect
      if (tip?.frozen === true && (tip.at ?? null) !== (lifted.at ?? null)) {
        const flat = (v) => flatText(v ?? '?', 120);
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
  // A skip is never silent: a real `freeze` run from a shell that happens to export one of these must say the shared
  // copy (which CI reads) was not touched.
  const skip = (skipped, why) => { stderr(`red-main freeze: ⚠ the shared copy was NOT published — ${why}. CI's merge-gate does not see this ${clear === true ? 'clear' : 'freeze'}; unset it and re-run ${clear === true ? 'unfreeze' : 'publish'} if that was not intended.\n`); return { ok: true, skipped }; };
  if ((env.VITEST || env.WE_UNDER_TEST) && !env.WE_RED_MAIN_FREEZE_SHARED_BOARD) return skip('test-run', 'inside a test run (VITEST / WE_UNDER_TEST is set)');
  // Explicit off switch for a child CLI that must clear VITEST/WE_UNDER_TEST (they also pick the freeze-marker path) yet must never push the live ops branch.
  if (env.WE_RED_MAIN_FREEZE_SHARED === 'off' && !env.WE_RED_MAIN_FREEZE_SHARED_BOARD) return skip('disabled', 'WE_RED_MAIN_FREEZE_SHARED=off');
  if (marker == null && clear !== true) {
    stderr('red-main freeze: ✗ refusing to publish — no valid local freeze marker here (missing or corrupt), and "no marker" is not a clear. The shared copy is unchanged. To clear it run: node scripts/readiness/red-main-remediation.mjs unfreeze\n');
    setExitCode(1);
    return { ok: false, refused: 'no-marker' };
  }
  // A REJECTED raise (a raced writer, a refusing hook, a blip) must not leave CI reading a stale clear: every attempt
  // re-fetches the tip and re-stages onto it, so a non-fast-forward resolves itself. Bounded by count AND by a total
  // deadline: checked between attempts, AND passed down as `deadlineAt` so each git call is capped at the time left
  // (min of that and GIT_TIMEOUT_MS) — a hung first call ends at the deadline too. A deterministic refusal is never retried. A CLEAR is tried once: a
  // rejected clear leaves CI frozen (fail closed), and a clear never overwrites a different freeze (see `lifted`).
  const tries = clear === true ? 1 : Math.max(1, attempts);
  const envMs = (name) => { const n = Number(env[name]); return Number.isInteger(n) && n > 0 ? n : null; };
  const gitTimeoutMs = envMs('WE_RED_MAIN_FREEZE_SHARED_GIT_TIMEOUT_MS') ?? GIT_TIMEOUT_MS;
  deadlineMs = envMs('WE_RED_MAIN_FREEZE_SHARED_DEADLINE_MS') ?? deadlineMs;
  const started = nowMs();
  // The git calls run on the wall clock: their cap is the deadline in real time, so a hung FIRST call ends there too.
  const deadlineAt = Date.now() + deadlineMs;
  let error;
  let attempt = 0;
  while (attempt < tries) {
    attempt += 1;
    try {
      const r = publish({ marker, gitTimeoutMs, deadlineAt, ...(clear === true ? { clear: true, ...(lifted != null ? { lifted } : {}) } : {}), ...(env.WE_RED_MAIN_FREEZE_SHARED_BOARD ? { board: env.WE_RED_MAIN_FREEZE_SHARED_BOARD } : {}) });
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
  const clean = (v) => (v == null ? null : flatText(v)); // printed to the CI log and the hold reason: never raw
  // `kind`: only an explicit 'auto' is automatic; anything else (absent, an old doc, junk) counts as MANUAL (fail closed).
  return { source, frozen: doc.frozen, kind: doc.kind === 'auto' ? 'auto' : 'manual', reason: clean(doc.reason), at: clean(doc.at), publishedAt: clean(doc.publishedAt) };
}
