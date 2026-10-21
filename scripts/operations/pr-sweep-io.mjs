/**
 * @file scripts/operations/pr-sweep-io.mjs
 * @description The injected, READ-ONLY reader behind `pr-sweep.mjs`: open PRs + their full comment threads from `gh`,
 *   the drain daemon's latest skip reasons, and the live review/fix processes from `ps`. Nothing here writes.
 *   A repo or PR that cannot be read lands in `unreadable` (shown by the table) instead of silently vanishing.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSettings } from '../lib/settings-files.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { STALLED_AFTER_MINUTES_DEFAULT } from './pr-sweep.mjs';

export const DEFAULT_REPOS = Object.freeze([CONSTELLATION_REPOS.we.slug, CONSTELLATION_REPOS['plateau-app'].slug]);
export const DRAIN_LOG = join(homedir(), 'workspace', 'plateau-app', '.drain-daemon', 'daemon.log');
export const STALLED_AFTER_ENV = 'WE_PR_SWEEP_STALLED_AFTER_MINUTES';
const LIST_FIELDS = 'number,title,url,isDraft,headRefOid,updatedAt,labels,statusCheckRollup,body,createdAt';
/** Plain `gh` through execFileSync, deliberately NOT the throttled wrapper: that one creates lock dirs and appends call
 *  logs, and this operation must write nothing. */
const ghSync = (_file, args, opts) => execFileSync('gh', args, { maxBuffer: 256 * 1024 * 1024, ...opts });
export const LIST_LIMIT = 1000;
const SKIP_MARKER = 'merge-ai-prs · skip-reasons:';

/** Threshold cascade: `--stalled-after` > env > setting `prSweep.stalledAfterMinutes` > 45. PURE-ish (reads settings). */
export function resolveStalledAfter({ flag, env = process.env, settings = readSettings({}) } = {}) {
  for (const v of [flag, env[STALLED_AFTER_ENV], settings?.prSweep?.stalledAfterMinutes]) {
    const n = Number(v);
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(n) && n > 0) return n;
  }
  return STALLED_AFTER_MINUTES_DEFAULT;
}

/** Latest `merge-ai-prs · skip-reasons` row set from the drain log text: `{rows, error}`. The newest marker line must
 *  parse as an array; anything else is reported as `error` (never read as "no skips"). No marker at all is a clean
 *  empty answer. PURE. */
export function parseDrainSkips(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lines[i].indexOf(SKIP_MARKER);
    if (at < 0) continue;
    let rows;
    try { rows = JSON.parse(lines[i].slice(at + SKIP_MARKER.length).trim()); }
    catch { return { rows: [], error: 'the newest skip-reasons row is not valid JSON (torn write?)' }; }
    if (!Array.isArray(rows)) return { rows: [], error: 'the newest skip-reasons row is not a list' };
    return { rows: rows.filter((r) => Number.isInteger(r?.num)).map((r) => ({
      num: r.num, repo: r.repo ?? null, kind: String(r.kind ?? 'unknown'), reason: String(r.reason ?? '') })), error: null };
  }
  return { rows: [], error: null };
}

/** Review / fix processes that name a PR, from `ps` output. PURE. */
export function parseLiveJobs(psText) {
  const jobs = [];
  for (const line of String(psText ?? '').split('\n')) {
    const script = /\b(review-job|review-extra-seats|fix-run|ci-heal|deliver-item-run|red-team-gate-apply)\b[^\s]*\.mjs/.exec(line);
    const pr = /--pr[= ](\d+)/.exec(line);
    if (!script || !pr) continue;
    const repo = /--repo[= ]([\w.-]+\/[\w.-]+)/.exec(line);
    jobs.push({ kind: script[1], pr: Number(pr[1]), repo: repo?.[1] ?? null, source: 'ps' });
  }
  return jobs;
}

export function tailOf(path, bytes = 4_000_000) {
  if (!existsSync(path)) throw new Error(`${path} does not exist`);
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

const jsonGh = (run, args) => JSON.parse(run('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 }));

/** The reader `run.mjs` binds. Every dependency is injectable for tests. */
export function createPrSweepReader({ run = ghSync, now = () => Date.now(), readText = tailOf,
  ps = () => execFileSync('ps', ['-axo', 'pid,etime,command'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }),
  settings = () => readSettings({}) } = {}) {
  return (input = {}) => {
    const cfg = settings();
    const repos = input.repo ? [String(input.repo)] : (Array.isArray(cfg?.prSweep?.repos) && cfg.prSweep.repos.length ? cfg.prSweep.repos : DEFAULT_REPOS);
    const unreadable = [];
    const prs = [];
    for (const repo of repos) {
      let list;
      try {
        // An explicit --pr is fetched by number, so a PR outside the list cap is never reported as absent.
        list = input.pr !== undefined ? [jsonGh(run, ['pr', 'view', String(input.pr), '-R', repo, '--json', LIST_FIELDS])]
          : jsonGh(run, ['pr', 'list', '-R', repo, '--state', 'open', '--limit', String(LIST_LIMIT), '--json', LIST_FIELDS]);
      } catch (e) { unreadable.push(`${repo}: ${String(e?.message ?? e).split('\n')[0]}`); continue; }
      if (list.length >= LIST_LIMIT) unreadable.push(`${repo}: open PR list hit the ${LIST_LIMIT} cap; some PRs were not swept`);
      for (const p of list) {
        try {
          const paged = (path) => JSON.parse(run('gh', ['api', '--paginate', '--slurp', `${path}?per_page=100`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })).flat();
          const comments = paged(`repos/${repo}/issues/${p.number}/comments`)
            .map((c) => ({ id: c.id, author: { login: c.user?.login ?? '' }, user: c.user, body: c.body ?? '', createdAt: c.created_at }));
          const labelEvents = paged(`repos/${repo}/issues/${p.number}/events`).filter((e) => e.event === 'labeled' && e.label?.name)
            .map((e) => ({ label: e.label.name, at: e.created_at }));
          const view = jsonGh(run, ['pr', 'view', String(p.number), '-R', repo, '--json', 'commits']);
          const commit = (view.commits ?? []).filter((c) => c.oid === p.headRefOid).pop();
          prs.push({ ...p, repo, comments, labelEvents, headCommittedAt: commit?.committedDate ?? null });
        } catch (e) { unreadable.push(`${repo}#${p.number}: ${String(e?.message ?? e).split('\n')[0]}`); }
      }
    }
    let liveJobs = [];
    try { liveJobs = parseLiveJobs(ps()); } catch (e) { unreadable.push(`ps: ${String(e?.message ?? e).split('\n')[0]}`); }
    let drainSkips = [];
    try {
      const parsed = parseDrainSkips(readText(DRAIN_LOG));
      drainSkips = parsed.rows;
      if (parsed.error) unreadable.push(`drain log: ${parsed.error}`);
    } catch (e) { unreadable.push(`drain log: ${String(e?.message ?? e).split('\n')[0]}`); }
    return { now: now(), repos, prs, liveJobs, drainSkips, unreadable,
      stalledAfterMinutes: resolveStalledAfter({ flag: input.stalledAfter, settings: cfg }) };
  };
}
