// @vitest-environment node
/**
 * @file scripts/operations/__tests__/land-human-only-io-real.test.mjs
 * @description Card 334 — the #2949 fidelity qualifier for `land-human-only-io.mjs`: its real non-GitHub mechanism is
 *   finding a checkout of the PR's repo to run the pinned git reads in (`cloneFor`). Exercised against a REAL clone of
 *   a bare origin. Git discovers the real clone and reads its origin; the origin's GitHub spelling is injected
 *   because the fixture's transport is a local path. No fetch or network call is made.
 */
import { it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withBareOrigin, withRealRepo } from './helpers/real-repo.mjs';
import { cloneFor } from '../land-human-only-io.mjs';

it('finds the clone of the repo from inside it, and refuses a checkout of another repo', async () => {
  await withBareOrigin(async ({ clone, slug }) => {
    const nested = join(clone, 'scripts', 'deep');
    mkdirSync(nested, { recursive: true });
    const withOrigin = (origin) => (bin, args, opts) => {
      const real = execFileSync(bin, args, opts);
      return args.includes('get-url') ? origin : real;
    };
    for (const origin of [`https://github.com/${slug}.git`, `git@github.com:${slug}.git`, `ssh://git@github.com/${slug}.git`]) {
      const options = { candidates: [nested], exec: withOrigin(origin), canonical: () => null };
      expect(cloneFor(slug, options)).toBe(clone);
      expect(cloneFor(`someone/${slug.split('/')[1]}`, options)).toBeNull();
      expect(cloneFor('someone/other-repo', options)).toBeNull();
    }
    expect(cloneFor(slug, { candidates: [nested], exec: withOrigin(`https://elsewhere.test/${slug}.git`) })).toBeNull();
    // A clone whose origin keeps a renamed repo's old owner counts once GitHub resolves that spelling to the repo.
    const renamed = { candidates: [nested], exec: withOrigin(`git@github.com:old-owner/${slug.split('/')[1]}.git`) };
    expect(cloneFor(slug, { ...renamed, canonical: () => slug.toLowerCase() })).toBe(clone);
    expect(cloneFor(slug, { ...renamed, canonical: () => null })).toBeNull();
    // A local path cannot establish the GitHub host even when owner/name matches.
    expect(cloneFor(slug, { candidates: [nested] })).toBeNull();
  });
  // A checkout with no origin at all is never mistaken for the repo.
  await withRealRepo(async ({ root }) => {
    expect(cloneFor('web-everything/repo', { candidates: [root], canonical: () => null })).toBeNull();
  });
});
