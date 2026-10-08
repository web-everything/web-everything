/**
 * @file scripts/lib/ruling-ledger.mjs
 * @description Two durable facts about a PR, both read from its own comment thread (the mandatory-referral
 *   records, `jury-core.mjs#readReferralRecords`), so the daemon, the operator queue and the health watch all
 *   answer from ONE definition and no state store of their own:
 *
 *   1. RULING NEEDED — the PR's CURRENT head carries an attempted referral record with CONFIRMED findings that
 *      still await a finding-specific block/card/not-real ruling. Live 2026-10-04, PR #3794: the review parked
 *      correctly ("review paused: N referrals need a ruling") and then nothing told the operator for 8 hours.
 *      This is the input for the `advisory:ruling-needed` label, the NEEDS-YOU row, the push and the health alert.
 *
 *   2. IGNORED RULING — a confirmed finding on the current head matches (same file, same or similar claim) a
 *      finding already ruled `block` on an EARLIER head. The fixer's push did not satisfy the ruling. Parking it
 *      again just waits for the same human to repeat themselves, so it goes back to the fixer with the original
 *      ruling attached; a second miss is a fixer-versus-reviewer disagreement. Two sources of a block ruling,
 *      because the live case used the second: (a) a `block` ruling inside a referral record, and (b) the
 *      operator's own "Operator ruling ... ruling: block" verdict comment (live: PR #3794, comment of
 *      2026-10-04 01:19Z, card xcs4nce; the in-record rulings on that thread were the automated reviewer's
 *      `card`/`not-real`, which never overrode it).
 *
 * PURE. A record is only read from a trusted author (`readReferralRecords` enforces that), and a comment that
 * cannot be read as a record contributes nothing here (the hold itself already fails closed on malformed ones).
 */
import { readReferralRecords, mandatoryReferralState, parseOperatorRulingComment, readOperatorRulings, carriedBackingHolds, sameFindingForClearing } from './jury-core.mjs';
import { isOperatorAuthored, isTrustedMarkerAuthor } from './marker-authorship.mjs';
import { DEFAULT_FIXER_ESCALATION, TEST_FIRST_INSTRUCTION, humanAtMisses } from './fixer-escalation-policy.mjs';

export const RULING_NEEDED_LABEL = 'advisory:ruling-needed';
export const RULING_NEEDED_LABEL_META = Object.freeze({
  color: 'fbca04',
  description: 'AI review parked with confirmed findings that need an operator ruling on the current head (auto-managed)',
});

/** Leading line of the send-back comment; its hidden second marker carries the head it answered. */
export const RULING_NOT_ADDRESSED_MARKER = '⛔ conveyor — ruling not addressed';
/** Misses at which the PLATFORM-DEFAULT ladder asks a person, with only Claude rungs available (the cross-provider rung
 *  is dormant until a launcher is wired). Callers that loaded the effective ladder pass its own `humanAt`. */
export const DEFAULT_HUMAN_AT = humanAtMisses(DEFAULT_FIXER_ESCALATION, { available: (r) => r.provider !== 'codex' });
const SIMILARITY_FLOOR = 0.5;

const SHA = /^[a-f0-9]{40}$/;
const OPENER = /^[ \t]*<!-- mandatory-referrals-v1:/m;
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const sinceOf = (c) => Date.parse(c?.createdAt ?? c?.updatedAt) || null;

/** Each record snapshot with the comment that carried it, in thread order. Reuses the one record reader. */
function recordSnapshots(comments, head) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((comment, index) => {
    if (typeof comment === 'string' || !OPENER.test(comment?.body ?? '')) return;
    for (const record of readReferralRecords([comment], { head }).records) out.push({ record, comment, index });
  });
  return out;
}

const findingView = (f) => ({
  key: f.key, seat: f.seat, file: f.finding?.file ?? null, line: f.finding?.line ?? null,
  summary: oneLine(f.finding?.summary),
});

