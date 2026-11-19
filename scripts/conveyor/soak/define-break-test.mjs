/**
 * @file define-break-test.mjs — #4075 daemon soak harness (card x0zg44l). One vitest test per real-world break
 * (`breaks/<id>.mjs`). When the tree under test carries the break's fix (`fixPresent`), the scenario must be
 * GREEN. When it does not (the fix lives on another branch still in review), the test is EXPECTED-FAIL — titled
 * with the missing fix and its card, and `it.fails` still REQUIRES the break to reproduce, so it is never a
 * silent skip; it flips to a required pass by itself the moment the fix lands on this tree.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

export function defineBreakTest(b) {
  const present = b.fixPresent(REPO_ROOT);
  const title = present
    ? `${b.title} — stays fixed (fix ${b.fixedBy.sha})`
    : `[EXPECTED-FAIL: fix ${b.fixedBy.sha} (${b.fixedBy.where}) is not in this tree — ${b.card}] ${b.title}`;
  describe(`daemon soak — break ${b.id}`, () => {
    (present ? it : it.fails)(title, async () => {
      const report = await b.run({});
      expect(b.judge(report)).toEqual([]);
    });
  });
}
