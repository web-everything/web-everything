/**
 * @file exec-output-guard.mjs — pure captured-output detector and per-file ratchet (#74a).
 * No npm command or package dependency is needed to regenerate the tracked-source baseline:
 * node scripts/lib/exec-output-guard.mjs --write-baseline
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Tokenize while dropping comments, retaining source offsets and opaque quoted text. */
function tokens(content) {
  const result = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\[\s\S]|[^'\\])*'|"(?:\\[\s\S]|[^"\\])*"|`(?:\\[\s\S]|[^`\\])*`|[\w$]+|[^\s]/g;
  for (const match of content.matchAll(re)) {
    const text = match[0];
    if (/^\s|^\/\/|^\/\*/.test(text)) continue;
    result.push({ text, index: match.index });
  }
  return result;
}

/** Split the balanced bracket/call at start into its immediate comma-separated entries. */
function entries(ts, start) {
  const parts = [];
  let depth = 0;
  let from = start + 1;
  for (let i = start; i < ts.length; i++) {
    const t = ts[i].text;
    if (['(', '[', '{'].includes(t)) depth++;
    if ([')', ']', '}'].includes(t)) depth--;
    if (depth === 0) {
      parts.push(ts.slice(from, i));
      return { parts, end: i };
    }
    if (depth === 1 && t === ',') { parts.push(ts.slice(from, i)); from = i + 1; }
  }
  return { parts: [], end: start };
}

const literal = (t) => t && /^(['"`])[\s\S]*\1$/.test(t) ? t.slice(1, -1) : null;
const uncaptured = (t) => ['inherit', 'ignore'].includes(literal(t));

/** Inspect only direct options properties, not argv strings or nested objects. */
function bounded(options) {
  if (options?.[0]?.text !== '{') return false;
  return entries(options, 0).parts.some((property) => {
    const key = literal(property[0]?.text) ?? property[0]?.text;
    if (key === 'maxBuffer') return true;
    if (key !== 'stdio' || property[1]?.text !== ':') return false;
    if (property.length === 3 && uncaptured(property[2]?.text)) return true;
    if (property[2]?.text !== '[') return false;
    const stdout = entries(property, 2).parts[1];
    return stdout?.length === 1 && uncaptured(stdout[0].text);
  });
}

/** @returns {{line: number, call: string}[]} Captured gh/git calls lacking an explicit maxBuffer. */
export function findUnboundedExecReads(content) {
  const ts = tokens(content);
  const findings = [];
  for (let i = 0; i < ts.length; i++) {
    const name = ts[i].text;
    if (!['execFileSync', 'spawnSync', 'execSync'].includes(name) || ts[i + 1]?.text !== '(') continue;
    const { parts, end } = entries(ts, i + 1);
    const first = parts[0];
    if (first?.length !== 1) continue;
    const command = literal(first[0].text);
    if (command == null || !(name === 'execSync' ? /^(gh|git)\s/.test(command) : /^(gh|git)$/.test(command))) continue;
    if (bounded(parts[name === 'execSync' ? 1 : 2])) continue;
    findings.push({ line: content.slice(0, ts[i].index).split('\n').length,
      call: content.slice(ts[i].index, ts[end].index + 1) });
  }
  return findings;
}

/** Count default executor seams separately: warning only, outside the capturing-call ratchet. */
export function countDefaultSeamParams(content) {
  const ts = tokens(content);
  const defaults = new Set();
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].text !== '(') continue;
    const { end } = entries(ts, i);
    const after = ts[end + 1]?.text;
    if (after !== '{' && !(after === '=' && ts[end + 2]?.text === '>')) continue;
    for (let j = i + 1; j < end; j++) {
      if (ts[j].text === '=' && ts[j + 1]?.text === 'execFileSync'
        && [',', ')', '}'].includes(ts[j + 2]?.text)) defaults.add(j);
    }
  }
  return defaults.size;
}

/** Compare per-file counts; a new file has no allowance and removed files are improvements. */
export function checkBaseline(counts, baseline) {
  const regressions = [];
  const improvements = [];
  for (const file of [...new Set([...Object.keys(counts), ...Object.keys(baseline)])].sort()) {
    const count = counts[file] ?? 0;
    const allowed = baseline[file] ?? 0;
    if (count > allowed) regressions.push({ file, count, allowed });
    if (count < allowed) improvements.push({ file, count, allowed });
  }
  return { regressions, improvements };
}

/** Shared generator/test source boundary. */
export function isExecReadSource(file) {
  return /^(scripts|skills-src)\//.test(file) && /\.(mjs|js)$/.test(file)
    && !/(?:^|\/)(?:__tests__|__fixtures__|node_modules)(?:\/|$)|\.test\./.test(file)
    && !/^scripts\/lib\/(?:proc-read|exec-output-guard)\.mjs$/.test(file);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).join(' ') !== '--write-baseline') throw new Error('Usage: node scripts/lib/exec-output-guard.mjs --write-baseline');
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { readGit } = await import('./proc-read.mjs');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = readGit(['ls-files', '-z', 'scripts', 'skills-src'], { cwd: root }).split('\0').filter(isExecReadSource).sort();
  const counts = {};
  let seams = 0;
  for (const file of files) {
    const content = readFileSync(resolve(root, file), 'utf8');
    const count = findUnboundedExecReads(content).length;
    if (count) counts[file] = count;
    seams += countDefaultSeamParams(content);
  }
  writeFileSync(resolve(root, 'scripts/exec-output-baseline.json'), `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`${Object.values(counts).reduce((a, b) => a + b, 0)} capturing sites in ${Object.keys(counts).length} files; ${seams} default executor seams`);
  console.log('Largest:', Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5));
}