const activeRulings = (record, key) => {
  const mine = record.rulings.filter((r) => r.key === key);
  const superseded = new Set(mine.flatMap((r) => (r.supersedes == null ? [] : [].concat(r.supersedes))));
  return mine.filter((r) => !superseded.has(r.id));
};

/** Latest snapshot of each record on `head` (a later snapshot may have ruled what an earlier one left open). */
function currentRecords(snaps, head) {
  const latest = new Map();
  for (const s of snaps) if (s.record.head === head && s.record.attempted) latest.set(s.record.runId, s);
  return [...latest.values()];
}

/**
 * The findings that await a ruling on the PR's current head, or null: those a record still lists as pending
 * (`reason: 'pending'`), plus those that came back after an operator block and have now missed twice
 * (`reason: 'dispute'`: fixer and reviewer disagree, so only the operator can settle it).
 * @param {{comments?: Array, headRefOid?: string}} pr
 * @returns {null|{head:string, since:number|null, findings:Array<{key:string,seat:string,file:?string,line:?number,summary:string,reason:string}>}}
 */
export function rulingNeeded(pr, { humanAt = DEFAULT_HUMAN_AT, cardReadable = () => true } = {}) {
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  if (!SHA.test(head)) return null;
  // Held item 132 (live #4271): an ACCEPTED PR has nothing left to rule on. Its label must not outlive the acceptance.
  if ((Array.isArray(pr?.labels) ? pr.labels : []).some((l) => (typeof l === 'string' ? l : l?.name) === 'review:accepted')) return null;
  const snaps = recordSnapshots(pr?.comments, head);
  let since = null;
  let firstIndex = Infinity;
  for (const s of snaps) {
    if (s.record.head !== head || !s.record.attempted) continue;
    firstIndex = Math.min(firstIndex, s.index);
    const at = sinceOf(s.comment);
    if (at !== null && (since === null || at < since)) since = at;
  }
  if (operatorVerdictAfter(pr?.comments, firstIndex)) return null;
  // THE SAME LIST THE ADVISORY COUNTS (`mandatoryReferralState().pendingFindings`), read with the same card rule the
  // gate uses when the caller passes one. It once re-derived the set with `cardReadable: () => true`, so the label
  // listed fewer findings than the gate held (live #4271, 2026-10-07: 7 held, a shorter list shown).
  const state = mandatoryReferralState(pr.comments, { head, cardReadable,
    ...(typeof pr?.body === 'string' ? { body: pr.body } : {}), ...(pr?.createdAt ? { createdAt: pr.createdAt } : {}) });
  const live = new Map();
  for (const f of state.pendingFindings) {
    if (f.attempted && !live.has(f.key)) live.set(f.key, { key: f.key, seat: f.seat, file: f.file, line: f.line, summary: f.summary, reason: 'pending' });
  }
  const ig = ignoredRulings(pr, { humanAt });
  if (ig?.escalate) for (const m of ig.matches) if (!live.has(m.finding.key)) live.set(m.finding.key, { ...m.finding, reason: 'dispute' });
  return live.size ? { head, since, findings: [...live.values()] } : null;
}

