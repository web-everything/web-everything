/** R131: pure shadow proposal; callers keep enforcing today's humanRequired decision. */
import { PROTECTION_PATHS } from './human-review-surfaces.mjs';
import { SANDBOX_TOKEN_RE } from './permission-change.mjs';
import { readFileSync } from 'node:fs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';

/** R131: standard → platform → tool → environment; shadow is the safe fallback. */
export function resolveDirectionAwareMode({ env = process.env, readFile = readFileSync } = {}) {
  let tool;
  try { tool = JSON.parse(String(readFile(new URL('../settings/direction-aware-human.json', import.meta.url), 'utf8')))?.directionAwareHuman; } catch { /* absent layer */ }
  const valid = value => value === 'shadow' || value === 'live';
  const raw = env?.WE_DIRECTION_AWARE_HUMAN;
  const platform = platformPreference('directionAwareHuman', { env, readFile });
  return cascadePolicy('directionAwareHuman', valid(tool) ? tool : 'shadow', {
    standard: 'shadow', platform: valid(platform) ? platform : null,
    envValues: { '': raw === undefined ? undefined : valid(raw) ? raw : 'shadow' }, valid, env,
  }).value ?? 'shadow';
}

const SURFACE = 'scripts/lib/human-review-surfaces.mjs';
const CLASSIFIERS = new Set(['scripts/lib/review-escalation.mjs', 'scripts/lib/permission-change.mjs',
  'scripts/lib/direction-aware-human.mjs', 'scripts/review-core-cli.mjs', 'scripts/settings/human-review-surfaces.json',
  'scripts/lib/policy-cascade.mjs', 'scripts/lib/merge-queue-enqueue.mjs', 'scripts/lib/read-only-ops.mjs', 'scripts/lib/import-closure.mjs', 'scripts/operations/registry.mjs',
  'scripts/operations/step-kinds.mjs', 'scripts/settings/direction-aware-human.json']);
const ALLOW_LISTS = new Set(['scripts/operations/run.mjs', 'scripts/operations/scheduled-sweep.mjs',
  'scripts/conveyor/health-investigate-dispatch.mjs']);
const yes = reason => ({ proposed: true, reason });
const entry = text => /^\s*\/((?:\\[^\n]|[^/\\\n])+)\/([a-z]*),\s*(?:\/\/[^\n]*)?$/.exec(text);
const opener = text => /^\s*(?:export\s+)?const\s+[A-Z_]+_PATHS\s*=\s*Object\.freeze\(\[\s*$/.test(text);

// Compilation proves syntax, not bounded matching cost. Admit only short literal
// paths, optional anchors and the fixed basename boundary used by shipped rules.
// No quantifiers, arbitrary groups, alternatives, character classes or stateful flags.
function boundedProtection(source, flags) {
  if (source.length > 512 || !['', 'i'].includes(flags)) return false;
  const boundary = String.raw`(^|\/)`;
  let literal = source.startsWith(boundary) ? source.slice(boundary.length) : source.replace(/^\^/, '');
  if (literal.endsWith('$')) literal = literal.slice(0, -1);
  return /^(?:[a-z0-9_-]|\\[./])+$/i.test(literal);
}

// Count both sides of every hunk: truncated, binary, combined and malformed evidence cannot clear a hold.
function parse(text) {
  if (typeof text !== 'string') throw new Error('null hunks');
  if (text.length > 200000) throw new Error('oversized diff: human review required');
  const rows = []; let active = false; let old = 0; let next = 0; let context = ''; let hunk = 0;
  for (const raw of text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined)) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.length > 2000) throw new Error('oversized line: human review required');
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (header) {
      hunk += 1;
      if (old || next) throw new Error('unparsable incomplete hunk');
      old = Number(header[1] ?? 1); next = Number(header[2] ?? 1); active = true; context = '';
    } else if (active) {
      if (line === '\\ No newline at end of file') continue;
      const kind = line[0];
      if (![' ', '+', '-'].includes(kind)) throw new Error('unparsable hunk line');
      if (kind !== '+') old -= 1;
      if (kind !== '-') next -= 1;
      if (old < 0 || next < 0) throw new Error('unparsable hunk counts');
      if (kind === ' ') context = line.slice(1);
      rows.push({ kind, text: line.slice(1), context, hunk });
    } else if (!/^(diff --git |index |--- |\+\+\+ )/.test(line)) throw new Error('unparsable diff metadata');
  }
  if (!active || old || next || !rows.some(r => r.kind !== ' ')) throw new Error('unparsable incomplete diff');
  return rows;
}

