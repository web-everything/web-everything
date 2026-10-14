// @vitest-environment node
/**
 * @file scripts/operations/__tests__/land-human-only-io-real.test.mjs
 * @description Card 334 — the #2949 fidelity qualifier for `land-human-only-io.mjs`: its real non-GitHub mechanism is
 *   finding a checkout of the PR's repo to run the pinned git reads in (`cloneFor`). Exercised against a REAL clone of
 *   a bare origin named like the repo; only GitHub is out of scope here (the stubbed suite covers those calls).
 */
import { it, expect } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withBareOrigin, withRealRepo } from './helpers/real-repo.mjs';
import { cloneFor } from '../land-human-only-io.mjs';

it('finds the clone of the repo from inside it, and refuses a checkout of another repo', async () => {
  await withBareOrigin(async ({ clone, slug }) => {
    const nested = join(clone, 'scripts', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(cloneFor(slug, { candidates: [nested] })).toBe(clone);
    expect(cloneFor('someone/other-repo', { candidates: [nested] })).toBeNull();
  });
  // A checkout with no origin at all is never mistaken for the repo.
  await withRealRepo(async ({ root }) => {
    expect(cloneFor('web-everything/repo', { candidates: [root] })).toBeNull();
  });
});
