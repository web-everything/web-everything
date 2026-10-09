/** Evidence-based prepare failures. Time alone never releases an item or a route. */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolveCoordinationRoot } from '../operations/coordination-root.mjs';
import { readBackoffSettings, backoffVerdict, evidenceReasonCode, BACKOFF_REASON_CODES, isCloneWideReasonCode } from './retry-backoff.mjs';
import { redactSpawnText } from '../lib/describe-spawn-failure.mjs';
import { classifyPrepareReport, needsYouReason } from './prepare-outcome.mjs';

export const INFRA_RETRY_BUDGET = 2;
/** builder-starved-2 — the lane-acquire infrastructure failure a prepare agent reports when it never got a lane. */
export const LANE_ACQUIRE_INFRA_RE = /could not determine an origin URL/i;
/** Only a failure of the dispatch launch itself is a known-transient candidate. */
export const DISPATCH_TRANSIENT_STAGE = 'dispatch';
/**
 * Live 2026-10-09 16:47Z: the builder listed 28 prepares held after ONE attempt. These classes were not the card's
 * fault and are retried within {@link INFRA_RETRY_BUDGET} (each one observed text, never the prompt):
 *  - another dispatch holds the lane (`could not acquire a lane: … a LIVE lease`, #4423/#4425/#4433/#4440-#4442);
 *  - the raw git ref-lock race at ANY stage (`cannot lock ref 'refs/remotes/origin/main'`, stamp-stage #4341/#4647);
 *  - the dispatch scratch dir lost its CLI trust grant to a concurrent `~/.claude.json` write (#4426; the grant
 *    itself exists, we:scripts/operations/dispatch-lane-io.mjs#grantDispatchTrust);
 *  - the worker was retired by orphan adoption across a daemon restart (#4319/#4322/#4327/#4414/#4445);
 *  - a prepare result refused by the card-edit rule as it stood THEN (#4392/#4421/#4469 ran 2026-10-01, before
 *    `size:` became prepare-owned on 2026-10-03, #4670): re-running under today's rule is the fix.
 */
const INFRA_TRANSIENT_RE = /\bHTTP\s+429\b|\b429 Too Many Requests\b|rate.limit(?: exceeded| reached)|ECONNRESET|ENETUNREACH|EAI_AGAIN|network (?:error|unavailable)|git-ref-lock-transient|cannot lock ref '[^'\n]*'|could not acquire a lane:[^\n]*\ba LIVE lease\b|workspace not trusted\b/i;
const ORPHAN_RETIRED_RE = /^build-dispatch-orphan-adopt: dispatch retired\b/;
const PREPARE_CARD_RULE_RE = /^not built: the worker edited the item's own backlog card\b/;
const ALREADY_DONE_HOLD = (commit) => `spec already done on main: commit ${commit}`;
/** The worker's own final report carried by the evidence: the runner's `worker report: …` suffix, or the terminal
 * message of an orphan-retired worker. `null` when there is none. */
function workerReport(evidence) {
  const error = String(evidence.error ?? '');
  const tail = /\bworker report:\s*([\s\S]+)$/i.exec(error);
  if (tail) return tail[1];
  return ORPHAN_RETIRED_RE.test(error) && typeof evidence.terminal === 'string' ? evidence.terminal : null;
}
/** What a held prepare should become instead of a silent hold: the resolve route for a cited already-done, a
 * needs-you hold for a decline. `null` when the worker declined nothing. Card/worker text never reaches the
 * already-done reason (only a hex sha does); a needs-you reason is defused by {@link needsYouReason}. */
