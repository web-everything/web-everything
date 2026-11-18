#!/usr/bin/env node
/** Whole-session attribution, not a claim of per-PR billing or work allocation. */
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { entries, blocks } from './agent-usage-report.mjs';
import { PROJECTS_DIR, flattenToolResultText, stripControlSequences } from '../../skills-src/inspect-agent-health/agent-health.mjs';
import { codexUsageLedgerPath, usageRepoSlug } from '../lib/codex-usage-ledger.mjs';
import { runGhSync } from '../lib/gh-throttle.mjs';

// Lane clones and the primary checkout of this repository share one PR namespace.
const POOL_CWD = /\/workspace\/(?:\.lanes\/web-everything\/lane-\d+|webeverything)(?:\/|$)/;
const POOL_DIR = /-workspace-(?:\.lanes-web-everything-lane-\d+|-lanes-web-everything-lane-\d+|webeverything)(?:-|$)/;
const claudeZero = () => ({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0, total: 0 });
const codexZero = () => ({ input: 0, cached: 0, output: 0, reasoning: 0 });
function add(target, source, preserveUnknown = false) {
  let incomplete = false;
  for (const key of Object.keys(target)) if (key !== 'total') {
    const value = source?.[key];
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid token count: ${key}`);
    if (value == null) incomplete = true;
    target[key] = preserveUnknown && (value == null || target[key] === null) ? null : target[key] + (value ?? 0);
  }
  if ('total' in target) target.total = target.input + target.cacheCreation + target.cacheRead + target.output;
  return incomplete;
}
// A slug must occupy a complete component; "fix" must not match "prefix".
const branchMatches = (head, branch) => Boolean(branch) && new RegExp(`(?:^|[/._-])${branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[/._-])`).test(head);

export function attributeSessions({ sessions, prs, codexRows = [], repository }) {
  const perPr = prs.map(pr => ({ pr: pr.number, branch: pr.headRefName, sessions: 0, claude: claudeZero(), codex: null, agy: null }));
  const byNumber = new Map(perPr.map(row => [row.pr, row]));
  const unattributed = [], claude = claudeZero();
  const repoSlug = usageRepoSlug(repository ? `https://${repository}` : null);
  let codexUnattributedRows = 0, incompleteUsageMessages = 0;
  for (const session of sessions) {
    add(claude, session.tokens);
    incompleteUsageMessages += session.incompleteUsageMessages ?? 0;
    // Legacy pure-core inputs are already scoped. Disk readers always attach namespaces,
    // including null for unknown scope, which must never match a repository-local identifier.
    const local = (namespaces, i) => namespaces === undefined || Boolean(repository && namespaces[i] === repository);
    const primary = session.prs.map((number, i) => local(session.prRepositories, i) && byNumber.get(number)).find(Boolean)
      ?? session.branches.map((branch, i) => local(session.branchRepositories, i) && perPr.find(row => branchMatches(row.branch, branch))).find(Boolean);
    if (primary) { primary.sessions++; add(primary.claude, session.tokens); }
    else unattributed.push({ sessionId: session.sessionId, tokens: { ...session.tokens } });
  }
  for (const row of codexRows) {
    const target = byNumber.get(Number(row.pr));
    if (!target || !repoSlug || usageRepoSlug(row.repo)?.toLowerCase() !== repoSlug.toLowerCase()) { codexUnattributedRows++; continue; }
    target.codex ??= codexZero();
    add(target.codex, row.tokens, true);
  }
  return { perPr, unattributed, totals: { claude, mergedPrs: prs.length, codexUnattributedRows, incompleteUsageMessages,
    claudeTotalPerMergedPr: prs.length ? claude.total / prs.length : null }, note: 'agy tokens: no source' };
}

/** Evidence comes only from assistant prose and tool results, never prompts/tool inputs. */
function evidence(entry) {
  const content = entry.message?.content;
  if (entry.type === 'assistant' && typeof content === 'string') return [content];
  return blocks(entry).flatMap(block => {
    if (block.type === 'tool_result') return [flattenToolResultText(block.content)];
    return entry.type === 'assistant' && block.type === 'text' ? [block.text] : [];
  }).filter(text => typeof text === 'string');
}

function prRepository(value) {
  try {
    const url = new URL(value), path = /^\/([^/]+\/[^/]+)\/pull\/\d+\b/.exec(url.pathname);
    return /^https?:$/.test(url.protocol) && path ? `${url.host}/${path[1]}`.toLowerCase() : null;
  } catch { return null; }
}

export async function readSession(file, { repository = null, projectRepository = null, cwd = process.cwd() } = {}) {
  const session = { sessionId: basename(file, '.jsonl'), tokens: claudeZero(), prs: [], branches: [], prRepositories: [], branchRepositories: [] };
  const messages = new Map(), diagnostics = { corrupt: 0 };
  let anonymous = 0;
  for await (const { entry } of entries(file, diagnostics)) {
    const localCwd = typeof entry.cwd === 'string' && (resolve(entry.cwd) === cwd || resolve(entry.cwd).startsWith(`${cwd}${sep}`) || POOL_CWD.test(resolve(entry.cwd)));
    const scope = entry.cwd ? (localCwd ? repository : null) : projectRepository;
    if (entry.type === 'assistant' && entry.message?.usage) {
      messages.set(entry.message.id ?? Symbol(anonymous++), entry.message.usage);
    }
    for (const text of evidence(entry)) for (const line of text.split(/\r?\n/)) {
      const urls = [...line.matchAll(/https?:\/\/[^\s<>"']+\/pull\/\d+\b/gi)];
      const lineRepositories = new Set(urls.map(match => prRepository(match[0])));
      const lineScope = urls.length ? (lineRepositories.size === 1 ? [...lineRepositories][0] : null) : scope;
      if (/\b(?:created|opened|merged|pr-land)\b/i.test(line)) {
        for (const match of line.matchAll(/https?:\/\/[^\s<>"']+\/pull\/(\d+)\b|\bPR\s+#(\d+)\b/gi)) {
          session.prs.push(Number(match[1] ?? match[2]));
          session.prRepositories.push(match[1] ? prRepository(match[0]) : lineScope);
        }
      }
      for (const match of line.matchAll(/refs\/heads\/([\w./-]+)|\bgit\s+push\s+(?:--?\w[\w-]*\s+)*[^\s]+\s+([\w./-]+(?::[\w./-]+)?)/g)) {
        session.branches.push((match[1] ?? match[2]).split(':').at(-1));
        session.branchRepositories.push(lineScope);
      }
    }
  }
  if (diagnostics.corrupt) throw new Error(`Incomplete transcript ${file}: ${diagnostics.corrupt} malformed rows; repair the file and retry`);
  session.incompleteUsageMessages = 0;
  for (const usage of messages.values()) if (add(session.tokens, {
    input: usage.input_tokens, cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens, output: usage.output_tokens,
  })) session.incompleteUsageMessages++;
  // The public session shape carries the four source counters; total is derived by attribution.
  delete session.tokens.total;
  return session;
}

export async function readSessions({ projectsDir = PROJECTS_DIR, since, now, repository, cwd = process.cwd() }) {
  const sessions = [];
  cwd = resolve(cwd);
  async function walk(dir, projectRepository) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, projectRepository);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const mtime = statSync(file).mtimeMs;
        if (mtime >= since && mtime <= now) sessions.push(await readSession(file, { repository, projectRepository, cwd }));
      }
    }
  }
  // Missing/unreadable project stores are errors, rather than a misleading zero-token report.
  for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) await walk(join(projectsDir, entry.name), entry.name === cwd.replaceAll(sep, '-') || POOL_DIR.test(entry.name) ? repository : null);
  }
  return sessions;
}

