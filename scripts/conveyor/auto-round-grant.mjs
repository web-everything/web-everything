/**
 * @file scripts/conveyor/auto-round-grant.mjs
 * @description The operator's standing ruling, automated (operator 2026-10-19; confirmed 2026-10-20 "Ok" to
 *   "automate, capped at 3 per PR"): when a card-only PR hits its review round cap, the system grants +1 round
 *   itself instead of waiting for a person to run `extend-rounds` by hand. PURE — the IO shell is
 *   `auto-round-grant-io.mjs`, which posts the same `buildRoundExtensionComment` record `extend-rounds` writes (on the
 *   App identity, not through that operation: its operator-credential check does not apply to an automatic grant).
 *
 *   Eligibility (ALL must hold; otherwise nothing happens and the needs-you event stays for a person):
 *     - the note is `round-cap-exhausted` (never `ci-heal-exhausted`, never a not-converging takeover);
 *     - the repo is in `review.autoRoundGrant.cardOnly.repos`;
 *     - every file in the PR's NET diff vs current main is under `backlog/` (cards and `backlog/raised-by/`
 *       sidecars) — the net two-tree diff, never gh's inflated three-dot list;
 *     - the operator has recorded the standing ruling (`standing-ruling-mark.mjs`: an open, operator-authored
 *       issue whose bounds cover this repo);
 *     - the automatic grants already on the PR (and every reservation in the durable ledger) are below the
 *       smaller of the ruling's `maxPerPr` and `review.autoRoundGrant.cardOnly.maxPerPr`.
 *   The grant is posted by the automation and trusted ONLY through that ruling (`round-extension-mark.mjs`).
 *   At the cap, no grant: the event is kept with an "auto-grant cap reached (n/max)" reason.
 *
 *   SETTINGS (shared policy cascade, sources logged): standard `enabled: false`, `maxPerPr: 3`,
 *   `repos: ['web-everything/web-everything']`; the tool layer (`scripts/settings/review.json` →
 *   `autoRoundGrant.cardOnly`) turns it on for this repo.
 */
import { roundExtensionGrants } from './round-extension-mark.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

/** The standing-ruling owner. Every automatic grant is recorded as theirs, like the manual ones. */
export const AUTO_GRANT_ACTOR = 'chalbert';
/** Marks a grant as automatic, so it is counted toward the per-PR cap and never mistaken for a manual one. */
export const AUTO_GRANT_CHANNEL = 'standing-ruling-auto';
/** The ruling, quoted verbatim-in-substance in every grant's reason. */
export const STANDING_RULING = 'operator 2026-10-19 standing ruling (confirmed 2026-10-20 "Ok" to "automate, capped at 3 per PR"): card PR rounds consumed by mechanical list re-merges';

/** The ruling's own ceiling: configuration may lower the per-PR cap, never raise it past this. */
export const AUTO_GRANT_ABSOLUTE_MAX = 3;

export const AUTO_ROUND_GRANT_STANDARD = Object.freeze({
  enabled: false, maxPerPr: 3, repos: Object.freeze([CONSTELLATION_REPOS.we.slug]),
});

const slugOf = (repo) => CONSTELLATION_REPOS[repo]?.slug ?? repo;

/**
 * PURE: validate one layer's `cardOnly` block leaf by leaf. An invalid leaf is dropped (never coerced), so a
 * lower layer's value stands.
 * @returns {{enabled?:boolean, maxPerPr?:number, repos?:string[]}}
 */
export function validCardOnlyLayer(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return {};
  const out = {};
  if (typeof block.enabled === 'boolean') out.enabled = block.enabled;
  if (Number.isInteger(block.maxPerPr) && block.maxPerPr >= 0 && block.maxPerPr <= AUTO_GRANT_ABSOLUTE_MAX) out.maxPerPr = block.maxPerPr;
  if (Array.isArray(block.repos) && block.repos.every((r) => typeof r === 'string' && /^[^/\s]+\/[^/\s]+$/.test(r))) {
    out.repos = [...block.repos];
  }
  return out;
}

/**
 * PURE: standard → platform → tool, per leaf, with each leaf's source.
 * @returns {{enabled:boolean, maxPerPr:number, repos:string[], sources:Record<string,string>}}
 */
export function resolveAutoRoundGrantSettings({ platform, tool } = {}) {
  const value = { ...AUTO_ROUND_GRANT_STANDARD, repos: [...AUTO_ROUND_GRANT_STANDARD.repos] };
  const sources = { enabled: 'standard', maxPerPr: 'standard', repos: 'standard' };
  for (const [name, layer] of [['platform', platform], ['tool', tool]]) {
    for (const [leaf, v] of Object.entries(validCardOnlyLayer(layer?.autoRoundGrant?.cardOnly))) {
      value[leaf] = v; sources[leaf] = name;
    }
  }
  return { ...value, sources };
}

