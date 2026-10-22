/**
 * Audited operator grants. Pure. A grant is authenticated by GitHub's own record of who posted it: the comment's
 * `author.login` must be an operator, exactly like `operatorFixBudget`. The automation account is NOT enough — any
 * automation-credentialed process could otherwise post a body naming an operator and lift the cap itself.
 *
 * ONE NARROW EXCEPTION — a STANDING RULING (operator 2026-10-19, confirmed 2026-10-20; option B 2026-10-20). The
 * operator records a ruling ONCE as an operator-authored GitHub issue (`standing-ruling-mark.mjs`). An
 * automation-posted grant counts only when the caller passes `standingRuling` — that ruling as VERIFIED at read
 * time by the IO shell (operator author, never edited by anyone else) plus the card-only verdict of each cited head
 * against current main — and the grant cites that ruling's id and stays inside ALL its bounds: +`by` exactly, a
 * listed repo, a head proven card-only, and at most `maxPerPr` such grants per PR (later ones never count). With no
 * `standingRuling` (every caller that does not verify one), an automation-posted grant is never trusted.
 */
import { isAutomationAuthored, isOperatorAuthored, isTrustedMarkerAuthor, OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

export const ROUND_EXTENSION_MARKER = '➕ conveyor — review round extension granted';

/** The most extra rounds all grants together may add to one PR; repeated grants clamp here, never grow past it. */
export const MAX_TOTAL_ROUND_EXTENSIONS = 10;

export function buildRoundExtensionComment({ repo, pr, by, actor, channel, reason, at, standingRuling, head, episode }) {
  const record = { version: 1, repo, pr, by, actor, channel, reason, at, ...(standingRuling ? { standingRuling, head, episode } : {}) };
  // Escape markup in the machine record without changing the parsed operator words. U+2028/U+2029 are escaped too:
  // the counter's `.`/`^`/`$` treat them as line breaks, so a raw one would stop this grant from counting.
  const json = JSON.stringify(record).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  // Quoted prose is still scanned for trusted review markers. Escape every angle bracket (not strip delimiters) so
  // no HTML comment of any form (`-->`, `--!>`, nested, partial) can appear; the same rule as operator-action comments.
  // A one-line field also folds every line break (`^` under /m matches after CR and U+2028/U+2029 too), so no
  // caller's validation is needed to keep plain-prose readers such as parseAdvisories from seeing a new line.
  const prose = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const oneLine = (value) => prose(value).replace(/\r\n|[\r\n\u2028\u2029]/g, ' ');
  return [
    ROUND_EXTENSION_MARKER, '',
    standingRuling
      ? `Standing ruling ${oneLine(standingRuling)} (operator @${oneLine(actor)}) granted +${oneLine(by)} auto-repair round(s) via ${oneLine(channel)}`
      : `Operator @${oneLine(actor)} granted +${oneLine(by)} auto-repair round(s) via ${oneLine(channel)}`, '',
    ...prose(reason).split(/\r\n|[\r\n\u2028\u2029]/).map((line) => `> ${line}`), '',
    `<!-- round-extension: ${json} -->`,
  ].join('\n');
}

/**
 * The comment fields the grant trust checks read, from either production shape (PR #5758 operator send-back): GraphQL
 * and `gh pr view` / the label provider (`id` = node id, `createdAt`), or raw REST as the drain reads it (`id`
 * numeric, `node_id`, `created_at`). The node id is what GitHub's edit-history read returns, so a numeric id alone
 * never matches it. Only the field NAMES are reconciled; every check on the values is unchanged. PURE.
 */
export function commentNodeId(c) { return typeof c?.node_id === 'string' ? c.node_id : c?.id; }
export function commentCreatedAt(c) { return c?.createdAt ?? c?.created_at; }

/**
 * PURE: does an automation-posted record sit inside the verified standing ruling's bounds?
 * @param {object} r - the parsed grant record
 * @param {{id:string, author:string, by:number, maxPerPr:number, repos:string[], cardOnlyHeads:Record<string,boolean>,
 *   uneditedComments:string[]}} ruling - `cardOnlyHeads`: each cited head, judged card-only vs current main AND proven
 *   to be a commit of this PR; `uneditedComments`: comment ids GitHub shows as never edited.
 */
function withinStandingRuling(r, { repo, slug }, ruling, autoSoFar, commentId) {
  if (!ruling || typeof ruling.id !== 'string' || r.standingRuling !== ruling.id) return false;
  if (autoSoFar >= ruling.maxPerPr) return false;
  if (r.by !== ruling.by || !ruling.repos.map(slug).includes(slug(repo)) || !ruling.repos.map(slug).includes(slug(r.repo))) return false;
  if (String(r.actor).toLowerCase() !== String(ruling.author).toLowerCase()) return false;
  // Bound to the comment GitHub shows as never edited since it was posted (the IO shell's own read).
  if (!Array.isArray(ruling.uneditedComments) || !ruling.uneditedComments.includes(commentId)) return false;
  // The limit hit it answers (`<repo>#<pr>@<head>:<capKind>:<attempts>/<cap>`) must name this PR and this head.
  if (typeof r.episode !== 'string' || !r.episode.startsWith(`${slug(repo)}#${Number(r.pr)}@${r.head}:`)) return false;
  return typeof r.head === 'string' && /^[0-9a-f]{40}$/.test(r.head) && ruling.cardOnlyHeads?.[r.head] === true;
}

/**
 * Repo keys and their canonical slugs name the same grant; unknown repos match exactly.
 * @param {{repo:string, pr:number|string, standingRuling?:object|null}} scope - `standingRuling`: see the header.
 */
export function roundExtensionGrants(comments, { repo, pr, standingRuling = null }) {
  const slug = (value) => CONSTELLATION_REPOS[value]?.slug ?? value;
  let remaining = MAX_TOTAL_ROUND_EXTENSIONS;
  let autoSoFar = 0;
  const autoEpisodes = new Set();
  return (Array.isArray(comments) ? comments : []).flatMap((comment, index) => {
    const operator = isOperatorAuthored(comment);
    const automation = !operator && standingRuling && isAutomationAuthored(comment);
    if ((!operator && !automation) || typeof comment?.body !== 'string'
      || !comment.body.startsWith(ROUND_EXTENSION_MARKER + '\n')) return [];
    const matches = [...comment.body.matchAll(/^<!-- round-extension: (.+) -->$/gm)];
    if (matches.length !== 1) return [];
    try {
      const r = JSON.parse(matches[0][1]);
      if (r?.version !== 1 || slug(r.repo) !== slug(repo) || r.pr !== Number(pr)
        || !Number.isInteger(r.by) || r.by < 1 || r.by > 5
        || typeof r.actor !== 'string' || !OPERATOR_LOGINS.includes(r.actor.toLowerCase())
        || typeof r.reason !== 'string' || !r.reason.trim()
        || typeof r.channel !== 'string' || !r.channel.trim() || /[\r\n\u{2028}\u{2029}]/u.test(r.channel)
        || typeof r.at !== 'string' || !r.at.trim()) return [];
      const createdAt = commentCreatedAt(comment);
      if (automation) {
        if (!withinStandingRuling(r, { repo, slug }, standingRuling, autoSoFar, commentNodeId(comment))) return [];
        // The anchor time of an automatic grant is GitHub's own record of when the comment was posted, never the
        // body's `at` (which the automation writes): a missing or invalid creation time is not trusted.
        if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return [];
        if (autoEpisodes.has(r.episode)) return [];
        autoEpisodes.add(r.episode);
        autoSoFar += 1;
      }
      const by = Math.min(r.by, remaining);
      remaining -= by;
      return by > 0 ? [{ index, by, at: automation ? createdAt : r.at, ...(automation ? { standingRuling: r.standingRuling, head: r.head } : {}) }] : [];
    } catch { return []; }
  });
}

/** Total grants retain the same authentication and ten-round ceiling as the indexed reader. */
export function countGrantedRoundExtensions(comments, scope) {
  return roundExtensionGrants(comments, scope).reduce((sum, grant) => sum + grant.by, 0);
}

/**
 * CONSERVATIVE, unverified: the rounds every automation-posted standing-ruling grant record on this PR WOULD add if
 * trusted. For ceilings only (e.g. `extend-rounds`'s ten-round admission) — never to raise a cap.
 */
export function countStandingRulingGrantRecords(comments, { repo, pr }) {
  const slug = (value) => CONSTELLATION_REPOS[value]?.slug ?? value;
  let total = 0;
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!isTrustedMarkerAuthor(comment)) continue;
    // Only the automation's own comments can ever become standing-ruling grants; anyone else's never consumes room.
    if (isOperatorAuthored(comment) || !isAutomationAuthored(comment)
      || typeof comment?.body !== 'string' || !comment.body.startsWith(ROUND_EXTENSION_MARKER + '\n')) continue;
    for (const m of comment.body.matchAll(/^<!-- round-extension: (.+) -->$/gm)) {
      try {
        const r = JSON.parse(m[1]);
        if (r?.standingRuling && slug(r.repo) === slug(repo) && r.pr === Number(pr)) total += Math.min(Math.max(Number(r.by) || 1, 1), 5);
      } catch { /* not a record */ }
    }
  }
  return total;
}

/**
 * The limit-hit keys (`episode`) of every automation-posted standing-ruling grant record on this PR, unverified.
 * `unrecoverable` counts records with no usable key — a caller seeding a ledger from them must fail closed.
 */
export function standingRulingGrantEpisodes(comments, { repo, pr }) {
  const slug = (value) => CONSTELLATION_REPOS[value]?.slug ?? value;
  const episodes = [];
  let unrecoverable = 0;
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (!isTrustedMarkerAuthor(comment)) continue;
    if (isOperatorAuthored(comment) || !isAutomationAuthored(comment)
      || typeof comment?.body !== 'string' || !comment.body.startsWith(ROUND_EXTENSION_MARKER + '\n')) continue;
    for (const m of comment.body.matchAll(/^<!-- round-extension: (.+) -->$/gm)) {
      let r;
      try { r = JSON.parse(m[1]); } catch { continue; }
      if (!r?.standingRuling || slug(r.repo) !== slug(repo) || r.pr !== Number(pr)) continue;
      if (typeof r.episode === 'string' && r.episode.startsWith(`${slug(repo)}#${Number(pr)}@`)) episodes.push(r.episode);
      else unrecoverable += 1;
    }
  }
  return { episodes, unrecoverable };
}
