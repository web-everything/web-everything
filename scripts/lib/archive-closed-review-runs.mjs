#!/usr/bin/env node
/**
 * Readers of review-pr run records:
 * - drain-red-team-evidence.mjs (reviewRunLookup, settlement scan)
 * - review-round-replay.mjs
 * - agy-shadow-trial-report.mjs
 * - review-red-team-on-skip.mjs
 * - conveyor/run-rating.mjs
 * - conveyor/review-referral-hold.mjs
 * - review-ledger-history.mjs
 * - `review-pr --resume` by id
 *
 * Only closed/merged PRs with terminal records leave the live, top-level scan:
 * open PR evidence and unfinished replay cursors remain in place. Records are
 * moved intact, never deleted. Historical/id readers can explicitly look in the
 * archive; restore a reopened PR's records before using existing live readers or
 * `review-pr --resume`. No reader is implicitly redirected by this utility.
 * Unknown state/corrupt evidence stays live for operator inspection and retry.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isRunRecordTerminal, listRunIds, parseRunRecord, runPath, sharedRunsDir, tryReadRun,
} from '../operations/run-store.mjs';

// lstat also refuses a dangling symlink at the destination.
function refuseExisting(destination, bytes) {
  try {
    const stat = lstatSync(destination);
    if (bytes && stat.isFile() && readFileSync(destination).equals(bytes)) return;
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Archive move refused: destination exists (${destination})`);
}

function noClobberLink(source, destination, link = linkSync) {
  try {
    link(source, destination);
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error;
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
}

function noClobberMove(source, destination, link = linkSync) {
  const bytes = readFileSync(source);
  try {
    noClobberLink(source, destination, link);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    try { refuseExisting(destination, bytes); } catch { throw error; }
  }
  // Verify even an existing destination before removing the private claim.
  if (!readFileSync(destination).equals(bytes)) throw new Error(`Archive bytes changed (${destination})`);
  // source is a private claim, never the live path a writer may recreate.
  // A failed link/copy must leave the claim intact, including on EEXIST.
  unlinkSync(source);
}

function returnClaim(claim, source, failure) {
  try {
    // Same-directory recovery must not overwrite a writer's newly created path.
    linkSync(claim, source);
    // Keep the claim: a writer can replace source immediately after this link.
  } catch (error) {
    throw new Error(`${failure ? `${failure.message ?? failure}; ` : ''}claim retained at ${claim}: ${error.message ?? error}`);
  }
  if (failure) throw new Error(`${failure.message ?? failure}; claim retained at ${claim}`);
  return claim;
}

function revalidationFailure(claim, bytes, mtime) {
  try {
    const currentBytes = readFileSync(claim);
    const current = parseRunRecord(currentBytes.toString('utf8'));
    if (current.ok && !isRunRecordTerminal(current.record)) return 'unfinished';
    if (current.ok && bytes.equals(currentBytes)
      && statSync(claim, { bigint: true }).mtimeNs === mtime) return null;
  } catch { /* Changed or unreadable evidence must be returned for inspection. */ }
  return 'changed';
}

function moveRecord(source, destination, move, beforeMove, afterClaim, validate, onMissing, retainSource = false) {
  refuseExisting(destination, retainSource ? undefined : readFileSync(source));
  mkdirSync(dirname(destination), { recursive: true });
  if (beforeMove?.(source, destination) === false) return false;
  // Not a run id or a .json file: a crash leaves evidence outside listRunIds.
  const claim = join(dirname(source), `.${basename(source, '.json')}.archiving-${process.pid}-${randomUUID()}`);
  try {
    if (retainSource) linkSync(source, claim);
    else renameSync(source, claim);
  } catch (error) {
    if (error.code === 'ENOENT' && onMissing) return onMissing();
    throw error;
  }
  let valid;
  try {
    afterClaim?.(claim, destination);
    valid = validate(claim);
    if (valid) move(claim, destination);
  } catch (error) {
    returnClaim(claim, source, error);
    throw error;
  }
  if (!valid) {
    returnClaim(claim, source);
    throw new Error(`claim retained at ${claim}`);
  }
  return valid;
}

/**
 * Synchronous IO hooks: list(dir), read(id, dir), move(claim, dst), link(claim, dst).
 * beforeMove(src, dst) runs after the destination precheck, before claiming.
 * afterClaim(claim, dst) runs before parsing/revalidating the claimed bytes.
 * move/link run after validation of the private claim; writers may recreate src.
 * A failed move returns the claim without clobbering src; recovery failures report
 * the retained claim path in errors. Recovery uses real, exclusive hard links.
 * Default reads classify the captured bytes; custom readers still require a real file.
 * `scanned` counts review-pr-* candidates; `archived` is the proposed set in dry-run.
 * `now` is accepted for injected clocks; eligibility deliberately has no age cutoff.
 * run-store.mjs writeRun uses writeJsonAtomic (tmp file + renameSync), never
 * in-place writes: replacing the public path cannot mutate the claimed inode.
 */
