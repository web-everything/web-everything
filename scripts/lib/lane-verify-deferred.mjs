/**
 * @file scripts/lib/lane-verify-deferred.mjs
 * @description R893 — "verify deferred to CI". When lane verify ends infra-failed or unsettled (NEVER red), a
 *   distinct `deferred-to-ci` marker is recorded, bound to the exact HEAD sha, in its OWN file
 *   (`<gitDir>/.lane-verify-deferred`). It is deliberately NOT written into `.lane-verify`: every existing reader
 *   (finish-guard, check, prototype-load, drain, review gates) reads only that file, so none of them can see a
 *   deferred marker as green, by construction. The single consumer is pr-land's OPEN path
 *   (`deferredToCiDecision`), which never accepts the `land` mode; ready-to-merge still needs a green CI `test`
 *   check-run on the exact sha (`ciTestGreenOnSha`).
 */
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readVerifyMarker } from './lane-verify.mjs';

export const DEFERRED_FILENAME = '.lane-verify-deferred';
export const DEFERRED_STATUS = 'deferred-to-ci';
/** Modes that only OPEN (and at most label once CI is green). `land` merges, so it is never allowed. */
export const DEFERRED_OPEN_MODES = Object.freeze(['park', 'label-on-green', 'open-only']);
/** Finish-guard statuses a deferred marker may stand in for. red / corrupt / running are never overridden. */
const OVERRIDABLE_GATE_STATUSES = Object.freeze(['absent', 'unverified', 'untracked', 'infrastructure-failure']);

/** The only infrastructure reasons that may defer to CI (verificationInfrastructureFailure + remote termination). */
export const DEFERRABLE_INFRA_REASONS = Object.freeze(['verify-unsettled', 'verify-timeout', 'verify-signal', 'remote-termination-unconfirmed']);
const validInfra = i => !!i && typeof i === 'object' && !Array.isArray(i) && DEFERRABLE_INFRA_REASONS.includes(i.reason) && typeof i.detail === 'string' && i.detail.length > 0;

/** Pure. Null unless there is an exact sha and infra evidence. */
export function buildDeferredRecord({ sha, infrastructure, exitCode = null, recordedAt = new Date().toISOString() } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) return null;
  if (!validInfra(infrastructure)) return null;
  return {
    status: DEFERRED_STATUS, sha,
    reason: String(infrastructure.reason),
    detail: String(infrastructure.detail || infrastructure.reason),
    infrastructure, exitCode: Number.isFinite(Number(exitCode)) && exitCode != null ? Number(exitCode) : null,
    recordedAt,
  };
}

export function readDeferredMarker(gitDir) {
  const path = join(gitDir, DEFERRED_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { corrupt: true };
  } catch { return { corrupt: true }; }
}

/**
 * The deferred record pr-land's open path may use for EXACTLY `headSha`, or null. PR #6674 red team: a verify the
 * dispatcher KILLS (queue/gate ceiling) is settled into `.lane-verify` by the dispatcher itself
 * (recordKilledVerification); the killed child never reaches its terminal hook, so no deferred file is written.
 * The main marker is the single source of truth for the latest verdict, so read both here:
 * - a corrupt main marker, or a red/green main marker for this sha, means no deferral (fail closed: a newer verdict
 *   voids any deferred file left for the same sha);
 * - otherwise a well-formed deferred file for this exact sha wins;
 * - otherwise an `infrastructure-failure` main marker for this exact sha with deferrable evidence is turned into
 *   the same record (no carry-forward to another sha; a legacy `red`-with-signal record never defers).
 */
export function readDeferredForSha(gitDir, headSha) {
  if (typeof headSha !== 'string' || !/^[0-9a-f]{40}$/.test(headSha)) return null;
  const main = readVerifyMarker(gitDir);
  if (main?.corrupt) return null;
  const mainForSha = main && main.sha === headSha ? main : null;
  if (mainForSha && (mainForSha.status === 'red' || mainForSha.status === 'green')) return null;
  const file = readDeferredMarker(gitDir);
  if (file && !file.corrupt && file.status === DEFERRED_STATUS && file.sha === headSha) return file;
  if (mainForSha?.status !== 'infrastructure-failure') return null;
  return buildDeferredRecord({ sha: headSha, infrastructure: mainForSha.infrastructure, exitCode: mainForSha.exitCode,
    ...(typeof mainForSha.finishedAt === 'string' ? { recordedAt: mainForSha.finishedAt } : {}) });
}

export function clearDeferredMarker(gitDir) {
  try { rmSync(join(gitDir, DEFERRED_FILENAME), { force: true }); } catch { /* best effort */ }
}

/**
 * Called with the terminal record verify just wrote. An infrastructure-failure writes the deferred marker; any
 * other terminal status (red, green) clears a stale one, so a red can never coexist with a deferred for its sha.
 * @returns {object|null} the deferred record written, else null
 */
export function recordTerminalVerifyOutcome(gitDir, finished) {
  if (finished?.status !== 'infrastructure-failure') { clearDeferredMarker(gitDir); return null; }
  const rec = buildDeferredRecord({ sha: finished.sha, infrastructure: finished.infrastructure, exitCode: finished.exitCode });
  if (!rec) { clearDeferredMarker(gitDir); return null; }
  const path = join(gitDir, DEFERRED_FILENAME);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  renameSync(tmp, path);
  return rec;
}

/**
 * Pure. May this refused finish-guard result still OPEN the PR? Only for a refused gate whose status is
 * absent/unverified/infrastructure-failure, a well-formed deferred marker for EXACTLY `headSha` (no carry-forward),
 * and a non-`land` mode.
 */
export function deferredToCiDecision({ gate, deferred, headSha, mode } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!gate || gate.ok !== false) return no('gate-not-refused');
  if (!OVERRIDABLE_GATE_STATUSES.includes(gate.status)) return no(`gate-status-${gate.status}`);
  if (!DEFERRED_OPEN_MODES.includes(mode)) return no(`mode-${mode}`);
  if (!deferred || deferred.corrupt || deferred.status !== DEFERRED_STATUS) return no('no-deferred-marker');
  if (!headSha || deferred.sha !== headSha) return no('deferred-sha-mismatch');
  if (!validInfra(deferred.infrastructure) || deferred.reason !== deferred.infrastructure.reason) return no('deferred-evidence-invalid');
  return { ok: true, reason: 'deferred-to-ci', disclosure: `lane verify deferred to CI: ${deferred.reason} - ${deferred.detail}` };
}

export function appendDeferredDisclosure(body, disclosure) {
  const base = typeof body === 'string' ? body : '';
  if (base.includes(disclosure)) return base; // idempotent: a rerun never stacks a second copy
  return `${base}${base.endsWith('\n') || !base ? '' : '\n'}\n> ${disclosure}\n> ready-to-merge is withheld until the GitHub CI \`test\` check is green on this exact commit.\n`;
}

/** Pure. A `gh pr view --json headRefOid,statusCheckRollup` result: is the `test` check green on exactly `sha`? */
export function ciTestGreenOnSha(view, sha) {
  if (!view || !sha || view.headRefOid !== sha || !Array.isArray(view.statusCheckRollup)) return false;
  // EVERY `test` entry must be green: a newer pending/failed run of the same name voids an older success.
  const tests = view.statusCheckRollup.filter(c => c && c.name === 'test');
  return tests.length > 0 && tests.every(c => String(c.conclusion).toUpperCase() === 'SUCCESS');
}