export function preparedReportRoute(evidence = {}) {
  const report = workerReport(evidence);
  if (!report) return null;
  const r = classifyPrepareReport(report);
  if (r.outcome === 'no-change' && r.commit) return { cause: 'already-done', commit: r.commit, routeHold: ALREADY_DONE_HOLD(r.commit) };
  if (r.outcome === 'no-change') return { cause: 'needs-you', holdReason: needsYouReason('already-done', 'the worker said the card is already done but cited no delivering commit') };
  if (r.outcome === 'blocked') return { cause: 'needs-you', holdReason: needsYouReason(r.blocker.kind, r.summary.replace(/^.*?could[- ]not[- ]prepare\W*/i, '')) };
  return null;
}
export function classifyPrepareFailure(evidence = {}, stage = undefined) {
  // Match observed error output, never the prompt (which can mention hypothetical failures).
  const error = String(evidence.error ?? evidence.reason ?? '');
  // A worker that REPORTED (already-done / could-not-prepare) is an outcome, not a failure: route it.
  const route = preparedReportRoute(evidence);
  if (route) return route.cause;
  if (INFRA_TRANSIENT_RE.test(error)) return 'infra-transient';
  if (ORPHAN_RETIRED_RE.test(error) || PREPARE_CARD_RULE_RE.test(error)) return 'infra-transient';
  // builder-starved-2 (2026-10-07) — the agent never got a lane: `lane-pool.mjs acquire` could not resolve an origin
  // from its scratch cwd (#4174). That is the launcher's fault, not the card's, so it is retried, never held for good.
  if (LANE_ACQUIRE_INFRA_RE.test(`${error}\n${String(evidence.terminal ?? '')}`)) return 'infra-transient';
  if (evidence.sessionAbsent === true) return 'no-session';
  if (evidence.resultDiscarded === true && evidence.resultAuthored === true) return 'result-lost';
  if (evidence.stoppedBeforeCompletion === true) return 'agent-stopped-early';
  // Items 95/96: a known-transient dispatch failure (launch not confirmed, checkout behind origin, ...) is retried
  // with bounded backoff instead of held forever. Unrecognised text — or ANY other stage, e.g. a stamp-stage
  // `Command failed: git ...` — stays `unknown` (held + a diagnose card).
  if (stage === DISPATCH_TRANSIENT_STAGE && evidenceReasonCode(evidence)) return 'dispatch-transient';
  return 'unknown';
}
export function validatePrepareRelease(entry, verifyCommit) {
  // `needs-you` is released by the commit that made the ruling the worker asked for.
  if (!entry?.target || !entry?.attempt || !entry?.cause || !['agent-stopped-early', 'no-session', 'result-lost', 'infra-transient', 'needs-you'].includes(entry.cause)
      || !entry.evidence || !/^[a-f0-9]{40}$/.test(entry.fixCommit ?? '')) {
    throw new Error('prepare release refused: target, exact attempt, known cause, evidence and full fix commit required');
  }
  if (!verifyCommit(entry.fixCommit)) throw new Error('prepare release refused: fix commit is not an ancestor of this daemon');
  return entry;
}
/** An entry that fails validation (malformed, or its fix commit is not in this daemon's ancestry — a shallow
 * clone, a stale HEAD) is simply NOT a release: the item stays held. It must never throw, because this runs at
 * the top of every build-dispatch tick and one bad entry would halt all daemon work. */
export function readPrepareReleases(path, root, { onInvalid = () => {} } = {}) {
  let entries;
  try { entries = JSON.parse(readFileSync(path, 'utf8')).releases; } catch (error) { onInvalid(null, error); return []; }
  if (!Array.isArray(entries)) return [];
  const releases = [];
  for (const entry of entries) {
    try {
      releases.push(validatePrepareRelease(entry, sha => {
        try { execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { cwd: root, stdio: 'ignore' }); return true; }
        catch { return false; }
      }));
    } catch (error) { onInvalid(entry, error); }
  }
  return releases;
}
export function releasedAttempt(releases, target, attempt) {
  return releases.some(r => r.target === String(target) && r.attempt === attempt);
}
export const failureStatePath = () => join(resolveCoordinationRoot(), 'prepare-failures.json');
export function readFailureState(path = failureStatePath()) {
  if (!existsSync(path)) return { failures: {}, cards: {} };
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch {
    // A truncated ledger must not throw out of every daemon tick; keep the bytes for diagnosis and start empty.
    try { renameSync(path, `${path}.corrupt-${Date.now()}`); } catch { /* best effort */ }
    return { failures: {}, cards: {} };
  }
}
function save(state, path) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  // The ledger holds failure evidence (child output can echo credentials): owner-only.
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
/** Evidence as stored: every string field redacted (booleans and the rest pass through). Classification and the
 * reason code are always read off the RAW evidence first — redaction never changes what a code pattern matches. */
