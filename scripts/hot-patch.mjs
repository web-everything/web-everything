#!/usr/bin/env node
/** R1100: immutable hot-patch admission; urgent-sweep owns monitoring and rollback. */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSyncThrottled } from './lib/gh-throttle.mjs';
import { DAEMON_CLONE_SEED, daemonCloneForLabel } from './lib/daemon-clone-registry.mjs';
import { workspaceFor } from './lib/lane-pool-paths.mjs';
import { urgentLedger } from './operations/urgent-verify-marker.mjs';
const repo = 'web-everything/web-everything', prefix = `repos/${repo}`;
const shaOK = sha => typeof sha === 'string' && /^[a-f0-9]{40}$/.test(sha);
export function hotPatchRoot(daemon, cwd) {
  const clone = daemonCloneForLabel(daemon) ?? (DAEMON_CLONE_SEED.includes(daemon) ? daemon : null);
  if (clone) return join(workspaceFor(cwd), clone);
  if (daemon && (isAbsolute(daemon) || daemon.includes('/'))) return resolve(cwd, daemon);
  throw Error('unknown daemon; use its registered label, clone name or explicit clone path');
}
export function easternIso(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${p.timeZoneName.replace('GMT', '')}`;
}
function easternTimes(v) {
  if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v)) return easternIso(v);
  if (Array.isArray(v)) return v.map(easternTimes);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, easternTimes(x)]));
  return v;
}
export function verifyPr(evidence, { pr, sha }) {
  if (!Number.isSafeInteger(pr) || pr <= 0 || evidence?.number !== pr || evidence.state !== 'OPEN'
    || evidence.baseRefName !== 'main' || evidence.headRepository?.nameWithOwner !== repo
    || evidence.isCrossRepository !== false || !shaOK(evidence.headRefOid) || (sha !== undefined && evidence.headRefOid !== sha))
    throw Error('open canonical PR on main at exact head sha required; repair PR evidence or use ordinary delivery');
  return evidence.headRefOid;
}
export async function verifyRuleset({ sha, ghJson }) {
  if (!shaOK(sha)) throw Error('invalid ruleset sha');
  const rules = await ghJson(['api', `${prefix}/rules/branches/hotpatch/${sha}`, '--repo', repo]);
  if (!Array.isArray(rules) || !rules.length || rules.length > 100
    || !['update', 'deletion', 'non_fast_forward'].every(type => rules.some(r => r?.type === type))
    || rules.some(r => !Number.isSafeInteger(r?.ruleset_id) || r.ruleset_id <= 0))
    throw Error('immutable rules evidence incomplete (maximum 100); operator must repair protection');
  for (const id of new Set(rules.map(r => r.ruleset_id))) {
    const rule = await ghJson(['api', `${prefix}/rulesets/${id}`, '--repo', repo]);
    if (rule?.id !== id || rule.enforcement !== 'active' || rule.current_user_can_bypass !== 'never')
      throw Error('immutable ruleset inactive, mismatched or bypassable; operator must repair protection');
  }
}
export async function ensureRef({ sha, ghJson }) {
  if (!shaOK(sha)) throw Error('invalid ref sha');
  const branch = `hotpatch/${sha}`;
  let ref;
  try { ref = await ghJson(['api', '-X', 'POST', `${prefix}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${sha}`, '--repo', repo]); }
  catch (e) {
    if (!/422/.test(String(e.status ?? e.message)) || !/already exists/i.test(e.message)) throw e;
    ref = await ghJson(['api', `${prefix}/git/ref/heads/${branch}`, '--repo', repo]);
  }
  if (ref?.ref !== `refs/heads/${branch}` || ref.object?.sha !== sha) throw Error('immutable ref readback sha mismatch');
}
export const buildLoadArgs = ({ daemon, sha, pr }) => [`--daemon=${daemon}`, `--branch=hotpatch/${sha}`, `--sha=${sha}`, '--urgent', `--reason=R1100 hot-patch PR #${pr}`];
function readLedger(env, name) {
  const path = urgentLedger(env.HOME, name);
  try {
    if (statSync(path).size > 4 * 1024 * 1024) throw Error('ledger exceeds 4 MiB; archive settled records and retry');
    return readFileSync(path, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), env = process.env, ghJson, spawn = spawnSync,
  loads = () => readLedger(env, 'urgent-loads'), state = () => readLedger(env, 'urgent-sweep-state'),
  stdout = s => process.stdout.write(s), stderr = s => process.stderr.write(s) } = {}) {
  try {
    const childEnv = { ...env }; delete childEnv.GH_REPO; delete childEnv.GH_HOST;
    ghJson ??= async args => {
      // gh api has no --repo flag: its literal endpoint already pins the repository.
      const actual = args[0] === 'api' ? args.slice(0, -2) : args;
      return JSON.parse(String(execFileSyncThrottled('gh', actual, { cwd, env: childEnv, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })));
    };
    const [command, ...args] = argv;
    if (!['request', 'status'].includes(command)) throw Error('expected request or status');
    const { values: f } = parseArgs({ args, options: command === 'request' ? { daemon: { type: 'string' }, pr: { type: 'string' } } : {} });
    const records = await loads(), receipts = await state();
    const hot = records.filter(r => r.type === 'prototype-load.urgent' && /^hotpatch\/[a-f0-9]{40}/.test(r.ref ?? ''));
    const settled = r => {
      const id = createHash('sha256').update(JSON.stringify([r.ref, r.sha, r.clone, r.registration, r.trackingId])).digest('hex');
      return receipts.some(s => s.id === id && s.ref === r.ref && s.sha === r.sha
        && ((s.status === 'settled-unregistered' && s.ancestryVerified === true) || s.status === 'unloaded-adopted'));
    };
    if (command === 'status') {
      stdout(JSON.stringify(easternTimes(hot.map(r => ({ ...r, sweep: receipts.filter(s => s.ref === r.ref && s.sha === r.sha) }))), null, 2) + '\n'); return 0;
    }
    if (!f.daemon || !/^[1-9]\d*$/.test(f.pr ?? '') || !Number.isSafeInteger(Number(f.pr))) throw Error('--daemon and a positive safe --pr required');
    if (hot.some(r => !settled(r))) throw Error('unsettled hot-patch load exists; inspect status and settle it before retrying');
    const pr = Number(f.pr);
    const evidence = await ghJson(['pr', 'view', String(pr), '--repo', repo, '--json', 'number,state,headRefOid,headRefName,baseRefName,headRepository,isCrossRepository']);
    const sha = verifyPr(evidence, { pr });
    await verifyRuleset({ sha, ghJson }); await ensureRef({ sha, ghJson });
    const result = await spawn(process.execPath, ['scripts/operations/run.mjs', 'prototype-load', ...buildLoadArgs({ daemon: f.daemon, sha, pr })], { cwd, env: childEnv, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    return result.status === 0 ? 0 : 1;
  } catch (e) { stderr(String(e.message).replace(/[\x00-\x1f\x7f-\x9f]/g, '') + '\n'); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
