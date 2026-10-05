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
  // Escape markup in the machine record without changing the parsed operator words.
  const json = JSON.stringify(record).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return [
    ROUND_EXTENSION_MARKER, '',
    `Operator @${actor} granted +${by} auto-repair round(s) via ${channel}`, '',
    ...String(reason).split(/\r?\n/).map((line) => `> ${line}`), '',
    `<!-- round-extension: ${json} -->`,
  ].join('\n');
}

/** Repo keys and their canonical slugs name the same grant; unknown repos match exactly. */
export function countGrantedRoundExtensions(comments, { repo, pr }) {
  const slug = (value) => CONSTELLATION_REPOS[value]?.slug ?? value;
  const total = (Array.isArray(comments) ? comments : []).reduce((sum, comment) => {
    if (!isOperatorAuthored(comment) || typeof comment?.body !== 'string'
      || !comment.body.startsWith(ROUND_EXTENSION_MARKER + '\n')) return sum;
    const matches = [...comment.body.matchAll(/^<!-- round-extension: (.+) -->$/gm)];
    if (matches.length !== 1) return sum;
    try {
      const r = JSON.parse(matches[0][1]);
      if (r?.version !== 1 || slug(r.repo) !== slug(repo) || r.pr !== Number(pr)
        || !Number.isInteger(r.by) || r.by < 1 || r.by > 5
        || typeof r.actor !== 'string' || !OPERATOR_LOGINS.includes(r.actor.toLowerCase())
        || typeof r.reason !== 'string' || !r.reason.trim()
        || typeof r.channel !== 'string' || !r.channel.trim() || /[\r\n]/.test(r.channel)
        || typeof r.at !== 'string' || !r.at.trim()) return sum;
      return sum + r.by;
    } catch { return sum; }
  }, 0);
  return Math.min(total, MAX_TOTAL_ROUND_EXTENSIONS);
}
