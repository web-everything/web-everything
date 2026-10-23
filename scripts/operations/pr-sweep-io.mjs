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
import { annotateLapsedStandDowns, STAND_DOWN_MARKER } from '../conveyor/stand-down.mjs';
import { readFixLoopRows, fixLoopConfig, fixLoopRedMainLapse } from '../conveyor/fix-loop-ledger.mjs';
import { repoKeyForSlug } from '../lib/constellation-repos.mjs';

export const DEFAULT_REPOS = Object.freeze([CONSTELLATION_REPOS.we.slug, CONSTELLATION_REPOS['plateau-app'].slug]);
export const DRAIN_LOG = join(homedir(), 'workspace', 'plateau-app', '.drain-daemon', 'daemon.log');
export const STALLED_AFTER_ENV = 'WE_PR_SWEEP_STALLED_AFTER_MINUTES';
const LIST_FIELDS = 'number,state,title,url,isDraft,headRefOid,updatedAt,labels,statusCheckRollup,body,createdAt';
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
/** `ps` etime (`[[dd-]hh:]mm:ss`) in seconds, or null. PURE. */
export function etimeSeconds(v) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(v ?? '').trim());
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : null;
}
export function parseLiveJobs(psText, now = null) {
  const jobs = [];
  for (const line of String(psText ?? '').split('\n')) {
    const script = /\b(review-job|review-extra-seats|fix-run|ci-heal|deliver-item-run|red-team-gate-apply)\b[^\s]*\.mjs/.exec(line);
    // Launchers can use the last duplicate flag. No ambiguous identity can prove activity for a PR.
    const flags = [...line.matchAll(/(?:^|\s)--(pr|repo)(?==|\s|$)/g)].map((m) => m[1]);
    if (flags.filter((f) => f === 'pr').length !== 1 || flags.filter((f) => f === 'repo').length > 1) continue;
    const pr = /(?:^|\s)--pr(?:=|\s+)(\d+)(?=\s|$)/.exec(line);
    if (!script || !pr) continue;
    const repo = /(?:^|\s)--repo(?:=|\s+)([\w.-]+\/[\w.-]+)(?=\s|$)/.exec(line);
    const age = etimeSeconds(line.trim().split(/\s+/)[1]);
    jobs.push({ kind: script[1], pr: Number(pr[1]), repo: repo?.[1] ?? null, source: 'ps', ...(Number.isFinite(now) && age !== null ? { startedAt: now - age * 1000 } : {}) });
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
  settings = () => readSettings({}), lapseContext = () => ({ rows: readFixLoopRows(), config: fixLoopConfig() }) } = {}) {
  return (input = {}) => {
    // The fix daemon's own stand-down lapse annotation (`pr-comments-complete.mjs`): a stand-down that lapsed on a new
    // head, or a fix-loop hold whose attempts all ran while main was red, is not terminal. The ledger is read lazily,
    // only for a thread that carries a stand-down; an unreadable ledger means no red-main lapse, as in the daemon.
    let lapseCtx; let lapseRead = false;
    const annotate = (pr) => {
      if (!pr.comments.some((c) => c.body.trimStart().startsWith(STAND_DOWN_MARKER))) return pr;
      if (!lapseRead) { lapseRead = true; try { lapseCtx = lapseContext(); } catch { lapseCtx = null; } }
      return annotateLapsedStandDowns({ ...pr, headChangedAt: pr.headCommittedAt }, { onLapse: () => {},
        ...(lapseCtx ? { redMainLapse: (head) => fixLoopRedMainLapse({ ...lapseCtx, repo: repoKeyForSlug(pr.repo), pr: pr.number, head }) } : {}) });
    };
    const cfg = settings();
    const configured = Array.isArray(cfg?.prSweep?.repos) && cfg.prSweep.repos.length ? cfg.prSweep.repos : DEFAULT_REPOS;
    // PR numbers are repo-local. Without --repo, a targeted lookup belongs to the primary configured repo only.
    const repos = input.repo ? [String(input.repo)] : input.pr !== undefined ? configured.slice(0, 1) : configured;
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
        if (p.state !== 'OPEN') {
          unreadable.push(`${repo}#${p.number}: PR is ${p.state ?? 'unknown'}, not OPEN`);
          continue;
        }
        try {
          const paged = (path) => JSON.parse(run('gh', ['api', '--paginate', '--slurp', `${path}?per_page=100`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 })).flat();
          const comments = paged(`repos/${repo}/issues/${p.number}/comments`)
            .map((c) => ({ id: c.node_id ?? c.id, databaseId: c.id, url: c.html_url, author: { login: c.user?.login ?? '' }, user: c.user, body: c.body ?? '', createdAt: c.created_at }));
          const labelEvents = paged(`repos/${repo}/issues/${p.number}/events`).filter((e) => e.event === 'labeled' && e.label?.name)
            .map((e) => ({ label: e.label.name, at: e.created_at }));
          const view = jsonGh(run, ['pr', 'view', String(p.number), '-R', repo, '--json', 'commits']);
          const commit = (view.commits ?? []).filter((c) => c.oid === p.headRefOid).pop();
          prs.push(annotate({ ...p, repo, comments, labelEvents, headCommittedAt: commit?.committedDate ?? null }));
        } catch (e) { unreadable.push(`${repo}#${p.number}: ${String(e?.message ?? e).split('\n')[0]}`); }
      }
    }
    let liveJobs = [];
    try { liveJobs = parseLiveJobs(ps(), now()); } catch (e) { unreadable.push(`ps: ${String(e?.message ?? e).split('\n')[0]}`); }
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