export function listMergedPrs({ since = 0 } = {}) {
  const limit = 2000;
  const prs = JSON.parse(runGhSync(['pr', 'list', '--state', 'merged', '--limit', String(limit), '--json', 'number,headRefName,mergedAt,url'], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
  }));
  if (!Array.isArray(prs)) throw new Error('Invalid merged PR response');
  const times = prs.map(pr => Date.parse(pr.mergedAt));
  if (prs.length >= limit && Math.min(...times) >= since) throw new Error('Merged PR window exceeds the gh listing limit; shorten --days');
  return prs.filter((pr, i) => times[i] >= since);
}

export async function readCodexRows({ env = process.env, since, now }) {
  const rows = [], diagnostics = { corrupt: 0 };
  try {
    for await (const { entry } of entries(codexUsageLedgerPath(env), diagnostics)) {
      const at = Date.parse(entry.at);
      if (!Number.isFinite(at)) throw new Error('Codex ledger row has invalid timestamp');
      if (at >= since && at <= now) rows.push(entry);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (diagnostics.corrupt) throw new Error('Incomplete Codex ledger: malformed rows; repair the ledger and retry');
  return rows;
}

export async function readReport({ days = 7, now = Date.now(), projectsDir = PROJECTS_DIR, env = process.env,
  listMergedPrs: list = listMergedPrs, repository, cwd = process.cwd() } = {}) {
  if (!Number.isFinite(days) || days <= 0 || !Number.isFinite(now)) throw new Error('--days must be a positive finite number');
  const since = now - days * 86400000;
  const listed = await list({ since });
  if (!Array.isArray(listed) || listed.some(pr => !Number.isInteger(pr.number) || typeof pr.headRefName !== 'string' || !Number.isFinite(Date.parse(pr.mergedAt)))) {
    throw new Error('Invalid merged PR evidence');
  }
  // A capped, unfiltered listing cannot establish completeness, regardless of merge dates.
  if (listed.length >= 500) {
    throw new Error('Merged PR limit reached; supply a complete window-filtered listMergedPrs reader with fewer than 500 results');
  }
  repository ??= prRepository(listed[0]?.url);
  if (listed.length && (!repository || listed.some(pr => pr.url && prRepository(pr.url) !== repository))) {
    throw new Error('Unknown or mixed PR repository; supply repository identity and a repository-scoped listMergedPrs reader');
  }
  const prs = listed.filter(pr => Date.parse(pr.mergedAt) >= since && Date.parse(pr.mergedAt) <= now);
  const sessions = await readSessions({ projectsDir, since, now, repository, cwd });
  const codexRows = await readCodexRows({ env, since, now });
  return attributeSessions({ sessions, prs, codexRows, repository });
}

export function formatReport(report) {
  return ['PR      Branch                          Sessions  Claude tokens  Codex tokens',
    ...report.perPr.map(row => `${String(row.pr).padEnd(7)} ${stripControlSequences(row.branch).padEnd(31)} ${String(row.sessions).padEnd(9)} ${String(row.claude.total).padEnd(14)} ${row.codex ? `${row.codex.input ?? 'unknown'} in / ${row.codex.cached ?? 'unknown'} cached / ${row.codex.output ?? 'unknown'} out / ${row.codex.reasoning ?? 'unknown'} reasoning` : '—'}`),
    `Claude total: ${report.totals.claude.total}; merged PRs: ${report.totals.mergedPrs}; tokens/merged PR: ${report.totals.claudeTotalPerMergedPr ?? 'n/a'}`,
    `Incomplete Claude usage messages: ${report.totals.incompleteUsageMessages}; unattributed Codex rows: ${report.totals.codexUnattributedRows}`,
    `Unattributed: ${report.unattributed.length} sessions (${report.unattributed.reduce((sum, row) => sum + Object.values(row.tokens).reduce((a, b) => a + b, 0), 0)} tokens)`,
    report.note].join('\n');
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const { values } = parseArgs({ args: argv, options: { days: { type: 'string', default: '7' }, json: { type: 'boolean' }, out: { type: 'string' } } });
  const report = await readReport({ ...options, days: Number(values.days) });
  const json = JSON.stringify(report, null, 2);
  if (values.out) writeFileSync(values.out, `${json}\n`);
  console.log(values.json ? json : formatReport(report));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(stripControlSequences(error.message)); process.exitCode = 1; });
}
