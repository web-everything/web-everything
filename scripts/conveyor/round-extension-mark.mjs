/**
 * Audited operator grants. Pure. A grant is authenticated by GitHub's own record of who posted it: the comment's
 * `author.login` must be an operator, exactly like `operatorFixBudget`. The automation account is NOT enough — any
 * automation-credentialed process could otherwise post a body naming an operator and lift the cap itself.
 */
import { isOperatorAuthored, OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';

export const ROUND_EXTENSION_MARKER = '➕ conveyor — review round extension granted';

/** The most extra rounds all grants together may add to one PR; repeated grants clamp here, never grow past it. */
export const MAX_TOTAL_ROUND_EXTENSIONS = 10;

export function buildRoundExtensionComment({ repo, pr, by, actor, channel, reason, at }) {
  const record = { version: 1, repo, pr, by, actor, channel, reason, at };
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
    `Operator @${oneLine(actor)} granted +${oneLine(by)} auto-repair round(s) via ${oneLine(channel)}`, '',
    ...prose(reason).split(/\r\n|[\r\n\u2028\u2029]/).map((line) => `> ${line}`), '',
    `<!-- round-extension: ${json} -->`,
  ].join('\n');
}

/** Repo keys and their canonical slugs name the same grant; unknown repos match exactly. */
export function roundExtensionGrants(comments, { repo, pr }) {
  const slug = (value) => CONSTELLATION_REPOS[value]?.slug ?? value;
  let remaining = MAX_TOTAL_ROUND_EXTENSIONS;
  return (Array.isArray(comments) ? comments : []).flatMap((comment, index) => {
    if (!isOperatorAuthored(comment) || typeof comment?.body !== 'string'
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
      const by = Math.min(r.by, remaining);
      remaining -= by;
      return by > 0 ? [{ index, by, at: r.at }] : [];
    } catch { return []; }
  });
}

/** Total grants retain the same authentication and ten-round ceiling as the indexed reader. */
export function countGrantedRoundExtensions(comments, scope) {
  return roundExtensionGrants(comments, scope).reduce((sum, grant) => sum + grant.by, 0);
}
