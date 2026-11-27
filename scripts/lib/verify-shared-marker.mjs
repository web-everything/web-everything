/**
 * Write-once greens at <coordRoot>/verify-shared/<repo>/<sha>/<mergeBase>/<policyKey>.json.
 * Exact fields: v, writer, repo, sha, mergeBase, policyKey, status, exitCode, executedGate,
 * selectionMode, deltaBase, finishedAt, lane, revertRed. Both commit and merge base are 40-hex.
 * revertRed is null (absent/off), or {mode, status:'clean'} for a proven warn/enforce check.
 * Corrupt or non-green local evidence for ANY sha refuses; local green at HEAD also decides.
 * Otherwise an exact shared HEAD green may replace a stale local green, never carry forward.
 * No revocation or tooling deletion: equivalent greens for the same commit and policy coexist through EEXIST.
 * Manual escape: `rm <coordRoot>/verify-shared/<repo>/<sha>/<mergeBase>/<policyKey>.json` forces re-verification.
 * A crashed writer can leave a temp file; readers only open the exact final path.
 * Only a fresh verify run publishes: a "green, no new run needed" reuse of the lane marker writes nothing.
 */
import { mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, linkSync, unlinkSync, lstatSync, fstatSync, readFileSync, constants } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const SHA = /^[0-9a-f]{40}$/;
const POLICY = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;
const FIELDS = ['v', 'writer', 'repo', 'sha', 'mergeBase', 'revertRed', 'policyKey', 'status', 'exitCode', 'executedGate', 'selectionMode', 'deltaBase', 'finishedAt', 'lane'].sort();
const ownerOnly = (st, uid) => Number.isInteger(uid) && st.uid === uid && (st.mode & 0o077) === 0;

/** Runner evidence only. null means absent, malformed or incomplete; zero is a proven no-test run. */
export function executedTestCount(reportText) {
  try {
    const report = JSON.parse(reportText);
    const counters = ['numTotalTests', 'numPendingTests', 'numTodoTests', 'numPassedTests', 'numFailedTests'];
    if (!counters.every(k => Number.isSafeInteger(report?.[k]) && report[k] >= 0)) return null;
    const { numTotalTests: total, numPendingTests: pending, numTodoTests: todo,
      numPassedTests: passed, numFailedTests: failed } = report;
    if (Array.isArray(report.testResults)) {
      // Vitest 1.x includes skipped/todo in numPassedTests and omits skipped from numPendingTests.
      // Its assertion inventory still reports their actual status: subtract those from the runner's total.
      if (!report.testResults.every(file => Array.isArray(file?.assertionResults))) return null;
      const assertions = report.testResults.flatMap(file => file.assertionResults);
      if (assertions.length !== total || assertions.some(a => !['passed', 'failed', 'pending', 'skipped', 'todo'].includes(a?.status))) return null;
      if (assertions.filter(a => a.status === 'failed').length !== failed) return null;
      return total - assertions.filter(a => !['passed', 'failed'].includes(a.status)).length;
    }
    const executed = total - pending - todo;
    return executed >= 0 && executed === passed + failed ? executed : null;
  } catch { return null; }
}

/** Full phase only: every config-enumerated file must contain a passed/failed assertion in THIS report. */
export function fullPhaseInventory({ reportText, files, cwd }) {
  try {
    if (!Array.isArray(files) || files.length < 1 || files.some(file => typeof file !== 'string' || !isAbsolute(file))
      || executedTestCount(reportText) === null) return false;
    const report = JSON.parse(reportText);
    if (!Array.isArray(report.testResults)) return false;
    const executed = new Set(report.testResults.filter(file => typeof file?.name === 'string'
      && file.assertionResults.some(test => ['passed', 'failed'].includes(test.status)))
      .map(file => resolve(cwd, file.name)));
    return files.every(file => executed.has(resolve(file)));
  } catch { return false; }
}