const redactEvidence = evidence => Object.fromEntries(Object.entries(evidence ?? {})
  .map(([k, v]) => [k, typeof v === 'string' ? redactSpawnText(v) : v]));
/** Singleton daemon owns this ledger. Persist intent before spawning so a crash cannot double-file. */
export async function recordPrepareFailure({ num, attempt, stage, evidence = {} }, {
  path = failureStatePath(), fileCard, now = Date.now(), settings = readBackoffSettings(),
} = {}) {
  // builder-starved — a clone-wide dispatch refusal (the daemon's clone is behind origin/main) is not this card's
  // failure: never persisted, never held, never charged. The next tick after the clone's self-sync retries it.
  if (stage === DISPATCH_TRANSIENT_STAGE && isCloneWideReasonCode(evidenceReasonCode(evidence))) {
    return { num, attempt, stage, cause: 'clone-wide', reasonCode: evidenceReasonCode(evidence), evidence: redactEvidence(evidence), retry: true, held: false };
  }
  const state = readFailureState(path);
  const key = `${num}:${attempt}:${stage}`;
  if (state.failures[key]) return state.failures[key];
  const cause = classifyPrepareFailure(evidence, stage);
  const previous = Object.values(state.failures).filter(f => f.num === num && f.cause === 'infra-transient').length;
  const retry = cause === 'infra-transient' && previous < INFRA_RETRY_BUDGET;
  const failure = { num, attempt, stage, cause, evidence: redactEvidence(evidence), retry, held: !retry, recordedAt: new Date(now).toISOString() };
  // Read off the RAW evidence (redaction never changes a route). The caller places a fresh route hold itself.
  const route = preparedReportRoute(evidence);
  if (route?.routeHold) Object.assign(failure, { retry: true, held: false, commit: route.commit, routeHold: route.routeHold, routeHoldPlacedAt: new Date(now).toISOString() });
  if (route?.holdReason) failure.holdReason = route.holdReason;
  if (cause === 'dispatch-transient') {
    // Backoff: held until `retryAfter`, then `releaseDuePrepareRetries` lets it be dispatched again. Attempts
    // count every unfinished, not-yet-re-armed transient failure of this card; at the cap it stays held
    // (`exhausted`) until a re-arm, which starts a fresh budget (a re-armed record no longer counts).
    const attempts = Object.values(state.failures).filter(f => f.num === num && f.cause === 'dispatch-transient' && !f.completed && !f.rearmedAt && !f.budgetResetAt).length + 1;
    Object.assign(failure, { reasonCode: evidenceReasonCode(evidence), attempts, ...backoffVerdict({ attempts, now, settings, code: evidenceReasonCode(evidence) }) });
  }
  state.failures[key] = failure;
  if (cause === 'unknown') {
    const signature = evidence.causeKey || `${stage}:${String(evidence.terminal ?? evidence.error ?? evidence.reason ?? 'missing terminal evidence').replace(/#?\d+/g, 'N')}`;
    const fingerprint = createHash('sha256').update(signature).digest('hex').slice(0, 16);
    failure.causeKey = fingerprint;
    if (!state.cards[fingerprint]) {
      state.cards[fingerprint] = { status: 'pending', num, signature: redactSpawnText(signature) };
      save(state, path);
      try {
        const result = await fileCard({ title: `Diagnose unknown prepare ${stage} failure (${fingerprint})`,
          // A `story`, not a `task`: this card carries a size, and a sized task is refused (#x0h3pe4) — it would
          // silently never be filed.
          kind: 'story', size: '2', queue: 'false', scope: 'we:skills-src/conveyor/build-dispatch-daemon.mjs',
          digest: `Prepare #${num} is held. Cause is unknown. Evidence is retained in the coordination-root prepare failure ledger under cause key ${fingerprint} and item ${num}; inspect the recorded terminal output before making a diagnosis. Recover the terminal evidence, fix the cause and add a regression. Release requires a reviewed fix commit. Cause key: ${fingerprint}.` });
        state.cards[fingerprint] = { ...state.cards[fingerprint], status: result?.ok ? 'queued' : 'failed', result };
      } catch (error) { state.cards[fingerprint].status = 'failed'; state.cards[fingerprint].error = String(error); }
    }
    failure.prevention = state.cards[fingerprint];
  }
  // `fileCard` can take a while; a re-arm / release written meanwhile by another process must not be overwritten by
  // this call's stale snapshot, so merge ONLY this call's own failure and card into a fresh read.
  const latest = readFailureState(path);
  latest.failures[key] = failure;
  if (failure.causeKey) latest.cards[failure.causeKey] = state.cards[failure.causeKey];
  save(latest, path);
  return failure;
}

