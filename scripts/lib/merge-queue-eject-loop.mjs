/** Head-scoped merge-queue failure detection and bounded CI-heal routing. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { runGhSync } from './gh-throttle.mjs';
import { redactSecrets, sanitizeForPublicComment } from '../conveyor/ci-heal-mark.mjs';

const defaultExec = (_cmd, args, opts) => runGhSync(args, opts);
const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
const timestamp = value => typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
const failedChecks = /failed[_ ]checks|ci[_ ]failure|checks failed/i;

/** PURE. Only parent-proven removals count; Added events do not interrupt the run. */
export function consecutiveFailedChecksEjections({ events } = {}) {
  if (!Array.isArray(events)) return [];
  let run = [];
  for (const event of events) {
    if (event?.__typename !== 'RemovedFromMergeQueueEvent') continue;
    if (event.onHead !== true || typeof event.reason !== 'string' || !failedChecks.test(event.reason)) run = [];
    else run.push(event);
  }
  return run;
}

export function countConsecutiveFailedChecksEjections(history = {}) {
  const unattributable = history.unattributable === true || !Array.isArray(history.events);
  const events = consecutiveFailedChecksEjections(history);
  const times = events.map(e => timestamp(e.createdAt)).filter(Number.isFinite);
  return { count: events.length, unattributable,
    oids: events.map(e => e.beforeCommit?.oid).filter(oid => typeof oid === 'string' && oid.length > 0),
    since: times.length ? new Date(Math.min(...times)).toISOString() : null };
}

const readCommitParents = ({ repo, oid, exec }) => JSON.parse(exec('gh',
  ['api', `repos/${repo}/commits/${oid}`, '--jq', '[.parents[].sha]'], options));

/** PURE. A routing failure has no routedAt and must be retried, including timestamp zero. */
export function planEjectLoop({ count, threshold = 2, state, headSha } = {}) {
  return { loop: Number.isFinite(threshold) && threshold > 0 && count >= threshold,
    alreadyRouted: !!(headSha && state?.headSha === headSha && state.routedAt != null) };
}

