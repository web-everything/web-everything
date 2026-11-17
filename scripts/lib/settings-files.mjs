/**
 * @file scripts/lib/settings-files.mjs
 * @description One reader for the declared conveyor settings, split into PER-FEATURE files so parallel PRs stop
 *   editing one shared JSON file (held item 168, 2026-10-09: the fix-daemon edge kept conflict-dropping overlays —
 *   #4527 main-red owner, #4510 push-on-green — because every feature appended its keys to the end of
 *   `we:scripts/dispatch-settings.json`, and two appends at the same closing brace always conflict).
 *
 * LAYOUT
 *   - `we:scripts/settings/<feature>.json` — one file per feature, each a JSON object. A new feature adds a NEW file
 *     here; it never edits another feature's file. Discovered from disk (sorted by name), nothing hand-listed.
 *   - `we:scripts/dispatch-settings.json` — the LEGACY shared file, still read first for compatibility. Its keys are
 *     frozen (see `LEGACY_SETTINGS_LEAVES`); a new key there fails `settings-files.test.mjs`.
 *
 * MERGE: plain objects merge deeply, key by key; any other value (number, string, array) replaces. Layers apply in
 *   order legacy → feature files (sorted), so a feature file wins. Each leaf should have exactly one owner file;
 *   a leaf set by two files is reported in `duplicates` (and fails the layout test) instead of silently winning.
 *
 * Every reader of these settings keeps its own `env` override and built-in default; this module only replaces
 * "read the one file" with "read the merged layers". Never throws.
 * readSettingsChecked reports global read taint and removes duplicate leaves; lenient readers stay last-wins.
 * R969 F2: safety keys will REFUSE (throw) on taint; tuning keys use the default plus a health smell.
 * The per-key registry is intentionally empty in S1 and filled by S2 as resolvers migrate; unlisted = unclassified.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The per-feature settings folder. */
export const SETTINGS_DIR = resolve(HERE, '../settings');
/** The legacy shared file, read first for compatibility. */
export const LEGACY_SETTINGS_PATH = resolve(HERE, '../dispatch-settings.json');

/** Leaf path -> 'safety' | 'tuning'; classification is applied by migrating resolvers. */
export const SETTING_KEY_CLASSES = Object.freeze({});
export const SETTING_CLASSES = Object.freeze(['safety', 'tuning']);
export function settingKeyClass(path) {
  return Object.hasOwn(SETTING_KEY_CLASSES, path) ? SETTING_KEY_CLASSES[path] : undefined;
}

/**
 * The leaves the legacy file may hold — frozen as of 2026-10-09. `freeze.mainRed` is listed because the in-flight
 * PR #4527 (card xu1nixv) adds it there; listing it lets that PR land unchanged. Any other new setting goes in
 * `scripts/settings/<feature>.json`. The existing keys are NOT moved here on purpose: moving them edits the legacy
 * file, which conflicts with every open PR that still edits it (live 2026-10-09: #4527 was rebased onto these very
 * keys). Move them in a later change, when no open PR touches the legacy file.
 */
export const LEGACY_SETTINGS_LEAVES = Object.freeze([
  'heavyAdmissionCap', 'fixDispatchMaxConcurrent', 'maxLoadPerCore', 'memFreeMinPct',
  'cpuIdleMinPct.fix', 'cpuIdleMinPct.ci-heal', 'cpuIdleMinPct.build', 'cpuIdleMinPct.prepare', 'cpuIdleMinPct.review',
  'fixDispatch.borrowBuildSlots', 'fixDispatch.borrowAfterMinutes', 'fixDispatch.borrowExecutor',
  'fixDispatch.awaitVerifyLoopSeconds', 'fixDispatch.parkedReleasesSlot', 'fixDispatch.parkedCapFactor',
  'fixDispatch.releaseOnCompletion',
  'freeze.mainRed',
]);

/**
 * The scripts that STILL read `scripts/dispatch-settings.json` directly instead of through {@link readSettings}
 * (backlog xrxmm8e N1: switching them is a follow-up). A key moved out of the legacy file into
 * `scripts/settings/<feature>.json` is INVISIBLE to these readers — they silently fall back to their built-in
 * default. So: never move an existing key they own, and a new key only goes in a feature file when its reader
 * goes through `readSettings`. `settings-files.test.mjs` pins this list against the tree (a new direct reader fails
 * it; so does a listed one that migrated), and the `overlay-dropped` smell names it in its advice. Shrink this list
 * as each reader migrates.
 */
