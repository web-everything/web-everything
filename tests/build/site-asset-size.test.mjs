// Run after the complete docs build: node --test tests/build/site-asset-size.test.mjs
// Deliberately separate from unit tests, which do not produce _site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOversizedAssets } from '../../scripts/check-site-asset-size.mjs';

const ceiling = 20 * 1024 * 1024;

test('uses a 24 MiB deployment limit by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'backlog-asset-boundary-'));
  const asset = join(root, 'index.html');
  const script = fileURLToPath(new URL('../../scripts/check-site-asset-size.mjs', import.meta.url));
  const limit = 24 * 1024 * 1024;
  try {
    // Sparse files exercise the real deployment CLI without a full build or large buffers.
    for (const bytes of [limit, limit + 1, Math.round(24.010340 * 1024 * 1024)]) {
      const fd = openSync(asset, 'w');
      try { ftruncateSync(fd, bytes); } finally { closeSync(fd); }
      const result = spawnSync(process.execPath, [script, root], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
      });
      assert.ifError(result.error);
      assert.equal(result.status, bytes === limit ? 0 : 1, result.stderr);
      assert.deepEqual(findOversizedAssets(root), bytes === limit ? [] : [{ path: 'index.html', bytes }]);
      if (bytes > limit) {
        assert.match(result.stderr, /index\.html: .* MiB \(guard limit: 24 MiB\)/);
        assert.ok(result.stderr.includes(`${(bytes / (1024 * 1024)).toFixed(6)} MiB`));
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps the fully built backlog page at or below 20 MiB', () => {
  const page = statSync('_site/backlog/index.html');
  assert.ok(page.isFile(), 'Build the complete site before checking the backlog page');
  assert.ok(page.size <= ceiling,
    `backlog/index.html is ${page.size} bytes; reduce inline content or move it into bounded fragments`);
});

test('keeps every full-build asset at or below the 20 MiB acceptance ceiling', () => {
  assert.deepEqual(findOversizedAssets('_site', ceiling), [],
    'Reduce oversized assets before merge; inspect the reported paths and byte sizes');
});
