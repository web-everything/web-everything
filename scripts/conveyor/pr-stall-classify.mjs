/**
 * @file scripts/conveyor/pr-stall-classify.mjs
 * @description THE PURE CLASSIFIER behind the automatic PR stall sweep (operator OK 2026-10-21, slice 1). One stalled
 *   `pr-sweep` row (`we:scripts/operations/pr-sweep-core.mjs#assessPrSweep`), plus the round judge's verdict for a PR at
 *   a round cap or referral hold (`we:scripts/lib/round-judge.mjs#judgeRound`), becomes WHO moves it next and HOW:
 *     system   - tooling, no ruling: ledger outbox, ask the review daemon, re-run the red-team gate, a tooling card.
 *     policy   - the operator's standing rules, as `auto-policy` (never the operator's login): grant inside the ceiling,
 *                card coverage-only referrals to an existing readable card, block with a concrete fix list.
 *     operator - a person decides; every item carries one paste-ready command.
 *   It reads and acts on nothing. FAIL CLOSED: anything unknown, malformed or throwing is an `operator` item, and no
 *   automatic lane ever produces `not-real`, `clear-human`, `accept` or `supersede`.
 */
import { validateVerdict, isGuardPath, proposeFix } from '../lib/round-judge.mjs';
import { MAX_TOTAL_ROUND_EXTENSIONS } from './round-extension-mark.mjs';
import { nextActions } from '../operations/pr-sweep-core.mjs';
import { CARD_REF_RE } from '../lib/referral-card-readable.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

/** Actions no automatic lane may ever take, whatever a verdict says. */
export const NEVER_AUTOMATIC = Object.freeze(['not-real', 'clear-human', 'accept', 'supersede']);
export const POLICY_ACTOR = 'auto-policy';

/**
 * Every policy this classifier applies, as a SETTING (operator standing rule 2026-10-21 14:45 ET: no policy is a
 * constant). The sweep resolves them through the `prStallSweep` cascade and passes them in; these are the standard
 * values. Each can only make the classifier STRICTER than its built-in mapping, never looser:
 *   - `stateLanes`: per waiting state, `auto` (the mapping below) or `operator` (always ask a person).
 *   - `systemActions` / `policyActions`: turn each automatic action on or off; off sends the item to the operator.
 *   - `grantCeiling`: most rounds granted in total, 1..MAX_TOTAL_ROUND_EXTENSIONS (lowers the shared ceiling, never raises).
 *   - `maxFixListLines`: the longest fix list a policy block may carry (1..20: it can only lower the standard).
 *   - `staleHoldAutoResume`: a stale hold is the system's (true) or the operator's (false).
 */
export const CLASSIFY_DEFAULTS = Object.freeze({
  staleHoldAutoResume: false, grantCeiling: MAX_TOTAL_ROUND_EXTENSIONS, maxFixListLines: 20, stateLanes: Object.freeze({}),
  systemActions: Object.freeze({ 'await-ledger-outbox': true, 'resume-stale-hold': true, 'rerun-red-team-gate': true, 'ask-review-daemon': true, 'tooling-card': true }),
  policyActions: Object.freeze({ grant: true, card: true, block: true }),
});
/** Validators for each classifier setting leaf (shared with the sweep's cascade, so a bad value is refused there too). */
export const CLASSIFY_VALID = Object.freeze({
  staleHoldAutoResume: (v) => typeof v === 'boolean',
  grantCeiling: (v) => Number.isSafeInteger(v) && v >= 1 && v <= MAX_TOTAL_ROUND_EXTENSIONS,
  maxFixListLines: (v) => Number.isSafeInteger(v) && v >= 1 && v <= 20,
  stateLanes: (v) => v === 'auto' || v === 'operator',
  systemActions: (v) => typeof v === 'boolean',
  policyActions: (v) => typeof v === 'boolean',
});
/** A plain record (Object or null prototype): a Date, an array or an object inheriting its fields is not one. */
const plain = (x) => !!x && typeof x === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(x));
/** Deep-copy plain JSON-shaped data, refusing anything that could hide a restriction from validation: a getter, a
 *  non-enumerable or symbol key, an inherited field, a non-plain prototype, a sparse array, a function. */