/** Successful main observation closes failures, preserving their audit history. */
export function completePrepareFailures(num, path = failureStatePath()) {
  const state = readFailureState(path);
  for (const failure of Object.values(state.failures)) if (failure.num === num) failure.completed = true;
  save(state, path);
}

/** Held transient failures whose backoff has elapsed become retryable again. Returns the card numbers that now have
 * NO remaining held failure (their hold files can be released). Exhausted failures are never released here. */
/**
 * @param {{path?: string, now?: number, settings?: object,
 *   cardChange?: ((num: string, sinceIso: string) => ({commit: string, at: string}|null))|null}} [o] - `cardChange`
 *   names the newest origin/main commit that changed the card's file AFTER `sinceIso` (null when none); it releases
 *   a held `needs-you` record (step e). Omitted, needs-you holds are left alone.
 */
export function releaseDuePrepareRetries({ path = failureStatePath(), now = Date.now(), settings = readBackoffSettings(), cardChange = null } = {}) {
  const state = readFailureState(path);
  const touched = new Set();
  // builder-starved (2026-10-07) — SELF-HEAL held dispatch failures the CURRENT policy would never have held:
  //  (a) a clone-wide refusal (any cause, even exhausted) is released outright — it was never the card's failure;
  //  (b) a dispatch failure recorded as `unknown` by code that predates the transient classification (items 95/96)
  //      but whose evidence now classifies `dispatch-transient` gets the backoff it would get today, so it is
  //      released when that backoff is due instead of being held forever. Live: 62 cards sat `prepare-unstamped`
  //      on such records, two of them at the head of the pinned tier, and nothing ever released them.
  let healed = false;
  for (const f of Object.values(state.failures)) {
    if (!f.held || f.completed || f.stage !== DISPATCH_TRANSIENT_STAGE) continue;
    const code = evidenceReasonCode(f.evidence);
    if (isCloneWideReasonCode(code)) {
      Object.assign(f, { held: false, retry: true, exhausted: false, healedAt: new Date(now).toISOString(), healedFrom: f.cause, cause: 'clone-wide', reasonCode: code });
      touched.add(f.num); healed = true;
    } else if (f.cause === 'unknown' && classifyPrepareFailure(f.evidence, f.stage) === 'dispatch-transient') {
      const at = Date.parse(f.recordedAt ?? f.attempt);
      const attempts = Object.values(state.failures).filter(o => o.num === f.num && o.cause === 'dispatch-transient' && !o.completed && !o.rearmedAt && !o.budgetResetAt).length + 1;
      Object.assign(f, { cause: 'dispatch-transient', healedFrom: 'unknown', reasonCode: code, attempts,
        ...backoffVerdict({ attempts, now: Number.isFinite(at) ? at : now, settings, code }) });
      healed = true;
    }
  }
  // builder-starved-2 (2026-10-07) — (c) a held `unknown` failure of ANY stage whose evidence now classifies
  // `infra-transient` (the agent never acquired a lane) is released, within the same per-card infra retry budget a
  // fresh one gets. Live: #4560 sat `prepare-unstamped` on exactly this, waiting on a prevention card nobody built.
  // Live 2026-10-09 — (d) the same for every held record today's policy classifies differently: a `no-session` lane-busy
  // or a `result-lost` card-rule refusal retries like (c); a worker report becomes its route (already-done: a resolve
  // hold the caller places once; could-not-prepare: a held needs-you reason the tick surfaces). This is what moves a
  // hold recorded by older code — the ledger is never edited by hand.
  for (const f of Object.values(state.failures)) {
    if (!f.held || f.completed || !RECLASSIFIABLE_CAUSES.includes(f.cause)) continue;
    const cause = classifyPrepareFailure(f.evidence, f.stage);
    if (cause === f.cause) continue;
    const healedAt = new Date(now).toISOString();
    if (cause === 'infra-transient') {
      const used = Object.values(state.failures).filter(o => o.num === f.num && o !== f && o.cause === 'infra-transient').length;
      if (used >= INFRA_RETRY_BUDGET) continue;
      Object.assign(f, { cause, healedFrom: f.cause, held: false, retry: true, healedAt });
      touched.add(f.num); healed = true;
    } else if (cause === 'already-done' || cause === 'needs-you') {
      const route = preparedReportRoute(f.evidence);
      Object.assign(f, { cause, healedFrom: f.cause, healedAt }, route.routeHold
        ? { held: false, retry: true, commit: route.commit, routeHold: route.routeHold }
        : { holdReason: route.holdReason });
      if (route.routeHold) touched.add(f.num);
      healed = true;
    }
  }
  // Live 2026-10-09 — (e) a could-not-prepare (`needs-you`) hold waits for the operator's ruling, and the ruling lands
  // as an edit to the card on main (#4354/#4411/#4476/#4488 each got a `## Ruling` section and stayed held: nothing
  // ever looked). Any change to the card's file on origin/main after the hold was recorded releases it, so the next
  // prepare reads the card as it is now. If the edit did not settle the choice, that prepare stops could-not-prepare
  // again and a NEW record holds it (its own, later `recordedAt`) — one extra prepare per card edit, never a loop.
  // An unreadable history keeps the hold (fail closed).
  if (typeof cardChange === 'function') {
    for (const f of Object.values(state.failures)) {
      if (!f.held || f.completed || f.cause !== 'needs-you') continue;
      const since = f.recordedAt ?? f.healedAt;
      if (!since || !Number.isFinite(Date.parse(since))) continue;
      let change = null;
      try { change = cardChange(String(f.num), since); } catch { change = null; }
      if (!change?.commit || !(Date.parse(change.at) > Date.parse(since))) continue;
      Object.assign(f, { held: false, retry: true, releasedAt: new Date(now).toISOString(), releasedBy: { cardChange: change.commit, at: change.at } });
      touched.add(f.num);
    }
  }
  for (const f of Object.values(state.failures)) {
    if (f.held && !f.completed && !f.exhausted && f.retryAfter && Date.parse(f.retryAfter) <= now) {
      Object.assign(f, { held: false, retry: true, retriedAt: new Date(now).toISOString() });
      touched.add(f.num);
    }
  }
  if (!touched.size) { if (healed) save(state, path); return []; }
  save(state, path);
  return [...touched].filter(num => !Object.values(state.failures).some(f => f.num === num && f.held && !f.completed));
}

