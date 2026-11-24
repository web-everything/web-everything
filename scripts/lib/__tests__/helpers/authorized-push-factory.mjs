import { fileURLToPath } from 'node:url';
/** Test-only harness: expose the private factory without adding a production injection API. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readLiveFixClaim, isClaimHolder, pushRefusal, repoKeyOf } from '../../../conveyor/fix-procedure.mjs';
import { validateFixClaimMeta } from '../../../conveyor/fix-claim-store.mjs';
import { CONSTELLATION_REPOS } from '../../constellation-repos.mjs';
import { runGhSync } from '../../gh-throttle.mjs';
import { protectedBranchNames, staleTrackerPushDecision } from '../../../guard-prototype-tracker.mjs';
import { POC_REGISTRY_PATH, normalizeRegistry } from '../../poc-branches.mjs';
import { findTrackerPath, parseTracker } from '../../prototype-tracker-data.mjs';
import { localToday } from '../../local-date.mjs';
import { dirname, relative } from 'node:path';
import { pushGuardDecision, readPushLease } from '../../../guard-git-push.mjs';
import { PUSH_HOLD_LABELS } from '../../review-hold-model.mjs';
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../authorized-push.mjs'), 'utf8');
const body = source.replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const factory = Function('validateFixClaimMeta', 'spawnSync', 'chmodSync', 'mkdtempSync', 'readFileSync', 'writeFileSync', 'rmSync', 'statSync', 'homedir', 'tmpdir', 'join', 'resolve', 'readLiveFixClaim', 'isClaimHolder', 'pushRefusal', 'repoKeyOf', 'CONSTELLATION_REPOS', 'runGhSync', 'protectedBranchNames', 'staleTrackerPushDecision', 'POC_REGISTRY_PATH', 'normalizeRegistry', 'findTrackerPath', 'parseTracker', 'localToday', 'dirname', 'relative', 'PUSH_HOLD_LABELS', 'pushGuardDecision', 'readPushLease', body + '\nreturn { createAuthorizedPush, snapshotOptions };')(validateFixClaimMeta, spawnSync, chmodSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, homedir, tmpdir, join, resolve, readLiveFixClaim, isClaimHolder, pushRefusal, repoKeyOf, CONSTELLATION_REPOS, runGhSync, protectedBranchNames, staleTrackerPushDecision, POC_REGISTRY_PATH, normalizeRegistry, findTrackerPath, parseTracker, localToday, dirname, relative, PUSH_HOLD_LABELS, pushGuardDecision, readPushLease);
export const createAuthorizedPushForTesting = io => factory.createAuthorizedPush(io);
export const snapshotOptionsForTesting = factory.snapshotOptions;

/** Shared static guard; production imports are forbidden anywhere outside __tests__. */
export const nonTestFactoryImports = paths => paths.filter(path => !path.split(/[\\/]/).includes('__tests__')
  && /\.[cm]?[jt]sx?$/.test(path)
  && /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"][^'"]*authorized-push-(?:factory|testing)/.test(readFileSync(path, 'utf8')));