function strictClone(x, depth = 0) {
  if (x === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof x)) return x;
  if (depth > 20 || typeof x !== 'object') throw new Error('unreadable input');
  const isArr = Array.isArray(x);
  if (Object.getPrototypeOf(x) !== (isArr ? Array.prototype : Object.prototype) && !(!isArr && Object.getPrototypeOf(x) === null)) throw new Error('unreadable input: prototype');
  const out = isArr ? [] : {};
  for (const k of Reflect.ownKeys(x)) {
    if (isArr && k === 'length') continue;
    const d = Object.getOwnPropertyDescriptor(x, k);
    if (typeof k !== 'string' || !d.enumerable || !('value' in d) || k === '__proto__' || (isArr && !(/^(0|[1-9]\d*)$/.test(k) && Number(k) < x.length))) throw new Error('unreadable input: not a plain data property');
    out[k] = strictClone(d.value, depth + 1);
  }
  if (isArr && (out.length !== x.length || Object.keys(out).length !== x.length)) throw new Error('unreadable input: sparse array');
  return out;
}
const KNOWN_STATES = () => new Set([...Object.keys(EXPECTED_ACTOR), ...Object.keys(JUDGED_STATES), ...Object.keys(OPERATOR_STATES)]);
/** Defaults under the caller's values, every leaf validated; anything unknown or invalid throws (fails closed). */
export function classifySettings(raw = {}) {
  const top = strictClone(raw); // read once; a getter, hidden key or `__proto__` key is refused
  if (!plain(top)) throw new Error('unreadable settings');
  const out = { ...CLASSIFY_DEFAULTS };
  for (const [k, v] of Object.entries(top)) {
    // A misspelled or unknown key is refused: silently ignoring it would leave the stricter intent unapplied.
    if (!Object.hasOwn(CLASSIFY_DEFAULTS, k)) throw new Error(`unknown setting ${k}`);
    const ok = plain(CLASSIFY_DEFAULTS[k]) ? plain(v) && Object.entries(v).every(([sub, x]) => (k === 'stateLanes' ? KNOWN_STATES().has(sub) : Object.hasOwn(CLASSIFY_DEFAULTS[k], sub)) && CLASSIFY_VALID[k](x)) : CLASSIFY_VALID[k](v);
    if (!ok) throw new Error(`unreadable setting ${k}`);
    out[k] = isRec(v) ? { ...CLASSIFY_DEFAULTS[k], ...v } : v;
  }
  return out;
}

/** The waiting states where the round judge's verdict decides, and the judge trigger each one maps to. */
export const JUDGED_STATES = Object.freeze({ 'ruling-needed:referral-hold': 'referral-hold', 'ruling-needed:red-team-round-cap': 'red-team-cap',
  'at-round-limit': 'review-cap' });

/** Automation-owned waits: past the threshold with no live job, the TOOLING is broken, so a card is filed through the
 *  existing health smell that owns that wait. Never an operator ask. */
const TOOLING_SMELL = Object.freeze({
  fixing: 'fixer-stuck', 'sent-back-red-team': 'fixer-stuck', draft: 'pr-no-owner', 'ci-failed': 'red-pr-unattended',
  'awaiting-ci': 'ci-job-hung', 'ready-to-merge': 'pr-stage-stall', 'in-merge-queue': 'pr-stage-stall',
  // Only the drain skips that mean "the drain will get to it": an unknown or escalated skip kind is a person's.
  'drain-skip:queue-file-overlap': 'pr-stage-stall', 'drain-skip:overlap-yield': 'pr-stage-stall', 'drain-skip:ready-not-reached': 'pr-stage-stall',
});
/** Waits on the review daemon: ask it again, once per head. The sweep never spawns a review job itself. */
const REVIEW_WAITS = new Set(['awaiting-review', 'human-review-pending-advisory', 'red-team-pending', 'drain-skip:red-team-pending']);
/** The actor `deriveWaitingOn` sets for each state an automatic lane may act on. */
const EXPECTED_ACTOR = Object.freeze({
  'system:ledger-write-miss': 'system', 'system:stale-hold': 'system', 'red-team-sent-back-cleared': 'nobody',
  'awaiting-review': 'reviewer', 'human-review-pending-advisory': 'reviewer', 'red-team-pending': 'red-team', 'drain-skip:red-team-pending': 'red-team',
  fixing: 'fixer', 'sent-back-red-team': 'fixer', draft: 'fixer', 'ci-failed': 'fixer', 'awaiting-ci': 'ci', 'ready-to-merge': 'drain',
  'in-merge-queue': 'drain', 'drain-skip:queue-file-overlap': 'drain', 'drain-skip:overlap-yield': 'drain', 'drain-skip:ready-not-reached': 'drain',
});
/** Operator-owned states the judge does not cover: why a person is needed. */
const OPERATOR_STATES = Object.freeze({
  'ruling-needed:dispute': 'the fixer and the reviewer disagree about a ruling',
  'needs-decision:note': 'an escalation note waits for your answer',
  'draft-withdrawn': 'the PR was withdrawn to draft; only a person releases it',
  'needs-you': 'the PR carries status:needs-you',
  'human-review': 'the human review is owed',
  'drain-skip:not-certified': 'the drain will not merge it uncertified',
  unclassified: 'no signal says who moves next',
});

