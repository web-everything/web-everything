// Auto-derived route set for the rendered-site a11y gate (#847, per #774 Fork-1=C + Fork-2=A).
//
// Replaces the hand-maintained route-allowlist.ts (#770): instead of a list someone edits when a
// surface ships, the gate reads /sitemap.xml (#846 — 11ty's complete page knowledge over
// collections.all) and filters it to **scope-C** — every index surface + one representative detail
// page per path-prefix group. One template per collection (`*-pages.njk`) means a detail-page
// violation is almost always a shared-template bug, so a single sample per group catches it at ~1%
// of the all-pages cost. Mechanism is pa11y-ci's `--sitemap` posture: consume the published sitemaps.org
// artifact, never reach into build internals or re-derive permalinks (#774 rejected globbing `_site`
// and reconstructing from `_data`).
//
// FORCED INVARIANT (#774, not a fork): the enforce posture #793/#805 earned is preserved by an explicit
// ENFORCED_ROUTES set, decoupled from the derived set. A newly-derived route enters **warn-only**
// (most-permissive default); it is promoted per-route as it goes green. Resetting every route to
// warn-only would silently un-earn the 10 build-blocking routes — the broken alternative.

import { execSync } from 'node:child_process';

/** WCAG tag set the gate asserts against (WCAG 2.0 + 2.1, levels A + AA). */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/**
 * The build-blocking route set — a derived route is build-blocking iff it appears here; everything
 * else auto-derivation surfaces is warn-only until individually promoted. (#774 forced invariant —
 * an explicit set, never auto-derived, so enforcement is never silently un-earned.)
 *
 * PROMOTION (#2378, per #867 Fork 1 = decoupled): a scope-C route enters this set the moment it
 * measures green (0 WCAG A/AA violations), regardless of FUI-conversion state. The block below is the
 * 33 routes that measured green in a fresh full-set enforce run on 2026-07-28 (`A11Y_ENFORCE=1`
 * over the live sitemap: 43 derived, 33 green, 10 red). The 10 seed surfaces #793/#805 earned are
 * inside this green set — nothing was un-earned. Promotion is a hand set-edit after a fresh
 * measurement, never runtime auto-derivation of enforcement.
 *
 * Still warn-only (red at this measurement — remediate then promote, per spin-off #2): /assets/visual-diff-surface-demo/,
 * /backlog/001-resource-specs-and-plans/, /blocks/action-button/, /capabilities/adapters/base-select/,
 * /cases/accordion/01-standard/, /compat/, /demos/analytics-conformance-demo/, /module-resolution/,
 * /plugs/customattribute/, /semantics/.
 */
export const ENFORCED_ROUTES: ReadonlySet<string> = new Set([
  // The 10 #793/#805-earned index surfaces (all measured green).
  '/',
  '/intents/',
  '/blocks/',
  '/protocols/',
  '/adapters/',
  '/capabilities/',
  '/demos/',
  '/governance/',
  '/research/',
  '/backlog/',
  // Resolved archive shares the tracked-work markup; gate it alongside the current backlog.
  '/backlog/resolved/',
  // Promoted 2026-07-28 (#2378): measured green in the same enforce run.
  '/adapters/declarative-component/',
  '/author/',
  '/conformance/',
  '/design-systems/',
  '/governance/cla/',
  '/intents/access-control/',
  '/mission/',
  '/plugs/',
  '/presets/',
  '/privacy/',
  '/project-lifecycle/',
  '/projects/range-anchor/',
  '/research/a11y-gate-route-auto-derivation/',
  '/resources/',
  '/resources/cache/',
  '/rules/',
  '/rules/backlog-workflow/',
  '/specs/',
  '/specs/plugs/customnoderegistry/',
  '/states/',
  '/states/schemas/',
  '/validation-rules/',
  '/web-contexts/',
]);

const withSlash = (p: string): string => (p.endsWith('/') ? p : `${p}/`);
const segments = (p: string): string[] => p.replace(/^\/|\/$/g, '').split('/').filter(Boolean);

/**
 * Scope-C filter over a flat list of sitemap pathnames: keep **every index surface** (root + any
 * single-segment page) plus **the lexicographically-first detail page per path-prefix group** (one
 * representative sample per collection-template, keyed by first path segment). Pure + deterministic
 * (sorted output, stable "first" pick) so the gate's route set can't drift run-to-run.
 */
/** Two-segment pages that are index surfaces in their own right (not collection details), so scope-C
 *  must keep sampling them: the resolved-backlog archive holds the tiles split off `/backlog/`. */
