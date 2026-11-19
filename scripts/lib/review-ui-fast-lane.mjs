import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cascadePolicy, formatCascadeSourcesLine, platformPreference } from './policy-cascade.mjs';
import { REVIEW_SETTINGS_FILE } from './review-seat-settings.mjs';

const defaults = () => ({ enabled: false, seats: 1, redTeam: false, nitpicksBlock: false, maxFiles: 60, paths: {} });
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validBlock = v => object(v) && Object.entries(v).every(([k, x]) => {
  if (['enabled', 'redTeam', 'nitpicksBlock'].includes(k)) return typeof x === 'boolean';
  if (k === 'seats') return x === 1;
  if (k === 'maxFiles') return Number.isSafeInteger(x) && x > 0;
  if (k === 'paths') return object(x) && Object.values(x).every(a => Array.isArray(a) && a.every(g => typeof g === 'string'));
  return false;
});

export function resolveUiFastLaneSettings({ env = process.env, platform, file = REVIEW_SETTINGS_FILE,
  readFile = p => readFileSync(p, 'utf8'), log = m => console.error(m) } = {}) {
  let tool, invalid = false, envValues = {};
  try { const data = JSON.parse(readFile(file)); tool = data.uiFastLane === undefined ? {} : data.uiFastLane; } catch { invalid = true; }
  const plat = platform ?? platformPreference('review', { env })?.uiFastLane ?? {};
  try {
    if (env.WE_REVIEW_UI_FAST_LANE !== undefined) envValues = JSON.parse(env.WE_REVIEW_UI_FAST_LANE);
    for (const [key, suffix] of Object.entries({ enabled: 'ENABLED', seats: 'SEATS', redTeam: 'RED_TEAM', nitpicksBlock: 'NITPICKS_BLOCK', maxFiles: 'MAX_FILES', paths: 'PATHS' })) {
      if (env[`WE_REVIEW_UI_FAST_LANE_${suffix}`] !== undefined) envValues[key] = JSON.parse(env[`WE_REVIEW_UI_FAST_LANE_${suffix}`]);
    }
  } catch { invalid = true; }
  invalid ||= !validBlock(tool) || !validBlock(plat) || !validBlock(envValues);
  const result = cascadePolicy('review.uiFastLane', invalid ? defaults() : tool, {
    standard: defaults(), platform: invalid ? {} : plat, env, envValues: invalid ? {} : envValues,
  });
  // Invalid blocks must never inherit another layer's UI paths.
  if (invalid) { result.value = defaults(); result.invalid.push('disabled-or-invalid-settings'); }
  result.value.paths ??= {};
  log(formatCascadeSourcesLine('review.uiFastLane', result));
  return result;
}

