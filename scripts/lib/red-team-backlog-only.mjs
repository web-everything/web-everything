/** Settle backlog-only heads independently of prep verdicts and acceptance-based recovery. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';
import { gitExec, defaultGitDirFor } from '../operations/free-scope-io.mjs';
import { redTeamForHead, redTeamMarker } from './red-team-gate.mjs';
import { syncRedTeamStatusLabels } from './red-team-status-labels.mjs';

export const RULE = 'backlog-only';
export const REASON = 'Red team not required on this head: backlog-only';
const settingPath = join(dirname(fileURLToPath(import.meta.url)), '../settings/red-team.json');
const clean = value => String(value?.message ?? value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 600);
const names = labels => Array.isArray(labels) ? labels.map(l => typeof l === 'string' ? l : l?.name) : null;
const candidate = labels => labels?.includes('review:prep') && labels.includes('red-team:pending');
const settingBoolean = (value, source, allowWords = false) => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (value === '1') return true;
  if (value === '0') return false;
  if (allowWords && typeof value === 'string' && /^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
  throw Error(`invalid ${source} skipBacklogOnlyPrep=${JSON.stringify(value)}`);
};
const safeLog = log => line => { try { log(clean(line)); } catch { /* diagnostic only */ } };

export function resolveBacklogOnlyPrepSetting({ env = process.env, log = () => {}, readFile = readFileSync } = {}) {
  try {
    const envValue = settingBoolean(env?.WE_RED_TEAM_SKIP_BACKLOG_ONLY_PREP, 'env', true);
    let tool;
    try { tool = JSON.parse(readFile(settingPath, 'utf8'))?.redTeam?.skipBacklogOnlyPrep; }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    tool = settingBoolean(tool, 'tool');
    // platformPreference discards read errors; this exemption needs the complete evidence.
    const { prefs, errors } = readPlatformPreferences({ env, readFile });
    if (errors.length) throw Error(`platform preferences unreadable: ${errors.join('; ')}`);
    const resolved = cascadePolicy('redTeamSkipBacklogOnlyPrep', { skipBacklogOnlyPrep: tool }, {
      standard: { skipBacklogOnlyPrep: true }, platform: { skipBacklogOnlyPrep: settingBoolean(prefs.redTeam?.skipBacklogOnlyPrep, 'platform') },
      envValues: { skipBacklogOnlyPrep: envValue },
      valid: v => typeof v === 'boolean', env, log: safeLog(log),
    });
    return { enabled: resolved.value.skipBacklogOnlyPrep };
  } catch (error) {
    // Unreadable settings evidence is never overridden by env: an exemption cannot turn on from partial evidence.
    safeLog(log)(`red-team: backlog-only prep enabled=false (fail-closed): ${clean(error)}`);
    return { enabled: false };
  }
}

/** Parse raw --no-renames --name-status -z output without repairing incomplete evidence. */
export function parseNameStatusZ(raw) {
  if (typeof raw !== 'string' || !raw.endsWith('\0')) return { ok: false };
  const fields = raw.slice(0, -1).split('\0');
  if (fields.length % 2 || fields.some(field => field === '')) return { ok: false };
  const files = [];
  for (let i = 0; i < fields.length; i += 2) {
    if (fields[i].length !== 1 || !/^[AMDT]$/.test(fields[i])) return { ok: false };
    files.push(fields[i + 1]);
  }
  return { ok: true, files };
}

