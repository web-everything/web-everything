/**
 * @file scripts/lib/prevention-landing-job.mjs
 * @description THE SHARED DETACHED PREVENTION-CARD LANDING SEAM (#4493). Any caller that must file an owed
 * prevention-guard backlog card WITHOUT writing into whatever checkout it happens to be running in (a read-only
 * daemon clone, the primary checkout, or any other non-lane tree) spawns `we:scripts/operations/land-
 * prevention-card.mjs` (#4317) through {@link spawnPreventionLandingJob} rather than shelling `file-item`
 * in-process there.
 *
 * EXTRACTED HERE (#4493), out of `we:scripts/review-set-label.mjs#fileApprovalPreventionCard` (#4317's own
 * original, single caller), because a SECOND caller had the exact same bug: `we:scripts/operations/review-
 * loop-cli.mjs#fileItemForPrevention` still drove `file-item` IN PROCESS, against whatever checkout is running
 * the review daemon (routinely `~/workspace/wev-review-daemon`, never committed, never pushed — 74 untracked
 * `backlog/x*.md` cards there as of 2026-09-29, orphaned by BOTH filing callers, not only the one #4317 fixed).
 * Two callers, one bug, one fix: this file is now the ONE place either seam builds its `file-item` argv and
 * spawns the landing job, so a future third caller reuses it too instead of re-deriving a third copy.
 *
 * PURE-ISH, IMPURE ONLY AT THE ONE SPAWN. {@link spawnPreventionLandingJob} validates nothing about WHAT is
 * being filed (that is each caller's own pure builder — `we:scripts/lib/approval-prevention-notice.mjs
 * #buildApprovalPreventionFilingInput` for the approval-time caller, `we:scripts/lib/review-loop-policy.mjs
 * #buildPreventionFilingInput` for the review-loop caller) — it only knows how to hand a composed `file-item`
 * input off to the detached job and report a spawn handle, never a filed card's real number (that is known only
 * once the job's own lane + file-item + verify + open-pr sequence lands it, which this function does not wait
 * for — see `land-prevention-card.mjs`'s own header for the full "can therefore never cost the approval/accept
 * that already happened" invariant this preserves for every caller).
 *
 * @see we:scripts/operations/land-prevention-card.mjs for the detached job itself.
 */
import { join } from 'node:path';
import { owePreventionFiling, owedPreventionRecord, preventionFilingKey } from './prevention-filing-owed.mjs';
import { defaultSpawnDetached, REPO_ROOT } from '../operations/detached-dispatch.mjs';
import { buildGhShimSettingsEnv, isDaemonCaller } from './gh-app-shim.mjs';
import { automationStateRoot } from './automation-home.mjs';
import { loadPreventionBatchSettings, formatPreventionBatchSettings } from './card-batch-settings.mjs';

/** The detached job every caller spawns — resolved by SCRIPT LOCATION, never `cwd` (which for every caller of
 *  this file is whatever checkout is running right now — a daemon clone, routinely). */
export const LAND_PREVENTION_CARD_SCRIPT = join(REPO_ROOT, 'scripts', 'operations', 'land-prevention-card.mjs');

/** Where a landing job's own stdout/stderr narration goes — the automation's state root, NEVER a checkout. */
export function preventionCardLandingLogPath(sessionSlug) {
  const safe = /^[A-Za-z0-9._-]+$/.test(String(sessionSlug || '')) ? String(sessionSlug) : 'unnamed-prevention-card';
  return join(automationStateRoot(), 'prevention-card-landing-logs', `${safe}.log`);
}

/**
 * SPAWN THE DETACHED LANDING JOB. See the file header for the full account. Never throws; every failure comes
 * back as `{ok:false, error}`, because a caller's own filing step must never crash over a landing-job spawn —
 * the approval/accept it rides may already have happened.
 *
 * WHY DETACHED, NOT INLINE. Every caller of this function runs SYNCHRONOUSLY on its own critical path (an
 * approval that already landed, or a review-loop round that is about to resume to `accept`), and must stay
 * fast and non-blocking: the full lane-acquire + file-item + verify + open-pr sequence is the same multi-minute
 * arc a delivery agent runs. So this function's ONLY synchronous work is spawning that sequence as its own
 * detached, unref'd process (`defaultSpawnDetached`) and returning; the spawned job (`land-prevention-card.mjs`)
 * does the real acquire/file-item/verify/open-pr/release work on its own time.
 *
 * `num`/`rel` are ALWAYS `null` in the return value — the card's real id is not known until the spawned job
 * files it, minutes later. A caller that wants a synchronous number when a PAST run's card has already reached
 * this checkout (via a daemon rebuild, say) checks its own on-disk idempotency lookup FIRST and never calls this
 * function at all in that case (see `runApprovalPreventionFiling`'s own `findApprovalPreventionCardOnDisk` call
 * for the approval-time caller's version of that short-circuit).
 *
 * `input.retractTo` (`{repo, pr, headSha}`, optional): if the job fails after this spawn succeeded, it posts a
 * retraction of its own marker for that head, so the next attempt on the same head retries instead of the guard
 * being lost for good (#4317 advisory review, 2026-09-29). The returned `session` is the job's slug, which a
 * caller's own marker (if it posts one) should name, so a later retraction can be matched to the right job.
 *
 * @param {{title:string,kind:string,size:string,digest:string,scope:string,parent?:string,queue:string,
 *   retractTo?:{repo:string,pr:(number|string),headSha:string}}} input
 * @param {{spawnDetached?: Function, logPathFor?: Function, runScript?: string, root?: string,
 *   resolveSettingsEnv?: Function, sessionPrefix?: string}} [o] - `sessionPrefix` lets each caller's spawned
 *   jobs stay distinguishable in the shared log directory (`prevention-card` for the approval-time caller,
 *   `review-loop-prevention` for the review-loop one) without changing anything else about the seam.
 * @returns {{ok:boolean, num:(number|null), rel:(string|null), error:(string|null), handle?:string,
 *   session?:string}}
 */
