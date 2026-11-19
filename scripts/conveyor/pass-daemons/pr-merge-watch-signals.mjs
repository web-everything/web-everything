/** Bounded evidence readers; all publication receipts belong to the current head. */
import { isRunAbandoned } from '../../lib/run-abandoned.mjs';
import { openSync, closeSync, fstatSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { REPEAT_LINE_RE } from '../../lib/log-timestamp.mjs';
import { defaultLogDirs } from '../../../skills-src/conveyor/daemon-log.mjs';
import { sharedRunsDir } from '../../operations/run-store.mjs';

const minute = 60_000;
const date = value => { const n = Date.parse(value); if (!Number.isFinite(n)) throw Error('invalid time'); return n; };
const rows = (value, cap) => {
  if (!Array.isArray(value) || value.length >= cap) throw Error('incomplete bounded evidence');
  return value;
};
export function readSignalLogs(dirs = defaultLogDirs(), bytes = 256 * 1024) {
  const logs = [];
  for (const dir of dirs) {
    let names;
    try { names = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const files = names.filter(n => /(?:review|fix|drain).*\.log$/.test(n));
    if (files.length > 12) throw Error('log file cap');
    for (const name of files) {
      const fd = openSync(join(dir, name), 'r');
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw Error('invalid log');
        const start = Math.max(0, stat.size - bytes), buffer = Buffer.alloc(Math.min(bytes, stat.size));
        const size = readSync(fd, buffer, 0, buffer.length, start);
        let text = buffer.subarray(0, size).toString('utf8');
        if (start) text = text.slice(text.indexOf('\n') + 1);
        logs.push(text.slice(0, text.lastIndexOf('\n') + 1));
      } finally { closeSync(fd); }
    }
  }
  if (!logs.length) throw Error('logs unavailable');
  return logs;
}
export const normalizeReason = text => text.replace(/[\p{Cc}\p{Cf}]/gu, '')
  .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>').replace(/\b[a-f0-9]{7,40}\b/gi, '<sha>')
  .replace(/\d+(?:\.\d+)?/g, '<n>').replace(/\s+/g, ' ').trim();
export function loopingSignals(logs, { repo, pr, now, pushed }) {
  const counts = new Map();
  for (const text of logs) for (let line of text.split('\n')) {
    let count = 1;
    const repeat = REPEAT_LINE_RE.exec(line);
    if (repeat) {
      if (!repeat[1] || date(repeat[3]) < Math.max(pushed, now - 30 * minute)) continue;
      count = Number(repeat[2]);
      if (!Number.isSafeInteger(count) || count < 1 || count > 100000) throw Error('repeat cap');
      line = `${repeat[1]} ${repeat[4]}`;
    }
    const m = /^(\S+) (review-daemon|reconcile-fix-dispatch-daemon|fix-dispatch-daemon|drain(?:-daemon)?): (.*)$/.exec(line);
    if (!m) continue;
    const at = date(m[1]), body = m[3];
    if (at < Math.max(pushed, now - 30 * minute) || at > now) continue;
    if (!body.includes(`${repo}#${pr} `) && !body.includes(`${repo} PR #${pr} `)) continue;
    if (!/\b(skip(?:ped)?|refus(?:e|ed|al))\b|no review dispatched|not dispatched/.test(body)) continue;
    const reason = normalizeReason(body), key = `${m[2]}:${reason}`;
    counts.set(key, { daemon: m[2], reason, count: (counts.get(key)?.count ?? 0) + count });
  }
  return [...counts.values()].filter(r => r.count >= 10);
}
export function noProgressSignal(pr, timeline, pushed, now, config) {
  let since = pushed;
  for (const event of timeline) {
    if (typeof event?.event !== 'string') throw Error('invalid timeline');
    // A force-push moves the head without moving its commit's committer date; it restarts the clock, it is no transition.
    if (event.event === 'head_ref_force_pushed') { const at = date(event.created_at); if (at <= now) since = Math.max(since, at); continue; }
    if (!['reviewed', 'ready_for_review', 'added_to_merge_queue', 'merged'].includes(event.event)) continue;
    if (event.event === 'reviewed' && !['approved', 'changes_requested', 'commented', 'dismissed'].includes(event.state)) throw Error('invalid verdict');
    const at = date(event.submitted_at ?? event.created_at);
    if (at > now) throw Error('future transition');
    since = Math.max(since, at);
  }
  const minutes = (now - since) / minute;
  return minutes > (pr.isDraft ? config.noProgressDraftMinutes : config.noProgressMinutes)
    ? { minutes, state: pr.isDraft ? 'draft' : 'ready' } : null;
}
export function overdueSignals(jobs, history, now, factor) {
  return jobs.filter(j => j.status === 'in_progress').flatMap(job => {
    if (!Number.isSafeInteger(job.id) || typeof job.name !== 'string') throw Error('invalid job');
    const minutes = (now - date(job.started_at)) / minute;
    const samples = history.filter(j => j.name === job.name && j.status === 'completed').map(j => {
      if (date(j.completed_at) > now) throw Error('future completion');
      const n = (date(j.completed_at) - date(j.started_at)) / minute;
      if (n < 0) throw Error('invalid duration');
      return n;
    }).sort((a, b) => a - b);
    if (samples.length < 3) return [];
    const middle = Math.floor(samples.length / 2);
    const median = samples.length % 2 ? samples[middle] : (samples[middle - 1] + samples[middle]) / 2;
    return minutes > factor * median ? [{ id: job.id, job: job.name, minutes, median }] : [];
  });
}
const PAUSED_RUN_CAP = 3, RUN_FILES = 1000, RUN_BYTES = 16 * 1024 * 1024, RUN_AGE = 24 * 60 * minute;
const DECISIVE = new Set(['accept', 'accepted', 'changes', 'needs-human']);
let runCache = { at: 0, dir: '', rows: [] };
/** Summaries of recent review-pr run records on disk, one scan shared by every PR in a pass (60 s cache; no GitHub reads).
 * Throws on an unreadable directory or record so the caller fails closed. */
export function readReviewRuns({ dir = process.env.OPERATION_RUNS_DIR?.trim() || sharedRunsDir(), now = Date.now() } = {}) {
  if (runCache.dir === dir && now - runCache.at < minute && now >= runCache.at) return runCache.rows.filter(r => !isRunAbandoned(r.id, dir));
  let listing;
  try { listing = readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } // a runs folder that was never created holds no runs
  const names = listing.filter(n => /^review-pr-.*\.json$/.test(n) && !n.endsWith('.abandoned.json') && !isRunAbandoned(n.slice(0, -5), dir))
    .map(n => ({ n, t: statSync(join(dir, n)).mtimeMs })).filter(f => f.t > now - RUN_AGE)
    .sort((a, b) => b.t - a.t);
  if (names.length > RUN_FILES) throw Error('incomplete bounded evidence: review run file cap');
  const rows = [];
  for (const { n } of names) {
    const st = statSync(join(dir, n));
    if (!st.isFile() || st.size > RUN_BYTES) throw Error('invalid review run record');
    const r = JSON.parse(readFileSync(join(dir, n), 'utf8'));
    const read = r?.findings?.read, verdict = r?.verdict?.verdict;
    const rev = String(read?.headRefOid ?? read?.netBasis?.rev ?? '').toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(rev) || typeof r?.input?.repo !== 'string' || !Number.isSafeInteger(r?.input?.pr)) continue;
    const ask = String(r?.pending?.asks ?? '').split('\n')[0];
    rows.push({ id: r.id, repo: r.input.repo, pr: r.input.pr, head: rev, verdict: typeof verdict === 'string' ? verdict : null,
      recorded: r?.findings?.record?.applied === true && (r.findings.record.effects ?? []).some(e => e?.status === 'applied'
        && (e.type === 'review.label-swap' || e.type === 'verdict-ledger.append')), reason: normalizeControl(`${verdict ?? 'no verdict'}: ${ask}`).slice(0, 240) });
  }
  runCache = { at: now, dir, rows };
  return rows;
}
const normalizeControl = text => text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
/** A review is paused with no verdict when the head has >= `cap` review runs, none a recorded decisive verdict, and the
 * PR is not already accepted or waiting on an operator. PURE. */
