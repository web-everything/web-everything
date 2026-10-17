/** Open-head observations, shared by every writer. Missing evidence never grants a clearance. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { appendVerdict, buildVerdictRecord, foldVerdictLedger, labelVerdictOf,
  parseLedgerEvents, observedLedgerHead, verdictLedgerPath, resolveLedgerBoardDetail, resolveLedgerStoreChoice } from './verdict-ledger.mjs';
import { readLedgerFromGit } from './verdict-ledger-io.mjs';
import { execFileSyncThrottled } from './gh-throttle.mjs';
import { readSettings } from './settings-files.mjs';
import { cascadePolicy } from './policy-cascade.mjs';
import { proveNumberingOnlyMove, resolveNumberingHumanClearanceSetting } from './numbering-carry.mjs';
import { proveIdenticalHeadTrees, resolveHumanClearanceCarrySetting } from './human-clearance-carry.mjs';
import { proveIdenticalNetPatch, resolveIdenticalNetPatchSetting } from './identical-net-patch.mjs';
import { resolveAcceptCarryForward } from './accept-carry-forward.mjs';

export function resolveLedgerObservationSettings({ tool = readSettings().ledger, platform, env = process.env } = {}) {
  return cascadePolicy('ledger', tool, { standard: { firstSeenRows: true, headMoveInvalidation: true }, platform, env,
    valid: v => typeof v === 'boolean' });
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
  if (!settings.value.headMoveInvalidation || oldHead === headSha) return [];
  const current = foldVerdictLedger(mine).get(pr)?.current;
  // Never carry a stale acceptance through an intervening unreviewed head or a hold.
  const canCarry = current?.clears === true && current.coverage?.headSha === oldHead;
  const rule = canCarry ? proveCarry({ repo, fromSha: oldHead, toSha: headSha, human: current.verdict === 'clear-human' || current.state === 'clear-human' }) : null;
  return [buildVerdictRecord({ ...fields, source: 'head-observer', fromHead: oldHead,
    verdict: rule ? 'carried' : 'head-moved', carryRule: rule,
    state: rule ? (current.state ?? current.verdict) : 'pending',
    reason: rule ? `acceptance carried by ${rule}` : 'head moved; prior head verdicts and clearances invalidated' })];
}

/** Writes through appendVerdict and its store locks. Unreadable data is a loud miss, never an empty ledger. */
export function observeLedgerHead(facts, { read = readObservationLedger, append = appendVerdict,
  settings = resolveLedgerObservationSettings(), log = s => process.stderr.write(`${s}\n`), ...options } = {}) {
  if (!/^[0-9a-f]{40}$/i.test(facts.headSha ?? '') || String(facts.state ?? 'OPEN').toUpperCase() !== 'OPEN') return { ok: true, rows: [] };
  logLedgerObservationSettings(settings, log);
  try {
    const rows = planLedgerObservation({ ...facts, events: read(facts.repo), settings, ...options });
    for (const row of rows) {
      const result = append(row);
      if (!result?.ok || result.ledgerWriteMiss) throw Error(result?.errors?.join('; ') || 'append failed');
    }
    return { ok: true, rows };
  } catch (e) { log(`ledger-write-miss: observation ${facts.repo}#${facts.pr}: ${e.message}`); return { ok: false, rows: [], error: e.message }; }
}

/** Feed records can arrive late. Re-read the live PR before observing; never rewind to an event's old SHA. */
export function observeLedgerPrEvent(event, pr, { readPr = (repo, number) => JSON.parse(String(execFileSyncThrottled('gh',
  ['pr', 'view', String(number), '--repo', repo, '--json', 'state,headRefOid,labels'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))),
  observe = observeLedgerHead, log = s => process.stderr.write(`${s}\n`) } = {}) {
  try {
    const live = readPr(event.repo, pr);
    return observe({ repo: event.repo, pr, headSha: live.headRefOid, state: live.state,
      labels: (live.labels ?? []).map(l => typeof l === 'string' ? l : l.name) });
  } catch (e) { log(`ledger-write-miss: event observation ${event.repo}#${pr}: ${e.message}`); return { ok: false }; }
}

/** Drain snapshots are also historical evidence. Use the same live read as the feed consumer. */
export function observeLiveLedgerHead({ repo, pr }, options = {}) {
  return observeLedgerPrEvent({ repo }, pr, options);
}
