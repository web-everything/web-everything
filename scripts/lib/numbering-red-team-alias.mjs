/**
 * @file scripts/lib/numbering-red-team-alias.mjs
 * @description Which head the drain's red-team admission reads evidence for when the PR head moved only by the
 *   drain's own card-numbering commit(s).
 *
 *   THE LIVE CASE (WE PR #5742, 2026-10-21): the operator cleared head 11f43c85d; the drain numbered five cards
 *   (33a282cc0) and carried the clearance mechanically (human-clearance-carry). The red-team admission gate is
 *   head-bound, found no red-team evidence for 33a282cc0, and requested a red team for it. The review daemon had
 *   no review run on that head either, so `carriedAcceptTriggersReview` dispatched a FRESH full review, whose
 *   mandatory-referral step re-raised an already-ruled finding on the renamed card and parked the PR to
 *   review:human: three more operator rulings for unchanged content.
 *
 *   Rule: when the head has no red-team evidence of its own, and `proveNumberingOnlyMove` proves the head is a
 *   linear chain of exact drain numbering commits (card renames, bornAs stamps, whole-token id rewrites — nothing
 *   else) over an ancestor that HAS red-team evidence, read evidence and gate records from that ancestor. A
 *   head's own evidence always wins. Any failed or unreadable proof returns null, which is today's behavior.
 *   This never widens what counts as numbering; it reuses the same proof the human-clearance carry uses.
 */
import { proveNumberingOnlyMove, MAX_NUMBERING_COMMITS } from './numbering-carry.mjs';

const HEX40 = /^[0-9a-f]{40}$/;

/**
 * Every first-parent ancestor `head` is proven exact drain numbering over, nearest first. Stops at the first step the
 * proof refuses; any error yields what was proven so far (an empty list = today's exact-head behavior).
 * @param {{exec:Function, cwd?:string, head:string, prove?:Function, max?:number}} o
 * @returns {Array<{head:string, reason:string, pairs:Array<[string,string]>}>}
 */
export function numberingProvenAncestors({ exec, cwd, head, prove = proveNumberingOnlyMove, max = MAX_NUMBERING_COMMITS }) {
  const proven = [];
  try {
    if (typeof exec !== 'function' || !HEX40.test(String(head ?? ''))) return proven;
    const git = (args) => String(exec('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(cwd === undefined ? {} : { cwd }) }) ?? '').trim();
    try { git(['cat-file', '-e', `${head}^{commit}`]); }
    catch { git(['fetch', '--no-tags', '-q', 'origin', head]); }
    const chain = git(['rev-list', '--first-parent', `--max-count=${max + 1}`, head]).split('\n').filter(Boolean);
    if (chain[0] !== head) return proven;
    for (const ancestor of chain.slice(1)) {
      if (!HEX40.test(ancestor)) break;
      const proof = prove({ exec, cwd, fromSha: ancestor, toSha: head });
      if (!proof?.ok) break;
      proven.push({ head: ancestor, reason: proof.reason, pairs: proof.pairs });
    }
  } catch { /* what was proven so far stands; nothing more */ }
  return proven;
}

/**
 * The nearest proven numbering ancestor that has red-team evidence, or null.
 * @param {{exec:Function, cwd?:string, head:string, hasEvidence:(sha:string)=>boolean, prove?:Function, max?:number}} o
 * @returns {{head:string, reason:string, pairs:Array<[string,string]>}|null}
 */
export function numberingRedTeamAlias({ hasEvidence, ...o }) {
  if (typeof hasEvidence !== 'function') return null;
  try { return numberingProvenAncestors(o).find((a) => hasEvidence(a.head)) ?? null; } catch { return null; }
}

/** True when a red-team evidence read shows anything scheduled, running, queued or recorded for its head. */
export const hasRedTeamEvidence = (e) => !!(e && (e.scheduled || e.recorded || e.inFlight || e.queued));