const keyOf = (row, head) => `${row.repo}#${row.number}@${String(head ?? '').toLowerCase()}:${row.waitingOn}`;
const fill = (cmd) => (typeof cmd === 'string' ? cmd : null);
/** Guard code for THIS policy, on top of the shared roster (`isGuardPath`): the judge, the round ceiling, the ruling and
 *  grant writers, and the stall sweep itself. A PR that edits the rules policy acts under is never acted on by policy. */
const POLICY_FILE = /(?:^|\/)(?:round-judge[\w-]*|round-extension-mark|extend-rounds[\w-]*|record-referral-ruling[\w-]*|pr-stall-[\w-]+|referral-card-readable|marker-authorship|pr-sweep-core)\.mjs$/;
const guarded = (p) => isGuardPath(p) || POLICY_FILE.test(p);
/** A plain record: an array (or anything else) dressed up with the right fields is not one. */
const isRec = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
/** A dense list of CANONICAL repo-relative paths: a `./x`, `/x`, `a/../b`, `a//b` or padded spelling could slip past
 *  the guard predicates, so it is unreadable rather than normalised. A `we:` style prefix (any `:`) is refused too. */
const canonical = (x) => typeof x === 'string' && x !== '' && x === x.trim() && !/^\.{0,2}\/|\\|\/\/|\/$|:|[\0-\x1f\x7f]|(^|\/)\.\.?(\/|$)/.test(x);
const strings = (a) => Array.isArray(a) && [...a].every(canonical);
/** A judge finding the sweep can act on: a named file and a real summary. A sparse or partial list is not. */
const goodFinding = (f) => isRec(f) && typeof f.file === 'string' && f.file.trim() !== ''
  && typeof f.summary === 'string' && f.summary.trim().length >= 8 && ['broken', 'degraded', 'unconfirmed'].includes(f.cls)
  && (f.line === null || f.line === undefined || (Number.isSafeInteger(f.line) && f.line > 0)) && isCount(f.priorAppearances);

/**
 * Classify one stalled row. PURE; never throws.
 * @param {{row:object, head?:string, verdict?:(object|null), files?:string[], card?:({id:string, readable:boolean}|null),
 *   grantsSoFar?:number, settings?:object}} o  `settings`: see {@link CLASSIFY_DEFAULTS}
 *   `card` is an EXISTING backlog card the sweep matched to the coverage findings and proved readable; `grantsSoFar`
 *   overrides the judge's own count of round grants already spent (the sweep adds policy grants once they exist).
 * @returns {{lane:string, action:string, reason:string, key:string, actor?:string, k?:number, card?:string,
 *   fixList?:string[], trigger?:string, smell?:string, command:(string|null), evidence:string[]}|null}
 *   null = the row is not stalled (nothing to do).
 */
export function classifyStall(o) {
  try { return classifyUnsafe(o); } catch (e) {
    let key = '?#0@:unknown';
    try { const row = o?.row ?? {}; key = keyOf({ repo: row.repo ?? '?', number: row.number ?? 0, waitingOn: row.waitingOn ?? 'unknown' }, o?.head); } catch { /* keep the placeholder */ }
    return { lane: 'operator', action: 'unclassified', reason: `fail-closed: classifier error (${String(e?.message ?? e).slice(0, 120)})`,
      key, command: null, evidence: [] };
  }
}

