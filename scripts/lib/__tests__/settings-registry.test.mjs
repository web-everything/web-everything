/**
 * @file scripts/lib/__tests__/settings-registry.test.mjs
 * @description Vitest inventory drift guard, closed-path fixtures and deterministic document checks.
 * Run through host admission: node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/settings-registry.test.mjs
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, renderMarkdown } from '../settings-registry.mjs';
import { CAPACITY_LEAVES } from '../operator-override-reader.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const META = 'scripts/lib/settings-registry-metadata.json';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'settings-registry-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
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
    instantGaps: [], toSettle: [], discoveryPasses: ['H', 'I'].map(pass => ({ pass, family: 'Fixture', scope: 'scripts/', newItems: 0, newHighImpactItems: 0 })),
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
  assert.ok([0, 10].includes(registry.toSettle.filter(row => row.top === true).length));
  const identities = registry.toSettle.map(row => `${row.identifier}:${row.where.replace(/:\d+$/, '')}`);
  assert.equal(new Set(identities).size, identities.length, 'identifier+file pairs must be unique');
  assert.equal(registry.capacityRows.length, Object.keys(CAPACITY_LEAVES).length);
  assert.equal(readFileSync(join(ROOT, 'docs/agent/settings-registry.md'), 'utf8'), renderMarkdown(registry));
});
test('top proposals allow zero or ten and refuse incomplete, oversized or non-boolean selections', t => {
  const f = fixture(t);
  for (const count of [0, 1, 9, 10, 11]) {
    f.meta.toSettle = Array.from({ length: count }, (_, i) => ({ identifier: `ITEM_${i}`, proposedKey: `key${i}`, impact: 'H', top: true }));
    const registry = f.build();
    if ([0, 10].includes(count)) assert.deepEqual(registry.problems, []);
    else assert.throws(() => renderMarkdown(registry), /top proposals must number 10 or 0/);
  }
  f.meta.toSettle = [{ top: 'true' }];
  assert.throws(() => renderMarkdown(f.build()), /invalid top proposal boolean/);
});
test('discovery metadata refuses missing, unreadable or incomplete evidence', t => {
  const f = fixture(t);
  for (const value of [undefined, {}, [], [null], [{ pass: 'A', family: 'Codex', scope: 'scripts/', newItems: 'inventory', newHighImpactItems: '-' }], [{ pass: 'A', family: 'Codex', scope: 'scripts/' }],
    [{ pass: 'A', family: 'Codex', scope: 'scripts/', newItems: -1, newHighImpactItems: 0 }]]) {
    f.meta.discoveryPasses = value;
    assert.throws(() => renderMarkdown(f.build()), /invalid (metadata section: discoveryPasses|discovery pass)/);
  }
});
test('discovery convergence and only selected proposals render before the full inventory', t => {
  const f = fixture(t);
  f.meta.discoveryPasses = [{ pass: 'H', family: 'Family | test', scope: 'scripts/', newItems: 17, newHighImpactItems: 2 },
    { pass: 'I', family: 'Claude', scope: 'whole sweep', newItems: 23, newHighImpactItems: 0 }];
  f.meta.toSettle = Array.from({ length: 11 }, (_, i) => ({ identifier: `ITEM_${i}`, proposedKey: `key${i}`, impact: 'H', top: i < 10 }));
  const md = renderMarkdown(f.build());
  const discovery = md.indexOf('## Discovery convergence');
  const top = md.indexOf('## Top 10 proposals');
  const full = md.indexOf('## Hard-coded constants to settle');
  assert.ok(discovery < top && top < full);
  assert.ok(md.includes('| I | Claude | whole sweep | 23 | 0 |'));
  assert.ok(md.includes('Family \\| test'));
  assert.ok(md.includes('H-impact discovery converged (fewer than 5 new H items in each of passes H and I)'));
  assert.equal((md.slice(top, full).match(/ITEM_/g) ?? []).length, 10);
  assert.ok(!md.slice(top, full).includes('ITEM_10'));
  assert.ok(md.slice(full).includes('ITEM_10'));
});

test('duplicate JSON keys fail closed', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'scripts/settings/feature.json'), '{"beta":1,"beta":2,"empty":{}}');
  const registry = f.build();
  assert.ok(registry.problems.includes('scripts/settings/feature.json: duplicate key in file'));
  assert.throws(() => renderMarkdown(registry), /duplicate key in file/);
});
test('scalar-over-subtree collisions fail closed', t => {
  const f = fixture(t); f.write('scripts/settings/collision.json', { alpha: 3 });
  const registry = f.build();
  assert.ok(registry.problems.includes('duplicate setting leaf: alpha'));
  assert.throws(() => renderMarkdown(registry), /duplicate leaf alpha/);
});
test('duplicate leaves fail closed', t => {
  const f = fixture(t); f.write('scripts/settings/collision.json', { alpha: { count: 3 } });
  assert.throws(() => renderMarkdown(f.build()), /duplicate setting leaf: alpha.count/);
});
test('high counts in the last two passes cannot claim convergence', t => {
  const f = fixture(t);
  for (const row of f.meta.discoveryPasses) { row.newItems = 100; row.newHighImpactItems = 100; }
  const md = renderMarkdown(f.build());
  assert.ok(md.includes('H-impact discovery has not converged'));
  assert.ok(md.includes('M-impact tail has not converged'));
});
test('both of the last two passes must be below the strict convergence thresholds', t => {
  const f = fixture(t);
  assert.ok(renderMarkdown(f.build()).includes('M-impact tail converged'));
  for (const index of [0, 1]) {
    f.meta.discoveryPasses[index].newItems = 5;
    f.meta.discoveryPasses[index].newHighImpactItems = 5;
    const md = renderMarkdown(f.build());
    assert.ok(md.includes('H-impact discovery has not converged'));
    assert.ok(md.includes('M-impact tail has not converged'));
    f.meta.discoveryPasses[index].newItems = 0;
    f.meta.discoveryPasses[index].newHighImpactItems = 0;
  }
});
test('current numeric discovery evidence converges for H but not the M tail', () => {
  const md = renderMarkdown(buildRegistry({ root: ROOT }));
  assert.ok(md.includes('H-impact discovery converged'));
  assert.ok(md.includes('M-impact tail has not converged'));
});
