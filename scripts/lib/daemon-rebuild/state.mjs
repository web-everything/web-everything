/** @file scripts/lib/daemon-rebuild/state.mjs — Per-clone state files.
 * Split out of daemon-rebuild.mjs (move-only).
 */
import { rebuildReaders } from './evidence-context.mjs';


import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { overlayFilePath, cloneKey } from '../daemon-overlays.mjs';
import { daemonStateDir } from '../daemon-last-good.mjs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { FULL_SHA_RE, REBUILD_IDENTITY_ENV, verifyRev } from './shared.mjs';

/**
 * Is `root` a daemon-managed clone — one the rebuild moves with `reset --hard`? True once it has a rebuild
 * state file or a registered overlay list (both keyed on the same `cloneKey`). A plain checkout or lane has
 * neither. Never throws.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isDaemonManagedClone(root, env = process.env) {
  try {
    return existsSync(rebuildStatePath(root, env)) || existsSync(overlayFilePath(root, env));
  } catch {
    return false;
  }
}

// ── per-clone rebuild state (outside the git tree, per clause 3(iii) — same posture as daemon-overlays.mjs) ──

/** Env var pinning the rebuild-state root outside any git tree. */
export const WE_DAEMON_STATE_DIR_ENV = 'WE_DAEMON_STATE_DIR';

export function stateDir(env = process.env) {
  // One definition, shared with the staleness guard's last-good read (x5wbsbc) — never two spellings.
  return daemonStateDir(env);
}

/** `<stateDir>/<cloneKey>.rebuild.json` — reuses `daemon-overlays.mjs#cloneKey` so every per-clone state file
 *  (overlay list, rebuild state) keys on the SAME identity, never re-derived.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function rebuildStatePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.rebuild.json`);
}

export function alertsFilePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.alerts.jsonl`);
}

const EMPTY_STATE = Object.freeze({
  adopted: null, rejected: null, inProgress: null, quarantine: null, unverified: null, building: null, held: null, busySkippedTrees: null, forceUnverifiedTrees: null, smokePassed: null, pinnedNotified: null,
});

/**
 * Read the per-clone rebuild state, never throwing — a missing or corrupt file reads as the empty state. Legacy, best-effort consumers only;
 * admission must use the strict reader and retain its snapshot.
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{adopted:object|null, rejected:object|null, inProgress:object|null, quarantine:object|null,
 *   unverified:{head:string, prevHead:string}|null, building:object|null, smokePassed:Array<{key:string, tree:string, passedAt:string}>|null}}
 */
export function readRebuildState(root, env = process.env) {
  return rebuildReaders() ? rebuildReaders().state(root, env) : readState(root, env, false);
}

/** Launch admission: only ENOENT means empty; unreadable/corrupt evidence throws for refusal. */
export function readRebuildStateStrict(root, env = process.env, read = readFileSync) {
  return readState(root, env, true, read);
}

const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = v => typeof v === 'string' && v.length > 0;
const date = v => string(v) && Number.isFinite(Date.parse(v));
const positive = v => Number.isSafeInteger(v) && v > 0;
const strings = v => Array.isArray(v) && v.every(string);
export const appliedShape = v => Array.isArray(v) && v.every(r => object(r) && string(r.ref) && string(r.sha)
  && (!Object.hasOwn(r, 'pinnedFrom') || string(r.pinnedFrom)));
const applied = appliedShape;
const pinnedApplied = v => appliedShape(v) && v.every(r => !Object.hasOwn(r, 'pinnedFrom')
  || (FULL_SHA_RE.test(r.pinnedFrom) && FULL_SHA_RE.test(r.sha) && r.sha !== r.pinnedFrom));
const fields = (v, required, optional = {}) => object(v)
  && Object.entries(required).every(([k, valid]) => valid(v[k]))
  && Object.entries(optional).every(([k, valid]) => !(k in v) || valid(v[k]));