export function spawnPreventionLandingJob(input, {
  spawnDetached = defaultSpawnDetached,
  logPathFor = preventionCardLandingLogPath,
  runScript = LAND_PREVENTION_CARD_SCRIPT,
  root = REPO_ROOT,
  resolveSettingsEnv = () => buildGhShimSettingsEnv(),
  sessionPrefix = 'prevention-card',
  loadFilingSettings = loadPreventionBatchSettings,
  write = line => process.stderr.write(line),
} = {}) {
  const filing = loadFilingSettings();
  write(`${formatPreventionBatchSettings(filing)}\n`);
  if (filing.filingEnabled === false) {
    const reason = 'prevention filing paused by prevention.filingEnabled';
    try { owePreventionFiling(input); }
    catch (e) { return { ok: false, step: 'paused', error: `could not record owed filing: ${e.message}`, reason, num: null, rel: null }; }
    write(`${reason}\n`);
    return { ok: false, skipped: true, step: 'paused', reason, num: null, rel: null, error: reason };
  }
  let owed;
  try { owed = owedPreventionRecord(input); }
  catch (e) { return { ok: false, error: e.message, num: null, rel: null }; }
  if (owed?.status === 'done') return owed.result;
  // Resolver failure → `null` (the spawn still goes out, as it did before), never a thrown filing — except for a
  // daemon (PR #5729): its gh-guard refusal means no landing job is spawned without the shim.
  let settingsEnv = null;
  try { settingsEnv = resolveSettingsEnv() || null; } catch (e) {
    if (isDaemonCaller(process.env)) return { ok: false, num: null, rel: null, error: `land-prevention-card: refusing to spawn without the gh auth guard — ${String(e?.message || e)}` };
    settingsEnv = null;
  }
  const sessionSlug = `${sessionPrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const argv = [
    runScript,
    `--title=${input.title}`,
    `--kind=${input.kind}`,
    `--size=${input.size}`,
    `--digest=${input.digest}`,
    `--scope=${input.scope}`,
    ...(input.parent ? [`--parent=${input.parent}`] : []),
    `--queue=${input.queue}`,
    `--session=${sessionSlug}`,
    `--owed-key=${preventionFilingKey(input)}`,
    ...(input.retractTo?.repo && input.retractTo?.pr && input.retractTo?.headSha
      ? [`--retract-repo=${input.retractTo.repo}`, `--retract-pr=${input.retractTo.pr}`, `--retract-head=${input.retractTo.headSha}`]
      : []),
  ];
  try {
    // `cwd: root` — the checkout THIS process is running in (whatever reviewed the PR, or is running the review
    // loop), NEVER a lane: the spawned job acquires its OWN lane from there.
    const child = spawnDetached(argv, { cwd: root, logPath: logPathFor(sessionSlug), settingsEnv });
    const pid = Number(child?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return { ok: false, num: null, rel: null, error: 'land-prevention-card: spawned but node reported no pid' };
    }
    // A detached child's `spawn` can still fail ASYNCHRONOUSLY after returning a pid (e.g. a bad `cwd`) — with
    // no listener, that surfaces as an uncaught `error` event on THIS process. Best-effort: narrate it, never
    // throw.
    if (typeof child?.on === 'function') {
      child.on('error', (err) => {
        try {
          process.stderr.write(`spawnPreventionLandingJob: the detached landing job errored asynchronously (pid ${pid}) — ${String(err?.message || err)}\n`);
        } catch { /* stderr itself unavailable — nothing else to do */ }
      });
    }
    return { ok: true, num: null, rel: null, error: null, handle: `pid:${pid}`, session: sessionSlug };
  } catch (e) {
    return { ok: false, num: null, rel: null, error: `could not spawn the landing job: ${String(e?.message || e)}` };
  }
}
