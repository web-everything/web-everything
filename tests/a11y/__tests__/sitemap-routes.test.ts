import { describe, it, expect } from 'vitest';
import {
  deriveScopeCRoutes,
  ENFORCED_ROUTES,
  isDrainComplete,
  pendingWarnOnlyRoutes,
} from '../sitemap-routes';

describe('deriveScopeCRoutes — scope-C filter over sitemap pathnames (#847/#774)', () => {
  const sitemap = [
    '/',
    '/intents/',
    '/blocks/',
    '/mission/',
    '/intents/motion/',
    '/intents/loading/',
    '/blocks/accordion/',
    '/blocks/wizard/',
    '/backlog/846-sitemap/',
    '/backlog/100-foo/',
    '/cases/for-each/01-basic/',
    '/cases/accordion/01-standard/',
  ];
  const routes = deriveScopeCRoutes(sitemap);

  it('keeps every index surface (root + single-segment pages)', () => {
    expect(routes).toEqual(expect.arrayContaining(['/', '/intents/', '/blocks/', '/mission/']));
  });

  it('keeps exactly one representative detail page per path-prefix group', () => {
    const details = routes.filter((r) => r.replace(/^\/|\/$/g, '').split('/').length >= 2);
    const groups = details.map((r) => r.split('/')[1]);
    expect(new Set(groups).size).toBe(groups.length); // no group appears twice
    expect(new Set(groups)).toEqual(new Set(['intents', 'blocks', 'backlog', 'cases']));
  });

  it('keeps the resolved-backlog archive sampled as an index surface (split off /backlog/)', () => {
    const r = deriveScopeCRoutes([...sitemap, '/backlog/resolved/']);
    expect(r).toContain('/backlog/resolved/');
    expect(r).toContain('/backlog/100-foo/');
  });

  it('picks the lexicographically-first detail per group (deterministic)', () => {
    expect(routes).toContain('/backlog/100-foo/'); // not /backlog/846-…/
    expect(routes).toContain('/blocks/accordion/'); // not /blocks/wizard/
    expect(routes).toContain('/cases/accordion/01-standard/'); // not /cases/for-each/…
  });

  it('normalizes missing trailing slashes and returns a sorted, de-duped list', () => {
    const out = deriveScopeCRoutes(['/blocks', '/blocks/', '/blocks/x']);
    expect(out).toEqual(['/blocks/', '/blocks/x/']);
  });

  it('ignores non-absolute / empty entries', () => {
    expect(deriveScopeCRoutes(['', 'https://x.dev/y', '/ok/'])).toEqual(['/ok/']);
  });

  it('keeps the 10 #793/#805-earned index surfaces enforced after the #2378 promotion', () => {
    for (const seed of [
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
    ]) {
      expect(ENFORCED_ROUTES.has(seed)).toBe(true); // nothing un-earned (#774 forced invariant)
    }
  });

  it('promotes the measured-green routes into ENFORCED_ROUTES (#2378, per #867 Fork 1)', () => {
    // A sample of the 2026-07-28 promotions — measured green, decoupled from FUI-conversion state.
    expect(ENFORCED_ROUTES.has('/mission/')).toBe(true);
    expect(ENFORCED_ROUTES.has('/web-contexts/')).toBe(true); // was red at 2026-07-02 prep, green now
    expect(ENFORCED_ROUTES.has('/rules/backlog-workflow/')).toBe(true); // ditto
    // Routes red at the fresh measurement stay warn-only — NOT promoted.
    expect(ENFORCED_ROUTES.has('/semantics/')).toBe(false);
    expect(ENFORCED_ROUTES.has('/compat/')).toBe(false);
  });
});

describe('drain trigger — #867 Fork-2 self-announcing "flip when the ratchet drains" (#2378)', () => {
  it('pendingWarnOnlyRoutes returns the derived routes not yet enforced', () => {
    const enforced = new Set(['/', '/blocks/']);
    expect(pendingWarnOnlyRoutes(['/', '/blocks/', '/intents/', '/mission/'], enforced)).toEqual([
      '/intents/',
      '/mission/',
    ]);
  });

  it('is NOT drained while any derived route is still warn-only', () => {
    const enforced = new Set(['/', '/blocks/']);
    expect(isDrainComplete(['/', '/blocks/', '/intents/'], enforced)).toBe(false);
  });

  it('IS drained once every derived route is enforced (the #867 flip milestone)', () => {
    const enforced = new Set(['/', '/blocks/', '/intents/']);
    expect(isDrainComplete(['/', '/blocks/', '/intents/'], enforced)).toBe(true);
  });

  it('treats an empty derived set (sitemap-fetch failure) as NOT drained, never a false flip', () => {
    // gatedRoutes()'s fetch-fail fallback is ENFORCED_ROUTES itself; feeding the DERIVED set here (empty
    // on failure) keeps a server hiccup from false-firing the trigger.
    expect(isDrainComplete([], ENFORCED_ROUTES)).toBe(false);
    expect(pendingWarnOnlyRoutes([], ENFORCED_ROUTES)).toEqual([]);
  });

  it('defaults to the live ENFORCED_ROUTES set (a warn-only route reads as not-drained)', () => {
    // With no explicit `enforced`, the predicate reads the live set. /semantics/ is a warn-only route
    // (red at the 2026-07-28 measurement), so a derived set containing it is not drained.
    expect(isDrainComplete(['/', '/semantics/'])).toBe(false);
  });
});