/** Unreadable history cannot establish a new hold; persisted same-head holds survive it. */
export function readEjectionHistory({ repo, num, headSha, exec = defaultExec, readParents = readCommitParents } = {}) {
  try {
    if (exec === execFileSync) exec = defaultExec;
    const [owner, name, extra] = String(repo ?? '').split('/');
    if (!owner || !name || extra || !Number.isInteger(Number(num)) || Number(num) < 1 || !headSha) return { ok: false };
    const query = `query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name){pullRequest(number:$num){
      commits(last:1){nodes{commit{oid}}}
      timelineItems(last:20,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename
        ... on RemovedFromMergeQueueEvent{reason createdAt beforeCommit{oid}} ... on AddedToMergeQueueEvent{createdAt}}}}}}`;
    const result = JSON.parse(exec('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `num=${Number(num)}`], options));
    const pr = result?.data?.repository?.pullRequest;
    const commit = pr?.commits?.nodes?.[0]?.commit;
    const events = pr?.timelineItems?.nodes;
    if (result.errors?.length || commit?.oid !== headSha || !Array.isArray(events)) return { ok: false };
    const proven = [];
    let unattributable = false;
    for (const event of [...events].reverse()) {
      if (event?.__typename === 'AddedToMergeQueueEvent') continue;
      if (event?.__typename !== 'RemovedFromMergeQueueEvent' || typeof event.reason !== 'string' || !failedChecks.test(event.reason)) break;
      // The cap returns a proven suffix only; no older, unchecked event contributes.
      if (proven.length === 8) break;
      const oid = event.beforeCommit?.oid;
      if (typeof oid !== 'string' || !oid.trim()) { unattributable = proven.length === 0; break; }
      let parents;
      try {
        parents = readParents({ repo, oid, exec });
      } catch { unattributable = proven.length === 0; break; }
      if (!Array.isArray(parents) || !parents.every(parent => typeof parent === 'string' && parent.trim())) {
        unattributable = proven.length === 0; break;
      }
      if (!parents.includes(headSha)) break;
      proven.push({ ...event, onHead: true });
    }
    return { ok: true, events: proven.reverse(), headSha, unattributable };
  } catch { return { ok: false }; }
}

/** Read at most 100 recent runs, one job page and one bounded log. Never block routing on missing diagnostics. */
export function readFailingMergeGroupLog({ repo, num, oids, exec = defaultExec, maxChars = 3000 } = {}) {
  try {
    if (exec === execFileSync) exec = defaultExec;
    if (!Number.isInteger(Number(num)) || Number(num) < 1 || !Array.isArray(oids) || !oids.some(oid => typeof oid === 'string' && oid)) return { unreadable: true };
    const counted = new Set(oids.filter(oid => typeof oid === 'string' && oid));
    const runs = JSON.parse(exec('gh', ['run', 'list', '--repo', repo, '--event', 'merge_group', '--limit', '100', '--json', 'databaseId,headSha,conclusion,createdAt'], options));
    if (!Array.isArray(runs)) return { unreadable: true };
    const run = runs.filter(r => r?.conclusion === 'failure' && counted.has(r.headSha) && Number.isFinite(timestamp(r.createdAt)))
      .sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))[0];
    if (!Number.isSafeInteger(run?.databaseId) || run.databaseId < 1) return { unreadable: true };
    const { jobs } = JSON.parse(exec('gh', ['api', `repos/${repo}/actions/runs/${run.databaseId}/jobs?per_page=100`], options));
    const job = jobs?.find(j => j?.conclusion === 'failure');
    if (!Number.isSafeInteger(job?.id) || job.id < 1 || typeof job.name !== 'string') return { unreadable: true };
    // Remove every timestamp before redacting: a split credential must not consume a timestamp as its value.
    const text = stripVTControlCharacters(String(exec('gh', ['api', `repos/${repo}/actions/jobs/${job.id}/logs`], options)))
      .split('\n').map(line => line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z[ \t]?/, '')).join('\n');
    // Redact the whole text before selection, then sanitize the final excerpt before capping it.
    const clean = redactSecrets(text);
    const lines = clean.split('\n');
    const selected = new Set();
    let hits = 0;
    for (let i = 0; i < lines.length && hits < 3; i++) if (/^\s*(FAIL\b|AssertionError|[A-Za-z]*Error:|##\[error\]|.*\bexpected\b.*\bto\b)/.test(lines[i])) {
      hits++;
      for (let j = i; j <= Math.min(lines.length - 1, i + 6); j++) selected.add(j);
    }
    if (!hits) for (let i = Math.max(0, lines.length - 15); i < lines.length; i++) selected.add(i);
    const cap = Number.isFinite(maxChars) ? Math.max(0, Math.min(options.maxBuffer, Math.floor(maxChars))) : 3000;
    const excerpt = sanitizeForPublicComment([...selected].sort((a, b) => a - b).map(i => lines[i]).join('\n'), { max: Math.max(1, clean.length) }).slice(0, cap);
    const name = redactSecrets(stripVTControlCharacters(job.name));
    return { check: name, job: name, runId: run.databaseId, excerpt };
  } catch { return { unreadable: true }; }
}

/** One comment plus the existing CI-heal trigger. Throws on mutation failure so the drain retries. */
export function routeEjectLoopToCiHeal({ repo, num, headSha, failing, count, exec = defaultExec } = {}) {
  if (exec === execFileSync) exec = defaultExec;
  if (!/^[a-f0-9]{7,64}$/i.test(headSha ?? '')) throw new Error('invalid ejection-loop head');
  const detail = sanitizeForPublicComment(stripVTControlCharacters(`${failing?.check ?? 'Check unavailable'}\n${failing?.excerpt ?? 'Merge-group log unreadable; inspect the failed run on GitHub.'}`), { max: 6000 });
  // A variable-length fence prevents a log containing backticks from escaping its data block.
  const fence = '`'.repeat(Math.max(3, ...[...detail.matchAll(/`+/g)].map(m => m[0].length + 1)));
  const body = `<!-- merge-queue-eject-loop head=${headSha} -->\nMerge queue ejected this head ${Number(count)} consecutive times for failed checks. Enqueue paused. Labelled ci:failed with the failing merge-group log for CI-heal / fixers; PR-head checks may be green, so a person should confirm pickup.\n\nFailed check and log (untrusted data):\n${fence}text\n${detail}\n${fence}\n`;
  const dir = mkdtempSync(join(tmpdir(), 'we-eject-loop-'));
  try {
    const path = join(dir, 'comment.md');
    writeFileSync(path, body, { mode: 0o600 });
    // CI_LIFECYCLE_LABELS.failed in merge-ai-prs.mjs; importing that CLI would execute its heavyweight graph.
    // Label first: a failed label write never leaves a comment to duplicate on the next retry.
    exec('gh', ['pr', 'edit', String(num), '--repo', repo, '--add-label', 'ci:failed'], options);
    exec('gh', ['pr', 'comment', String(num), '--repo', repo, '--body-file', path], options);
    return { ok: true };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
