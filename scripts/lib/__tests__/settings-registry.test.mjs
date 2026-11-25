/**
 * @file scripts/lib/__tests__/settings-registry.test.mjs
 * @description Vitest inventory drift guard, closed-path fixtures and deterministic document checks.
 * Run through host admission: node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/__tests__/settings-registry.test.mjs
 */
import { test } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import MarkdownIt from 'markdown-it';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, symlinkSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRegistry, readMetadata, renderMarkdown, ensureRegistryDoc } from '../settings-registry.mjs';
import { fixture as mergeFixture, snapshot, DOC, CLOSURE } from './fixtures/generated-merge.mjs';
import { CAPACITY_LEAVES } from '../operator-override-reader.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const META = 'scripts/lib/settings-registry-metadata.json';
const META_DIR = 'scripts/lib/settings-registry-metadata.d';
const filename = key => encodeURIComponent(key).replace(/[!'()*_]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replaceAll('%', '_') + '.json';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'settings-registry-'));
  t.onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['scripts/settings', 'scripts/lib']) mkdirSync(join(root, dir), { recursive: true });
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
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
test('render round-trips backslashes and pipes in one table cell', t => {
  const f = fixture(t);
  const markdown = new MarkdownIt();
  const betaCells = registry => {
    const tokens = markdown.parse(renderMarkdown(registry), {});
    const rows = tokens.flatMap((token, index) => token.type === 'tr_open'
      ? [tokens.slice(index + 1, tokens.findIndex((next, end) => end > index && next.type === 'tr_close'))
        .filter(next => next.type === 'inline').map(next => next.children.map(child => child.content).join(''))]
      : []);
    return rows.find(cells => cells[0] === 'beta');
  };
  const original = betaCells(f.build());
  ['a\\|b\\', 'a\\', 'a\\\\|b\\', 'a|b', 'a\\\\'].forEach(value => {
    f.meta.settings.beta.description = value;
    const actual = betaCells(f.build());
    assert.equal(actual.length, original.length, 'escaping must preserve the table column count');
    assert.deepEqual(actual, original.map(cell => cell === 'Fixture beta.' ? value : cell));
  });
});
test('real repository metadata is complete and generated documentation matches the render', () => {
  const registry = buildRegistry({ root: ROOT }); assert.deepEqual(registry.problems, []);
  assert.ok([0, 10].includes(registry.toSettle.filter(row => row.top === true).length));
  const identities = registry.toSettle.map(row => `${row.identifier}:${row.where.replace(/:\d+$/, '')}`);
  assert.equal(new Set(identities).size, identities.length, 'identifier+file pairs must be unique');
  assert.equal(registry.capacityRows.length, Object.keys(CAPACITY_LEAVES).length);
  assert.equal(execFileSync('git', ['ls-files', 'docs/agent/settings-registry.md'], { cwd: ROOT, encoding: 'utf8' }), '', 'generated doc must not be tracked');
  assert.equal(ensureRegistryDoc({ root: ROOT }), renderMarkdown(registry));
  assert.equal(renderMarkdown(buildRegistry({ root: ROOT })), renderMarkdown(registry));
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

test('--check succeeds without a tracked or local doc and writes nothing', t => {
  const tracked = spawnSync('git', ['ls-files', '--', DOC], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(tracked.status, 0); assert.equal(tracked.stdout, '');
  const ignored = spawnSync('git', ['check-ignore', '--', DOC], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ignored.status, 0); assert.equal(ignored.stdout.trim(), DOC);
  const f = mergeFixture(); t.onTestFinished(f.cleanup);
  f.ok(['rm', '--', DOC]); f.write('.gitignore', `${DOC}\n`); f.commit('untrack doc');
  const before = snapshot(f);
  f.generate('--check'); f.generate('--check');
  assert.equal(existsSync(join(f.root, DOC)), false);
  assert.deepEqual(snapshot(f), before);
  f.generate('--write'); assert.ok(existsSync(join(f.root, DOC)));
  assert.equal(f.ok(['status', '--porcelain']), '');
  f.json(`${META_DIR}/settings/sample.json`, {});
  assert.throws(() => f.generate('--check'), /invalid description: sample/);
});

test('--check refuses unequal fresh renders without writing the doc', t => {
  const f = mergeFixture(); t.onTestFinished(f.cleanup);
  rmSync(join(f.root, DOC));
  f.write(CLOSURE[0], readFileSync(join(f.root, CLOSURE[0]), 'utf8')
    .replace('return out.join', 'return String(globalThis.renderCount = (globalThis.renderCount ?? 0) + 1) + out.join'));
  const before = snapshot(f);
  assert.throws(() => f.generate('--check'), /render is not deterministic/);
  assert.deepEqual(snapshot(f), before);
});

// Immutable compact snapshot captured before the per-key migration (not regenerated).
const originalMetadata = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/__tests__/fixtures/settings-registry-original.json'), 'utf8'));
// Literal B1 oracle: never derive these declarations from the live metadata.
const poolMetadata = {
  settings: { resourcePool: {
    description: 'S1a shadow studio ledger: builder floor and maxima; reserves validated for later slices. Enforce is refused as unknown.',
    owner: 'scripts/settings/resource-pool.json', changeVia: 'pr', instant: false,
    leaves: {
      builderFloor: { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.builderFloor' },
      'classes.1.reserve': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.1.reserve' },
      'classes.1.max': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.1.max' },
      'classes.2.reserve': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.2.reserve' },
      'classes.2.max': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.2.max' },
      'classes.3.reserve': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.3.reserve' },
      'classes.3.max': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.3.max' },
      'classes.4.reserve': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.4.reserve' },
      'classes.4.max': { range: 'integer 0–64', unit: 'units', note: 'also instant via resourcePool.class.4.max' },
      mode: { range: 'off | shadow | enforce', unit: 'mode', note: 'instant via resourcePool.mode enum override; enforce is refused as unknown in S1a' },
    },
  } },
  capacityLeaves: {
    'resourcePool.builderFloor': { description: 'Protected builder capacity floor in shadow allocation decisions.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.1.reserve': { description: 'Class 1 reserve policy, validated and retained for later pool slices.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.1.max': { description: 'Maximum units for class 1 repair work in shadow allocation decisions.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.2.reserve': { description: 'Class 2 reserve policy, validated and retained for later pool slices.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.2.max': { description: 'Maximum units for class 2 review work in shadow allocation decisions.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.3.reserve': { description: 'Class 3 reserve policy, validated and retained for later pool slices.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.3.max': { description: 'Maximum units for class 3 fix work in shadow allocation decisions.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.4.reserve': { description: 'Class 4 reserve policy, validated and retained for later pool slices.', range: 'integer 0–64', unit: 'units' },
    'resourcePool.class.4.max': { description: 'Maximum units for class 4 builder work in shadow allocation decisions.', range: 'integer 0–64', unit: 'units' },
  },
};
const poolValue = { mode: 'shadow', builderFloor: 4, classes: {
  1: { reserve: 2, max: 4, class1Overdraw: 2 }, 2: { reserve: 6, max: 8 },
  3: { reserve: 2, max: 6 }, 4: { reserve: 4, max: 64 },
} };
const poolCapacityValues = {
  'resourcePool.builderFloor': 4,
  'resourcePool.class.1.reserve': 2, 'resourcePool.class.1.max': 4,
  'resourcePool.class.2.reserve': 6, 'resourcePool.class.2.max': 8,
  'resourcePool.class.3.reserve': 2, 'resourcePool.class.3.max': 6,
  'resourcePool.class.4.reserve': 4, 'resourcePool.class.4.max': 64,
};
// Declarations from the same pre-migration commit (sourceCommit in the fixture).
// Ignore top-level $comments, replace account IDs with placeholders, and excerpt
// the privacy allowlist. Every rendered default and leaf count stays unchanged.
// Live defaults and keys evolve independently.
const originalDeclarations = JSON.parse(readFileSync(join(ROOT, 'scripts/lib/__tests__/fixtures/settings-registry-original-declarations.json'), 'utf8'));
function originalFixture(t) {
  const f = fixture(t);
  rmSync(join(f.root, 'scripts/settings/feature.json'));
  for (const [path, value] of Object.entries(originalDeclarations.files)) f.write(path, value);
  Object.assign(f.meta, structuredClone(originalMetadata));
  // Capacity declarations come from live code even with historical owner files.
  Object.assign(f.meta.capacityLeaves, structuredClone(poolMetadata.capacityLeaves));
  return f;
}
function split(f) {
  for (const section of ['settings', 'capacityLeaves']) {
    for (const [key, value] of Object.entries(f.meta[section])) f.write(`${META_DIR}/${section}/${filename(key)}`, value);
    delete f.meta[section];
  }
  f.write(META, f.meta);
}
test('per-key directory reconstructs exactly the original metadata JSON shape and registry', t => {
  const f = fixture(t), original = structuredClone(f.meta), before = f.build();
  split(f);
  assert.deepEqual(readMetadata({ root: f.root }), original);
  assert.deepEqual(f.build(), before);
});
test('migration preserves the registry built from the original repository metadata JSON', t => {
  const f = originalFixture(t), metadata = structuredClone(f.meta), before = f.build();
  assert.deepEqual(before.problems, []);
  split(f);
  assert.deepEqual(readMetadata({ root: f.root }), metadata);
  assert.deepEqual(f.build(), before);
});
test('a new metadata key file alone adds a row without editing the base metadata', t => {
  const f = fixture(t); split(f);
  const base = readFileSync(join(f.root, META), 'utf8');
  f.write('scripts/settings/new.json', { newKey: 7 });
  f.write(`${META_DIR}/settings/newKey.json`, { description: 'New key.', owner: 'scripts/settings/new.json', changeVia: 'pr', instant: false });
  const registry = f.build();
  assert.deepEqual(registry.problems, []);
  assert.equal(registry.rows.find(row => row.key === 'newKey').value, 7);
  assert.equal(readFileSync(join(f.root, META), 'utf8'), base);
});
test('duplicate metadata key in base and directory fails closed in either section', t => {
  for (const section of ['settings', 'capacityLeaves']) {
    const f = fixture(t), [key, value] = Object.entries(f.meta[section])[0];
    f.write(`${META_DIR}/${section}/${filename(key)}`, value);
    assert.throws(() => renderMarkdown(f.build()), /duplicate metadata key/);
  }
});
test('base and per-key metadata cannot override declared key, value or owners', t => {
  for (const perKey of [false, true]) {
    const f = fixture(t), before = f.build().rows;
    Object.assign(f.meta.settings.alpha, { key: 'forged', value: { forged: true }, owners: ['forged.json'] });
    if (perKey) split(f);
    const r = f.build();
    for (const field of ['key', 'value', 'owners']) assert.ok(r.problems.includes(`metadata overrides declared field: alpha.${field}`));
    assert.deepEqual(r.rows, before);
    assert.throws(() => renderMarkdown(r), /metadata overrides declared field/);
  }
});
test('base and per-key JSON reject duplicate properties at the root and inside nested objects and arrays', t => {
  for (const section of [null, 'settings', 'capacityLeaves']) for (const raw of [
    '{"description":"first","description":"last"}',
    '{"leaves":{"count":{"range":"first","range":"last"}}}',
    '{"nested":[{"key":1,"k\\u0065y":2}]}',
  ]) {
    const f = fixture(t); split(f);
    const key = section === 'settings' ? 'alpha' : Object.keys(CAPACITY_LEAVES)[0];
    const path = section === null ? META : `${META_DIR}/${section}/${filename(key)}`;
    writeFileSync(join(f.root, path), raw);
    const problems = [], metadata = readMetadata({ root: f.root, problems });
    assert.ok(problems.includes(`${path}: duplicate JSON property`));
    if (section !== null) assert.deepEqual(metadata[section][key], {});
    assert.throws(() => readMetadata({ root: f.root }), /duplicate JSON property/);
    assert.throws(() => renderMarkdown(buildRegistry({ root: f.root })), /duplicate JSON property/);
  }
});
test('base JSON rejects symlinks and non-regular files', t => {
  for (const symlink of [false, true]) {
    const f = fixture(t); f.build();
    const absolute = join(f.root, META);
    if (symlink) {
      const target = join(f.root, 'target.json');
      renameSync(absolute, target);
      symlinkSync(target, absolute);
    } else {
      rmSync(absolute);
      mkdirSync(absolute);
    }
    const problems = [];
    readMetadata({ root: f.root, problems });
    assert.ok(problems.includes(`${META}: expected regular file (no symlinks)`));
    assert.throws(() => readMetadata({ root: f.root }), /expected regular file/);
    assert.throws(() => renderMarkdown(buildRegistry({ root: f.root })), /expected regular file/);
  }
});
test('duplicate scanner allows repeated names in separate scopes and punctuation in strings', t => {
  const f = fixture(t);
  f.meta.extra = { left: { key: '"key":{}[],\\' }, right: [{ key: 1 }, { key: 2 }] };
  f.write(META, f.meta);
  assert.deepEqual(readMetadata({ root: f.root }), f.meta);
});
test('metadata directory rejects symlinked roots, sections and files and other non-regular entries', t => {
  for (const section of ['settings', 'capacityLeaves']) for (const entry of ['root', 'section', 'file']) for (const symlink of [false, true]) {
    const f = fixture(t); split(f);
    const key = section === 'settings' ? 'alpha' : Object.keys(CAPACITY_LEAVES)[0];
    const path = entry === 'root' ? META_DIR : entry === 'section' ? `${META_DIR}/${section}` : `${META_DIR}/${section}/${filename(key)}`;
    const absolute = join(f.root, path);
    if (symlink) {
      const target = join(f.root, 'target');
      renameSync(absolute, target);
      symlinkSync(target, absolute);
    } else {
      rmSync(absolute, { recursive: true });
      if (entry === 'file') mkdirSync(absolute);
      else writeFileSync(absolute, '{}');
    }
    const problems = [];
    readMetadata({ root: f.root, problems });
    assert.ok(problems.some(p => p.startsWith(`${path}: expected `)), problems.join('\n'));
    assert.throws(() => readMetadata({ root: f.root }), /expected (directory|regular file)/);
    assert.throws(() => renderMarkdown(f.build()), /expected (directory|regular file)/);
  }
});
test('filenames round-trip punctuation, percent, slash and Unicode keys in deterministic order', t => {
  const f = fixture(t); split(f);
  const keys = ['z', 'a.b', '$*', 'slash/\\percent%', 'café', '__proto__', 'snake_case', '$description', '*'];
  // Every filename stays inside the audit-path grammar, so no percent sign ever reaches a tracked path.
  for (const key of keys) assert.match(filename(key), /^[A-Za-z0-9._-]+$/);
  for (const key of keys) f.write(`${META_DIR}/settings/${filename(key)}`, { description: key });
  const metadata = readMetadata({ root: f.root });
  for (const key of keys) assert.equal(metadata.settings[key].description, key);
  assert.deepEqual(Object.keys(metadata.settings), Object.keys(metadata.settings).sort());
});
test('malformed names, unexpected entries and unreadable per-key JSON fail closed with repair paths', t => {
  for (const name of ['bad%.json', '%61lpha.json', '_61lpha.json', 'a_b.json', 'notes.txt']) {
    const f = fixture(t); f.write(`${META_DIR}/settings/${name}`, {});
    assert.throws(() => renderMarkdown(f.build()), /settings-registry-metadata\.d/);
  }
  const f = fixture(t); f.write(`${META_DIR}/settings/broken.json`, {});
  writeFileSync(join(f.root, META_DIR, 'settings/broken.json'), '{');
  assert.throws(() => renderMarkdown(f.build()), /settings-registry-metadata\.d\/settings\/broken.json/);
});

test('generated documentation includes the literal B1 resourcePool declarations', () => {
  const registry = buildRegistry();
  assert.deepEqual(registry.problems, []);
  assert.deepEqual(registry.rows.find(row => row.key === 'resourcePool').value, poolValue);
  for (const [key, value] of Object.entries(poolCapacityValues))
    assert.equal(CAPACITY_LEAVES[key].failClosedFallback, value);
  const metadata = readMetadata();
  for (const section of ['settings', 'capacityLeaves'])
    for (const [key, value] of Object.entries(poolMetadata[section])) assert.deepEqual(metadata[section][key], value);
  const doc = renderMarkdown(registry);
  assert.match(doc, /^\| resourcePool \|/m);
  for (const key of Object.keys(poolCapacityValues)) assert.ok(doc.includes(key), key);
});

test('generated documentation preserves original bytes except the intentional per-key authoring instruction', t => {
  const f = originalFixture(t);
  split(f);
  const registry = f.build();
  // Keep the byte oracle on its historical capacity roster; B1 has its own literal oracle above.
  const doc = renderMarkdown({ ...registry, capacityRows: registry.capacityRows.filter(row => Object.hasOwn(originalMetadata.capacityLeaves, row.key)) });
  const originalInstruction = 'For repo defaults, edit the owner file through a PR and rebuild the consuming daemon. Add or update metadata in scripts/lib/settings-registry-metadata.json, then run `node scripts/lib/settings-registry.mjs --write`. Verify with `node scripts/lib/settings-registry.mjs --check`. Missing declarations or invalid evidence block generation; repair the named file before regenerating.';
  const original = doc.replace(/^For repo defaults,.*$/m, originalInstruction);
  // The original declaration fixture no longer advertises the retired MQ signature setting.
  assert.equal(createHash('sha256').update(original).digest('hex'), '307ab2610c6c0c5efe3bd91c0d6a1c9d7afa5fe5e6e3d3152de798299783bd9d');
});
test('generated documentation retains rotation, rerun, audit debounce/delta, audit-owed and build-priority scope rows and authoring instructions', () => {
  const registry = buildRegistry(), doc = renderMarkdown(registry);
  for (const key of ['providerRotation', 'ciUnitRerun', 'audit', 'reviewAutoAudit', 'allowedFiles']) assert.match(doc, new RegExp(`^\\| ${key} \\|`, 'm'));
  const reviewAutoAudit = registry.rows.find(row => row.key === 'reviewAutoAudit');
  assert.deepEqual(reviewAutoAudit.owners, ['scripts/settings/review-auto-audit.json']);
  assert.equal(reviewAutoAudit.value.mode, 'shadow');
  const audit = registry.rows.find(row => row.key === 'audit');
  assert.deepEqual(audit.value.debounce, { minutes: 5 });
  assert.deepEqual(audit.value.delta, { maxFiles: 0, waivedCarry: { maxFiles: 40 } });
  const auditRow = doc.split('\n').find(line => line.startsWith('| audit |'));
  assert.ok(auditRow.includes('"debounce":{"minutes":5}'));
  assert.ok(auditRow.includes('"delta":{"maxFiles":0,"waivedCarr…'));
  // Forge host sizes are operator-private: the repo default names no hosts.
  assert.deepEqual(registry.rows.find(row => row.key === 'forgeSlots').value, { default: 8, hosts: {} });
  assert.ok(doc.split('\n').find(line => line.startsWith('| forgeSlots |')).includes('{"default":8,"hosts":{}}'));
  assert.ok(doc.includes('scripts/lib/settings-registry-metadata.d/settings/<encoded-key>.json'));
  assert.ok(doc.includes('generated by `npm run settings:registry`, not committed'));
  execFileSync(process.execPath, [join(ROOT, 'scripts/lib/settings-registry.mjs'), '--check']);
});

test('standalone timeout policy does not claim conveyor setting metadata', t => {
  const f = fixture(t);
  f.write('scripts/settings/test-timeout-policy.json', { policyType: 'timeout', all: {}, tests: { 'a.test.mjs': { soft: 'PT1S' } } });
  const r = f.build();
  assert.deepEqual(r.problems, []);
  assert.ok(!r.rows.some(row => row.owners.includes('scripts/settings/test-timeout-policy.json')));
});

function authoredFixture(t) {
  const f = fixture(t); split(f);
  for (const key of ['instantGaps', 'toSettle', 'discoveryPasses']) f.write(`${META_DIR}/lists/${key}.json`, f.meta[key]);
  rmSync(join(f.root, META));
  return f;
}
function checkFixture(f) {
  for (const name of ['settings-registry', 'settings-files', 'operator-override-reader']) {
    const path = `scripts/lib/${name}.mjs`;
    writeFileSync(join(f.root, path), readFileSync(join(ROOT, path)));
  }
  return spawnSync(process.execPath, [join(f.root, 'scripts/lib/settings-registry.mjs'), '--check'], {
    cwd: f.root, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  });
}
test('clean build creates a missing doc, repairs stale output and checks inputs without output', t => {
  const f = authoredFixture(t);
  assert.equal(existsSync(join(f.root, DOC)), false);
  assert.equal(checkFixture(f).status, 0);
  assert.equal(existsSync(join(f.root, DOC)), false, '--check only validates inputs');
  const content = ensureRegistryDoc({ root: f.root });
  assert.equal(readFileSync(join(f.root, DOC), 'utf8'), content);
  writeFileSync(join(f.root, DOC), 'stale');
  assert.match(checkFixture(f).stderr, /is stale/);
  ensureRegistryDoc({ root: f.root });
  assert.equal(checkFixture(f).status, 0);
  assert.equal(readFileSync(join(f.root, DOC), 'utf8'), content);
  f.write(`${META_DIR}/settings/beta.json`, {});
  const invalid = checkFixture(f);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid description: beta/);
  assert.throws(() => ensureRegistryDoc({ root: f.root }), /invalid description: beta/);
});
test('both generated registry paths are ignored by git', () => {
  assert.deepEqual(execFileSync('git', ['check-ignore', '--', DOC, META], {
    cwd: ROOT, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
  }).trim().split('\n'), [DOC, META]);
});
test('adding a setting needs only its owner and metadata fragment, leaving lists and generated files untouched', t => {
  const f = authoredFixture(t);
  const paths = readdirSync(join(f.root, META_DIR, 'lists')).map(name => `${META_DIR}/lists/${name}`);
  const before = paths.map(path => readFileSync(join(f.root, path), 'utf8'));
  f.write('scripts/settings/new.json', { newKey: 7 });
  f.write(`${META_DIR}/settings/newKey.json`, { description: 'New key.', owner: 'scripts/settings/new.json', changeVia: 'pr', instant: false });
  assert.match(renderMarkdown(buildRegistry({ root: f.root })), /\| newKey \| scripts\/settings\/new.json \|/);
  assert.deepEqual(paths.map(path => readFileSync(join(f.root, path), 'utf8')), before);
  for (const path of [DOC, META]) assert.equal(existsSync(join(f.root, path)), false);
});
test('list metadata rejects non-arrays, unreadable evidence and duplicate legacy keys', t => {
  for (const raw of ['{}', '[', '[{"x":1,"x":2}]']) {
    const f = authoredFixture(t), path = `${META_DIR}/lists/instantGaps.json`;
    writeFileSync(join(f.root, path), raw);
    assert.throws(() => renderMarkdown(buildRegistry({ root: f.root })), /lists\/instantGaps.json/);
  }
  const f = authoredFixture(t);
  f.write(META, { instantGaps: [] });
  assert.throws(() => readMetadata({ root: f.root }), /duplicate metadata key: instantGaps/);
});
