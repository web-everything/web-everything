/**
 * @file scripts/conveyor/standing-ruling-mark.mjs
 * @description The operator's STANDING RULING record (operator option B, 2026-10-20). PURE.
 *
 *   The operator records a ruling ONCE as a GitHub issue THEY author, in a listed repo. The issue body carries one
 *   machine record (`<!-- standing-ruling: {...} -->`) stating its bounds. Trust comes only from GitHub's own
 *   record of the issue: its author must be an operator, and if it was ever edited the last editor must be an
 *   operator too. The issue must be OPEN — closing it revokes the ruling, and every automation-posted grant citing
 *   it stops counting at the next read. Bounds come from the operator's record, never from a settings file.
 *
 *   Ruling id: `<owner>/<repo>#<issue number>`.
 */
import { isTrustedMarkerAuthor, OPERATOR_LOGINS } from '../lib/marker-authorship.mjs';

export const STANDING_RULING_MARKER = '🧭 standing ruling — automatic review round grant';
export const STANDING_RULING_KIND = 'auto-round-grant';
/** Option B's hard ceiling: a ruling record may lower it, never raise it. */
export const STANDING_RULING_MAX_PER_PR = 3;
const RECORD_RE = /^<!-- standing-ruling: (.+) -->$/gm;
const SLUG_RE = /^[^/\s]+\/[^/\s]+$/;
const isOperator = (login) => typeof login === 'string' && OPERATOR_LOGINS.includes(login.toLowerCase());

/** PURE: the issue body the operator posts. Prose first, then the one machine record. */
export function buildStandingRulingBody({ by = 1, maxPerPr = 3, repos, ruledAt, confirmedAt, words }) {
  const record = { version: 1, kind: STANDING_RULING_KIND, scope: 'card-only', by, maxPerPr, repos, ruledAt, confirmedAt };
  const json = JSON.stringify(record).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return [
    STANDING_RULING_MARKER, '',
    String(words).replace(/</g, '&lt;').replace(/>/g, '&gt;'), '',
    `Bounds: card-only PRs (net diff vs current main entirely under backlog/), +${by} review round per round-limit hit, at most ${maxPerPr} automatic grants per PR, repos ${repos.join(', ')}. Close this issue to revoke.`, '',
    `<!-- standing-ruling: ${json} -->`,
  ].join('\n');
}

/**
 * PURE: verify one issue (GraphQL shape: `{number, state, body, author{login}, lastEditedAt, editor{login}}`) as a
 * standing ruling of `repo`. Returns the ruling, or `{ ok:false, why }`.
 */
export function verifyStandingRuling(issue, { repo }) {
  if (!issue || typeof issue !== 'object') return { ok: false, why: 'no issue' };
  if (!SLUG_RE.test(String(repo ?? ''))) return { ok: false, why: 'bad repo' };
  if (!Number.isSafeInteger(issue.number) || issue.number <= 0) return { ok: false, why: 'no issue number' };
  if (String(issue.state ?? '').toUpperCase() !== 'OPEN') return { ok: false, why: 'ruling issue is not open (revoked)' };
  if (!isOperator(issue.author?.login)) return { ok: false, why: 'ruling issue is not operator-authored' };
  if (issue.lastEditedAt && !isOperator(issue.editor?.login)) return { ok: false, why: 'ruling issue was last edited by a non-operator' };
  const body = String(issue.body ?? '');
  if (!body.startsWith(STANDING_RULING_MARKER + '\n')) return { ok: false, why: 'no standing-ruling marker' };
  const matches = [...body.matchAll(RECORD_RE)];
  if (matches.length !== 1) return { ok: false, why: 'expected exactly one standing-ruling record' };
  let r;
  try { r = JSON.parse(matches[0][1]); } catch { return { ok: false, why: 'unparseable standing-ruling record' }; }
  if (r?.version !== 1 || r.kind !== STANDING_RULING_KIND || r.scope !== 'card-only') return { ok: false, why: 'not an auto-round-grant card-only ruling' };
  if (r.by !== 1) return { ok: false, why: 'ruling by must be 1' };
  if (!Number.isInteger(r.maxPerPr) || r.maxPerPr < 1 || r.maxPerPr > STANDING_RULING_MAX_PER_PR) return { ok: false, why: 'ruling maxPerPr out of range (1..3)' };
  if (![r.ruledAt, r.confirmedAt].every((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))) return { ok: false, why: 'ruling dates missing' };
  if (!Array.isArray(r.repos) || !r.repos.length || !r.repos.every((x) => typeof x === 'string' && SLUG_RE.test(x))) return { ok: false, why: 'ruling repos invalid' };
  if (!r.repos.includes(repo)) return { ok: false, why: `ruling does not cover ${repo}` };
  return {
    ok: true, id: `${repo}#${issue.number}`, author: issue.author.login.toLowerCase(), by: r.by, maxPerPr: r.maxPerPr,
    repos: [...r.repos], ruledAt: r.ruledAt, confirmedAt: r.confirmedAt,
  };
}

/** PURE: the newest valid ruling among `issues` (highest issue number), or null. */
export function pickStandingRuling(issues, { repo }) {
  const valid = (Array.isArray(issues) ? issues : []).map((i) => verifyStandingRuling(i, { repo })).filter((r) => r.ok);
  valid.sort((a, b) => Number(b.id.split('#')[1]) - Number(a.id.split('#')[1]));
  return valid[0] ?? null;
}

/** PURE: the heads cited by automation-shaped standing-ruling grant records on this thread (cheap pre-screen). */
export function citedGrantHeads(comments) {
  const heads = new Set();
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isTrustedMarkerAuthor(c)) continue;
    const body = typeof c?.body === 'string' ? c.body : '';
    if (!body.includes('"standingRuling"')) continue;
    for (const m of body.matchAll(/^<!-- round-extension: (.+) -->$/gm)) {
      try { const r = JSON.parse(m[1]); if (typeof r?.head === 'string' && /^[0-9a-f]{40}$/.test(r.head)) heads.add(r.head); } catch { /* not a record */ }
    }
  }
  return [...heads];
}