const refuse = (reason, detail) => ({ verdict: 'full-panel', reason, ...(detail === undefined ? {} : { detail }) });
function cleanPath(path) {
  if (typeof path !== 'string') return null;
  const p = path.normalize('NFKC');
  return !p || /[\\\0]/.test(p) || p.startsWith('/') || /^[a-z]:/i.test(p) || p.split('/').some(s => !s || s === '..') ? null : p;
}
function floor(path) {
  const p = path.toLowerCase();
  if (p.split('/').some(s => s.startsWith('.'))) return 'dot-segment';
  if (p.split('/').some(s => /^package.*\.json$/.test(s))) return 'package-json';
  if (p.split('/').some(s => /^(yarn\.lock|pnpm-lock\.yaml|bun\.lockb|npm-shrinkwrap\.json)$/.test(s))) return 'lockfile';
  if (p.includes('config')) return 'config';
  if (/^(scripts|tools|functions|packages)\//.test(p)) return 'root-tooling';
  if (/^src\/(wip|_data)\//.test(p)) return 'protected-source';
  return /\.(mjs|cjs|sh|yml|yaml)$/.test(p) ? 'executable-extension' : null;
}
function matches(path, globs) {
  return globs.some(g => {
    const pattern = g.split(/(\*\*|\*)/).map(s => s === '**' ? '.*' : s === '*' ? '[^/]*' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
    return new RegExp(`^${pattern}$`).test(path);
  });
}
const tokens = [ ['node', /node:/], ['child-process', /child_process/], ['fs', /\bfs\b/],
  ['process-env', /process\s*\.\s*env/], ['eval', /\beval\s*\(/], ['new-function', /\bnew\s+Function\b/],
  ['inner-html', /innerHTML/], ['outer-html', /outerHTML/], ['insert-adjacent-html', /insertAdjacentHTML/], ['document-write', /document\s*\.\s*write/] ];

export function classifyUiFastLane({ repo, entries, addedLines = {}, importers = {}, settings }) {
  if (!Array.isArray(entries) || !entries.length) return refuse('empty-diff');
  if (!Number.isSafeInteger(settings?.maxFiles) || entries.length > settings.maxFiles) return refuse('too-many-files');
  const globs = settings?.paths?.[repo];
  if (!Array.isArray(globs) || !globs.length || !globs.every(g => typeof g === 'string')) return refuse('repo-not-listed');
  for (const e of entries) {
    const modes = [e.oldMode ?? (e.status === 'A' ? '000000' : e.mode), e.newMode ?? (e.status === 'D' ? '000000' : e.mode)];
    if (modes.some(m => m !== '000000' && m !== '100644') || modes.every(m => m === '000000')) return refuse('bad-mode', { rule: 'regular-file-only', path: e.path });
  }
  const paths = entries.flatMap(e => [e.path, ...(e.oldPath ? [e.oldPath] : [])]);
  for (const p of paths) if (!cleanPath(p) || floor(cleanPath(p))) return refuse('hard-floor', { rule: cleanPath(p) ? floor(cleanPath(p)) : 'invalid-path', path: p });
  for (const p of paths) if (!matches(cleanPath(p), globs)) return refuse('not-in-allowlist', { rule: 'repo-allowlist', path: p });
  for (const p of paths) {
    const lines = addedLines instanceof Map ? addedLines.get(p) : addedLines[p];
    for (const line of lines ?? []) {
      for (const [rule, re] of tokens) if (re.test(line)) return refuse('tripwire', rule);
      const imports = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["']([^"']+)["']/g;
      for (const hit of line.matchAll(imports)) {
        const spec = hit[1];
        if (spec.startsWith('.') || spec.startsWith('/') || spec.includes('\\')) {
          const target = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(p), spec)) : spec;
          if (!cleanPath(target) || floor(target) || !matches(target, globs)) return refuse('tripwire', 'import-outside-ui');
        }
      }
      if (/\b(?:import|require)\s*\(/.test(line) && !/\b(?:import|require)\s*\(\s*["'][^"']+["']\s*\)/.test(line)) return refuse('tripwire', 'unknown-import');
    }
  }
  for (const p of paths) if ((importers instanceof Map ? importers.get(p) : importers[p])?.length) return refuse('reverse-import', { rule: 'non-ui-importer', path: p });
  return { verdict: 'ui-fast-lane', reason: 'ui-only' };
}

export function parseRawDiffZ(buf) {
  const parts = String(buf).split('\0'), entries = [];
  if (parts.pop() !== '') throw new Error('incomplete raw diff');
  for (let i = 0; i < parts.length; i += 2) {
    const hit = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ ([AMDT])$/.exec(parts[i]);
    if (!hit || !parts[i + 1]) throw new Error('invalid raw diff');
    entries.push({ status: hit[3], oldMode: hit[1], newMode: hit[2], mode: hit[2] === '000000' ? hit[1] : hit[2], path: parts[i + 1] });
  }
  return entries;
}

export function addedLinesFromPatch(patchText) {
  const result = Object.create(null);
  let path, inHunk = false;
  for (const line of String(patchText).split('\n')) {
    if (line.startsWith('diff --git ')) { path = null; inHunk = false; }
    if (!inHunk && line.startsWith('+++ ')) {
      let name = line.slice(4);
      if (name.startsWith('"')) name = JSON.parse(name);
      path = name.startsWith('b/') ? name.slice(2) : null;
      if (path) result[path] = [];
    } else if (line.startsWith('@@ ')) inHunk = true;
    else if (path && inHunk && line.startsWith('+')) result[path].push(line.slice(1));
  }
  return result;
}

export function gatherUiFastLaneEvidence({ cwd, base, head, repo, settings, expectedBase, expectedHead, run = (args, opts) => execFileSync('git', args, opts) }) {
  const opts = { cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
  let stage = 'fetch-failed';
  try {
    const read = args => {
      const out = run(args, opts);
      if (out && typeof out === 'object' && !Buffer.isBuffer(out)) {
        if (out.error || (out.status ?? out.code ?? 0) !== 0) throw Object.assign(new Error('git failed'), { status: out.status ?? out.code });
        return String(out.stdout ?? '');
      }
      return String(out ?? '');
    };
    read(['fetch', '--no-tags', 'origin', base]);
    const baseOid = read(['rev-parse', '--verify', 'FETCH_HEAD']).trim();
    read(['fetch', '--no-tags', 'origin', head]);
    const headOid = read(['rev-parse', '--verify', 'FETCH_HEAD']).trim();
    if (![baseOid, headOid].every(s => /^[a-f0-9]{40,64}$/.test(s))) throw new Error('missing fetched oid');
    if ((expectedBase && expectedBase !== baseOid) || (expectedHead && expectedHead !== headOid)) return { ok: false, reason: 'ref-mismatch' };
    stage = 'merge-base-failed';
    const mergeBase = read(['merge-base', baseOid, headOid]).trim();
    if (!/^[a-f0-9]{40,64}$/.test(mergeBase)) throw new Error('missing merge base');
    stage = 'diff-failed';
    const entries = parseRawDiffZ(read(['diff', '--raw', '-z', '--no-renames', mergeBase, headOid]));
    const patch = read(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '-U0', mergeBase, headOid]);
    if (/^Binary files .* differ$/m.test(patch)) return { ok: false, reason: 'diff-failed' };
    const addedLines = addedLinesFromPatch(patch);
    if (entries.some(e => e.status !== 'D' && !Object.hasOwn(addedLines, e.path))) return { ok: false, reason: 'diff-failed' };
    stage = 'reverse-import-failed';
    const importers = Object.create(null), globs = settings?.paths?.[repo] ?? [];
    for (const { path } of entries) {
      const name = posix.basename(path, posix.extname(path)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let output;
      try { output = read(['grep', '-zlE', '-e', `(import|from|require).*['"][^'"]*${name}([./'"]|$)`, headOid, '--']); }
      catch (e) { if (e.status === 1) output = ''; else throw e; }
      importers[path] = output.split('\0').filter(Boolean).map(p => p.replace(`${headOid}:`, '')).filter(p => !cleanPath(p) || floor(cleanPath(p)) || !matches(cleanPath(p), globs));
    }
    return { ok: true, repo, entries, addedLines, importers };
  } catch { return { ok: false, reason: stage }; }
}

export function classifyFromGit(options) {
  const evidence = gatherUiFastLaneEvidence(options);
  return evidence.ok ? classifyUiFastLane({ ...evidence, settings: options.settings }) : refuse(evidence.reason);
}