export function archiveClosedReviewRuns({
  runsDir = sharedRunsDir(), archiveDir = join(runsDir, 'archive', 'review-pr'),
  prState, dryRun = true, list = listRunIds, read = tryReadRun,
  link = linkSync, move = (src, dst) => noClobberMove(src, dst, link), beforeMove, afterClaim, now = Date.now,
} = {}) {
  void now;
  const result = {
    scanned: 0, archived: [],
    kept: { open: [], unfinished: [], unknownState: [], corrupt: [], notReview: [], changed: [], claimed: [] },
    errors: [],
  };
  // Claims survive rollback and abrupt exit; never silently hide them from operators.
  const claimedIds = new Set();
  try {
    for (const name of readdirSync(runsDir)) {
      const match = /^\.(review-pr-.+)\.archiving-\d+-[\da-f-]+$/.exec(name);
      if (!match) continue;
      const id = match[1], path = join(runsDir, name);
      result.kept.claimed.push({ id, path });
      claimedIds.add(id);
      if (!dryRun) {
        try { linkSync(path, runPath(id, runsDir)); }
        catch (error) {
          if (error.code !== 'EEXIST') result.errors.push({ id, error: `claim retained at ${path}: ${error.message ?? error}` });
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      result.errors.push({ id: null, error: String(error.message ?? error) });
      return result;
    }
  }
  let ids;
  try {
    ids = list(runsDir).filter(id => id.startsWith('review-pr-') && !claimedIds.has(id));
  } catch (error) {
    result.errors.push({ id: null, error: String(error.message ?? error) });
    return result;
  }
  const states = new Map();
  for (const id of ids) {
    result.scanned++;
    let record, bytes, mtime;
    try {
      const source = runPath(id, runsDir);
      mtime = statSync(source, { bigint: true }).mtimeNs;
      bytes = readFileSync(source);
      record = read === tryReadRun ? parseRunRecord(bytes.toString('utf8')).record : read(id, runsDir);
    } catch { /* unreadable evidence is kept */ }
    if (!record) { result.kept.corrupt.push(id); continue; }
    if (record.op !== 'review-pr') { result.kept.notReview.push(id); continue; }
    if (!isRunRecordTerminal(record)) { result.kept.unfinished.push(id); continue; }
    const repo = record.input?.repo;
    const rawPr = record.input?.pr;
    const pr = typeof rawPr === 'string' || typeof rawPr === 'number' ? Number(rawPr) : NaN;
    if (typeof repo !== 'string' || !repo.trim() || !Number.isSafeInteger(pr) || pr <= 0) {
      result.kept.unknownState.push(id);
      continue;
    }
    const key = `${repo}#${pr}`;
    if (!states.has(key)) {
      let state;
      try { state = prState?.(repo, pr); } catch { /* fail closed, including cached failures */ }
      states.set(key, state);
    }
    const state = states.get(key);
    if (state === 'open') { result.kept.open.push(id); continue; }
    if (state !== 'closed' && state !== 'merged') { result.kept.unknownState.push(id); continue; }
    try {
      const source = runPath(id, runsDir), destination = runPath(id, archiveDir);
      if (dryRun) refuseExisting(destination, bytes);
      else if (!moveRecord(source, destination, move, () => {
        beforeMove?.(source, destination);
      }, afterClaim, claim => {
        const failure = revalidationFailure(claim, bytes, mtime);
        if (!failure) return true;
        result.kept[failure].push(id);
        return false;
      }, () => {
        result.kept.changed.push(id);
        return false;
      })) continue;
      result.archived.push(id);
    } catch (error) {
      result.errors.push({ id, error: String(error.message ?? error) });
    }
  }
  return result;
}

/** Explicit archive lookup: null for absent records; corrupt records still throw. */
export function readArchivedRun(id, {
  runsDir = sharedRunsDir(), archiveDir = join(runsDir, 'archive', 'review-pr'),
} = {}) {
  return tryReadRun(id, archiveDir);
}

export function listArchivedRunIds({
  runsDir = sharedRunsDir(), archiveDir = join(runsDir, 'archive', 'review-pr'),
} = {}) {
  return listRunIds(archiveDir).filter(id => id.startsWith('review-pr-'));
}

/** Restore before resuming a reopened PR; refuse to overwrite a newer live record. */
export function restoreArchivedRun(id, {
  runsDir = sharedRunsDir(), archiveDir = join(runsDir, 'archive', 'review-pr'),
  link = linkSync, move = (src, dst) => noClobberLink(src, dst, link), beforeMove, afterClaim,
} = {}) {
  const source = runPath(id, archiveDir);
  const destination = runPath(id, runsDir);
  const mtime = statSync(source, { bigint: true }).mtimeNs;
  const bytes = readFileSync(source);
  moveRecord(source, destination, move, beforeMove, afterClaim, claim => {
    const failure = revalidationFailure(claim, bytes, mtime);
    if (failure) throw new Error(`Restore refused: ${failure} evidence (${source})`);
    return true;
  }, undefined, true);
  return destination;
}

/** CLI-only resolver; callers of the library supply their own PR-state reader. */
export function ghPrState(repo, pr, { exec = execFileSync } = {}) {
  const state = exec('gh', [
    'pr', 'view', String(pr), '--repo', repo, '--json', 'state', '-q', '.state',
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return new Map([['OPEN', 'open'], ['CLOSED', 'closed'], ['MERGED', 'merged']]).get(state);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dryRun = !process.argv.includes('--apply');
  const result = archiveClosedReviewRuns({ prState: ghPrState, dryRun });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log([
    `scanned: ${result.scanned}`, `${dryRun ? 'would-archive' : 'archived'}: ${result.archived.length}`,
    `open: ${result.kept.open.length}`, `unfinished: ${result.kept.unfinished.length}`,
    `unknown: ${result.kept.unknownState.length}`, `corrupt: ${result.kept.corrupt.length}`,
    `not-review: ${result.kept.notReview.length}`, `errors: ${result.errors.length}`,
    `changed: ${result.kept.changed.length}`, `claimed: ${result.kept.claimed.length}`,
  ].join('\n'));
  if (result.errors.length) process.exitCode = 1;
}