export function sharedMarkerPath({ coordRoot, repo, sha, mergeBase, policyKey }) {
  if (typeof coordRoot !== 'string' || !coordRoot || typeof repo !== 'string' || !REPO.test(repo)
    || typeof sha !== 'string' || !SHA.test(sha) || typeof mergeBase !== 'string' || !SHA.test(mergeBase) || typeof policyKey !== 'string' || !POLICY.test(policyKey)) return null;
  return join(resolve(coordRoot), 'verify-shared', repo.replace(/\//g, '__'), sha, mergeBase, `${policyKey}.json`);
}

function directories(file, coordRoot) {
  const root = join(resolve(coordRoot), 'verify-shared'), chain = [];
  for (let p = dirname(file); ; p = dirname(p)) { chain.unshift(p); if (p === root) return chain; }
}

function validRecord(rec, { repo, sha, mergeBase, policyKey }, nowMs) {
  return rec && typeof rec === 'object' && !Array.isArray(rec)
    && JSON.stringify(Object.keys(rec).sort()) === JSON.stringify(FIELDS)
    && rec.v === 1 && rec.writer === 'verify-lane' && rec.repo === repo && rec.sha === sha && rec.mergeBase === mergeBase && rec.policyKey === policyKey
    && (rec.revertRed === null || (rec.revertRed && typeof rec.revertRed === 'object' && !Array.isArray(rec.revertRed)
      && JSON.stringify(Object.keys(rec.revertRed).sort()) === JSON.stringify(['mode', 'status'])
      && ['warn', 'enforce'].includes(rec.revertRed.mode) && rec.revertRed.status === 'clean'))
    && rec.status === 'green' && rec.exitCode === 0
    && typeof rec.executedGate === 'string' && rec.executedGate.trim().length > 0
    && ['full', 'pr', 'since-last-green'].includes(rec.selectionMode)
    && (rec.selectionMode === 'since-last-green' ? typeof rec.deltaBase === 'string' && SHA.test(rec.deltaBase) : rec.deltaBase === null)
    && typeof rec.finishedAt === 'string' && Number.isFinite(Date.parse(rec.finishedAt)) && Date.parse(rec.finishedAt) <= nowMs + 5 * 60_000
    && typeof rec.lane === 'string' && rec.lane.trim().length > 0;
}

/** Only the publish site in verify-lane calls this writer. Never replaces an existing final record. */
export function publishGreen({ coordRoot, repo, sha, mergeBase, policyKey, record }) {
  const file = sharedMarkerPath({ coordRoot, repo, sha, mergeBase, policyKey });
  if (!file || !validRecord(record, { repo, sha, mergeBase, policyKey }, Date.now())) return false;
  let tmp, fd;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    for (const p of directories(file, coordRoot)) {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.isSymbolicLink() || !ownerOnly(st, process.getuid?.())) return false;
    }
    tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    try { linkSync(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* failed publication cannot grant reuse */ } }
    // Only this writer's scratch file is ever removed. The final record is immutable.
    if (tmp) { try { unlinkSync(tmp); } catch { /* abandoned temp files are ignored */ } }
  }
}

/** Absence is null; every untrusted/unreadable/incomplete record is corrupt and refuses admission. */
export function readSharedGreen({ coordRoot, repo, sha, mergeBase, policyKey, uid = process.getuid?.(), nowMs = Date.now() }) {
  const file = sharedMarkerPath({ coordRoot, repo, sha, mergeBase, policyKey });
  if (!file) return { corrupt: true };
  try {
    for (const p of directories(file, coordRoot)) {
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) return null;
      if (!st.isDirectory() || st.isSymbolicLink() || !ownerOnly(st, uid)) return { corrupt: true };
    }
    if (!lstatSync(file, { throwIfNoEntry: false })) return null;
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let rec;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || !ownerOnly(st, uid)) return { corrupt: true };
      rec = JSON.parse(readFileSync(fd, 'utf8'));
    } finally { closeSync(fd); }
    if (!validRecord(rec, { repo, sha, mergeBase, policyKey }, nowMs)) return { corrupt: true };
    return { sha, status: 'green', suites: rec.executedGate, sharedFrom: { lane: rec.lane, at: rec.finishedAt } };
  } catch { return { corrupt: true }; }
}

/** Corrupt/non-green local evidence at any SHA decides; then local HEAD green, then shared HEAD green. Pure. */
export function resolveMarkerWithShared({ local, shared, headSha }) {
  if (local && (local.corrupt || local.status !== 'green' || local.sha === headSha)) return local;
  if (shared?.corrupt) return shared;
  if (shared?.status === 'green' && shared.sha === headSha) return shared;
  return local;
}
