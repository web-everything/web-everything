/** Open-head observations, shared by every writer. Missing evidence never grants a clearance. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendVerdict, buildVerdictRecord, foldVerdictLedger, labelVerdictOf, ledgerCarryAllowed, ledgerEventId,
  parseLedgerEvents, observedLedgerHead, verdictLedgerPath, resolveLedgerBoardDetail, resolveLedgerStoreChoice } from './verdict-ledger.mjs';
import { readLedgerFromGit } from './verdict-ledger-io.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { readSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { proveNumberingOnlyMove, resolveNumberingHumanClearanceSetting } from './numbering-carry.mjs';
import { proveIdenticalHeadTrees, resolveHumanClearanceCarrySetting } from './human-clearance-carry.mjs';
import { proveIdenticalNetPatch, resolveIdenticalNetPatchSetting } from './identical-net-patch.mjs';
import { resolveAcceptCarryForward } from './accept-carry-forward.mjs';
import { sameHead } from './pr-state/referrals.mjs';

const flag = v => typeof v === 'boolean';
const positive = v => Number.isInteger(v) && v > 0;
/** `drainObserveMaxPerPass` / `drainObserveBudgetMs` cap the drain's live observations per pass (count and wall time). */
export function resolveLedgerObservationSettings({ tool = readSettings().ledger, platform, env = process.env } = {}) {
  return cascadePolicy('ledger', tool, { standard: { firstSeenRows: true, headMoveInvalidation: true, drainObserveMaxPerPass: 20, drainObserveBudgetMs: 15_000 },
    platform, env, valid: { firstSeenRows: flag, headMoveInvalidation: flag, drainObserveMaxPerPass: positive, drainObserveBudgetMs: positive } });
}
const logged = new Set();
export function logLedgerObservationSettings(settings, log = s => process.stderr.write(`${s}\n`)) {
  const line = Object.entries(settings.value).map(([k, v]) => `ledger.${k}=${v} (${settings.sources[k]})`).join(', ');
  if (!logged.has(line)) { logged.add(line); log(line); }
}
export function readObservationLedger(repo) {
  if (resolveLedgerStoreChoice().store !== 'home') {
    const { board, certain } = resolveLedgerBoardDetail(repo);
    if (board || !certain) {
      const read = readLedgerFromGit({ board, repo });
      if (read.status !== 'ok') throw Error(`ledger unreadable: ${read.reason}`);
      return parseLedgerEvents(read.text);
    }
  }
  try { return parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

/** Uses the existing byte/mode-sensitive numbering, mechanical tree and net-patch proofs. */
export function proveLedgerCarry({ repo, fromSha, toSha, cwd = resolveLedgerBoardDetail(repo).board ?? process.cwd(), exec = execFileSync, human = false } = {}) {
  if (resolveAcceptCarryForward().value !== 'on') return null;
  if (human && !resolveHumanClearanceCarrySetting().value) return null;
  const args = { fromSha, toSha, cwd, exec };
  if ((!human || resolveNumberingHumanClearanceSetting().value) && proveNumberingOnlyMove(args).ok) return 'numbering-only';
  if (proveIdenticalHeadTrees(args).ok) return 'tree-identical';
  if (resolveIdenticalNetPatchSetting().value && proveIdenticalNetPatch(args).ok) return 'identical-net-patch';
  return null;
}

const eventIdOrNull = e => { try { return ledgerEventId(e); } catch { return null; } };

export function planLedgerObservation({ repo, pr, headSha, state = 'OPEN', labels = [], events,
  now = new Date().toISOString(), settings = resolveLedgerObservationSettings(), proveCarry = proveLedgerCarry } = {}) {
  if (String(state).toUpperCase() !== 'OPEN' || !/^[0-9a-f]{40}$/i.test(headSha ?? '')) return [];
  if (!Array.isArray(events)) throw Error('ledger observation requires a readable ledger');
  headSha = headSha.toLowerCase();
  pr = Number(pr);
  const mine = events.filter(e => e.repo.toLowerCase() === repo.toLowerCase() && e.pr === pr);
  const fields = { repo, pr, headSha, at: now, declaredActor: 'ledger-observer' };
  const oldHead = mine.length ? observedLedgerHead(mine) : null;
  // No witnessed head yet, including a PR whose only rows are headless (a drain park with no readable head).
  if (!oldHead) {
    if (!settings.value.firstSeenRows) return [];
    const label = labelVerdictOf(labels);
    // An acceptance label alone has no content witness. Import holds, never manufacture approval.
    const verdict = ['human', 'changes', 'pending'].includes(label) ? label : 'observed';
    return [buildVerdictRecord({ ...fields, verdict, source: 'first-seen', state: label ?? 'unreviewed',
      reason: 'first observed open head; labels alone do not prove an acceptance' })];
  }
  if (!settings.value.headMoveInvalidation || sameHead(oldHead, headSha)) return [];
  const current = foldVerdictLedger(mine).get(pr)?.current;
  // Never carry a stale acceptance through an intervening unreviewed head or a hold, or onto an already-judged head.
  const canCarry = sameHead(current?.coverage?.headSha, oldHead) && ledgerCarryAllowed(mine, oldHead, headSha);
  const rule = canCarry ? proveCarry({ repo, fromSha: oldHead, toSha: headSha, human: current.verdict === 'clear-human' || current.state === 'clear-human' }) : null;
  // `basis` names the snapshot's last event: the tip refuses this row if the witness moved after it, even back to `oldHead`.
  return [buildVerdictRecord({ ...fields, source: 'head-observer', fromHead: oldHead, basis: eventIdOrNull(mine.at(-1)),
    verdict: rule ? 'carried' : 'head-moved', carryRule: rule,
    state: rule ? (current.state ?? current.verdict) : 'pending',
    reason: rule ? `acceptance carried by ${rule}` : 'head moved; prior head verdicts and clearances invalidated' })];
}

/** Writes through appendVerdict and its store locks. Unreadable data is a loud miss, never an empty ledger. */
export function observeLedgerHead(facts, { read = readObservationLedger, append = appendVerdict,
  settings = resolveLedgerObservationSettings(), log = s => process.stderr.write(`${s}\n`), deadline = null, clock = Date.now, ...options } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(facts.headSha ?? '') || String(facts.state ?? 'OPEN').toUpperCase() !== 'OPEN') return { ok: true, rows: [] };
  logLedgerObservationSettings(settings, log);
  try {
    const rows = planLedgerObservation({ ...facts, events: read(facts.repo), settings, ...options });
    for (const row of rows) {
      // A caller's budget (the drain pass) bounds the write too: no append starts past it, and the git leg stops retrying at it.
      if (deadline != null && clock() >= deadline) throw Error('observation budget spent before the append');
      const result = deadline != null ? append(row, { deadline }) : append(row);
      if (!result?.ok || result.ledgerWriteMiss) throw Error(result?.errors?.join('; ') || 'append failed');
    }
    return { ok: true, rows };
  } catch (e) { log(`ledger-write-miss: observation ${facts.repo}#${facts.pr}: ${e.message}`); return { ok: false, rows: [], error: e.message }; }
}

/** Split a remaining budget three ways: the throttle's points wait, its slot wait (each bounded by `acquireTimeoutMs`)
 *  and the child. No retry of either kind (rate limit, cut-off JSON), so the whole read stays inside the budget. */
export const ghBudget = (ms, env = process.env) => {
  const wait = Math.max(1, Math.floor(ms / 3));
  return { timeout: Math.max(1, ms - 2 * wait), throttle: { acquireTimeoutMs: wait, maxAttempts: 1, env: { ...env, WE_GH_JSON_RETRIES: '0' } } };
};

/** Read the ledger NOW, for an observation whose live head is read after it, and replay it as that observation's `read`.
 *  A ledger read after the live read can already hold a newer head's acceptance, and the stale live head would then
 *  plan a head move away from it that the locked tip accepts. Planned from an older snapshot, any row appended between
 *  the two reads moves the tip's witness and refuses the stale row. A failed read replays as the same error. */
export function ledgerSnapshot(repo, read = readObservationLedger) {
  try { const events = read(repo); return () => events; } catch (e) { return () => { throw e; }; }
}

/** Feed records can arrive late. Re-read the live PR before observing; never rewind to an event's old SHA. */
export function observeLedgerPrEvent(event, pr, { readPr = (repo, number, { timeout } = {}) => JSON.parse(String(execFileSyncThrottled('gh',
  // With a budget, the throttle's slot/points wait is bounded by it and a rate-limited read is not retried: one try, then a logged miss.
  ['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,labels'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    ...(timeout ? ghBudget(timeout) : {}) }))),
  read = readObservationLedger, observe = observeLedgerHead, log = s => process.stderr.write(`${s}\n`), deadline = null, clock = Date.now } = {}) {
  try {
    // A deadline also bounds the live read; never start one past it.
    if (deadline != null && deadline - clock() <= 0) throw Error('observation budget spent before the live read');
    const snapshot = ledgerSnapshot(event.repo, read);
    const left = deadline == null ? null : deadline - clock();
    if (left != null && left <= 0) throw Error('observation budget spent before the live read');
    const live = left == null ? readPr(event.repo, pr) : readPr(event.repo, pr, { timeout: left });
    const facts = { repo: event.repo, pr, headSha: live.headRefOid, state: live.state,
      labels: (live.labels ?? []).map(l => typeof l === 'string' ? l : l.name) };
    return observe(facts, deadline == null ? { read: snapshot } : { read: snapshot, deadline, clock });
  } catch (e) { log(`ledger-write-miss: event observation ${event.repo}#${pr}: ${e.message}`); return { ok: false }; }
}

/** Drain snapshots are also historical evidence. Use the same live read as the feed consumer.
 *  With `read` (the caller's ledger snapshot) and a full `listedHeadSha` that already equals the ledger's witnessed
 *  head, the live read is skipped: nothing has moved, and a per-PR `gh pr view` every pass would burn the shared
 *  API budget. A head that moved shows up as a listed/witnessed mismatch on this or the next pass. */
export function observeLiveLedgerHead({ repo, pr, listedHeadSha = null }, options = {}) {
  if (ledgerHeadUnchanged({ repo, pr, listedHeadSha }, options.read)) return { ok: true, rows: [], skipped: 'head-unchanged' };
  return observeLedgerPrEvent({ repo }, pr, options);
}

/** True only when the snapshot's witnessed head equals a full listed head. An unreadable snapshot never skips. */
export function ledgerHeadUnchanged({ repo, pr, listedHeadSha = null }, read) {
  const listed = /^[0-9a-f]{40}$/i.test(listedHeadSha ?? '') ? listedHeadSha.toLowerCase() : null;
  if (!listed || typeof read !== 'function') return false;
  try {
    const mine = read(repo).filter(e => e.repo.toLowerCase() === repo.toLowerCase() && e.pr === Number(pr));
    return mine.length > 0 && sameHead(observedLedgerHead(mine), listed);
  } catch { return false; /* the live read decides, and logs its own miss */ }
}

/** One drain-pass ledger budget: `ledger.drainObserveMaxPerPass` writes within `ledger.drainObserveBudgetMs` (sources logged). */
export function drainLedgerBudget({ settings = resolveLedgerObservationSettings(), clock = Date.now, log = s => process.stderr.write(`${s}\n`) } = {}) {
  logLedgerObservationSettings(settings, log);
  const { drainObserveMaxPerPass: max = 20, drainObserveBudgetMs: budget = 15_000 } = settings.value;
  return { max, budget, deadline: clock() + budget };
}

/**
 * The drain pass's observations, capped per pass by `ledger.drainObserveMaxPerPass` live reads and
 * `ledger.drainObserveBudgetMs` of wall time (each logged with its source). The budget is also the deadline of
 * every live read and append, so a slow `gh` read or git leg ends the pass's observing instead of stalling the
 * pass. Unchanged heads cost no live read and are never capped. Anything skipped or failed is one logged
 * `ledger-write-miss` line; the next pass sees the same listed/witnessed mismatch and retries it. Never throws.
 */
export function observeDrainLedgerHeads(targets, { read, settings = resolveLedgerObservationSettings(), clock = Date.now,
  log = s => process.stderr.write(`${s}\n`), readPr, append, // test seams: the live `gh` read and the ledger writer
  // The pass snapshot predates every live read, so it is also each observation's planning snapshot.
  observe = (target, deadline) => observeLedgerPrEvent({ repo: target.repo }, target.pr, { read, deadline, clock, log, ...(readPr ? { readPr } : {}),
    observe: (facts, opts) => observeLedgerHead(facts, { ...opts, settings, log, ...(append ? { append } : {}) }) }) } = {}) {
  const out = { observed: 0, unchanged: 0, missed: [], capped: [] };
  try {
    const { max, budget, deadline } = drainLedgerBudget({ settings, clock, log });
    let reason = null;
    for (const target of targets) {
      if (ledgerHeadUnchanged(target, read)) { out.unchanged += 1; continue; }
      reason ??= out.observed >= max ? `count cap ledger.drainObserveMaxPerPass=${max}`
        : clock() >= deadline ? `time budget ledger.drainObserveBudgetMs=${budget}` : null;
      if (reason) { out.capped.push(target); continue; }
      out.observed += 1;
      let result;
      try { result = observe(target, deadline); } catch (e) { result = { ok: false, error: e?.message }; }
      if (!result?.ok) out.missed.push(target);
    }
    const prs = list => list.map(t => `${t.repo}#${t.pr}`).join(', ');
    if (out.capped.length) log(`ledger-write-miss: drain observation skipped ${out.capped.length} PR(s) this pass (${reason}): ${prs(out.capped)}; retried next pass`);
    if (out.missed.length) log(`ledger-write-miss: drain observation failed for ${out.missed.length} PR(s): ${prs(out.missed)}; retried next pass`);
  } catch (e) { log(`ledger-write-miss: drain observation pass: ${e?.message}`); }
  return out;
}