const boolean = v => typeof v === 'boolean';
const nullable = valid => v => v === null || valid(v);
const backoff = { retryAt: nullable(date), attempts: positive };
// Admission schema: every persisted discriminator and every value defaulted/coerced by
// readState/prepare is required. Null is an explicit absence, never an omitted field.
// Old incomplete files require operator repair; only ENOENT creates EMPTY_STATE.
export const rebuildStateSchema = {
  held: v => fields(v, { reason: string, since: date, updatedAt: date, ...backoff })
    && (v.reason !== 'smoke-env-timeout' || date(v.retryAt)),
  rejected: v => fields(v, { inputsKey: string, reason: string, at: date, ...backoff,
    harnessBroken: boolean, externalOnly: boolean, envLoad: boolean, dispatchSmoke: boolean })
    && (!(v.harnessBroken || v.externalOnly || v.envLoad) || date(v.retryAt)),
  adopted: v => fields(v, { head: string, inputsKey: string, applied, mainSha: string, at: date }),
  inProgress: v => fields(v, { pid: positive, host: string, startedAt: date, prevHead: string, target: string,
    inputsKey: string, mainSha: string, applied, verified: boolean }),
  quarantine: v => fields(v, { prevHead: string, reason: string }),
  unverified: v => fields(v, { head: string, prevHead: string }),
  building: v => fields(v, { token: string, pid: positive, host: string, startedAt: date,
    target: string, inputsKey: string, path: string, adoptOnly: boolean }),
  busySkippedTrees: strings,
  forceUnverifiedTrees: strings,
  smokePassed: v => Array.isArray(v) && v.every(r => fields(r, { key: string, tree: string, passedAt: date })),
  pinnedNotified: v => object(v) && Object.values(v).every(string),
};

function readState(root, env, strict, read = readFileSync) {
  try {
    const parsed = JSON.parse(read(rebuildStatePath(root, env), 'utf8'));
    if (strict && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error('Invalid rebuild state object');
    }
    if (strict) for (const [key, valid] of Object.entries(rebuildStateSchema)) {
      if (!Object.hasOwn(parsed, key) || (parsed[key] !== null && !valid(parsed[key]))) {
        throw new Error(`Invalid rebuild state ${key}`);
      }
    }
    if (strict) return parsed; // Preserve the one validated snapshot, without legacy coercion.
    return {
      adopted: parsed?.adopted ?? null,
      rejected: parsed?.rejected ?? null,
      inProgress: parsed?.inProgress ?? null,
      quarantine: parsed?.quarantine ?? null,
      unverified: parsed?.unverified ?? null,
      building: parsed?.building ?? null,
      held: parsed?.held ?? null,
      busySkippedTrees: parsed?.busySkippedTrees ?? null,
      forceUnverifiedTrees: parsed?.forceUnverifiedTrees ?? null,
      smokePassed: parsed?.smokePassed ?? null,
      pinnedNotified: parsed?.pinnedNotified ?? null,
    };
  } catch (error) {
    if (strict && error?.code !== 'ENOENT') throw error;
    return { ...EMPTY_STATE };
  }
}

