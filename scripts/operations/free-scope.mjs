/**
 * @file scripts/operations/free-scope.mjs
 * @description PURE scope assessment over supplied PR and agent snapshots. Reuses the lease matcher so
 * file/subtree conflicts have the same meaning for operators and workers; partial reads never claim free.
 * No filesystem, clock, process or network access. The declared reader is injected by the IO boundary.
 *
 * WHY (operator handoff rules 21 and 26, 2026-10-05): "free scope" means no overlap with (a) the files of any
 * open PR in web-everything/web-everything or plateauapp/plateau-app AND (b) the declared target files of every
 * agent still running without a PR. Agents declare (b) in the shared registry
 * `~/workspace/.operations/coordination/agent-scopes.json` via `we:scripts/operations/free-scope-cli.mjs register`;
 * an entry past its TTL is ignored and reported, never silently trusted. Skill: `we:skills-src/free-scope/SKILL.md`.
 */
import { op } from './registry.mjs';
import { compute } from './step-kinds.mjs';
import { scopeEntriesOverlap } from '../readiness/scope-lease.mjs';
import { CONSTELLATION_REPOS, repoKeyForSlug } from '../lib/constellation-repos.mjs';

export const FREE_SCOPE_OP = 'free-scope';
/** The repos whose open PRs count — WE and plateau-app, read from the one constellation table. */
export const DEFAULT_REPOS = Object.freeze(['we', 'plateau-app'].map((key) => CONSTELLATION_REPOS[key].slug));
export const DEFAULT_TTL_HOURS = 4;
const alias = (key) => ({ webeverything: 'we', 'web-everything': 'we', plateau: 'plateau-app' })[key] || key;
export function repoKeyFor(slug) {
  return repoKeyForSlug(slug) ?? slug.split('/').at(-1);
}
export function qualifyFile(f, defaultRepo = 'we') {
  const value = f.trim().replace(/^\.\//, '');
  if (!value) return '';
  const colon = value.indexOf(':');
  return colon < 0 ? `${alias(defaultRepo)}:${value}`
    : `${alias(value.slice(0, colon))}:${value.slice(colon + 1).replace(/^\.\//, '')}`;
}
/**
 * Parse `--exclude-pr` into a repo-qualified pair. PR numbers are per-repo, so the bare form `12` means the
 * default repo (WE); `plateau-app#12` or `owner/repo#12` names another. Empty/undefined means "exclude nothing".
 */
export function parseExcludePr(spec) {
  if (spec == null || spec === '') return { repo: DEFAULT_REPOS[0], number: 0 };
  const match = /^(?:([^#]+)#)?(\d+)$/.exec(String(spec).trim());
  if (!match) throw new TypeError('free-scope: --exclude-pr must be <n> or <repo>#<n>');
  const [, name, digits] = match;
  const repo = name === undefined ? DEFAULT_REPOS[0] : name.includes('/') ? name : CONSTELLATION_REPOS[alias(name)]?.slug;
  if (!repo) throw new TypeError(`free-scope: --exclude-pr names an unknown repo "${name}"`);
  return { repo, number: Number(digits) };
}
const qualified = (files) => [...new Set(files.map((f) => qualifyFile(f)).filter(Boolean))];
const expiry = (entry) => Date.parse(entry.startedAt) + (entry.ttlHours ?? DEFAULT_TTL_HOURS) * 3600e3;
export function partitionRegistry(entries, nowMs) {
  const live = [], stale = [];
  for (const entry of entries) (Number.isFinite(expiry(entry)) && expiry(entry) > nowMs ? live : stale).push(entry);
  return { live, stale };
}
export function registerScope(entries, { agent, purpose, files, ttlHours = DEFAULT_TTL_HOURS }, nowIso) {
  if (typeof agent !== 'string' || !agent.trim()) throw new TypeError('free-scope: give --agent=<name>');
  const scope = qualified(files || []);
  if (!scope.length) throw new TypeError('free-scope: give --files=a,b or --card=<id>');
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new TypeError('free-scope: ttlHours must be positive');
  return [...entries.filter((e) => e.agent !== agent), { agent, purpose, files: scope, startedAt: nowIso, ttlHours }];
}
export function releaseScope(entries, agent) {
  const remaining = entries.filter((e) => e.agent !== agent);
  return { entries: remaining, released: entries.length - remaining.length };
}
const holderName = (h) => h.type === 'pr' ? `PR #${h.number} (${h.repo})` : `agent ${h.agent}`;
export function assessFreeScope({ files, prs = [], agents = [], nowMs, excludeAgent = '', excludePr = 0, excludeRepo = DEFAULT_REPOS[0], unreadable = [] }) {
  const scope = qualified(files || []);
  if (!scope.length) throw new TypeError('free-scope: give --files=a,b or --card=<id>');
  const { live, stale } = partitionRegistry(agents.filter((e) => e.agent !== excludeAgent), nowMs);
  const candidates = [];
  for (const pr of prs) {
    if (excludePr > 0 && pr.number === excludePr && pr.repo === excludeRepo) continue;
    for (const path of pr.files) candidates.push({ type: 'pr', repo: pr.repo, number: pr.number,
      title: pr.title, url: pr.url, file: qualifyFile(path, repoKeyFor(pr.repo)) });
  }
  for (const entry of live) for (const file of qualified(entry.files || [])) candidates.push({ type: 'agent',
    agent: entry.agent, purpose: entry.purpose, startedAt: entry.startedAt,
    expiresAt: new Date(expiry(entry)).toISOString(), file });
  // A file is only FREE when the snapshot is complete AND nothing holds it; with an incomplete snapshot an
  // unheld file is `unknown` in every output (row, list and text), never free.
  const rows = scope.map((file) => {
    const holders = candidates.filter((h) => scopeEntriesOverlap(file, h.file));
    const state = holders.length ? 'occupied' : unreadable.length ? 'unknown' : 'free';
    return { file, state, free: state === 'free', holders };
  });
  const filesIn = (state) => rows.filter((r) => r.state === state).map((r) => r.file);
  const freeFiles = filesIn('free'), occupiedFiles = filesIn('occupied'), unknownFiles = filesIn('unknown');
  const status = occupiedFiles.length ? 'occupied' : unreadable.length ? 'unknown' : 'free';
  let headline = status === 'occupied'
    ? `${freeFiles.length} of ${rows.length} files free — ${rows.filter((r) => r.state === 'occupied').map((r) => `${r.file} held by ${r.holders.map(holderName).join(', ')}`).join('; ')}`
    : status === 'unknown' ? `UNKNOWN — could not read open PRs for ${unreadable.map((r) => r.repo).join(', ')}`
      : `all ${rows.length} files free`;
  if (status === 'occupied' && unreadable.length) headline += ` — could not read open PRs for ${unreadable.map((r) => r.repo).join(', ')}`;
  if (stale.length) headline += ` — ${stale.length} stale registry entr${stale.length === 1 ? 'y' : 'ies'} ignored`;
  return { observedAt: new Date(nowMs).toISOString(), status, files: rows, freeFiles, occupiedFiles, unknownFiles,
    staleAgents: stale.map(({ agent, purpose, startedAt, ttlHours = DEFAULT_TTL_HOURS }) => ({ agent, purpose, startedAt, ttlHours })),
    unreadable, headline };
}
/** Render an ISO timestamp in the operator's timezone (America/New_York), e.g. `2026-10-05 14:31 ET`. */
export function etTime(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ET`;
}
export function formatFreeScope(verdict) {
  const lines = [verdict.headline];
  const label = { free: 'FREE      ', occupied: 'OCCUPIED  ', unknown: 'UNKNOWN   ' };
  for (const row of verdict.files) lines.push(`${label[row.state]}${row.file}${row.holders.map((h) =>
    h.type === 'pr' ? `  ← PR #${h.number} "${h.title}" (${h.repo})`
      : `  ← agent ${h.agent} (${h.purpose}, since ${etTime(h.startedAt)})`).join('')}`);
  if (verdict.staleAgents.length) lines.push('stale (ignored):', ...verdict.staleAgents.map((e) => `  ${e.agent} (${e.purpose}, since ${etTime(e.startedAt)}, ttl ${e.ttlHours}h)`));
  return lines.join('\n');
}
export function freeScopeOperation({ collect } = {}) {
  if (typeof collect !== 'function') throw new TypeError('free-scope needs a collect reader');
  return op(FREE_SCOPE_OP, {
    input: { files: { type: 'string', required: false, default: '' }, card: { type: 'string', required: false, default: '' },
      excludeAgent: { type: 'string', required: false, default: '' }, excludePr: { type: 'number', required: false, default: 0 },
      excludeRepo: { type: 'string', required: false, default: DEFAULT_REPOS[0] } },
    verdictFrom: 'assess',
    read: compute({ reads: ['input.files', 'input.card'], fn: ({ input }) => collect({ files: input.files, card: input.card }) }),
    assess: compute({ reads: ['findings.read', 'input.excludeAgent', 'input.excludePr', 'input.excludeRepo'],
      fn: ({ findings, input }) => assessFreeScope({ ...findings.read, excludeAgent: input.excludeAgent,
        excludePr: input.excludePr, excludeRepo: input.excludeRepo }) }),
  });
}
