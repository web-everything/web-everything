// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as recovered from '../exhausted-retry-recovered-comment.mjs';
import rendererSource from '../exhausted-retry-recovered-comment.mjs?raw';

const kinds = ['ci-heal-exhausted', 'fix-loop-exhausted', 'exhaustion'];
const headSha = '0123456789abcdef0123456789abcdef01234567';
// Frozen producer output from before extraction; only the kind varies.
const originalBody = `<!-- we:exhausted-retry-recovered -->
the automatic retry after KIND went green on 0123456; the exhaustion and automatic retry budgets remain spent
head: 0123456789abcdef0123456789abcdef01234567`;
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('exhausted retry recovered comment leaf', () => {
  it('exports the closed producer kind list including the wrongSpent fallback', () => {
    expect(recovered.EXHAUSTED_RETRY_RECOVERED_KINDS).toEqual(kinds);
    expect(Object.isFrozen(recovered.EXHAUSTED_RETRY_RECOVERED_KINDS)).toBe(true);
  });

  it('imports nothing from reconcile-core, directly or transitively', () => {
    // Vite supplies the one source under test. Compile only a temp fixture, with
    // bundling disabled so even a newly introduced import cannot read the host.
    const root = mkdtempSync(join(tmpdir(), 'recovered-comment-graph-'));
    roots.push(root);
    writeFileSync(join(root, 'renderer.mjs'), rendererSource);
    const { metafile } = buildSync({
      absWorkingDir: root, entryPoints: ['renderer.mjs'], bundle: false,
      platform: 'node', format: 'esm', write: false, metafile: true, logLevel: 'silent',
    });
    expect(Object.keys(metafile.inputs)).toEqual(['renderer.mjs']);
    expect(metafile.inputs['renderer.mjs'].imports).toEqual([]);
  });

  it.each(kinds)('renders %s byte-identically to the original producer', kind => {
    expect(recovered.buildExhaustedRetryRecoveredComment({ kind, headSha }))
      .toBe(originalBody.replace('KIND', kind));
    expect(recovered.EXHAUSTED_RETRY_RECOVERED_MARKER).toBe(originalBody.split('\n')[0]);
  });
});