export const LEGACY_ONLY_READERS = Object.freeze([
  'scripts/lib/dispatch-throttle.mjs',
  'scripts/lib/main-red-priority.mjs',
]);

/** What the legacy-file layout guard tells an author whose new key failed it. */
export const LEGACY_FILE_GUARD_HINT = 'put a NEW setting in scripts/settings/<feature>.json (overlays conflict-drop on this one shared file) and read it through readSettings() from scripts/lib/settings-files.mjs — a reader that reads scripts/dispatch-settings.json directly (see LEGACY_ONLY_READERS) never sees a feature file';

/** A feature file name: lower-case kebab words, `.json`. */
export const FEATURE_FILE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** The key a settings file must never write through: `JSON.parse` makes `__proto__` an OWN key, and merging into it
 *  would reach `Object.prototype`. It is skipped, not merged. (`constructor` / `prototype` are plain own keys here:
 *  `into.constructor` is a function, never a plain object, so a merge cannot walk through them.) */
const UNSAFE_KEYS = new Set(['__proto__']);
/** A top-level `$comment` is documentation, not a setting: every feature file may carry its own, so it owns no leaf
 *  (two files each with a `$comment` are not a duplicate owner). */
const DOC_KEY = '$comment';

/** PURE: every leaf path (`a.b.c`) of a plain object. Arrays and scalars are leaves. */
export function settingsLeaves(obj, prefix = '') {
  if (!isPlainObject(obj)) return [];
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (k === DOC_KEY && !prefix) continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (isPlainObject(v)) out.push(...settingsLeaves(v, p));
    else out.push(p);
  }
  return out;
}

function deepMerge(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (isPlainObject(v) && isPlainObject(into[k])) deepMerge(into[k], v);
    else into[k] = isPlainObject(v) ? deepMerge({}, v) : v;
  }
  return into;
}

/**
 * PURE: merge settings layers in order.
 * @param {Array<{source:string, data:unknown}>} layers — a non-object `data` is skipped.
 * @returns {{settings:object, owners:Record<string,string>, duplicates:Array<{path:string, sources:string[]}>}}
 */
export function mergeSettingsLayers(layers) {
  const settings = {};
  // no prototype: a leaf named `toString` / `hasOwnProperty` must not look already owned
  const owners = Object.create(null);
  const dup = new Map();
  for (const { source, data } of Array.isArray(layers) ? layers : []) {
    if (!isPlainObject(data)) continue;
    for (const leaf of settingsLeaves(data)) {
      if (owners[leaf] && owners[leaf] !== source) {
        const list = dup.get(leaf) ?? [owners[leaf]];
        list.push(source);
        dup.set(leaf, list);
      }
      owners[leaf] = source;
    }
    deepMerge(settings, data);
  }
  return { settings, owners, duplicates: [...dup].map(([path, sources]) => ({ path, sources })) };
}

/**
 * Read the legacy file, then every `<dir>/*.json` (sorted), and merge them. An unreadable or invalid file is
 * skipped and named in `errors`. Never throws.
 * @param {{dir?:string, legacyPath?:string|null}} [o]
 * @returns {{settings:object, owners:Record<string,string>, duplicates:Array<{path:string,sources:string[]}>,
 *   sources:string[], errors:Array<{source:string, error:string}>}}
 */
export function readDeclaredSettings(o) {
  const { layers, errors } = loadSettingsLayers(o);
  return { ...mergeSettingsLayers(layers), sources: layers.map((l) => l.source), errors };
}

// Scan only already-valid JSON. Strings are consumed as tokens so punctuation inside them cannot affect
// container tracking; decoded names catch escape-equivalent keys. Keep one key set per open object.
function checkedFileKeys(text) {
  const containers = [];
  let dotted = false;
  let duplicate = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '{') containers.push(new Set());
    else if (char === '[') containers.push(null);
    else if (char === '}' || char === ']') containers.pop();
    else if (char === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        i++;
      }
      let next = i + 1;
      while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      if (text[next] !== ':') continue;
      const key = JSON.parse(text.slice(start, i + 1));
      const keys = containers.at(-1);
      dotted ||= key.includes('.');
      duplicate ||= keys.has(key);
      keys.add(key);
    }
  }
  return { dotted, duplicate };
}