/** Causes an older policy recorded for evidence today's {@link classifyPrepareFailure} may read differently. */
const RECLASSIFIABLE_CAUSES = ['unknown', 'no-session', 'result-lost'];

/** Already-done routes not yet handed to the daemon: each is returned ONCE (stamped `routeHoldPlacedAt`), and the
 * daemon places it as an ordinary TTL'd dispatch hold the hold router lands (resolve, graduatedTo the commit). A
 * crash between the stamp and the placement only lets the card be prepared again, which re-reports it. */
export function takePrepareRouteHolds({ path = failureStatePath(), now = Date.now() } = {}) {
  const state = readFailureState(path);
  const due = Object.values(state.failures).filter(f => f.routeHold && !f.routeHoldPlacedAt && !f.completed);
  if (!due.length) return [];
  for (const f of due) f.routeHoldPlacedAt = new Date(now).toISOString();
  save(state, path);
  return due.map(f => ({ num: f.num, reason: f.routeHold }));
}

/** The pre-#4148 launch-confirmation bug recorded healthy launches as "not confirmed" and held the card for good. */
export const NOT_CONFIRMED_FIX_LANDED_AT = '2026-10-07T00:25:38Z'; // merge of #4148 (2026-10-06 20:25 ET)

const ISO_CUTOFF = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** One-shot re-arm: clear held failures whose reason code is in `codes` and which were recorded before `before`
 * (`recordedAt`, else an ISO `attempt`, else unknown = written by older code = before). An EXHAUSTED transient hold
 * is re-armable whatever its age (the cutoff only separates pre-#4148 false holds from real ones), and re-arming it
 * starts a fresh backoff budget. `count` is the failures re-armed; `nums` is only the cards left with NO unresolved
 * held failure, i.e. the cards whose hold file may now be released — a card that still has another held failure
 * keeps its hold. An unparseable `before` throws: a typo must never widen the re-arm to every held failure. */
export function rearmFalseHolds({ path = failureStatePath(), before = NOT_CONFIRMED_FIX_LANDED_AT, codes = ['launch-not-confirmed'], now = Date.now(), dryRun = false } = {}) {
  // A real ISO date(-time) only (`Date.parse` alone also accepts `1`, `Oct 7`), and never a future one: a cutoff after
  // `now` would re-arm every held failure, including the genuine post-fix ones the cutoff exists to spare.
  const cutoff = typeof before === 'string' && ISO_CUTOFF.test(before) ? Date.parse(before) : NaN;
  if (!Number.isFinite(cutoff)) throw new Error(`rearm refused: --before must be an ISO timestamp, got ${JSON.stringify(before)}`);
  if (cutoff > Date.now()) throw new Error(`rearm refused: --before ${before} is in the future`);
  const unknownCodes = codes.filter(c => !BACKOFF_REASON_CODES.includes(c));
  if (!codes.length || unknownCodes.length) throw new Error(`rearm refused: --codes must name known reason codes (${BACKOFF_REASON_CODES.join(', ')}), got ${JSON.stringify(unknownCodes.length ? unknownCodes : codes)}`);
  const state = readFailureState(path);
  const rearmed = [];
  for (const f of Object.values(state.failures)) {
    if (!f.held || f.completed) continue;
    // Only a failure of the dispatch launch is ever a false/transient hold; a stamp/result-stage hold has its own
    // diagnose card and is cleared by a reviewed release, not by a reason-code match on its text.
    if (f.stage !== undefined && f.stage !== DISPATCH_TRANSIENT_STAGE) continue;
    if (!codes.includes(evidenceReasonCode(f.evidence))) continue;
    const at = Date.parse(f.recordedAt ?? f.attempt);
    if (!f.exhausted && Number.isFinite(at) && at >= cutoff) continue;
    rearmed.push(f);
  }
  if (!dryRun && rearmed.length) {
    const rearmedAt = new Date(now).toISOString();
    for (const f of rearmed) Object.assign(f, { held: false, retry: true, rearmedAt, rearmedBefore: before });
    // Fresh backoff budget for the card: its other transient attempts stop counting too (a separate marker —
    // `rearmedAt` stays "this failure was re-armed", so a still-held sibling is not mislabelled).
    const nums = new Set(rearmed.map(f => f.num));
    for (const f of Object.values(state.failures)) {
      if (nums.has(f.num) && f.cause === 'dispatch-transient' && !f.rearmedAt && !f.budgetResetAt) f.budgetResetAt = rearmedAt;
    }
    save(state, path);
  }
  const cleared = new Set(rearmed);
  const stillHeld = new Set(Object.values(state.failures).filter(f => f.held && !f.completed && !cleared.has(f)).map(f => f.num));
  return { count: rearmed.length, nums: [...new Set(rearmed.map(f => f.num))].filter(num => !stillHeld.has(num)) };
}