/** Fetch current main; a failed fetch or incomplete net list always retains manual review. */
export function readBacklogOnlyNetFiles({ repo, number, headRefOid }, {
  git = gitExec(), gitDirFor = defaultGitDirFor,
} = {}) {
  try {
    const dir = gitDirFor(repo);
    if (!dir || !Number.isInteger(number) || number <= 0
      || typeof headRefOid !== 'string' || !/^[0-9a-f]{40}$/i.test(headRefOid)) return { ok: false };
    let missing = false;
    try { git(dir, ['cat-file', '-e', `${headRefOid}^{commit}`]); } catch { missing = true; }
    git(dir, ['fetch', '--quiet', '--no-write-fetch-head', '--end-of-options', 'origin',
      '+refs/heads/main:refs/remotes/origin/main', ...(missing ? [`refs/pull/${number}/head`] : [])]);
    const mergeBase = String(git(dir, ['merge-base', '--end-of-options', 'origin/main', headRefOid])).trim();
    if (!/^[0-9a-f]{40}$/i.test(mergeBase)) return { ok: false };
    const raw = git(dir, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', '--end-of-options', mergeBase, headRefOid]);
    return parseNameStatusZ(raw);
  } catch { return { ok: false }; }
}

const backlogPath = path => typeof path === 'string' && path.startsWith('backlog/') && path.length > 'backlog/'.length
  && !path.includes('..') && !/[\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path);

export function backlogOnlyPrepClear({ enabled, head, files, labels } = {}) {
  const refuse = why => ({ ok: false, why });
  if (enabled !== true) return refuse('disabled');
  if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) return refuse('invalid head');
  if (!Array.isArray(files) || !files.length) return refuse('files unreadable or empty; inspect full diff manually');
  for (const path of files) {
    if (!backlogPath(path)) return refuse('files outside backlog or unsafe paths');
  }
  const ns = names(labels);
  if (!ns || ns.some(n => typeof n !== 'string') || !candidate(ns)) return refuse('required labels missing or unreadable');
  if (ns.some(n => n.startsWith('red-team:') && n !== 'red-team:pending'
    || ['review:changes', 'review:human'].includes(n))) return refuse('blocking label');
  return { ok: true, rule: RULE };
}

function settleCandidate({ repo, raw, readComments, readHeadFiles: readFiles, readLive, post, syncLabels, env, log, dryRun }) {
  const pr = Number(raw.number), head = raw.headRefOid;
  const row = { prNumber: pr, head, action: 'skip', rule: RULE };
  try {
    if (typeof head !== 'string' || !/^[0-9a-f]{40}$/i.test(head)) throw Error('invalid head');
    const key = { repo, pr, head }, comments = readComments(key);
    if (!Array.isArray(comments) || comments.some(c => typeof c?.body !== 'string')) throw Error('comments unreadable');
    if (redTeamForHead(comments, pr, head)) return { ...row, why: 'already' };
    const net = readFiles({ repo, number: pr, headRefOid: head });
    if (net?.ok !== true) throw Error('net files unreadable; inspect full diff manually');
    const files = net.files;
    const proof = backlogOnlyPrepClear({ enabled: true, head, files, labels: raw.labels });
    if (!proof.ok) return { ...row, why: proof.why };
    if (dryRun) return { ...row, why: 'dry run (backlog-only prep)' };
    const freshComments = readComments(key);
    if (!Array.isArray(freshComments) || freshComments.some(c => typeof c?.body !== 'string')) throw Error('comments unreadable');
    const live = readLive(key), before = names(raw.labels), after = names(live?.labels);
    if (live?.headRefOid !== head || !after || after.some(n => typeof n !== 'string')
      || JSON.stringify([...before].sort()) !== JSON.stringify([...after].sort())) throw Error('head or labels changed before post');
    const freshProof = backlogOnlyPrepClear({ enabled: true, head, files, labels: live.labels });
    if (!freshProof.ok) return { ...row, why: freshProof.why };
    if (redTeamForHead(freshComments, pr, head)) return { ...row, why: 'already' };
    const finalComments = readComments(key);
    if (!Array.isArray(finalComments) || finalComments.some(c => typeof c?.body !== 'string')) throw Error('comments unreadable');
    const finalProof = backlogOnlyPrepClear({ enabled: true, head, files, labels: live.labels });
    if (!finalProof.ok) return { ...row, why: finalProof.why };
    if (redTeamForHead(finalComments, pr, head)) return { ...row, why: 'already' };
    const finalLive = readLive(key), finalLabels = names(finalLive?.labels);
    if (finalLive?.headRefOid !== head || !finalLabels || finalLabels.some(n => typeof n !== 'string')
      || !candidate(finalLabels) || finalLabels.some(n => n.startsWith('red-team:') && n !== 'red-team:pending'
        || ['review:changes', 'review:human'].includes(n))) throw Error('head or labels unsafe before post');
    // A race window between the last read and the post is inherent.
    post({ ...key, body: `${redTeamMarker(pr, head)}\n\n${REASON}` });
    syncLabels({ ...key, env, log });
    return { ...row, action: 'clear', why: REASON };
  } catch (error) { return { ...row, why: `backlog-only prep held: ${clean(error)}` }; }
}

export function runBacklogOnlyPrep({ repo, rawPrs, env = process.env, log = () => {}, dryRun = false,
  readComments, readHeadFiles: readFiles = readBacklogOnlyNetFiles, readLive, post, syncLabels = syncRedTeamStatusLabels, enabled } = {}) {
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
