#!/usr/bin/env node
/** Read-only D-R379 eligibility decision. All evidence readers are injected. */
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import yaml from 'js-yaml';
import { findAudit, QUESTION_HASH } from './codex-audit.mjs';
import { globToRegExp } from '../lib/standards-sections.mjs';

const SHA = /^[a-f\d]{40}$/i;
const MAX_PATHS = 10_000;
const MAX_AUDITS = 100_000;
const USAGE = 'usage: node scripts/operations/d-r379-check.mjs --pr=N [--json]\n';
const DIRECTION = /\bD-R\d+\b|\bR\d{2,4}\b|#\d+\b|\b(?:card|story|item|focus(?:\s+item)?)\s*#?\d+\b/i;
const RULING = /\b(?:D-)?R\d+\b/i;
const clean = value => stripVTControlCharacters(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, ' ');
const result = (id, name, status, evidence) => ({ id, name, status, evidence });
const unknown = (id, name, detail) => result(id, name, 'UNKNOWN', [`${detail}; request human review of the full diff or repair evidence and retry`]);
const validPr = pr => Number.isSafeInteger(pr) && pr > 0;
const validPath = path => typeof path === 'string' && path.length > 0 && path.length <= 4096
  && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0')
  && !path.split('/').some(part => !part || part === '.' || part === '..');

/** Shared anchored matcher: ** crosses directories, * and ? stay within a segment. */
export function matchesGlob(path, glob) {
  return typeof path === 'string' && typeof glob === 'string' && globToRegExp(glob).test(path);
}

function validateSettings(settings) {
  for (const key of ['directionPaths', 'protectedPaths']) {
    const patterns = settings?.[key];
    if (!Array.isArray(patterns) || !patterns.length || patterns.length > 1000
      || patterns.some(p => typeof p !== 'string' || !p.trim() || p.length > 4096)) {
      throw new Error('incomplete path policy');
    }
  }
  return settings;
}

function labelNames(labels) {
  if (!Array.isArray(labels) || labels.length > 1000) throw new Error('invalid labels');
  return labels.map(label => {
    const name = typeof label === 'string' ? label : label?.name;
    if (typeof name !== 'string' || !name.trim()) throw new Error('invalid label');
    return name;
  });
}

/** findAudit owns canonical validation. Across bases, latest time / append order still wins. */
function latestAudit(records, head) {
  if (!Array.isArray(records) || records.length > MAX_AUDITS) throw new Error('invalid or oversized audit ledger');
  const byBase = new Map();
  for (const record of records) {
    if (record?.head !== head) continue;
    if (!byBase.has(record.base)) byBase.set(record.base, []);
    byBase.get(record.base).push(record);
  }
  const candidates = new Set([...byBase].map(([base, group]) =>
    findAudit(group, { head, base, questionHash: QUESTION_HASH })).filter(Boolean));
  let latest = null;
  for (const record of records) {
    if (candidates.has(record) && (!latest || Date.parse(record.at) >= Date.parse(latest.at))) latest = record;
  }
  return latest;
}

async function reviewed(pr, head, deps) {
  const name = 'Reviewed';
  let labels, audit;
  try { labels = labelNames(await deps.readLabels(pr, head)); }
  catch { return unknown(2, name, 'labels unavailable'); }
  const blocked = labels.filter(l => ['review:changes', 'red-team:held', 'red-team:pending'].includes(l));
  const missing = ['review:accepted', 'red-team:clear'].filter(l => !labels.includes(l));
  if (blocked.length || missing.length) return result(2, name, 'FAIL', [
    ...blocked.map(l => `blocking label: ${l}`), ...missing.map(l => `missing label: ${l}`),
  ]);
  try { audit = latestAudit(await deps.readAudits(), head); }
  catch { return unknown(2, name, 'audits unavailable or oversized'); }
  if (!audit) return result(2, name, 'FAIL', ['no audit for head']);
  if (audit.verdict !== 'NOT WEAKENED') return result(2, name, 'FAIL', [`latest audit: ${audit.verdict}`]);
  // readPrFacts gathers agents, comments, checks and constellation state as well as the ledger.
  // It is not a cheap ledger-only read; this standalone command intentionally uses labels + audit.
  return result(2, name, 'PASS', ['review:accepted', 'red-team:clear',
    `canonical audit NOT WEAKENED for head ${head}, base ${audit.base}, at ${audit.at}`,
    'labels only for review verdict; ledger unavailable (shared reader requires broad live probes)']);
}

function isRulingPath(path) {
  return /rulings?/i.test(path.split('/').at(-1));
}

/** Parse actual YAML, including quoted scalars; malformed/missing frontmatter is unknown. */
function decisionState(text) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('missing or oversized card');
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('missing frontmatter');
  const data = yaml.safeLoad(match[1]);
  if (!data || typeof (data.kind ?? data.type) !== 'string' || typeof data.status !== 'string') throw new Error('incomplete frontmatter');
  return (data.kind ?? data.type) === 'decision' && !['resolved', 'ratified'].includes(data.status);
}

