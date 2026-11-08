/** Settle backlog-only prep independently of acceptance-based red-team recovery. */
import { readFileSync } from 'node:fs';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';
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
  const envValue = booleanEnv(env?.WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP);
  try {
    let tool;
    try { tool = JSON.parse(readFile(settingPath, 'utf8'))?.redTeam?.skipBacklogOnlyPrep; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    // platformPreference discards read errors; this exemption needs the complete evidence.
    const { prefs, errors } = readPlatformPreferences({ env, readFile });
    if (errors.length) throw Error(`platform preferences unreadable: ${errors.join('; ')}`);
    const resolved = cascadePolicy('redTeamSkipBacklogOnlyPrep', { skipBacklogOnlyPrep: tool }, {
      standard: { skipBacklogOnlyPrep: true }, platform: { skipBacklogOnlyPrep: prefs.redTeam?.skipBacklogOnlyPrep },
      envValues: { skipBacklogOnlyPrep: envValue },
      valid: v => typeof v === 'boolean', env, log: safeLog(log),
    });
    return { enabled: resolved.value.skipBacklogOnlyPrep };
  } catch (error) {
    const enabled = envValue ?? false;
    safeLog(log)(`red-team: backlog-only prep enabled=${enabled} (${envValue === undefined ? 'fail-closed' : 'env'}): ${clean(error)}`);
    return { enabled };
  }
}

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
  const prior = comments.flatMap(comment => priorPrepReviews([comment])
    .filter(n => n.head === head).map(n => ({ ...n, body: comment.body })));
  if (prior.some(n => n.blocked || n.body.includes('**Verdict: findings**')))
    return refuse('trusted prep findings or blocked note for head');
  if (!prior.at(-1)?.body.includes('**Verdict: clean**')) return refuse('no clean newest trusted prep note for head');
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
    const freshComments = readComments(key);
    const freshProof = backlogOnlyPrepClear({ enabled: true, head, files, comments: freshComments, labels: live.labels });
    if (!freshProof.ok) return { ...row, why: freshProof.why };
    if (redTeamForHead(freshComments, pr, head)) return { ...row, why: 'already' };
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