const ARCHIVE_INDEX_SURFACES: ReadonlySet<string> = new Set(['/backlog/resolved/']);

export function deriveScopeCRoutes(paths: string[]): string[] {
  const indexSurfaces = new Set<string>();
  const firstDetailByGroup = new Map<string, string>();

  for (const raw of paths) {
    if (!raw || !raw.startsWith('/')) continue;
    const path = withSlash(raw);
    const segs = segments(path);
    if (segs.length <= 1 || ARCHIVE_INDEX_SURFACES.has(path)) {
      indexSurfaces.add(path); // '/', '/intents/', '/mission/', …
    } else {
      const group = segs[0];
      const current = firstDetailByGroup.get(group);
      if (current === undefined || path < current) firstDetailByGroup.set(group, path);
    }
  }

  return [...new Set([...indexSurfaces, ...firstDetailByGroup.values()])].sort();
}

/**
 * The 11ty origin the derived set is read from — the SAME env-driven port the spec's baseURL pins
 * (#2167: `WE_ELEVENTY_PORT`, default 8080), so a lane clone derives from its OWN sitemap, not main's
 * :8080. Without this the fetch in a lane hits the wrong port and fails, so `gatedRoutes()` collapses
 * to its `ENFORCED_ROUTES` fallback: the per-route gate silently shrinks to the enforced seed (the
 * warn-only routes are never exercised) and the #867 drain trigger sees an empty derived set, so it
 * can never observe the milestone in a lane. Default 8080 unchanged — main/CI behavior is identical.
 */
export const ELEVENTY_ORIGIN = `http://localhost:${process.env.WE_ELEVENTY_PORT ?? '8080'}`;

/**
 * Fetch /sitemap.xml from the running dev origin and return its `<loc>` pathnames. Uses the same
 * HTTP origin the Playwright lane already hits (the dev server is up via playwright.config `webServer`).
 * Returns [] on any failure so the caller can fall back to the enforced seed rather than crash.
 */
export function fetchSitemapPaths(origin = ELEVENTY_ORIGIN): string[] {
  try {
    const xml = execSync(`curl -fsS --max-time 10 ${origin}/sitemap.xml`, { encoding: 'utf8' });
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => {
      try {
        return new URL(m[1]).pathname;
      } catch {
        return m[1];
      }
    });
  } catch {
    return [];
  }
}

/**
 * The derived gate route set: scope-C over the live sitemap. If the sitemap can't be fetched (server
 * down at collection), fall back to the enforced seed so the gate still covers the known surfaces
 * rather than silently running zero routes.
 */
export function gatedRoutes(origin?: string): string[] {
  const derived = deriveScopeCRoutes(fetchSitemapPaths(origin));
  return derived.length ? derived : [...ENFORCED_ROUTES];
}

/**
 * The derived (scope-C) routes NOT yet in `enforced` — i.e. the routes still riding the warn-only rung
 * of the ratchet. Empty ⇒ every derived route is enforced ⇒ the ratchet has drained. Pure over its
 * inputs (sorted derived → sorted pending) so the drain trigger can't drift run-to-run. (#2378/#867.)
 */
export function pendingWarnOnlyRoutes(
  derived: readonly string[],
  enforced: ReadonlySet<string> = ENFORCED_ROUTES,
): string[] {
  return derived.filter((path) => !enforced.has(path));
}

/**
 * The #867 Fork-2 self-announcing drain trigger predicate: `true` iff every derived scope-C route is
 * enforced (no warn-only route remains), which is the milestone at which the #867 (b) endgame flip is
 * due — invert to enforce-by-default with an explicit `WARN_ROUTES` opt-out (see backlog/867 Fork 2 +
 * spin-off #5). A red *enforced* lane already went unnoticed for a week, so the lane carries a
 * meta-assertion (rendered-site-a11y.spec.ts) that FAILS with "drain complete — execute the #867 flip"
 * once this returns `true`, so the milestone can't rot unnoticed.
 *
 * `derived` MUST be the freshly-DERIVED set, never `gatedRoutes()`: gatedRoutes' sitemap-fetch-fail
 * fallback is `[...ENFORCED_ROUTES]`, which is drained by construction — feeding it here would
 * false-fire the trigger whenever the server is unreachable. An empty `derived` (fetch failed) is
 * therefore treated as NOT-drained (indeterminate), never as a completed drain.
 */
export function isDrainComplete(
  derived: readonly string[],
  enforced: ReadonlySet<string> = ENFORCED_ROUTES,
): boolean {
  return derived.length > 0 && pendingWarnOnlyRoutes(derived, enforced).length === 0;
}