// Keep historical error messages separate from the bounded, content-free checked diagnostics.
function loadSettingsLayers({ dir = SETTINGS_DIR, legacyPath = LEGACY_SETTINGS_PATH } = {}, checked = false) {
  const layers = [];
  const errors = [];
  const taint = [];
  const recordError = (source, e, reason) => {
    if (e?.code === 'ENOENT') return;
    errors.push({ source, error: String(e?.message ?? e) });
    taint.push({ source, reason: String(reason).slice(0, 200) });
  };
  const load = (source, path, listed = false) => {
    let parsing = false;
    try {
      const text = readFileSync(path, 'utf8');
      parsing = true;
      const data = JSON.parse(text);
      if (checked) {
        const { dotted, duplicate } = checkedFileKeys(text);
        if (dotted) taint.push({ source, reason: 'dotted key' });
        if (duplicate) taint.push({ source, reason: 'duplicate key in file' });
      }
      if (!isPlainObject(data)) {
        errors.push({ source, error: 'not a JSON object' });
        taint.push({ source, reason: 'not a JSON object' });
        return;
      }
      layers.push({ source, data });
    } catch (e) {
      if (checked && listed && e?.code === 'ENOENT') taint.push({ source, reason: 'vanished' });
      recordError(source, e, parsing ? 'invalid JSON' : (e?.code ?? 'read error'));
    }
  };
  if (legacyPath) load('dispatch-settings.json', legacyPath);
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (e) {
    names = [];
    recordError('settings/', e, e?.code ?? 'read error');
  }
  for (const f of names) load(`settings/${f}`, join(dir, f), true);
  return { layers, errors, taint };
}

// Checked ownership uses a trie: a literal dotted key and a nested path are distinct nodes.
function checkedCollisions(layers) {
  const root = { children: new Map() };
  const visit = (parent, data, source, keys = []) => {
    for (const [key, value] of Object.entries(data)) {
      if (UNSAFE_KEYS.has(key) || (!keys.length && key === DOC_KEY)) continue;
      if (!parent.children.has(key)) {
        parent.children.set(key, { children: new Map(), owners: new Set(), leaf: false });
      }
      const node = parent.children.get(key);
      node.owners.add(source);
      if (isPlainObject(value)) visit(node, value, source, [...keys, key]);
      else node.leaf = true;
    }
  };
  for (const { source, data } of layers) visit(root, data, source);
  const duplicates = [];
  const collect = (parent, keys = []) => {
    for (const [key, node] of parent.children) {
      const path = [...keys, key];
      if (node.leaf && node.owners.size > 1) duplicates.push({ keys: path, sources: [...node.owners] });
      collect(node, path);
    }
  };
  collect(root);
  return duplicates;
}

/**
 * Read a dotted namespace (empty = whole tree). An exact top-level key takes precedence, including a literal
 * dotted key; otherwise dots separate path segments. Read failures taint every namespace because an unreadable
 * layer could own any leaf. Dotted keys and repeated keys within a file also taint every namespace.
 * Duplicate nodes across layers are removed and taint their ancestors, themselves and descendants.
 * @returns {{value:unknown, taint:Array<{source:string,reason:string}>, duplicates:Array<{path:string,sources:string[]}>}}
 */
export function readSettingsChecked({ namespace = '', dir, legacyPath } = {}) {
  const { layers, taint } = loadSettingsLayers({ dir, legacyPath }, true);
  const { settings } = mergeSettingsLayers(layers);
  const allDuplicates = checkedCollisions(layers);
  const namespaceKeys = !namespace ? [] : Object.hasOwn(settings, namespace) ? [namespace] : namespace.split('.');
  const isPrefix = (prefix, path) => prefix.length <= path.length && prefix.every((key, i) => key === path[i]);
  const duplicates = allDuplicates
    .filter(({ keys }) => isPrefix(namespaceKeys, keys) || isPrefix(keys, namespaceKeys))
    .map(({ keys, sources }) => ({ path: keys.join('.'), sources }));
  for (const { keys } of allDuplicates) {
    let parent = settings;
    for (const key of keys.slice(0, -1)) {
      parent = parent != null && Object.hasOwn(parent, key) ? parent[key] : undefined;
    }
    if (isPlainObject(parent)) delete parent[keys.at(-1)];
  }
  for (const { path, sources } of duplicates) {
    taint.push({ source: sources.at(-1), reason: `duplicate leaf ${path}: ${sources.join(', ')}`.slice(0, 200) });
  }
  let value = settings;
  for (const key of namespaceKeys) {
    value = value != null && Object.hasOwn(value, key) ? value[key] : undefined;
  }
  taint.sort((a, b) => a.source < b.source ? -1 : a.source > b.source ? 1
    : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0);
  return { value, taint, duplicates };
}

/** The merged settings object alone (what the resolvers pass as `file`). Never throws. */
export function readSettings(o) {
  return readDeclaredSettings(o).settings;
}
