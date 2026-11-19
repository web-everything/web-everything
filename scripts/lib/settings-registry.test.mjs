/**
 * @file scripts/lib/settings-registry.test.mjs
 * @description node:test inventory drift guard, closed-path fixtures and deterministic document checks.
 * Run through host admission: node scripts/readiness/heavy-admission.mjs run -- node --test scripts/lib/settings-registry.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, renderMarkdown } from './settings-registry.mjs';
import { CAPACITY_LEAVES } from './operator-override-reader.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const META = 'scripts/lib/settings-registry-metadata.json';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'settings-registry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts/settings', 'scripts/lib']) mkdirSync(join(root, dir), { recursive: true });
  const write = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  write('scripts/dispatch-settings.json', { $comment: 'ignored', alpha: { count: 2 } });
  write('scripts/settings/feature.json', { beta: [1, 2], empty: {} });
  write('scripts/lib/delivery-platform-preferences.json', { alpha: { count: 5 } });
  write('scripts/lib/delivery-priority-settings.json', {});
  const meta = {
    settings: Object.fromEntries(['alpha', 'beta', 'empty'].map(key => [key, {
      description: `Fixture ${key}.`, owner: key === 'alpha' ? 'scripts/dispatch-settings.json' : 'scripts/settings/feature.json', changeVia: 'pr', instant: false,
    }])),
    capacityLeaves: Object.fromEntries(Object.keys(CAPACITY_LEAVES).map(key => [key, { description: 'Fixture capacity.', range: 'fixture range' }])),
    instantGaps: [], toSettle: [],
  };
  const build = () => { write(META, meta); return buildRegistry({ root }); };
  return { root, write, meta, build };
}

test('missing top-level setting metadata blocks generation', t => {
  const f = fixture(t); delete f.meta.settings.beta;
  const r = f.build(); assert.ok(r.problems.includes('missing setting metadata: beta'));
  assert.throws(() => renderMarkdown(r), /missing setting metadata: beta/);
});
test('missing platform-only setting metadata blocks generation', t => {
  const f = fixture(t); f.write('scripts/lib/delivery-priority-settings.json', { newPlatform: true });
  assert.ok(f.build().problems.includes('missing setting metadata: newPlatform'));
});
test('missing capacity leaf metadata blocks generation', t => {
  const f = fixture(t); delete f.meta.capacityLeaves['deliveryCapacity.pinUnits'];
  assert.ok(f.build().problems.includes('missing capacity metadata: deliveryCapacity.pinUnits'));
});
test('orphan top-level and capacity metadata are refused', t => {
  const f = fixture(t); f.meta.settings.orphan = f.meta.settings.beta;
  f.meta.capacityLeaves.unknown = { description: 'Unknown.', range: '0–1' };
  const r = f.build(); assert.ok(r.problems.includes('orphan setting metadata: orphan'));
  assert.ok(r.problems.includes('orphan capacity metadata: unknown'));
});
test('unknown changeVia is refused', t => {
  const f = fixture(t); f.meta.settings.alpha.changeVia = 'magic';
  assert.ok(f.build().problems.includes('invalid changeVia: alpha'));
});
test('unreadable or incomplete declarations fail closed and name the repair location', t => {
  const f = fixture(t);
  rmSync(join(f.root, 'scripts/dispatch-settings.json'));
  rmSync(join(f.root, 'scripts/settings'), { recursive: true });
  writeFileSync(join(f.root, 'scripts/lib/delivery-platform-preferences.json'), '{');
  const r = f.build();
  for (const path of ['scripts/dispatch-settings.json', 'scripts/settings', 'scripts/lib/delivery-platform-preferences.json']) assert.ok(r.problems.some(p => p.startsWith(`${path}:`)));
  assert.throws(() => renderMarkdown(r), /scripts\/settings/);
});
test('invalid metadata shape and oversized descriptions fail closed', t => {
  const f = fixture(t); f.meta.settings.beta.description = 'x'.repeat(161); f.meta.toSettle = {};
  const r = f.build(); assert.ok(r.problems.includes('invalid description: beta'));
  assert.ok(r.problems.includes('invalid metadata section: toSettle'));
  assert.throws(() => renderMarkdown(r), /invalid description/);
});
test('shared loader merges defaults, retains platform rows and counts arrays as one leaf', t => {
  const f = fixture(t); f.write('scripts/settings/addition.json', { alpha: { next: true } });
  const r = f.build(); assert.deepEqual(r.problems, []);
  const alpha = r.rows.filter(row => row.key === 'alpha'); assert.equal(alpha.length, 2);
  const merged = alpha.find(row => row.owners.includes('scripts/dispatch-settings.json'));
  assert.deepEqual(merged.value, { count: 2, next: true }); assert.equal(merged.leafCount, 2);
  assert.ok(merged.owners.includes('scripts/settings/addition.json'));
  assert.equal(r.rows.find(row => row.key === 'beta').leafCount, 1);
  assert.equal(r.rows.find(row => row.key === 'empty').leafCount, 0);
  const markdown = renderMarkdown(r); assert.equal(markdown, renderMarkdown(r));
  assert.ok(!r.rows.some(row => row.key.startsWith('$comment')));
});
test('render escapes table cells, bounds defaults and sorts constants by impact then key', t => {
  const f = fixture(t); f.meta.settings.beta.description = 'Pipe | and\nnewline.';
  f.write('scripts/settings/feature.json', { beta: 'v'.repeat(100), empty: {} });
  f.meta.toSettle = [
    { impact: 'L', proposedKey: 'a', identifier: 'LOW' },
    { impact: 'H', proposedKey: 'z', identifier: 'HIGH_Z' },
    { impact: 'H', proposedKey: 'a', identifier: 'HIGH_A' },
  ];
  const md = renderMarkdown(f.build()); assert.ok(md.includes('Pipe \\| and newline.'));
  assert.ok(md.includes('"' + 'v'.repeat(58) + '…')); assert.ok(!md.includes('v'.repeat(60)));
  assert.ok(md.indexOf('HIGH_A') < md.indexOf('HIGH_Z')); assert.ok(md.indexOf('HIGH_Z') < md.indexOf('LOW'));
});
test('real repository metadata is complete and committed documentation matches the render', () => {
  const registry = buildRegistry({ root: ROOT }); assert.deepEqual(registry.problems, []);
  assert.equal(registry.capacityRows.length, Object.keys(CAPACITY_LEAVES).length);
  assert.equal(readFileSync(join(ROOT, 'docs/agent/settings-registry.md'), 'utf8'), renderMarkdown(registry));
});
