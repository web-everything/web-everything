/**
 * constellation-repos.mjs — the #96 constellation repo table, single-sourced (WE #2830 M3).
 *
 * A parked PR can live in any of the constellation repos. Two vocabularies name a repo and they are NOT the same:
 *   • the internal repo KEY — `we` / `frontierui` / `plateau-app` — used everywhere in-process (the ledger subject
 *     `${key}#${pr}`, the discovered-PR `repo` field, the review reporting).
 *   • the gh SLUG — `web-everything/web-everything` / `frontier-ui/frontierui` / `plateauapp/plateau-app` — passed to `gh --repo`.
 * A tool that parses a `--repo=<slug>` flag but hard-codes the key (the #2830 review's M3 defect: `--repo=…frontierui`
 * read FrontierUI but emitted `repo: 'we'`, so the ledger subject pointed at an unrelated WE PR) crosses the two
 * silently. This module is the ONE mapping between them, so no consumer keeps its own key literal.
 *
 * `repoProfile`/`gateFor` (multi-repo slice 1, we:backlog/xjko7gy-multi-repo-slice-1-a-per-repo-profile.md, see
 * we:reports/2026-09-23-conveyor-multi-repo-gap-map.md) collapse the FIVE scattered per-repo vocabularies (key,
 * slug, slugTag, backlog scope prefix, `check-standards` locus marker) this file's own consumers each re-derive
 * today into ONE frozen profile per repo. They live in the SEPARATE `./repo-profile.mjs`, not here, on purpose:
 * several read-only-declared operations (`gate-health-io.mjs`, `operator-queue.mjs`'s `dispatch-eligibility.mjs`
 * chain — both asserted by a STATIC import-graph guard, `scripts/operations/__tests__/{gate-health,http-adapter}
 * .test.mjs`, to reach zero `node:` built-ins) already import THIS file for the plain data table below. `gateFor`
 * needs real fs/os/path IO (`verify-lane-gate.mjs#composeGate`, `homedir()`, a checkout's `package.json`) to do
 * its job — adding that here would hand every one of those read-only consumers a transitive IO capability they
 * are asserted never to have, tripping that guard for a purely additive change. `repo-profile.mjs` imports
 * `CONSTELLATION_REPOS`/`repoKeyForSlug` FROM here (still the one source), and everything that actually needs the
 * profile/gate imports `repo-profile.mjs` directly — this file re-exports neither, since a re-export is itself a
 * `from`-clause the same static scanner follows, which would defeat the split.
 */

/** The constellation repos, keyed by internal repo KEY. `slug` is the gh `--repo` slug; `path` is the checkout
 *  (empty = the WE primary's own cwd); `dirs` are the directory basenames that checkout is known to occupy —
 *  WE answers to two (the laptop's `webeverything` and the clone-from-slug `web-everything`), which is why a
 *  caller must never derive a key from a basename by hand. Frozen — the single source both the convergence
 *  workflow and the scheduled runner read (never a second copy). */
export const CONSTELLATION_REPOS = Object.freeze({
  we: { slug: 'web-everything/web-everything', slugTag: '', path: '', dirs: ['web-everything', 'webeverything'] },
  frontierui: { slug: 'frontier-ui/frontierui', slugTag: 'fui', path: '$HOME/workspace/frontierui', dirs: ['frontierui'] },
  'plateau-app': { slug: 'plateauapp/plateau-app', slugTag: 'pa', path: '$HOME/workspace/plateau-app', dirs: ['plateau-app'] },
});

/**
 * The default repo key when none is named — the WE primary.
 *
 * PROVISIONAL, and the seam to pull when it stops being true. `path: ''` above encodes the same assumption
 * structurally: WE is the hub every other checkout is located relative to. That is an artefact of where the
 * orchestration happens to live today, not a property of the constellation — WE is a PUBLIC peer, and the
 * lane/delivery machinery is Plateau's product. A consumer that wants to survive that move must ask which
 * repo it is IN (`repoKeyForDir`) rather than assume this default.
 */
export const DEFAULT_REPO_KEY = 'we';

/**
 * Map a checkout's directory BASENAME to its internal repo KEY. Returns `null` for an unknown directory —
 * fail-closed, never a silent fall back to `we` (the M3 bug, one level up). PURE.
 * @param {string} dirName
 * @returns {string|null}
 */
export function repoKeyForDir(dirName) {
  const v = String(dirName || '');
  if (!v) return null;
  for (const [key, meta] of Object.entries(CONSTELLATION_REPOS)) {
    if (meta.dirs.includes(v)) return key;
  }
  return null;
}

/**
 * The other constellation repos, given the one you are in. Returns every key when `selfKey` is unknown, so a
 * caller in an unrecognised checkout reports the whole constellation rather than a confidently wrong subset.
 * PURE.
 * @param {string|null} selfKey
 * @returns {string[]}
 */
export function siblingKeys(selfKey) {
  return Object.keys(CONSTELLATION_REPOS).filter((k) => k !== selfKey);
}

/**
 * Map a `gh` slug (or an already-internal key) to its internal repo KEY. Accepts either vocabulary so a caller can
 * pass whatever `--repo` carried. Returns `null` for an unknown value — the caller decides (fail-closed: never
 * silently fall back to `we`, the exact M3 bug). PURE.
 * @param {string} slugOrKey
 * @returns {string|null}
 */
export function repoKeyForSlug(slugOrKey) {
  const v = canonicalizeSlug(String(slugOrKey || ''));
  if (!v) return null;
  for (const [key, meta] of Object.entries(CONSTELLATION_REPOS)) {
    if (key === v || meta.slug === v) return key;
  }
  return null;
}

/** Resolve a key or canonicalized OWNER/REPO slug at the gh boundary (PR #3794 received `--repo we`). */
export function ghRepoSlug(keyOrSlug) {
  if (typeof keyOrSlug === 'string') {
    const key = repoKeyForSlug(keyOrSlug);
    if (key) return CONSTELLATION_REPOS[key].slug;
    const slug = canonicalizeSlug(keyOrSlug);
    if (/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return slug;
  }
  throw new Error('ghRepoSlug: expected a known repo key or an OWNER/REPO slug');
}

/**
 * Map a LEGACY slug to the repo's current one. The 2026-10-03 org move left old `chalbert/<repo>` names behind in
 * daemon-clone `origin` URLs and old config; git and REST follow GitHub's redirect for those, but GraphQL does
 * not, so any slug derived from such a remote must be canonicalized before it reaches `gh --repo`. Anything that
 * is not a legacy `chalbert/<known repo dir>` is returned unchanged. PURE.
 * @param {string} slug
 * @returns {string}
 */
export function canonicalizeSlug(slug) {
  const m = /^chalbert\/([^/]+?)(?:\.git)?$/i.exec(String(slug || '').trim());
  if (!m) return slug;
  const name = m[1].toLowerCase();
  for (const meta of Object.values(CONSTELLATION_REPOS)) {
    if (meta.dirs.includes(name)) return meta.slug;
  }
  return slug;
}

/** Session tag for a known repo key, or null. */
export function repoSlugTag(key) {
  return Object.hasOwn(CONSTELLATION_REPOS, key) ? CONSTELLATION_REPOS[key].slugTag : null;
}

/** Untagged sessions belong to WE. */
export function repoKeyForSlugTag(tag = '') {
  return Object.entries(CONSTELLATION_REPOS).find(([, meta]) => meta.slugTag === tag)?.[0] ?? null;
}