const STOP = new Set('the and but that this with for are not from into its any all can may will would when which than then there was were has have had been being does did only also each every both such'.split(' '));
const stem = (w) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
const tokens = (text) => new Set(oneLine(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
/** Shared words over the SMALLER side: a reworded or paraphrased claim still matches, an unrelated one does not. */
export function claimSimilarity(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return oneLine(a).toLowerCase() === oneLine(b).toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  // Three shared words minimum, or a two-word claim would match anything that mentions both.
  return shared >= Math.min(3, x.size, y.size) ? shared / Math.min(x.size, y.size) : 0;
}
const normPath = (p) => String(p ?? '').replace(/^\.\//, '').replace(/^\/+/, '');
/** Same file, and the same or a similar claim (the line may drift after a fix, so it is never compared). */
export function sameFinding(a, b) {
  if (!a.file || !b.file || normPath(a.file) !== normPath(b.file)) return false;
  return claimSimilarity(a.summary, b.summary) >= SIMILARITY_FLOOR;
}

/** What `sameFindingForClearing` (jury-core) compares: the exact path, the spot, the claim and the severity of a finding. */
const clearingView = (f) => ({ file: f.finding?.file, line: f.finding?.line, summary: f.finding?.summary,
  verdict: f.finding?.verdict, impactIfUnfixed: f.finding?.impactIfUnfixed });

/** The operator's own words for a ruling, one block of text for the fixer. */
export function rulingText(ruling) {
  const parts = [`${ruling.result}${ruling.card ? ` (${ruling.card})` : ''}: ${oneLine(ruling.rationale)}`];
  if (Array.isArray(ruling.evidence) && ruling.evidence.length) parts.push(`evidence: ${ruling.evidence.map(oneLine).join('; ')}`);
  return parts.join(' | ');
}

const OPERATOR_VERDICT = '🔁 review — changes requested';
const BLOCK_RULING = /ruling:\s*\*{0,2}\s*block\b/i;
// A card id (`xcs4nce`) or a path, as the operator names the thing a block ruling is about.
const hintsOf = (block) => [...block.matchAll(/`([^`\s]+)`|\bcard\s+(\d{3,5})\b/gi)]
  .map((m) => (m[1] ?? m[2]).toLowerCase()).filter((h) => /^(x[0-9a-z]{6}|\d{3,5}|[^\s]*[./][^\s]*)$/.test(h));
/**
 * The block rulings the OPERATOR wrote in a verdict comment ("## Operator ruling: send back to fix (block)"): one
 * entry per paragraph or list item that says `ruling: block`, with the card ids / paths it names. Only the
 * operator's own login counts (a block ruling is the operator's, and `author.login` cannot be forged by a body).
 */
export function operatorBlockRulings(comments) {
  const out = [];
  (Array.isArray(comments) ? comments : []).forEach((comment, index) => {
    const body = String(comment?.body ?? '');
    if (typeof comment === 'string' || !isOperatorAuthored(comment) || !body.trimStart().startsWith(OPERATOR_VERDICT)) return;
    for (const block of body.split(/\n\s*\n|\n(?=\s*\d+\.\s)/)) {
      if (!BLOCK_RULING.test(block)) continue;
      const hints = hintsOf(block);
      if (hints.length) out.push({ index, at: sinceOf(comment), text: oneLine(block.replace(/\*\*/g, '')).slice(0, 700), hints });
    }
  });
  return out;
}
/** Did the operator send the PR back (a verdict comment of their own) after thread position `index`? That IS a ruling on
 *  everything open at that point, so nothing is "waiting" or "ignored" for a head whose records came before it. */
const operatorVerdictAfter = (comments, index) => (Array.isArray(comments) ? comments : []).some((c, i) => i > index
  && typeof c !== 'string' && isOperatorAuthored(c) && String(c?.body ?? '').trimStart().startsWith(OPERATOR_VERDICT));
const hintMatchesFile = (hints, file) => !!file && hints.some((h) => String(file).toLowerCase().includes(h));

/**
 * Confirmed findings on the current head that repeat a finding already ruled `block` on an earlier head.
 * `misses` = distinct heads, after the ruling, on which the finding came back (the current head included).
 * A ruling the operator wrote AFTER this head's record is a fresh ruling on it, not an ignored one.
 * @returns {null|{head:string, misses:number, escalate:boolean, sentBack:boolean, sentBackAt:?number, matches:Array<object>}}
 */
export function ignoredRulings(pr, { humanAt = DEFAULT_HUMAN_AT, countInfraStalls = false } = {}) {
  const head = String(pr?.headRefOid ?? '').toLowerCase();
  if (!SHA.test(head)) return null;
  const snaps = recordSnapshots(pr?.comments, head);
  const cur = currentRecords(snaps, head);
  if (!cur.length) return null;
  const firstIndex = Math.min(...snaps.filter((s) => s.record.head === head).map((s) => s.index));
  if (operatorVerdictAfter(pr?.comments, firstIndex)) return null;
  const operator = operatorBlockRulings(pr?.comments);

  // Every block ruling: (a) inside an earlier head's record, (b) the operator's own verdict comments.
  // Read each earlier record from its LATEST snapshot only: supersession is resolved inside one snapshot, so an older
  // snapshot would keep planting a block that a later one withdrew. The ruling's thread position is where it first appeared.
  const blocks = new Map();
  const latestOfRun = new Map();
  for (const s of snaps) if (s.record.head !== head) latestOfRun.set(`${s.record.head}:${s.record.runId}`, s);
  for (const { record, index: latestIndex } of latestOfRun.values()) {
    for (const f of record.referrals) {
      for (const r of activeRulings(record, f.key)) {
        if (r.result !== 'block') continue;
        const firstSeen = snaps.find((s) => s.record.head === record.head && s.record.runId === record.runId
          && s.record.rulings.some((x) => x.key === f.key && x.id === r.id));
        blocks.set(`${record.head}:${record.runId}:${r.id}`, { source: 'record', rulingId: r.id, finding: findingView(f), clearing: clearingView(f), ruling: rulingText(r), priorHead: record.head, index: firstSeen?.index ?? latestIndex });
      }
    }
  }
  operator.forEach((o, n) => blocks.set(`operator:${n}`, { source: 'operator', hints: o.hints, text: o.text, ruling: o.text, priorHead: null, index: o.index, at: o.at }));

  // The operator's structured (#4979) rulings, with thread position and the finding each one ruled. A block that a
  // LATER non-block one overruled on the same finding is no longer a standing ruling (plateau-app #202, 2026-10-04:
  // a reviewer block on the first head, then the operator's not-real on the next head, raised a false "dispute").
  // The LATEST operator ruling on that finding decides: a later operator `block` withdraws an intervening not-real/card,
  // so the original block stands again. "Same finding" is `sameFindingForClearing` (exact path, line window, claim and
  // severity), the one definition the carry uses: a ruling on one instance never overrules a block on another.
  const allRecords = snaps.map((s) => s.record);
  const operatorRulings = readOperatorRulings(pr?.comments).rulings;
  const structured = [];
  (Array.isArray(pr?.comments) ? pr.comments : []).forEach((c, index) => {
    const parsed = parseOperatorRulingComment(c);
    for (const x of parsed?.record?.rulings ?? []) {
      const ruled = allRecords.find((r) => r.runId === x.runId && r.head === parsed.record.head)?.referrals.find((f) => f.key === x.key);
      if (ruled) structured.push({ index, result: x.result, clearing: clearingView(ruled), supersedes: x.supersedes ?? [] });
    }
  });
  const overruled = (b) => {
    if (b.source !== 'record') return false;
    // Held item 132: the LATEST operator ruling on the finding decides. It reaches the block either by naming the block's
    // id (`supersedes`, which survives a drifted line) or by being the same finding. A `block` never overrules.
    const latest = structured.filter((o) => o.index > b.index
      && ((b.rulingId && o.supersedes.includes(b.rulingId)) || sameFindingForClearing(o.clearing, b.clearing))).at(-1);
    return !!latest && latest.result !== 'block';
  };

  const matchesBlock = (view, b) => b.source === 'record'
    ? sameFinding(view, b.finding)
    : hintMatchesFile(b.hints, view.file) && claimSimilarity(view.summary, b.text) >= SIMILARITY_FLOOR;

  const matches = [];
  let worst = 0;
  for (const { record } of cur) {
    // A `block` already recorded on THIS head is the normal bounce, not an ignored ruling. Another ruling recorded
    // against an earlier in-record block is a deliberate re-ruling of it.
    const rulingsHere = (key) => activeRulings(record, key);
    for (const f of record.referrals) {
      const g = findingView(f);
      if (matches.some((m) => m.finding.key === g.key)) continue;
      if (rulingsHere(f.key).some((r) => r.result === 'block')) continue;
      // Already settled on this head by the operator: any structured ruling of theirs here (block included — they
      // looked at it), or a not-real/card one carried forward from an earlier head whose operator backing is still in
      // the thread. A carried `block` settles nothing: the cited lines are unchanged, which is exactly an ignored ruling.
      if (operatorRulings.some((o) => o.head === head && o.runId === record.runId && o.key === f.key)
        || (record.carried ?? []).some((c) => c.key === f.key && c.result !== 'block'
          && carriedBackingHolds(c, { repo: record.repo, pr: record.pr, operatorRulings }))) continue;
      // The standing ruling is the LATEST matching block: a fresh re-ruling restarts the count, so the ladder gives
      // the fixer the rungs that re-ruling bought instead of counting heads from the first ruling.
      let b = null;
      for (const c of blocks.values()) {
        if (c.index > firstIndex) continue; // written after this head's record: a fresh ruling on it
        if (!matchesBlock(g, c)) continue;
        if (c.source === 'record' && rulingsHere(f.key).length) continue;
        if (overruled(c)) continue;
        if (!b || c.index > b.index) b = c;
      }
      if (!b) continue;
      // The operator re-ruled on this very head after seeing it: handled, not ignored.
      if (operator.some((o) => o.index > firstIndex && hintMatchesFile(o.hints, g.file) && claimSimilarity(g.summary, o.text) >= SIMILARITY_FLOOR)) continue;
      const heads = new Set([head]);
      for (const s of snaps) {
        if (s.index <= b.index || s.record.head === b.priorHead) continue;
        if (s.record.referrals.some((x) => matchesBlock(findingView(x), b))) heads.add(s.record.head);
      }
      worst = Math.max(worst, heads.size);
      matches.push({ finding: g, ruledFinding: b.source === 'record' ? b.finding : null, ruling: b.ruling, priorHead: b.priorHead,
        ruledAt: b.at ? new Date(b.at).toISOString() : null, source: b.source, misses: heads.size });
    }
  }
  if (!matches.length) return null;
  const sent = sentBackAt(pr?.comments, head);
  // A fixer that was sent back, ended, and left this head unchanged missed once more: the ladder counts it.
  const returns = fixerReturnsAfter(pr?.comments, sent, { countInfraStalls });
  const effective = worst + returns;
  return { head, misses: worst, returns, effectiveMisses: effective, escalate: effective >= humanAt, sentBack: sent !== null, sentBackAt: sent, noticedRungs: noticedRungs(pr?.comments, head), matches };
}

/** Leading text of the fix-end marker (`we:scripts/conveyor/fix-procedure.mjs#FIX_END_MARKER`; a test pins them equal). */
export const FIX_END_PREFIX = '🔓 conveyor fix-end';
/** Leading text of the infra-stall mark a fix-end carries when its turn ended `blocked-on-infra`
 *  (`we:scripts/conveyor/fix-procedure.mjs#FIX_END_INFRA_STALL_MARK`; a test pins them equal). */
export const FIX_END_INFRA_STALL_PREFIX = '<!-- fix-end-outcome: blocked-on-infra';
/** Env knob: `WE_FIXER_LADDER_COUNT_INFRA_STALLS=1` makes an infra-stalled fixer turn count as a miss again
 *  (default off: an outage — verify never ran, GitHub down — says nothing about the fixer). */
export const COUNT_INFRA_STALLS_ENV = 'WE_FIXER_LADDER_COUNT_INFRA_STALLS';
export function resolveCountInfraStalls(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env?.[COUNT_INFRA_STALLS_ENV] ?? '').trim());
}
/** Turns a fixer ended after this head was sent back: each one that left the head unchanged is one more miss —
 *  except a turn that ended blocked on infrastructure (live 2026-10-04, PR #3890), unless `countInfraStalls`. */
export function fixerReturnsAfter(comments, at, { countInfraStalls = false } = {}) {
  if (at == null) return 0;
  return (Array.isArray(comments) ? comments : []).filter((c) => isTrustedMarkerAuthor(c)
    && String(c?.body ?? '').trimStart().startsWith(FIX_END_PREFIX) && (sinceOf(c) ?? 0) > at
    && (countInfraStalls || !String(c.body).includes(FIX_END_INFRA_STALL_PREFIX))).length;
}

const sentBackLine = (head, rungId = null) => `<!-- ruling-not-addressed: ${head}${rungId ? ` rung=${rungId}` : ''} -->`;
const sentBackComments = (comments, head) => (Array.isArray(comments) ? comments : []).filter((c) => isTrustedMarkerAuthor(c)
  && String(c?.body ?? '').trimStart().startsWith(RULING_NOT_ADDRESSED_MARKER)
  && new RegExp(`<!-- ruling-not-addressed: ${head}(?: rung=[\\w-]+)? -->`).test(String(c.body)));
/** The ladder rungs this head has already been announced on (one notice per head and rung). */
export function noticedRungs(comments, head) {
  return sentBackComments(comments, head).map((c) => /rung=([\w-]+)/.exec(c.body)?.[1] ?? '*');
}
/** When a trusted author sent this head back (ms), or null. Also the once-per-head guard for the post. */
export function sentBackAt(comments, head) {
  const times = sentBackComments(comments, head).map((c) => sinceOf(c) ?? 0);
  return times.length ? Math.min(...times) : null;
}
export const hasSentBack = (comments, head) => sentBackAt(comments, head) !== null;

const where = (f) => `${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}`;
/** The PR comment that goes with the send-back: the durable record AND what the fixer reads. */
export function renderRulingNotAddressed({ head, matches, rung = null }) {
  return `${RULING_NOT_ADDRESSED_MARKER}\n\nThe last fix did not satisfy a ruling the operator already gave. `
    + 'A review on the new head reports the same confirmed finding again, so this goes straight back to a fixer.\n\n'
    + (rung ? `**Escalation rung ${rung.at} (${rung.id}):** ${rung.label}${rung.model ? ` — model ${rung.model}` : ''}.\n\n` : '')
    + matches.map((m) => `- \`${where(m.finding)}\` — ${m.finding.summary}\n`
      + `  - earlier ruling (${m.priorHead ? `head \`${m.priorHead.slice(0, 9)}\`` : `operator, ${m.ruledAt ?? 'earlier'}`}): ${m.ruling}\n`
      + `  - times it came back after the ruling: ${m.misses}`).join('\n')
    + `\n\n${sentBackLine(head, rung?.id)}`;
}

/** The text put in front of the fixer's brief. */
export function fixerRulingBrief({ matches, rung = null }) {
  return '# Ruling not addressed — read this first\n\n'
    + 'The operator already ruled on the finding(s) below, and your predecessor\'s last push did not satisfy the ruling. '
    + 'This is the whole ask: change the code so each finding is actually fixed as ruled. '
    + 'Treat the "⛔ conveyor — ruling not addressed" comment on the PR as the authoritative finding '
    + '(advisory-fix style: repair only this, no verdict, never touch review:human).\n\n'
    + matches.map((m) => `- ${where(m.finding)} — ${m.finding.summary}\n  Operator ruling, verbatim: ${m.ruling}\n  Note: the last fix did not satisfy this.`).join('\n')
    + (rung?.instruction === TEST_FIRST_INSTRUCTION
      ? '\n\nThis is escalation rung ' + rung.at + ' (' + rung.id + '): the same finding has now come back ' + rung.at + ' time(s). '
        + 'Before changing any code, write a failing test for EACH finding above that fails on the current head for the reason the ruling gives, '
        + 'show it red, then make the fix that turns it green. A fix without such a test will be judged as not addressing the ruling.'
      : '')
    + '\n\n';
}

export const rulingDisputeText = (prNumber, ig, trail = '') => `PR #${prNumber}: ${ig.matches.length} confirmed finding(s) the operator ruled "block" came back on the new head `
  + (ig.returns ? `(${ig.misses} miss(es) after the ruling, and ${ig.returns} fixer turn(s) ended without a new head)` : `(${ig.misses} misses after the ruling)`)
  + ' — fixer and reviewer disagree; a person (or an arbiter) must decide.' + (trail ? ` Ladder so far: ${trail}.` : '') + ' '
  + ig.matches.map((m) => `${where(m.finding)}`).join(', ');
