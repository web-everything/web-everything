/** Settle backlog-only prep independently of acceptance-based red-team recovery. */
import { readFileSync } from 'node:fs';
import { cascadePolicy, platformPreference } from './policy-cascade.mjs';
import { priorPrepReviews } from '../conveyor/prep-review.mjs';
import { runGhSync } from './gh-throttle.mjs';
import { redTeamForHead, redTeamMarker } from './red-team-gate.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';

export const RULE = 'backlog-only-prep';
export const REASON = `Red team not required on this head: backlog-only prep (rule ${RULE})`;
const settingPath = new URL('../settings/red-team.json', import.meta.url);
const clean = value => String(value?.message ?? value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600);
const names = labels => Array.isArray(labels) ? labels.map(l => typeof l === 'string' ? l : l?.name) : null;
const candidate = labels => labels?.includes('review:prep') && labels.includes('red-team:pending');
const booleanEnv = value => /^(1|true)$/i.test(value ?? '') ? true : /^(0|false)$/i.test(value ?? '') ? false : undefined;
const safeLog = log => line => { try { log(clean(line)); } catch { /* diagnostic only */ } };

export function resolveBacklogOnlyPrepSetting({ env = process.env, log = () => {}, readFile = readFileSync } = {}) {
  let tool, platform;
  try { tool = JSON.parse(readFile(settingPath, 'utf8'))?.redTeam?.skipBacklogOnlyPrep; } catch { /* optional */ }
  try { platform = platformPreference('redTeam', { env, readFile })?.skipBacklogOnlyPrep; } catch { /* optional */ }
  try {
    const resolved = cascadePolicy('redTeamSkipBacklogOnlyPrep', { skipBacklogOnlyPrep: tool }, {
      standard: { skipBacklogOnlyPrep: true }, platform: { skipBacklogOnlyPrep: platform },
      envValues: { skipBacklogOnlyPrep: booleanEnv(env.WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP) },
      valid: v => typeof v === 'boolean', env, log: safeLog(log),
    });
    return { enabled: resolved.value.skipBacklogOnlyPrep };
  } catch { return { enabled: booleanEnv(env?.WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP) ?? falseIfConfigured(tool, platform) }; }
}

const falseIfConfigured = (tool, platform) => typeof tool === 'boolean' ? tool : typeof platform === 'boolean' ? platform : true;
const backlogPath = path => typeof path === 'string' && path.startsWith('backlog/')
  && !path.includes('..') && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);

export function backlogOnlyPrepClear({ enabled, head, files, comments, labels } = {}) {
  const refuse = why => ({ ok: false, why });
  if (enabled !== true) return refuse('disabled');
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return refuse('invalid head');
  if (!Array.isArray(files) || !files.length) return refuse('files unreadable or empty; inspect full diff manually');
  if (files.length >= 3000) return refuse('possibly truncated files; inspect full diff manually');
  if (files.some(f => !backlogPath(f?.filename)
    || Object.hasOwn(f, 'previous_filename') && !backlogPath(f.previous_filename))) return refuse('files outside backlog or unsafe paths');
  const ns = names(labels);
  if (!ns || ns.some(n => typeof n !== 'string') || !candidate(ns)) return refuse('required labels missing or unreadable');
  if (ns.some(n => ['review:changes', 'review:human', 'red-team:blocked'].includes(n))) return refuse('blocking label');
  if (!Array.isArray(comments) || comments.some(c => typeof c?.body !== 'string')) return refuse('comments unreadable');
  const newest = priorPrepReviews(comments).filter(n => n.head === head).at(-1);
  if (!newest || newest.blocked) return refuse('no clean newest trusted prep note for head');
  return { ok: true, rule: RULE };
}

export function readHeadFiles({ repo, pr, head, exec = runGhSync }) {
  const options = { encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 };
  const pages = JSON.parse(exec(['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/files`], options));
  if (!Array.isArray(pages) || !pages.length || pages.some(p => !Array.isArray(p))) throw Error('files response unreadable');
  const files = pages.flat().map(file => {
    if (!file || typeof file.filename !== 'string') throw Error('file entry unreadable');
    return { filename: file.filename, ...(Object.hasOwn(file, 'previous_filename') ? { previous_filename: file.previous_filename } : {}) };
  });
  const live = JSON.parse(exec(['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid'], options));
  if (live?.headRefOid !== head) throw Error('head moved during files read');
  return files;
}

function settleCandidate({ repo, raw, readComments, readHeadFiles: readFiles, readLive, post, syncLabels, env, log, dryRun }) {
  const pr = Number(raw.number), head = raw.headRefOid;
  const row = { prNumber: pr, head, action: 'skip', rule: RULE };
  try {
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) throw Error('invalid head');
    const key = { repo, pr, head }, comments = readComments(key);
    if (!Array.isArray(comments)) throw Error('comments unreadable');
    if (redTeamForHead(comments, pr, head)) return { ...row, why: 'already' };
    const files = readFiles(key);
    const proof = backlogOnlyPrepClear({ enabled: true, head, files, comments, labels: raw.labels });
    if (!proof.ok) return { ...row, why: proof.why };
    const live = readLive(key), before = names(raw.labels), after = names(live?.labels);
    if (live?.headRefOid !== head || !after || after.some(n => typeof n !== 'string')
      || JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort())) throw Error('head or labels changed before post');
    if (dryRun) return { ...row, why: 'dry run (backlog-only prep)' };
    post({ ...key, body: `${redTeamMarker(pr, head)}\n\n${REASON}` });
    syncLabels({ ...key, env, log });
    return { ...row, action: 'clear', why: REASON };
  } catch (error) { return { ...row, why: `backlog-only prep held: ${clean(error)}` }; }
}

export function runBacklogOnlyPrep({ repo, rawPrs, env = process.env, log = () => {}, dryRun = false,
  readComments, readHeadFiles: readFiles = readHeadFiles, readLive, post, syncLabels = syncRedTeamStatusLabels, enabled } = {}) {
  const note = safeLog(log);
  const candidates = (rawPrs ?? []).filter(raw => candidate(names(raw?.labels)));
  if (!candidates.length) return [];
  const effective = enabled ?? resolveBacklogOnlyPrepSetting({ env, log: note }).enabled;
  note(`red-team: backlog-only prep enabled=${effective}`);
  if (effective !== true) return [];
  return candidates.map(raw => {
    const row = settleCandidate({ repo, raw, env, log: note, dryRun, readComments, readHeadFiles: readFiles, readLive, post, syncLabels });
    note(`red-team: ${repo}#${row.prNumber} backlog-only prep ${row.action}: ${row.why}`);
    return row;
  });
}