function classifyUnsafe(o = {}) {
  if (!plain(o)) throw new Error('unreadable input');
  const rawSettings = o.settings; // read once: a getter must not validate one value and serve another
  const cfg = classifySettings(rawSettings === undefined ? {} : rawSettings);
  // Every other input is read ONCE into plain data (getters run once, here): what is validated is what is used.
  const { row, head = '', verdict = null, files = [], card = null, grantsSoFar } = strictClone({ row: o.row, head: o.head, verdict: o.verdict ?? null,
    files: o.files ?? [], card: o.card ?? null, grantsSoFar: o.grantsSoFar });
  if (!isRec(row) || typeof row.repo !== 'string' || !/^[\w-]+\/[\w-][\w.-]*$/.test(row.repo) || repoKeyForSlug(row.repo) === null
    || !Number.isSafeInteger(row.number) || row.number <= 0 || typeof row.waitingOn !== 'string' || !row.waitingOn) {
    throw new Error('unreadable row');
  }
  if (typeof row.stalled !== 'boolean') throw new Error('unreadable row: stalled is not a boolean');
  if (row.liveJob !== null && !(typeof row.liveJob === 'string' && row.liveJob.trim())) throw new Error('unreadable row: liveJob');
  if (typeof row.why !== 'string' || !Array.isArray(row.evidence) || !row.evidence.every((x) => typeof x === 'string')
    || !(row.next == null || (isRec(row.next) && (row.next.command == null || typeof row.next.command === 'string')))) throw new Error('unreadable row: why / evidence / next');
  if (!row.stalled) return null;
  if (typeof head !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(head)) throw new Error('unreadable head');
  const key = keyOf(row, head);
  const acts = nextActions({ repo: row.repo, number: row.number });
  const evidence = row.evidence.slice(0, 3);
  const state = row.waitingOn;
  const out = (lane, action, reason, extra = {}) => {
    const r = { lane, action, reason, key, command: null, evidence, ...extra };
    // The last line of defence: no automatic lane may produce an action reserved for a person.
    if (lane !== 'operator' && NEVER_AUTOMATIC.includes(action)) return { ...r, lane: 'operator', reason: `fail-closed: ${action} is never automatic` };
    // Settings may only send an automatic item to a person: a state forced to the operator, or an action switched off.
    const toPerson = (why) => ({ ...r, lane: 'operator', reason: `${why}; ${reason}`, command: fill(row.next?.command) });
    if (lane !== 'operator' && cfg.stateLanes[state] === 'operator') return toPerson(`setting stateLanes.${state}=operator`);
    if (lane === 'system' && cfg.systemActions[action] !== true) return toPerson(`setting systemActions.${action} is off`);
    if (lane === 'policy' && cfg.policyActions[action] !== true) return toPerson(`setting policyActions.${action} is off`);
    return r;
  };
  const operator = (action, reason, command = row.next?.command) => out('operator', action, reason, { command: fill(command) });

  if (/\(evidence unreadable/.test(row.why)) return operator('unreadable-evidence', 'the referral thread could not be read; a person must look');

  // An automatic or judged state needs the EXACT actor pr-sweep-core gives it; any other is a contradiction a person reads.
  const want = EXPECTED_ACTOR[state] ?? (JUDGED_STATES[state] ? 'operator' : null);
  if (want && row.actor !== want) return operator('unclassified', `fail-closed: actor ${JSON.stringify(row.actor)} does not fit ${state}`);

  if (state === 'system:ledger-write-miss') return out('system', 'await-ledger-outbox', 'the reviewer\'s referral save failed; the ledger outbox re-saves it');
  if (state === 'system:stale-hold') {
    // Resuming a hold lets the review move on: it needs guard-free file evidence, like any policy action.
    const guardFree = strings(files) && files.length > 0 && !files.some(guarded);
    return cfg.staleHoldAutoResume === true && guardFree
      ? out('system', 'resume-stale-hold', 'every finding already has a standing ruling; stale-hold auto-resume releases it')
      : operator('stale-hold', 'the hold is stale (every finding is ruled) and stale-hold auto-resume is off', acts.referralRuling.command);
  }
  if (state === 'red-team-sent-back-cleared') return out('system', 'rerun-red-team-gate', 'a confirmed red-team break was sent back but no fixer owns it; the gate re-sends it');
  // System nudges never rule on anything, so a guard file does not stop them (it stops every POLICY action, below).
  if (REVIEW_WAITS.has(state)) {
    return row.liveJob ? null : out('system', 'ask-review-daemon', `waiting on the ${row.actor === 'red-team' ? 'red team' : 'reviewer'} with no live job; ask the review daemon once for this head`,
      { onceKey: `${row.repo}#${row.number}@${head.toLowerCase()}:ask-review-daemon` });
  }
  if (OPERATOR_STATES[state]) return operator(state, OPERATOR_STATES[state]);
  const smell = TOOLING_SMELL[state] ?? null;
  if (smell) {
    return row.liveJob ? null : out('system', 'tooling-card', `waiting on ${row.actor} past the threshold with no live job; the tooling is stuck, not the PR`, { smell });
  }

  const trigger = JUDGED_STATES[state];
  if (!trigger) return operator('unclassified', `fail-closed: unknown waiting state ${JSON.stringify(state)}`);
  return judged({ head, verdict, trigger, files, card, grantsSoFar, acts, out, operator, cfg });
}

/** A PR at a round cap / referral hold: the judge's verdict decides, within the standing policy. */
function judged({ head, verdict, trigger, files, card, grantsSoFar, acts, out, operator, cfg }) {
  if (!isRec(verdict) || !validateVerdict(verdict).ok) return operator('no-verdict', `fail-closed: no valid round-judge verdict (${validateVerdict(verdict).why})`);
  // validateVerdict walks arrays with .some(), which skips holes: densify before trusting the reasons.
  if (![...verdict.reasons].every((r) => typeof r === 'string' && r.trim())) return operator('no-verdict', 'fail-closed: the verdict reasons are malformed');
  const ev = verdict.evidence;
  const why = verdict.reasons.slice(0, 3).join('; ');
  if (isRec(ev) && !(ev.failClosed === undefined || typeof ev.failClosed === 'boolean')) return operator('no-verdict', 'fail-closed: a malformed failClosed flag');
  if (ev?.failClosed) return operator('escalate', `the judge failed closed (${why})`);
  if (!isRec(ev)) return operator('no-verdict', 'fail-closed: the verdict carries no evidence');
  if (ev.trigger !== trigger) return operator('no-verdict', `fail-closed: the verdict is for ${ev.trigger ?? 'no trigger'}, the PR is at ${trigger}`);
  // A verdict judged on another head says nothing about this one.
  if (ev.head !== head.toLowerCase().slice(0, 12)) {
    return operator('no-verdict', 'fail-closed: the verdict was judged on a different head');
  }

  switch (verdict.verdict) {
    case 'escalate': return operator('escalate', `the judge escalated: ${why}`);
    case 'suggest-split': return operator('suggest-split', `the judge suggests splitting the PR: ${why}`);
    case 'not-real-verified': return operator('suggest-not-real', `every finding was mechanically refuted; only a person rules not-real (${(verdict.proof ?? []).slice(0, 2).join(' | ')})`,
      trigger === 'referral-hold' ? acts.referralRuling.command : acts.redTeamRuling.command);
    default: break;
  }

  // Policy may never act on guard / gate code: the judge's own guard list plus the PR's files. A malformed list is unknown.
  // Policy needs AFFIRMATIVE, complete evidence: an empty or unknown file list proves nothing about guard code, and the
  // judge's own guard list and findings must both be present.
  if (!strings(files) || !files.length || ev.filesKnown !== true || !strings(ev.guardFiles) || !Array.isArray(ev.latest)) {
    return operator('no-verdict', 'fail-closed: the PR file list or the judge\'s evidence is incomplete');
  }
  if (!isCount(ev.crossBroken)) return operator('no-verdict', 'fail-closed: the judge\'s cross-source break count is unreadable');
  // The judge's own tallies must agree with the findings it lists: a disagreement means a finding is missing.
  const tally = (cls) => ev.latest.filter((f) => f?.cls === cls).length;
  if (ev.latestCount !== ev.latest.length || !isRec(ev.classes) || ['broken', 'degraded', 'unconfirmed'].some((c) => ev.classes[c] !== tally(c))) {
    return operator('no-verdict', 'fail-closed: the judge\'s finding counts disagree with its findings');
  }
  if (![...ev.latest].every(goodFinding) || !strings(ev.latest.map((f) => f.file))) return operator(verdict.verdict, 'fail-closed: the judge\'s open findings are malformed');
  const guards = [...new Set([...ev.guardFiles, ...files, ...ev.latest.map((f) => f.file)])].filter(guarded);
  if (guards.length) return operator('guard-file-touched', `the PR touches guard code (${guards[0]}); policy does not act on it`);

  if (!isCount(ev.grantsSoFar) || !(grantsSoFar === undefined || isCount(grantsSoFar))) return operator('no-verdict', 'fail-closed: the rounds already granted are unknown');
  const policy = (action, reason, extra) => out('policy', action, reason, { actor: POLICY_ACTOR, trigger, ...extra });
  if (verdict.verdict === 'grant') {
    if (trigger === 'referral-hold') return operator('no-verdict', 'a round grant does not answer a referral hold');
    if (ev.crossBroken !== 0) return operator('no-verdict', 'fail-closed: a break may be open in another source (crossBroken is not 0)');
    // The caller's count may only ADD to the judge's (policy grants the judge cannot see), never lower it.
    const spent = Math.max(ev.grantsSoFar, grantsSoFar ?? 0);
    if (spent + verdict.k > cfg.grantCeiling) {
      return operator('past-ceiling', `the judge would grant +${verdict.k} but ${spent} of the ${cfg.grantCeiling}-round ceiling is spent`, acts.roundLimit.command);
    }
    return policy('grant', `findings are converging (${why}); +${verdict.k} round(s) inside the ${cfg.grantCeiling}-round ceiling`, { k: verdict.k });
  }

  const latest = ev.latest;
  if (!latest.length) return operator(verdict.verdict, 'fail-closed: the judge\'s open findings are missing or malformed');
  if (verdict.verdict === 'card-the-rest') {
    if (trigger !== 'referral-hold') return operator('card-the-rest', `only coverage findings are open (${why}); carding them past a ${trigger} is a person's call`);
    // Coverage only, and no confirmed break left open in another source (the judge's `crossBroken`; unknown = not zero).
    const coverageOnly = latest.every((f) => f.cls === 'degraded') && ev.crossBroken === 0;
    if (!coverageOnly) return operator('card-the-rest', 'fail-closed: not every open finding is coverage class');
    if (!isRec(card) || typeof card.id !== 'string' || !CARD_REF_RE.test(card.id) || card.readable !== true) {
      return operator('card-the-rest', 'only coverage findings are open, but no existing readable card matches them; policy never files a new one');
    }
    return policy('card', `every open finding is coverage class; rule card to existing card ${card.id}`, { card: card.id });
  }

  // send-back: block with the judge's concrete fix list. At the REVIEW round limit a block has no round left to fix in,
  // so it stays a person's call (conservative on purpose).
  if (trigger === 'review-cap') return operator('send-back-at-round-limit', `the judge says send back (${why}), but the review rounds are spent; grant rounds or rule`, acts.roundLimit.command);
  const fixList = typeof verdict.body === 'string' && verdict.body.trim()
    ? verdict.body.split('\n').map((l) => l.trim()).filter(Boolean)
    // No body: the fix is worked out from each finding's own remedy sentence; a bare diagnosis names no fix.
    : latest.map((f) => proposeFix(f));
  if (fixList.some((l) => typeof l !== 'string')) return operator('no-verdict', 'fail-closed: a finding states no concrete fix');
  // Every line must read as a concrete fix (`path[:line] - instruction`, the judge's own `proposeFix` shape).
  const pathOf = (l) => /^(\S+?)(?::[1-9]\d{0,6})? - (.{20,})$/.exec(l);
  // ...and each instruction must state a remedy (the same `proposeFix` reading as the no-body path), not a diagnosis.
  const concrete = (l) => { const m = pathOf(l); return !!m && canonical(m[1]) && !/[\0-\x1f\x7f]/.test(m[2]) && proposeFix({ file: m[1], summary: m[2] }) !== null; };
  if (!fixList.length || fixList.length > cfg.maxFixListLines || !fixList.every(concrete)) return operator('no-verdict', `fail-closed: a send-back with no concrete fix list (1-${cfg.maxFixListLines} fixes)`);
  const bodyGuard = fixList.map((l) => pathOf(l)[1]).find(guarded);
  if (bodyGuard) return operator('guard-file-touched', `the fix list touches guard code (${bodyGuard}); policy does not act on it`);
  return policy('block', `send back with ${fixList.length} concrete fix(es): ${why}`, { fixList });
}
