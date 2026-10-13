/**
 * The drain writes three facts: no-review head exemptions, carried-acceptance restamps,
 * and releases of its open holds. Additive and fail-soft: recording never throws or
 * changes a drain decision. Ledger clearance stays fail-closed on missing or unreadable evidence.
 */
import { readFileSync } from 'node:fs';
import { appendVerdict, buildLedgerEvent, buildVerdictRecord, EVENT_TYPES, foldVerdictLedger,
  parseLedgerEvents, validateLedgerEvent, verdictLedgerPath } from './verdict-ledger.mjs';

export const DRAIN_FACTS_SOURCE = 'merge-ai-prs';
export const EXEMPT_BASIS = 'no escalation signal and no review label';
const slug = value => String(value ?? '').trim().toLowerCase();
const fullSha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
const isVerdict = row => row.type === undefined || row.type === EVENT_TYPES.VERDICT;

export function drainReviewGateFact(gate) {
  return {
    reviewExempt: gate?.action === 'merge' && gate?.reason === 'no escalation signal — merge immediately',
    acceptedMerge: gate?.action === 'merge' && /^review:accepted\b/.test(gate?.reason ?? ''),
  };
}

// Separate planning from construction so the recorder can isolate each build/append failure.
function planRows({ verdicts, repo, events, now }, emit) {
  if (!Array.isArray(events)) throw new Error('ledger events are unreadable');
  const normalized = events.map(row => {
    const checked = validateLedgerEvent(row);
    if (!checked.valid) throw new Error(`ledger event is unreadable: ${checked.errors.join('; ')}`);
    return checked.record;
  });
  for (const v of verdicts) {
    const pr = Number(v?.num);
    if (slug(v.repo || repo) !== slug(repo) || !Number.isInteger(pr) || pr <= 0) continue;
    const rawHead = v.listedHeadSha || v.headSha;
    if (!fullSha(rawHead)) continue;
    const head = rawHead.toLowerCase();
    const mine = normalized.filter(e => e.pr === pr && slug(e.repo) === slug(repo));
    const folded = foldVerdictLedger(mine.filter(isVerdict)).get(pr);
    const common = { repo, pr, at: now, source: DRAIN_FACTS_SOURCE, declaredActor: 'drain' };
    const lastExempt = mine.filter(e => e.type === EVENT_TYPES.REVIEW_EXEMPT).at(-1);
    if (v.reviewGate?.reviewExempt === true && !folded?.current
      && lastExempt?.headSha !== head) {
      emit('exempt', buildLedgerEvent, { ...common, type: EVENT_TYPES.REVIEW_EXEMPT, headSha: head, basis: EXEMPT_BASIS });
    }
    const old = folded?.current?.coverage?.headSha;
    const coversHead = typeof old === 'string' && old.length >= 7 && head.startsWith(old.toLowerCase());
    if (v.reviewGate?.acceptedMerge === true && folded?.current && folded.clears === true && !coversHead) {
      emit('restamped', buildVerdictRecord, { ...common, verdict: 'restamped', headSha: head,
        reason: `drain carried the acceptance from ${old ? old.slice(0, 8) : 'no head'} to ${head.slice(0, 8)}: its review gate verified the accepted content still covers this head (no new review)` });
    }
    if (v.decision !== 'merge') continue;
    const last = new Map();
    for (const e of mine) if (e.holdSource === 'drain' && [EVENT_TYPES.HOLD, EVENT_TYPES.RELEASE].includes(e.type)) last.set(e.reasonCode, e);
    for (const [reasonCode, e] of last) if (e.type === EVENT_TYPES.HOLD) {
      emit('released', buildLedgerEvent, { ...common, type: EVENT_TYPES.RELEASE, reasonCode, holdSource: 'drain' });
    }
  }
}

export function planDrainLedgerFacts(options) {
  const rows = [];
  planRows(options, (_kind, build, fields) => rows.push(build(fields)));
  return rows;
}

const readHome = repo => {
  try { return parseLedgerEvents(readFileSync(verdictLedgerPath(repo), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
};

export function recordDrainLedgerFacts(options = {}) {
  const result = { ok: true, appended: { exempt: 0, restamped: 0, released: 0 }, errors: [] };
  const failed = error => {
    result.ok = false;
    result.errors.push(String(error?.message ?? error).split('\n')[0]);
  };
  try {
    const { verdicts = [], localSlug = null, read = readHome, append = appendVerdict, now = () => new Date().toISOString() } = options;
    const groups = new Map();
    for (const v of verdicts) {
      const repo = String(v?.repo || localSlug || '').trim();
      if (!repo) continue;
      if (!groups.has(slug(repo))) groups.set(slug(repo), { repo, group: [] });
      groups.get(slug(repo)).group.push(v);
    }
    for (const { repo, group } of groups.values()) {
      try {
        let events;
        try { events = read(repo); }
        catch (error) { if (error?.code === 'ENOENT') events = []; else throw error; }
        planRows({ verdicts: group, repo, events, now: now() }, (kind, build, fields) => {
          try {
            const written = append(build(fields));
            if (written?.ok !== true) throw new Error(written?.errors?.join('; ') || 'ledger append failed');
            result.appended[kind]++;
          } catch (error) { failed(error); }
        });
      } catch (error) { failed(error); }
    }
  } catch (error) { failed(error); }
  return result;
}