async function directionPaths(paths, settings, metadata, head, deps) {
  const matches = [], unreadable = [];
  for (const path of paths) {
    if (isRulingPath(path) || settings.directionPaths.some(glob => matchesGlob(path, glob))) matches.push(path);
    if (/^backlog\/[^/]+\.md$/.test(path)) {
      try {
        if (decisionState(await deps.readHeadFile(head, path))) matches.push(path);
      } catch { unreadable.push(path); }
    }
  }
  const hits = [...new Set(matches)];
  const recording = hits.length && hits.every(path => isRulingPath(path)
    && !settings.directionPaths.some(glob => matchesGlob(path, glob))) && RULING.test(`${metadata.title}\n${metadata.body}`)
    && /(?:^\s*>|\bverbatim\b)/im.test(metadata.body);
  if (hits.length && !recording) return result(3, 'Sets no direction', 'FAIL', hits.map(path => `direction path: ${path}`));
  if (unreadable.length) return unknown(3, 'Sets no direction', `unreadable decision evidence: ${unreadable.join(', ')}`);
  return result(3, 'Sets no direction', 'PASS', recording ? ['R391 ruling-record', ...hits] : ['no direction paths or unratified decision cards']);
}

function protectedPaths(paths, settings) {
  const hits = paths.filter(path => settings.protectedPaths.some(glob => matchesGlob(path, glob)));
  return result(4, 'Not guard-loosening / hard to undo', hits.length ? 'FAIL' : 'PASS',
    hits.length ? hits.map(path => `protected path: ${path}`) : ['no protected paths']);
}

/** Return all five conditions; seats are informational and never authorize approval. */
export async function checkPr(pr, deps) {
  if (!validPr(pr)) throw new Error('invalid PR number');
  const metadata = await deps.readPr(pr);
  if (!SHA.test(metadata?.headRefOid ?? '') || typeof metadata.title !== 'string' || typeof metadata.body !== 'string') {
    throw new Error('incomplete PR metadata');
  }
  const head = metadata.headRefOid;
  const citation = DIRECTION.exec(`${metadata.title}\n${metadata.body}`)?.[0];
  const conditions = [result(1, 'Direction source', citation ? 'PASS' : 'FAIL', [citation ?? 'no direction citation'])];
  conditions.push(await reviewed(pr, head, deps));
  let settings, netDiffPaths = [], failure;
  try { settings = validateSettings(await deps.readSettings()); }
  catch { failure = 'path policy unavailable or incomplete'; }
  try {
    const paths = await deps.fetchNetDiff(pr, head);
    if (!Array.isArray(paths) || paths.length > MAX_PATHS || paths.some(p => !validPath(p))) {
      throw new Error('invalid or oversized net diff');
    }
    netDiffPaths = [...new Set(paths)];
    if (!netDiffPaths.length) failure = 'empty net diff: cannot judge';
  } catch { failure = 'net diff unavailable, invalid or exceeds 10000 paths'; }
  if (failure) {
    conditions.push(unknown(3, 'Sets no direction', failure), unknown(4, 'Not guard-loosening / hard to undo', failure));
  } else {
    conditions.push(await directionPaths(netDiffPaths, settings, metadata, head, deps), protectedPaths(netDiffPaths, settings));
  }
  const seats = { sat: null, earned: null };
  conditions.push(result(5, 'Seats sat vs earned', 'UNKNOWN', ['not determinable: labels and canonical audit do not establish seats sat or earned']));
  return { pr, head, eligible: conditions.slice(0, 4).every(c => c.status === 'PASS'), conditions, netDiffPaths, seats };
}

function parseArgs(argv) {
  let pr, json = false;
  for (const arg of argv) {
    if (arg === '--json' && !json) { json = true; continue; }
    if (/^--pr=[1-9]\d*$/.test(arg) && pr === undefined) { pr = Number(arg.slice(5)); continue; }
    return null;
  }
  return validPr(pr) ? { pr, json } : null;
}

export async function main(argv, deps) {
  const stderr = text => (deps?.stderr ?? (s => process.stderr.write(s)))(text);
  const flags = parseArgs(argv);
  if (!flags) { stderr(USAGE); return 2; }
  try {
    deps ??= (await import('./d-r379-check-io.mjs')).createCheckDeps();
    const checked = await checkPr(flags.pr, deps);
    const human = [`PR #${checked.pr} @ ${checked.head}: ${checked.eligible ? 'eligible' : 'not eligible'}`,
      ...checked.conditions.map(c => `${c.id}. ${c.name}: ${c.status}\n   ${c.evidence.map(clean).join('; ')}`)].join('\n');
    deps.stdout(flags.json ? `${JSON.stringify(checked)}\n` : `${human}\n`);
    return checked.eligible ? 0 : 1;
  } catch {
    stderr('D-R379 check failed: incomplete evidence; request human review of the full diff or repair evidence and retry.\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
