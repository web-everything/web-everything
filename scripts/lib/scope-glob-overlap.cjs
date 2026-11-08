'use strict';
// ONE pure rule for "may two globs of one multi-path scope entry meet", shared by the backlog loader
// (`src/_data/backlog.js` normalizeScope, CJS) and the dispatcher (`scripts/operations/dispatch-lane.mjs`
// normalizeBriefScope, ESM imports this file). Two copies of the rule drifted once (PR #6244): the loader left
// every 2+ glob entry unsplit while dispatch accepted disjoint ones, so the planner saw one whitespace-joined
// string and lease/rival exclusion was bypassed. Keep the rule HERE only.
//
// An entry such as `we:a.mjs __tests__/a*.test.mjs` is the normal card shape (#4701). Only globs inside ONE
// authored entry that COULD overlap are a problem: the lease matcher cannot judge glob-vs-glob overlap, and
// splitting them would hide that behind a clean-looking list. Cross-entry glob-vs-glob overlap is pre-existing
// (R412), carded, and not judged here.

const PREFIX_RE = /^[A-Za-z][\w-]*:/;

/**
 * @param {string[]} pieces      the entry split on whitespace/commas, in authored order
 * @param {(prefix: string) => (string|null)} repoOf  canonical repo key for a bare prefix (no colon) — called with
 *                               '' when no prefix has been seen yet, so the caller supplies its default repo, or
 *                               null when that repo is not known yet (then the piece may meet any repo)
 * @returns {boolean} true when at least two glob pieces sit in the same repo and one fixed leading path starts
 *                    the other (they may match the same file)
 */
function entryGlobsMayMeet(pieces, repoOf) {
  let inherited = '';
  const globs = [];
  for (const piece of pieces) {
    const own = PREFIX_RE.exec(piece)?.[0] ?? '';
    if (own) inherited = own;
    if (!/[*?]/.test(piece)) continue;
    const path = own ? piece.slice(own.length) : piece;
    globs.push({ repo: repoOf(inherited ? inherited.slice(0, -1) : ''), fixed: path.slice(0, path.search(/[*?]/)) });
  }
  // Provably disjoint only when the repos differ or the fixed leading text diverges.
  // A null repo (the caller does not yet know which repo a bare piece belongs to) may meet any repo: judging it
  // "different" would split the entry early and lose the boundary the later pass needs to refuse it.
  const mayMeet = (a, b) => (a.repo == null || b.repo == null || a.repo === b.repo)
    && (a.fixed.startsWith(b.fixed) || b.fixed.startsWith(a.fixed));
  for (let i = 0; i < globs.length; i += 1) {
    for (let j = i + 1; j < globs.length; j += 1) if (mayMeet(globs[i], globs[j])) return true;
  }
  return false;
}

module.exports = { entryGlobsMayMeet };
