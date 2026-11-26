// Run after the complete docs build: node --test tests/build/site-asset-size.test.mjs
// Deliberately separate from unit tests, which do not produce _site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { findOversizedAssets } from '../../scripts/check-site-asset-size.mjs';

const ceiling = 20 * 1024 * 1024;

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