/** PURE: one source line for the daemon log. */
export function formatAutoRoundGrantSettings(s) {
  return `policy · review.autoRoundGrant.cardOnly enabled=${s.enabled} (${s.sources.enabled}) maxPerPr=${s.maxPerPr} (${s.sources.maxPerPr}) repos=${JSON.stringify(s.repos)} (${s.sources.repos})`;
}

/** PURE: a card or `backlog/raised-by/` sidecar — a plain relative path under `backlog/`, no traversal. */
export function isCardPath(path) {
  const p = String(path ?? '');
  return p.startsWith('backlog/') && p.length > 'backlog/'.length
    && !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '');
}

/** PURE: true only for a non-empty net file list that is entirely card paths. */
export function isCardOnlyNetDiff(files) {
  return Array.isArray(files) && files.length > 0 && files.every(isCardPath);
}

/**
 * PURE: the automatic grants already on the PR that the shared reader trusts under the verified ruling scope
 * (automation-posted, citing the ruling, inside its bounds). Without a scope there are none.
 */
export function countAutoRoundGrants(comments, { repo, pr, standingRuling }) {
  if (!standingRuling) return 0;
  return roundExtensionGrants(comments, { repo, pr, standingRuling })
    .filter((g) => g.standingRuling === standingRuling.id).reduce((sum, g) => sum + g.by, 0);
}

/** PURE: the idempotency key of ONE limit hit — the PR, its head, and the exact cap episode. */
export function autoGrantKey({ repo, note, head }) {
  return `${slugOf(repo)}#${note.prNumber}@${head}:${note.capKind ?? 'unknown'}:${note.attempts}/${note.cap}`;
}

/** PURE: the operator's words for this grant — the ruling, its dates, and the automatic-grant count. */
export function autoGrantReason({ note, head, count, max, rulingId }) {
  return `${STANDING_RULING}${rulingId ? ` (recorded as ${rulingId})` : ''}. Automatic grant ${count}/${max} for PR #${note.prNumber} `
    + `(${note.capKind ?? 'unknown'} cap ${note.attempts}/${note.cap}, head ${String(head).slice(0, 12)}).`;
}

/** PURE: the needs-you reason once the automatic grants are used up. */
export function capReachedReason({ used, max, text }) {
  return `auto-grant cap reached (${used}/${max}): ${text ?? ''}`.trim();
}

/**
 * PURE pre-read screen: is this note one the ruling could cover at all? Runs before any GitHub or git read.
 * @returns {{ok:true, slug:string} | {ok:false, why:string}}
 */
export function screenAutoGrantNote({ note, repo, pr, settings }) {
  if (!settings?.enabled) return { ok: false, why: 'disabled' };
  if (note?.kind !== 'round-cap-exhausted') return { ok: false, why: 'not a round-cap note' };
  if (note.takeoverNotConverging) return { ok: false, why: 'takeover not converging' };
  if (!Number.isSafeInteger(note.prNumber) || note.prNumber <= 0) return { ok: false, why: 'no PR number' };
  const slug = slugOf(repo);
  if (!settings.repos.includes(slug)) return { ok: false, why: `repo ${slug} not in autoRoundGrant.cardOnly.repos` };
  if (!/^[0-9a-f]{40}$/.test(String(pr?.headRefOid ?? ''))) return { ok: false, why: 'no usable head commit id' };
  if (settings.maxPerPr < 1) return { ok: false, why: 'maxPerPr is 0' };
  return { ok: true, slug };
}

/**
 * PURE verdict after the reads.
 * @param {{netRead:{ok:boolean, files?:string[], reason?:string}, used:number, max:number, state:string}} o
 * @returns {{action:'skip', why:string} | {action:'cap-reached', used:number, max:number} | {action:'grant', count:number, max:number}}
 */
export function decideAutoGrant({ netRead, used, max, state }) {
  if (String(state ?? '').toUpperCase() !== 'OPEN') return { action: 'skip', why: 'PR is not open' };
  if (!netRead?.ok) return { action: 'skip', why: `net diff unreadable: ${netRead?.reason ?? 'unknown'}` };
  if (!isCardOnlyNetDiff(netRead.files)) {
    const other = (netRead.files ?? []).filter((f) => !isCardPath(f));
    return { action: 'skip', why: other.length ? `not card-only: ${other.slice(0, 3).join(', ')}${other.length > 3 ? ` (+${other.length - 3})` : ''}` : 'empty net diff' };
  }
  if (used >= max) return { action: 'cap-reached', used, max };
  return { action: 'grant', count: used + 1, max };
}