/** Atomic write — `<file>.tmp-<pid>` then `renameSync`, same posture as `daemon-overlays.mjs#writeOverlays`. */
export function writeRebuildState(root, state, env = process.env) {
  rebuildReaders()?.validate(root, env);
  const file = rebuildStatePath(root, env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  // Producers materialize known policy defaults. Admission never repairs a persisted
  // file or invents missing identities, applied tips, timestamps or timeout deadlines.
  const persisted = { ...EMPTY_STATE, ...state };
  if (persisted.rejected) persisted.rejected = {
    retryAt: null, attempts: 1, harnessBroken: false, externalOnly: false, envLoad: false, dispatchSmoke: false,
    ...persisted.rejected,
  };
  writeFileSync(tmp, JSON.stringify(persisted, null, 2), 'utf8');
  renameSync(tmp, file);
}

// ── ready candidate — a PASSED smoke that could not be adopted yet (fix-rebuild-finalize) ─────────────────────
//
// Live 2026-09-26 on `wev-review-daemon`: a candidate passed its ~1-4 min off-lock smoke, then `finalizeRebuild`
// could not take the write lock within 60s because the SIBLING daemon had started a tick (read slot) during the
// smoke. The pass was thrown away; the next tick re-planned (main had moved — a new sha), re-smoked, and the
// sibling started another tick during THAT smoke. The build lease it left behind also made the sibling log
// `rebuild-in-progress` for up to 20 min. Registered overlay fixes were never adopted.
//
// Fix: a passing smoke is recorded here (`<cloneKey>.ready.json`, atomic rename, outside the git tree) BEFORE the
// finalize lock is attempted. Whichever process next holds the write lock — the mover itself on a later tick, or a
// SIBLING at its own tick start (a tick boundary: it holds no read slot then) — adopts it in `prepareRebuild`
// without re-smoking, as long as it was verified on top of the clone's CURRENT head. Written without the clone
// lock on purpose: only a build-lease holder writes it, the record fully describes itself, and every use of it
// re-checks it against the live HEAD under the write lock.

/** `<stateDir>/<cloneKey>.ready.json`. */
export function readyCandidatePath(root, env = process.env) {
  return join(stateDir(env), `${cloneKey(root)}.ready.json`);
}

/** The recorded ready candidate, or `null` (missing/corrupt reads as none — never throws). */
export function readReadyCandidate(root, env = process.env) {
  if (rebuildReaders()) return rebuildReaders().ready(root, env);
  try {
    const r = JSON.parse(readFileSync(readyCandidatePath(root, env), 'utf8'));
    return r && typeof r === 'object' && r.adopt?.finalSha && r.prevHead ? r : null;
  } catch {
    return null;
  }
}

/** Admission must distinguish absent ready evidence from unreadable or incomplete evidence. */
export function readReadyCandidateStrict(root, env = process.env, read = readFileSync, { strictPins = true, run = (args, opts) => spawnSync('git', args, opts) } = {}) {
  let text;
  try { text = read(readyCandidatePath(root, env), 'utf8'); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const r = JSON.parse(text);
  if (!fields(r, { prevHead: string, tree: string, passedAt: date, kind: v => ['candidate', 'fallback'].includes(v),
    forced: boolean, adopt: v => fields(v, { finalSha: string, inputsKey: string, mainSha: string, applied: strictPins ? pinnedApplied : appliedShape }) }, {
    at: date, token: string, pid: positive, host: string, forInputsKey: string,
    dropRefs: v => Array.isArray(v) && v.every(r => fields(r,
      { ref: string, sha: string, pr: v => v === null || positive(v) })),
    failed: v => typeof v === 'string',
  }) || (r.kind === 'fallback' && !fields(r, {
    forInputsKey: string, dropRefs: v => Array.isArray(v) && v.every(r => fields(r,
      { ref: string, sha: string, pr: v => v === null || positive(v) })),
    failed: v => typeof v === 'string',
  }))) {
    throw new Error('Invalid ready candidate');
  }
  // Validate pin provenance against the same registration and adopted second parent
  // used by planRebuild, plus the exact branch tip being held back. This supplies no
  // audit exemption: adoption still judges the applied sha through revokedAppliedTips.
  const pins = r.adopt.applied.filter(a => Object.hasOwn(a, 'pinnedFrom'));
  if (strictPins && pins.length) {
    if (!FULL_SHA_RE.test(r.prevHead) || !FULL_SHA_RE.test(r.adopt.mainSha)) throw new Error('Invalid ready pin history bounds');
    const registry = JSON.parse(read(overlayFilePath(root, env), 'utf8'));
    const git = args => run(args, { cwd: root, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' },
      encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' });
    if (verifyRev(git, 'HEAD') !== r.prevHead) throw new Error('Unproven ready pin head');
    const history = git(['log', '--first-parent', '--format=%P%x09%ce%x09%s', r.prevHead, '--not', r.adopt.mainSha]);
    if (history.status !== 0) throw new Error('Unreadable ready pin history');
    for (const pin of pins) {
      const registration = registry.overlays?.find(o => o.ref === pin.ref);
      if (!registration || (registration.pr ?? null) !== (pin.pr ?? null)
        || verifyRev(git, `refs/remotes/origin/${pin.ref}^{commit}`) !== pin.pinnedFrom) throw new Error('Unproven ready pin registration');
      const recorded = String(history.stdout).split('\n').find(line => {
        const [parents, committer, subject] = line.split('\t');
        const hit = subject?.match(/^daemon-rebuild: merge overlay (\S+) (?:\(PR #(\d+)\) )?onto /);
        return hit && hit[1] === pin.ref && (hit[2] ? Number(hit[2]) : null) === (registration.pr ?? null)
          && committer === REBUILD_IDENTITY_ENV.GIT_COMMITTER_EMAIL && [2, 3].includes(parents.split(' ').length);
      });
      if (!recorded || recorded.split('\t')[0].split(' ')[1] !== pin.sha) throw new Error('Unproven ready pin adopted head');
    }
  }
  return r;
}

export function writeReadyCandidate(root, record, env = process.env) {
  rebuildReaders()?.validate(root, env);
  try {
    const file = readyCandidatePath(root, env);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ forced: false, ...record }, null, 2), 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

export function clearReadyCandidate(root, env = process.env) {
  rebuildReaders()?.validate(root, env);
  try { unlinkSync(readyCandidatePath(root, env)); } catch { /* already gone */ }
}
