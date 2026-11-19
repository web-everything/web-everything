/**
 * @file scripts/lib/settings-registry.mjs
 * @description Declared settings inventory and documentation drift guard; never resolves host overrides.
 * Usage: node scripts/lib/settings-registry.mjs --write | --check
 * API: buildRegistry({ root }), renderMarkdown(registry). Descriptions belong in the metadata JSON.
 */
import { readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readSettingsChecked, settingsLeaves } from './settings-files.mjs';
import { CAPACITY_LEAVES } from './operator-override-reader.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const META = 'scripts/lib/settings-registry-metadata.json';
const DOC = 'docs/agent/settings-registry.md';
const PLATFORM = ['scripts/lib/delivery-platform-preferences.json', 'scripts/lib/delivery-priority-settings.json'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const entries = obj => Object.entries(obj).sort(([a], [b]) => compare(a, b));
const documented = key => !key.startsWith('$comment');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read only repository declarations. Missing/unreadable evidence is a problem, never an empty success. */
export function buildRegistry({ root = ROOT } = {}) {
  const problems = [];
  const read = path => {
    try {
      const data = JSON.parse(readFileSync(join(root, path), 'utf8'));
      if (!object(data)) throw Error('expected JSON object');
      return data;
    } catch (error) { problems.push(`${path}: ${error.message}`); return {}; }
  };
  // The shared reader intentionally tolerates ENOENT; an inventory must require both declaration homes.
  for (const path of ['scripts/dispatch-settings.json', 'scripts/settings']) {
    try {
      const stat = statSync(join(root, path));
      if (path.endsWith('.json') ? !stat.isFile() : !stat.isDirectory()) throw Error('wrong file type');
    } catch (error) { problems.push(`${path}: ${error.message}`); }
  }
  const declared = readSettingsChecked({ dir: join(root, 'scripts/settings'), legacyPath: join(root, 'scripts/dispatch-settings.json') });
  for (const { source, reason } of declared.taint) problems.push(`scripts/${source}: ${reason}`);
  for (const { path } of declared.duplicates) problems.push(`duplicate setting leaf: ${path}`);
  const metadata = read(META);
  for (const section of ['settings', 'capacityLeaves']) if (!object(metadata[section])) problems.push(`invalid metadata section: ${section}`);
  for (const section of ['instantGaps', 'toSettle', 'discoveryPasses']) if (!Array.isArray(metadata[section])) problems.push(`invalid metadata section: ${section}`);
  if (Array.isArray(metadata.toSettle)) {
    const topCount = metadata.toSettle.filter(row => row.top === true).length;
    if (![0, 10].includes(topCount)) problems.push(`top proposals must number 10 or 0: ${topCount}`);
    if (metadata.toSettle.some(row => Object.hasOwn(row, 'top') && typeof row.top !== 'boolean')) problems.push('invalid top proposal boolean');
  }
  if (Array.isArray(metadata.discoveryPasses) && metadata.discoveryPasses.length < 2) problems.push('invalid discovery passes: at least two numeric passes required');
  if (Array.isArray(metadata.discoveryPasses)) for (const row of metadata.discoveryPasses) {
    if (!row || !['pass', 'family', 'scope'].every(key => typeof row[key] === 'string' && row[key].trim()) || !['newItems', 'newHighImpactItems'].every(key =>
      Number.isSafeInteger(row[key]) && row[key] >= 0)) problems.push('invalid discovery pass');
  }
  const owners = new Map();
  const sources = new Set(['dispatch-settings.json']);
  // Enumerate declarations for ownership only; checked validation above owns merge safety.
  try {
    for (const file of readdirSync(join(root, 'scripts/settings')).filter(file => file.endsWith('.json')).sort()) sources.add(`settings/${file}`);
  } catch (error) { problems.push(`scripts/settings: ${error.message}`); }
  for (const source of sources) {
    const path = `scripts/${source}`;
    for (const key of Object.keys(read(path)).filter(documented)) {
      if (!owners.has(key)) owners.set(key, []);
      owners.get(key).push(path);
    }
  }
  const rows = entries(declared.value).filter(([key]) => documented(key)).map(([key, value]) => ({ key, value, owners: owners.get(key) ?? [] }));
  // Platform declarations remain distinct rows: their defaults can differ from tool defaults of the same key.
  for (const path of PLATFORM) for (const [key, value] of entries(read(path)).filter(([key]) => documented(key))) rows.push({ key, value, owners: [path] });
  const keys = new Set(rows.map(row => row.key));
  for (const key of keys) if (!Object.hasOwn(metadata.settings ?? {}, key)) problems.push(`missing setting metadata: ${key}`);
  for (const [key, meta] of entries(metadata.settings ?? {})) {
    if (!keys.has(key)) problems.push(`orphan setting metadata: ${key}`);
    if (!['pr', 'capacity-leaf', 'operator-prefs', 'env'].includes(meta?.changeVia)) problems.push(`invalid changeVia: ${key}`);
    if (typeof meta?.description !== 'string' || !meta.description.trim() || meta.description.length > 160) problems.push(`invalid description: ${key}`);
    if (typeof meta?.instant !== 'boolean') problems.push(`invalid instant: ${key}`);
    if (!rows.some(row => row.key === key && row.owners.includes(meta?.owner))) problems.push(`invalid owner: ${key}`);
  }
  const capacityRows = entries(CAPACITY_LEAVES).map(([key]) => {
    const meta = metadata.capacityLeaves?.[key];
    if (!meta) problems.push(`missing capacity metadata: ${key}`);
    else if (typeof meta.description !== 'string' || !meta.description.trim() || !meta.range) problems.push(`invalid capacity metadata: ${key}`);
    return { ...meta, key };
  });
  for (const key of Object.keys(metadata.capacityLeaves ?? {})) if (!Object.hasOwn(CAPACITY_LEAVES, key)) problems.push(`orphan capacity metadata: ${key}`);
  return { rows: rows.map(row => ({ ...row, ...metadata.settings?.[row.key], leafCount: leafCount(row.value) }))
    .sort((a, b) => compare(a.key, b.key) || compare(a.owners.join(), b.owners.join())),
  capacityRows, instantGaps: metadata.instantGaps ?? [], toSettle: metadata.toSettle ?? [], discoveryPasses: metadata.discoveryPasses ?? [], problems: problems.sort(compare) };
}

function leafCount(value) {
  if (!object(value)) return 1;
  return settingsLeaves(value).filter(path => !path.split('.').some(k => k.startsWith('$comment'))).length;
}
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
const abbreviated = value => {
  const str = JSON.stringify(value);
  return str.length > 60 ? `${str.slice(0, 59)}…` : str;
};
const table = (headers, rows) => [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n');

/** Deterministic Markdown: defaults are declarations, not the effective settings of a running host. */
export function renderMarkdown(registry) {
  if (registry.problems.length) throw Error(registry.problems.join('\n'));
  const { rows, capacityRows, instantGaps, toSettle, discoveryPasses } = registry;
  const proposalTable = proposals => table(['Impact', 'Proposed key', 'Identifier', 'Current', 'Range', 'Instant candidate', 'Pass', 'Location'], [...proposals]
    .sort((a, b) => 'HML'.indexOf(a.impact) - 'HML'.indexOf(b.impact) || compare(a.proposedKey, b.proposedKey) || compare(a.identifier, b.identifier))
    .map(row => [row.impact, row.proposedKey, row.identifier, row.current, row.range, row.instant ? 'yes' : 'no', row.pass, row.where]));
  const lastTwo = discoveryPasses.slice(-2);
  const passes = lastTwo.map(row => row.pass).join(' and ');
  const hConverged = lastTwo.every(row => row.newHighImpactItems < 5);
  const mConverged = lastTwo.every(row => row.newItems < 5);
  const unique = [...new Map(rows.map(row => [row.key, row])).values()];
  const out = ['Generated by scripts/lib/settings-registry.mjs — do not edit by hand', '', '# Centralised settings registry', '',
    '## How to read', '',
    'This inventory shows repository declarations, not effective host values. Arrays and scalars count as one leaf; empty objects have zero leaves. Documentation keys beginning with $comment are excluded. Shared top-level keys list every declaring owner; platform copies have separate rows. Defaults are abbreviated to 60 characters.', '',
    'R1076: behavior belongs in product settings. The constants below are candidates to settle, not conversions or approved policy changes. Pass C records environment override availability in its instant column; that alone does not prove live reload.', '',
    '## How to change a setting', '',
    'The policy layers are standard → platform → tool/repo → env → operator-db; see [policy-cascade.mjs](../../scripts/lib/policy-cascade.mjs). Readers opt into the cascade; this inventory does not assert every declaration uses every layer. Environment overrides require reader support and process environment propagation.', '',
    'For repo defaults, edit the owner file through a PR and rebuild the consuming daemon. Add or update metadata in scripts/lib/settings-registry-metadata.json, then run `node scripts/lib/settings-registry.mjs --write`. Verify with `node scripts/lib/settings-registry.mjs --check`. Missing declarations or invalid evidence block generation; repair the named file before regenerating.', '',
    '## Summary', '',
    `- Top-level keys: ${unique.length} (${rows.length} declaration rows).`,
    `- Declared leaves: ${rows.reduce((sum, row) => sum + row.leafCount, 0)} (platform copies counted separately).`,
    `- Instant top-level keys: ${unique.filter(row => row.instant).length}; not instant: ${unique.filter(row => !row.instant).length}.`,
    `- Instant capacity leaves: ${capacityRows.length}.`,
    `- Constants to settle: ${toSettle.length}.`,
    `- Instant gaps: ${instantGaps.length}.`, '',
    '## Instant settings', '',
    'Capacity leaves are instant through the operator-override store when their reader resolves policy. They do not make the repository default itself instant. The operator override writer owns validation and audit; guard leaves are not capacity overrides.', '',
    'Operator-prefs layer: ~/.plateau/platform-preferences.json is the requested operator home; the current policy-cascade implementation actually reads ~/.claude/platform-preferences.json (or WE_PLATFORM_PREFERENCES_FILE) per call. That operator-owned platform overlay may override platform-layer policies; tool and env layers still take precedence. It is orchestrator-written only. This registry changes neither path nor authority.', '',
    table(['Capacity leaf', 'Range', 'Unit', 'Instant', 'Description'], capacityRows.map(row => [row.key, row.range, row.unit, 'yes', row.description])), '',
    '## All declared settings', '',
    table(['Key', 'Owner file(s)', 'Leaf count', 'Current defaults', 'changeVia', 'Instant', 'Description'], rows.map(row => [row.key, row.owners.join(', '), row.leafCount, abbreviated(row.value), row.changeVia, row.instant ? 'yes' : 'no', row.description])), '',
    '### Capacity leaf aliases', '',
    table(['Declared key', 'Leaf path ($ = scalar)', 'Range', 'Unit', 'Note'], unique.flatMap(row => entries(row.leaves ?? {}).map(([path, meta]) => [row.key, path, meta.range, meta.unit, meta.note]))), '',
    '## Instant gaps', '',
    table(['Key', 'Today', 'Needed', 'Why'], [...instantGaps].sort((a, b) => compare(a.key, b.key)).map(row => [row.key, row.today, row.needed, row.why])), '',
    '## Discovery convergence', '',
    'Pass A established the unquantified baseline inventory (declared settings, platform files, capacity leaves, operator prefs keys and env vars). Numeric discovery evidence starts at pass B.', '',
    table(['Pass', 'Family', 'Scope', 'New items', 'New H-impact items'], discoveryPasses.map(row => [row.pass, row.family, row.scope, row.newItems, row.newHighImpactItems])), '',
    `H-impact discovery ${hConverged ? 'converged' : 'has not converged'} (${hConverged ? 'fewer than 5 new H items in each of' : 'at least 5 new H items in one or both of'} passes ${passes}); the M-impact tail ${mConverged ? 'converged (fewer than 5 new items total in each of the last two passes)' : 'has not converged (at least 5 new items total in one or both of the last two passes)'}; agy-gemini (a third model family) is off by ruling and can be added as an optional extra pass if the operator enables it.`, '',
    '## Top 10 proposals', '',
    'Prioritised for throughput and stuck-work impact, favouring capacity and concurrency controls that should be instant; these remain proposals.', '',
    proposalTable(toSettle.filter(row => row.top === true)), '',
    '## Hard-coded constants to settle', '',
    proposalTable(toSettle), ''];
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const mode = process.argv.slice(2);
    if (mode.length !== 1 || !['--write', '--check'].includes(mode[0])) throw Error('usage: node scripts/lib/settings-registry.mjs --write | --check');
    const content = renderMarkdown(buildRegistry({ root: ROOT }));
    if (mode[0] === '--write') writeFileSync(join(ROOT, DOC), content);
    else if (readFileSync(join(ROOT, DOC), 'utf8') !== content) throw Error(`${DOC} is stale; run node scripts/lib/settings-registry.mjs --write`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
