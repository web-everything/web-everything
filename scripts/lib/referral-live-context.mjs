/** The ONE definition of "live referral gate state" shared by the acceptance gate
 * (`we:scripts/review-set-label.mjs#assertMandatoryReferralsCleared`) and the review hold
 * (`we:scripts/conveyor/review-referral-hold.mjs#decideReferralHold`), so a hold can never release a PR the gate
 * would immediately re-park (the release/re-park loop the hold exists to prevent).
 *
 * Kept free of `review-seat-policy` / `review-set-label` imports on purpose: those import the hold, so importing
 * them here would close a cycle. The gate supplies its own `seatDisabled`; the hold omits it, which only ever
 * keeps a finding pending (a disabled seat can only retire an unruled finding), i.e. errs toward holding.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mandatoryReferralState } from './jury-core.mjs';

/** A deferral is discharged only by an existing readable backlog card, never an intention to file. */
export function referralCardReadable(ref, root = process.cwd()) {
  if (!/^we:backlog\/[^/]+\.md$/.test(ref ?? '')) return false;
  const card = text => /^---\r?\n[\s\S]+?\r?\n---\r?\n/.test(text);
  try { return card(readFileSync(`${root}/${ref.slice(3)}`, 'utf8')); }
  catch {
    // #4979 — a provisional card (`x…`) is renumbered when it lands (#2288 JIT numbering); a ruling that cited
    // it by its birth name still names that card through the landed file's `bornAs:`.
    const born = /^we:backlog\/(x[a-z0-9]{6})-/.exec(ref)?.[1];
    if (!born) return false;
    try {
      return readdirSync(`${root}/backlog`).some(name => name.endsWith('.md') && /^\d+-/.test(name) && (() => {
        const text = readFileSync(`${root}/backlog/${name}`, 'utf8');
        return card(text) && new RegExp(`^bornAs:[ \\t]*["']?${born}["']?[ \\t]*$`, 'm').test(text.split(/\r?\n---\r?\n/)[0]);
      })());
    } catch { return false; }
  }
}

/** The `mandatoryReferralState` context for a PR's live state (`headRefOid`, `body`, `createdAt`). */
export function referralLiveContext(state, { repo, pr, cardReadable = referralCardReadable, seatDisabled } = {}) {
  return { repo, pr, head: state.headRefOid, body: typeof state.body === 'string' ? state.body : '',
    createdAt: state.createdAt, cardReadable, ...(seatDisabled ? { seatDisabled } : {}) };
}

/** The live referral state of a PR, read the way the gate reads it. */
export function liveReferralState(state, options) {
  return mandatoryReferralState(state.comments, referralLiveContext(state, options));
}
