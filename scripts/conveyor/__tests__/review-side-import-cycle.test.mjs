// @vitest-environment node
/**
 * @file review-side-import-cycle.test.mjs
 * @description Pins that the review-side modules do not reach `reconcile-core.mjs` through `rearm-review.mjs` before
 *   it is initialised. `review-stack-base.mjs` once imported the comment reader from `parked-pr-conflict-watch.mjs`;
 *   that file's import graph loops back through `reconcile-core.mjs` to `rearm-review.mjs`, so loading
 *   `rearm-review.mjs` first threw `Cannot access 'REARM_COMMENT_MARKER' before initialization` and every daemon host
 *   (fix-dispatch) exited before ready. A fresh process per entry point is the only honest check: inside vitest the
 *   module graph is already warm.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const options = { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000 };
const ENTRIES = [
  '../rearm-review.mjs',
  '../reconcile-core.mjs',
  '../reconcile-fix-dispatch.mjs',
  '../review-stack-base.mjs',
  '../pr-comments-complete.mjs',
  '../../operations/review-pr.mjs',
];

describe('review-side modules load in a fresh process without an import-cycle crash', () => {
  for (const rel of ENTRIES) {
    it(rel, () => {
      const href = new URL(rel, import.meta.url).href;
      const result = spawnSync(process.execPath, [
        '--no-deprecation', '--input-type=module', '-e',
        `await import(${JSON.stringify(href)}); console.log('ok')`,
      ], options);
      expect(result.error).toBeUndefined();
      expect(result.stderr).not.toMatch(/ReferenceError|before initialization/);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('ok\n');
    });
  }

  it('the comment reader the review side uses is the leaf module, not the conflict watch', () => {
    const src = readFileSync(new URL('../pr-comments-complete.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/from '\.\/pr-comments-list\.mjs'/);
    expect(src).not.toMatch(/from '\.\/parked-pr-conflict-watch\.mjs'/);
  });
});