export function pausedReviewSignal(runs, { head, labels, cap = PAUSED_RUN_CAP }) {
  if (labels.some(l => l === 'review:human' || l === 'review:accepted')) return null;
  const onHead = runs.filter(r => r.head === head);
  if (onHead.length < cap || onHead.some(r => r.recorded && DECISIVE.has(r.verdict))) return null;
  return { head, runs: onHead.length, reason: onHead[0].reason };
}
export async function runMergeWatchSignals({ repo, pr, receipt, now, config, read, send, save, failure,
  signalLogs = readSignalLogs, reviewRuns = readReviewRuns }) {
  const publish = async (kind, key, detail) => {
    if (receipt.signals?.[key]) return;
    await send({ kind, repo, pr: pr.number, detail });
    (receipt.signals ??= {})[key] = true;
    save();
  };
  let pushed;
  try {
    const commit = read(['api', `repos/${repo}/commits/${pr.headRefOid}`]);
    if (commit?.sha !== pr.headRefOid) throw Error('head mismatch');
    pushed = date(commit.commit?.committer?.date);
    if (pushed > now) throw Error('future head');
  } catch { failure(); }
  if (pushed !== undefined) {
    try {
      for (const detail of loopingSignals(signalLogs(), { repo, pr: pr.number, now, pushed })) {
        await publish('pr-looping', `loop:${createHash('sha256').update(detail.daemon + detail.reason).digest('hex')}`, detail);
      }
    } catch { failure(); }
    try {
      const timeline = [];
      for (let page = 1; page <= 3; page++) {
        const batch = read(['api', `repos/${repo}/issues/${pr.number}/timeline?per_page=100&page=${page}`]);
        if (!Array.isArray(batch) || batch.length > 100) throw Error('invalid timeline');
        timeline.push(...batch);
        if (batch.length < 100) break;
        if (page === 3) throw Error('timeline cap');
      }
      const detail = noProgressSignal(pr, timeline, pushed, now, config);
      if (detail) await publish('pr-no-progress', 'progress', detail);
    } catch { failure(); }
  }
  try {
    const runs = reviewRuns({ now }).filter(r => r.repo === repo && r.pr === pr.number);
    const detail = pausedReviewSignal(runs, { head: pr.headRefOid, labels: (pr.labels ?? []).map(l => l?.name),
      cap: config.reviewPausedRuns ?? PAUSED_RUN_CAP });
    if (detail) await publish('review-paused-no-verdict', `loop:${createHash('sha256').update(`review-paused:${pr.headRefOid}`).digest('hex')}`, detail);
  } catch { failure(); }
  try {
    const jobs = rows(read(['api', `repos/${repo}/commits/${pr.headRefOid}/check-runs?per_page=100`])?.check_runs, 100);
    if (!jobs.some(j => j.status === 'in_progress')) return;
    const runs = read(['api', `repos/${repo}/actions/runs?status=completed&per_page=5`])?.workflow_runs;
    if (!Array.isArray(runs) || runs.length > 5) throw Error('invalid runs');
    const history = [];
    for (const run of runs) {
      if (!Number.isSafeInteger(run.id)) throw Error('invalid run');
      history.push(...rows(read(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`])?.jobs, 100));
    }
    for (const { id, ...detail } of overdueSignals(jobs, history, now, config.ciJobOverdueFactor)) {
      await publish('ci-job-overdue', `ci:${id}`, detail);
    }
  } catch { failure(); }
}