function tightening(rows) {
  const added = rows.filter(r => r.kind === '+');
  if (rows.some(r => r.kind === '-')) throw new Error(added.length ? 'mixed tighten+loosen' : 'removes protection');
  const regexes = [];
  for (const row of added) {
    if (/[\u2028\u2029\u0000-\u0008\u000b-\u001f]/.test(row.text)) throw new Error('unsafe protection text');
    if (!entry(row.context) && !opener(row.context)) throw new Error('unprovable tightening context');
    if (/^\s*\/\//.test(row.text)) continue;
    const match = entry(row.text);
    if (!match) throw new Error('unprovable tightening');
    let regex;
    try { regex = new RegExp(match[1], match[2]); }
    catch { throw new Error('invalid protection regex'); }
    if (!boundedProtection(match[1], match[2])) throw new Error('unproven protection regex cost: human review required');
    regexes.push(regex);
  }
  return regexes;
}

function references(text) {
  return [...text.matchAll(/\b([A-Z][A-Z0-9_]*_OP)\b|['"]([a-z][a-z0-9-]*)['"]/g)]
    .map(m => m[2] ?? m[1].slice(0, -3).toLowerCase().replaceAll('_', '-'));
}
const bracketCounts = text => [...'()[]{}'].map(char => [...text].filter(c => c === char).length);
const sameCounts = (a, b) => a.every((count, i) => count === b[i]);
const balanced = text => {
  const counts = bracketCounts(text);
  return counts[0] === counts[1] && counts[2] === counts[3] && counts[4] === counts[5];
};
const ITEM = String.raw`(?:[A-Z][A-Z0-9_]*_OP|'[a-z][a-z0-9-]*'|"[a-z][a-z0-9-]*")`;
const pureItem = new RegExp(`^\\s*${ITEM},?\\s*$`);
// Operation names alone do not prove list use; accept only self-contained wiring.
function allowedAddition(line, ops) {
  const text = line.trim();
  if (pureItem.test(text)) return false;
  if (!balanced(text)) return false;
  const imported = /^import\s*\{\s*([\w$,\s]+)\}\s*from\s*(['"])(\.\/[^'"]+\.mjs)\2\s*;$/.exec(text);
  const registration = /^\[([A-Z][A-Z0-9_]*_OP)\]:\s*\(\)\s*=>\s*\(\{\s*declaration:\s*(\w+)\(\{\s*readFacts:\s*(\w+)\(\)\s*\}\),\s*sinks:\s*\{\},\s*finish:\s*(\w+)\s*\}\)\s*,$/.exec(text);
  return ops.some(op => {
    const camel = op.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    const pascal = camel[0].toUpperCase() + camel.slice(1);
    const constant = `${op.toUpperCase().replaceAll('-', '_')}_OP`;
    const names = new Set([constant, `${camel}Operation`, `create${pascal}Reader`, `finish${pascal}`]);
    if (imported && imported[3] === `./${op}.mjs`) {
      const identifiers = imported[1].split(',').map(s => s.trim());
      if (identifiers.at(-1) === '') identifiers.pop();
      return identifiers.length > 0 && identifiers.every(name => names.has(name));
    }
    return registration && registration[1] === constant && registration[2] === `${camel}Operation`
      && registration[3] === `create${pascal}Reader` && registration[4] === `finish${pascal}`;
  });
}
function readOnlyAddition(rows, readOnlyOps, hunk) {
  if (SANDBOX_TOKEN_RE.test(hunk)) throw new Error('sandbox token in hunk');
  const added = rows.filter(r => r.kind === '+').map(r => r.text);
  const before = rows.filter(r => r.kind !== '+').map(r => r.text).join('\n');
  const previous = new Set(references(before));
  const ops = [...new Set(references(added.join('\n')))].filter(op => !previous.has(op));
  if (!ops.length) throw new Error('no new op reference');
  for (const op of ops) if (!readOnlyOps.has(op)) throw new Error(`write-capable or unproven op: ${op}`);
  // A stored array can control writes through indices, length or consumers outside
  // the hunk. Neither its name nor complete literal boundaries prove membership-only use.
  // Inline replacements get no exemption for pre-existing operation names either.
  for (const row of rows) {
    if (row.kind !== '+') continue;
    for (const op of references(row.text)) {
      if (!readOnlyOps.has(op)) throw new Error(`write-capable or unproven op: ${op}`);
    }
  }
  // Every removal needs its own ordered partner in the same hunk. Word subsets
  // cannot prove that a guard survived, even when another identical guard did.
  const normalize = text => text.replace(/[\s,]/g, '');
  const stripped = text => normalize(text.replace(
    /\b[A-Z][A-Z0-9_]*_OP\b|['"][a-z][a-z0-9-]*['"]/g,
    token => ops.includes(references(token)[0]) ? '' : token));
  const partners = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.kind !== '+') continue;
    const key = `${row.hunk}:${stripped(row.text)}`;
    if (!partners.has(key)) partners.set(key, { indices: [], consumed: 0 });
    partners.get(key).indices.push(index);
  }
  const nextAdded = new Map();
  for (const removed of rows.filter(row => row.kind === '-')) {
    const bucket = partners.get(`${removed.hunk}:${normalize(removed.text)}`);
    const minimum = nextAdded.get(removed.hunk) ?? 0;
    while (bucket && bucket.consumed < bucket.indices.length && bucket.indices[bucket.consumed] < minimum) bucket.consumed += 1;
    const partner = bucket?.indices[bucket.consumed++];
    if (partner === undefined) throw new Error('unpaired removed line: human review required');
    nextAdded.set(removed.hunk, partner + 1);
  }
  for (const row of rows) {
    if (row.kind === '+' && pureItem.test(row.text)) {
      throw new Error('unprovable list membership: human review required');
    }
  }
  // Word/bracket conservation cannot prove executable semantics (for example !).
  // Preserve replacements verbatim apart from indentation. Array insertions need
  // consumer evidence beyond this API's hunks, so retain human review for them.
  for (const [index, row] of rows.entries()) {
    if (row.kind !== '+') continue;
    const line = row.text;
    if (allowedAddition(line, ops)) continue;
    const counts = bracketCounts(line);
    // Text equality proves nothing about scope after moving past context or
    // crossing a hunk boundary. Only an immediately replaced line is evidence.
    const prior = rows[index - 1];
    const readded = balanced(line) && prior?.kind === '-' && prior.hunk === row.hunk
      && sameCounts(counts, bracketCounts(prior.text)) && prior.text.trim() === line.trim();
    if (!readded) throw new Error('unprovable added expression: human review required');
  }
  // Self-contained wiring carries its own proof. Everything else
  // must conserve each bracket kind across the file, including removed-only lines.
  const delta = [0, 0, 0, 0, 0, 0];
  for (const row of rows) {
    if (row.kind === ' ' || allowedAddition(row.text, ops)) continue;
    bracketCounts(row.text).forEach((count, i) => { delta[i] += row.kind === '+' ? count : -count; });
  }
  if (delta.some(count => count !== 0)) throw new Error('unprovable bracket delta: human review required');
  return ops;
}

/** Inputs are evidence from the caller; unavailable or malformed evidence preserves human review. */
export function proposeHumanRequired({ humanRequired, otherHumanForced, hits, files, hunksOf,
  readOnlyOps, protectionPaths = PROTECTION_PATHS } = {}) {
  if (humanRequired === false) return { proposed: false, reason: 'not human-required today' };
  if (otherHumanForced) return yes('other human-forced trigger');
  try {
    if (humanRequired !== true || !Array.isArray(files) || !files.length
      || files.some(f => typeof f !== 'string' || !f)) throw new Error('incomplete changed files');
    for (const file of files) if (CLASSIFIERS.has(file)) return yes(`classifier self-change: ${file}`);
    if (!(readOnlyOps instanceof Set) || !readOnlyOps.size) return yes('empty readOnlyOps');
    if (!Array.isArray(protectionPaths) || protectionPaths.some(re => !(re instanceof RegExp))) throw new Error('invalid protectionPaths');
    const hunks = new Map(files.map(file => [file, hunksOf(file)]));
    let total = 0;
    for (const text of hunks.values()) {
      if (typeof text !== 'string') throw new Error('null hunks');
      total += text.length;
      if (total > 200000) throw new Error('oversized diff: human review required');
    }
    const sections = new Map([...hunks].map(([file, text]) => [file, parse(text)]));
    const added = sections.has(SURFACE) ? tightening(sections.get(SURFACE)) : [];
    if (!Array.isArray(hits) || !hits.length) throw new Error('no sensitive hit evidence');
    const ops = new Set();
    // Non-sensitive changed files never forced human review today; normal review and red-team cover them, so judge only the files that triggered the hold.
    for (const hit of hits) {
      if (!hit || !sections.has(hit.file)) throw new Error('hit missing changed-file evidence');
      if (hit.file === SURFACE && hit.kind === 'human-surface-setting') continue;
      if (hit.category === 'protection' && hit.file !== SURFACE) {
        // Clone regexes so global/sticky caller regexes cannot mutate inputs or depend on lastIndex.
        const matches = re => new RegExp(re.source, re.flags).test(hit.file.toLowerCase());
        if (protectionPaths.some(matches)) throw new Error('edits existing protected path');
        if (!added.some(matches)) throw new Error('protection not newly added');
      } else if (hit.category === 'permission' && hit.kind === 'sandbox-widening' && ALLOW_LISTS.has(hit.file)) {
        for (const op of readOnlyAddition(sections.get(hit.file), readOnlyOps, hunks.get(hit.file))) ops.add(op);
      } else throw new Error(`human surface: ${hit.kind ?? hit.category}`);
    }
    return { proposed: false, reason: ops.size ? `adds only read-only ops: ${[...ops].join(', ')}` : 'adds protected paths only' };
  } catch (error) { return yes(error instanceof Error ? error.message : 'unprovable evidence'); }
}
