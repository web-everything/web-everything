/**
 * @file scripts/lib/red-main-freeze-shared.mjs
 * @description THE SHARED COPY OF THE RED-MAIN FREEZE (card xyd06qo). The freeze marker the drain consults lives
 *   on the drain host only (`we:scripts/readiness/red-main-remediation.mjs`), so the required `merge-gate` CI check
 *   (`we:scripts/merge-gate-check.mjs`) could never see it and failed closed on every PR. Every freeze / unfreeze
 *   now ALSO publishes the state to a shared `ops/*` git branch (same transport as `ops/review-requests`:
 *   `./git-transport-branch.mjs`), and CI reads that branch.
 *
 *   - WRITER: `red-main-remediation.mjs freeze|decide --apply` calls {@link publishFreezeFromCli} FIRST (so a failure
 *     between the two writes can only leave the shared copy frozen, never clear), THEN writes the local marker.
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
 *   ({@link PUBLISH_ATTEMPTS}), so a rejection no longer leaves CI reading a stale clear. Only a writer that cannot
 *   reach origin at all for every attempt still fails: the local marker stays (the drain still stops) and the CLI
 *   exits non-zero with a loud line naming the retry (`publish` after a raise, `unfreeze` after a clear). Nothing on
 *   that host can reach CI then; the drain-side retry/refusal for that residual is card x09e2bn.
 *
 *   IMPURE (git, fs) — every side effect is injectable.
 */
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageOnTransportBranch, readFromTransportBranch } from './git-transport-branch.mjs';
import { loadMergeDeliveryPolicy } from './merge-delivery-policy.mjs';
import { readSettings } from './settings-files.mjs';

export const SHARED_FREEZE_FILE = 'red-main-freeze.json';
/** How many times the CLI hook tries to land one publish before it reports failure. */
export const PUBLISH_ATTEMPTS = 4;
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

/** Push the state to the shared branch. Throws on any git failure (the caller decides what that means). */
export function publishSharedFreeze({ marker, clear = false, board = REPO_ROOT, branch = resolveFreezeBranch(), run, now, host, transport = {} } = {}) {
  if (!/^ops\/[a-z0-9][a-z0-9-]{0,63}$/.test(String(branch))) throw new Error(`red-main-freeze-shared: refusing to publish to "${branch}" — only an ops/<slug> branch`);
  // "No marker" is NOT "cleared": a clone without the gitignored local marker (or one holding a corrupt file) reads
  // `null`, and mirroring that would silently clear a standing freeze. Only an explicit clear may publish frozen:false.
  if (marker == null && clear !== true) throw new Error('red-main-freeze-shared: refusing to publish frozen:false without an explicit clear (no local freeze marker is not a clear)');
  const doc = buildSharedFreezeDoc(marker, { ...(now ? { now } : {}), ...(host ? { host } : {}) });
  const staged = stageOnTransportBranch({
    board,
    branch,
    files: [{ path: SHARED_FREEZE_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }],
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
 * @returns {Promise<{ok:boolean, skipped?:string, branch?:string, pushed?:boolean, error?:string}>}
 */
export async function publishFreezeFromCli({ marker, clear = false, env = process.env, stderr = (s) => process.stderr.write(s), publish = publishSharedFreeze, setExitCode = (c) => { process.exitCode = c; }, attempts = PUBLISH_ATTEMPTS, backoffMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if ((env.VITEST || env.WE_UNDER_TEST) && !env.WE_RED_MAIN_FREEZE_SHARED_BOARD) return { ok: true, skipped: 'test-run' };
  // Explicit off switch for a child CLI that must clear VITEST/WE_UNDER_TEST (they also pick the freeze-marker path) yet must never push the live ops branch.
  if (env.WE_RED_MAIN_FREEZE_SHARED === 'off' && !env.WE_RED_MAIN_FREEZE_SHARED_BOARD) return { ok: true, skipped: 'disabled' };
  if (marker == null && clear !== true) {
    stderr('red-main freeze: ✗ refusing to publish — no valid local freeze marker here (missing or corrupt), and "no marker" is not a clear. The shared copy is unchanged. To clear it run: node scripts/readiness/red-main-remediation.mjs unfreeze\n');
    setExitCode(1);
    return { ok: false, refused: 'no-marker' };
  }
  // A REJECTED raise (a raced writer, a refusing hook, a blip) must not leave CI reading a stale clear: every attempt
  // re-fetches the tip and re-stages onto it, so a non-fast-forward resolves itself. Bounded; the refusals above
  // never reach here, so only git failures are retried. A CLEAR is tried once: a rejected clear leaves CI frozen
  // (fail closed), and retrying it could overwrite the very freeze another writer just pushed to cause the reject.
  const tries = clear === true ? 1 : Math.max(1, attempts);
  let error;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const r = publish({ marker, ...(clear === true ? { clear: true } : {}), ...(env.WE_RED_MAIN_FREEZE_SHARED_BOARD ? { board: env.WE_RED_MAIN_FREEZE_SHARED_BOARD } : {}) });
      stderr(`red-main freeze: shared copy ${r.pushed ? 'published' : 'already current'} on ${r.branch} (frozen=${r.doc.frozen})${attempt > 1 ? ` after ${attempt} attempts` : ''}\n`);
      return { ok: true, branch: r.branch, pushed: r.pushed, attempts: attempt };
    } catch (e) {
      error = String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 300);
      if (attempt < tries) {
        stderr(`red-main freeze: shared publish attempt ${attempt}/${tries} failed (${error}); retrying\n`);
        await sleep(backoffMs * attempt);
      }
    }
  }
  stderr(`red-main freeze: ✗ the SHARED copy was NOT published${tries > 1 ? ` after ${tries} attempts` : ''} (${error}); the local marker is as ${clear === true ? 'cleared' : 'written'}. CI's merge-gate may show the previous state — re-run: node scripts/readiness/red-main-remediation.mjs ${clear === true ? 'unfreeze' : 'publish'}\n`);
  setExitCode(1);
  return { ok: false, error, attempts: tries };
}

/**
 * Read the shared freeze for the merge-gate. Never throws; anything unreadable is `{source, error}` (fail closed).
 * @returns {{source:string, frozen?:boolean, reason?:string|null, at?:string|null, publishedAt?:string|null, error?:string}}
 */
export function readSharedFreeze({ board = REPO_ROOT, branch = resolveFreezeBranch(), run } = {}) {
  const source = `${branch}:${SHARED_FREEZE_FILE}`;
  let text;
  try { text = readFromTransportBranch({ board, branch, paths: [SHARED_FREEZE_FILE], ...(run ? { run } : {}) })[SHARED_FREEZE_FILE]; }
  catch (e) { return { source, error: `branch unreadable: ${String(e?.stderr || e?.message || e).trim().split('\n').pop().slice(0, 200)}` }; }
  if (text == null) return { source, error: `${SHARED_FREEZE_FILE} not on ${branch}` };
  let doc;
  try { doc = JSON.parse(text); } catch { return { source, error: `${SHARED_FREEZE_FILE} is not JSON` }; }
  if (!doc || typeof doc.frozen !== 'boolean') return { source, error: `${SHARED_FREEZE_FILE} has no boolean "frozen"` };
  return { source, frozen: doc.frozen, reason: doc.reason ?? null, at: doc.at ?? null, publishedAt: doc.publishedAt ?? null };
}
