/**
 * @file scripts/lib/daemon-version-runtime.mjs
 * @description Card 89 S5 — the in-tick runtime of versioned daemon clones: rebuild -> build version -> atomic
 * switch with NO clone lock, readers that follow `current`, and the request files that replace the overlay
 * loader's lock wait. Dormant: every function answers "not versioned" (null context) unless the clone is
 * enabled in the versions settings, so an unversioned clone takes exactly the code paths it did before.
 *
 * Layout (S1): <home>/<name>/{versions/<id>, current -> versions/<id>, state.json, requests/, results/}.
 * A request is `requests/<id>.json`; the next in-tick rebuild answers it by writing `results/<id>.json` and
 * removing the request. This module never takes `daemon-clone-lock`: the switch module's own short mutex is the
 * only exclusion, and a reader keeps its version alive with a pin, not a lock.
 *
 * Known S5 limit: overlays are registered but not merged into a version build (the build is always origin/main).
 * Results say `overlaysApplied: false`; the dedicated updater (S7) takes that over.
 */
import * as filesystem from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logicalCloneRoot } from './daemon-clone-layout.mjs';
import {
  isVersionedClone, loadDaemonVersionsSettingsFile, resolveDaemonVersionsSettings,
} from './daemon-versions-settings.mjs';
import { buildVersion } from './daemon-version.mjs';
import { switchCurrent } from './daemon-version-switch.mjs';
import { gitRun } from './main-staleness.mjs';

const ID = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const RETRYABLE_SMOKE = new Set(['transient', 'auth-broken', 'env-timeout']);
const SMOKE_BACKOFF_BASE_MS = 5 * 60_000;
const SMOKE_BACKOFF_MAX_MS = 60 * 60_000;

/** True when `<clone home>/settings.local.json` holds `{"enabled": true}` (written by migrate). */
function hostEnabled(dir) {
  try { return JSON.parse(filesystem.readFileSync(join(dir, 'settings.local.json'), 'utf8'))?.enabled === true; }
  catch { return false; }
}

/** The versioned context of `root`, or null when that clone is not enabled (the default for every clone). */
export function resolveVersionedContext({ root, env = process.env, settings, settingsPath } = {}) {
  if (!root) return null;
  let values = settings ?? resolveDaemonVersionsSettings({ fileConfig: loadDaemonVersionsSettingsFile(settingsPath), env }).values;
  const clone = logicalCloneRoot(root);
  const name = basename(clone);
  const clonesRoot = values.clonesRoot ? resolve(values.clonesRoot) : join(dirname(clone), '.daemon-clones');
  if (!isVersionedClone(name, values) && settings === undefined && hostEnabled(join(clonesRoot, name))) {
    // Card 89 S6: `migrate` enables a clone on THIS host with a local file, so the flip needs no repo change
    // (a repo flip would have to be in the version before it is built). `unmigrate` removes the file.
    values = Object.freeze({ ...values, enabled: Object.freeze({ ...values.enabled, [name]: true }) });
  }
  if (!isVersionedClone(name, values)) return null;
  return { name, clone, home: clonesRoot, dir: join(clonesRoot, name), settings: values };
}

/** True when `root` is itself a version folder of `ctx` (a process booted from `current`). */
export function isInsideVersions(ctx, root) {
  return !!ctx && resolve(root).startsWith(join(ctx.dir, 'versions') + sep);
}

/** `current` as { id, dir, sha }, or null (no pointer yet / unreadable). Reads the link text, never follows it. */
export function currentVersion(ctx, { fs = filesystem } = {}) {
  try {
    const target = fs.readlinkSync(join(ctx.dir, 'current'));
    if (!target.startsWith('versions/')) return null;
    const id = target.slice('versions/'.length);
    if (!ID.test(id)) return null;
    const dir = join(ctx.dir, 'versions', id);
    const record = JSON.parse(fs.readFileSync(join(dir, '.version.json'), 'utf8'));
    return record?.id === id && typeof record.sha === 'string' ? { id, dir, sha: record.sha } : null;
  } catch { return null; }
}

function readJson(fs, path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

/** Write a JSON file atomically (temp + rename in the same directory). */
function writeAtomic(fs, path, value) {
  fs.mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp.${process.pid}.${randomBytes(3).toString('hex')}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, path);
}

/** Queue a rebuild request for the in-tick updater; returns its id. */
export function submitRequest(ctx, { ref = null, pr = null, by = null, now = Date.now, fs = filesystem } = {}) {
  const id = `${now()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  writeAtomic(fs, join(ctx.dir, 'requests', `${id}.json`), { id, ref, pr, by, at: new Date(now()).toISOString() });
  return id;
}

/** Wait for `results/<id>.json`. Resolves { status:'timeout' } instead of throwing. */
export async function waitForResult(ctx, id, {
  timeoutMs = 15 * 60_000, pollMs = ctx.settings?.requestPollMs ?? 5000, now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), fs = filesystem,
} = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    const result = readJson(fs, join(ctx.dir, 'results', `${id}.json`));
    if (result) return result;
    if (now() >= until) return { status: 'timeout', id };
    await sleep(pollMs);
  }
}

function takeRequests(ctx, fs) {
  let names = [];
  try { names = fs.readdirSync(join(ctx.dir, 'requests')); } catch { return []; }
  return names.filter((n) => n.endsWith('.json') && ID.test(n.slice(0, -5))).map((n) => n.slice(0, -5));
}

function answer(ctx, ids, result, fs) {
  for (const id of ids) {
    writeAtomic(fs, join(ctx.dir, 'results', `${id}.json`), { id, ...result, answeredAt: new Date().toISOString() });
    fs.rmSync(join(ctx.dir, 'requests', `${id}.json`), { force: true });
  }
}

/**
 * The versioned rebuild: fetch origin/main in the logical clone, build + smoke a version of it, and switch
 * `current` to it with a compare-and-swap. Returns the same shape rebuildClone does
 * ({ moved, adopted, head, reason }) so the daemon wrapper treats both alike. No lock is taken here.
 */
export async function versionedRebuild({ ctx, log = console, deps = {} }) {
  const fs = deps.fs ?? filesystem;
  const run = deps.run ?? gitRun;
  const build = deps.buildVersion ?? buildVersion;
  const swap = deps.switchCurrent ?? switchCurrent;
  const now = deps.now ?? Date.now;
  const pending = takeRequests(ctx, fs);
  const finish = (result) => {
    if (pending.length) answer(ctx, pending, { overlaysApplied: false, ...result }, fs);
    return result;
  };
  try {
    // A migrated clone has a stable bare repo (S6): fetch there and let versions borrow its objects, so no
    // version depends on another version's (or the retired legacy clone's) object store.
    const repoDir = join(ctx.dir, 'repo.git');
    const hasRepo = fs.existsSync(join(repoDir, 'HEAD'));
    const fetched = hasRepo
      ? run(['fetch', '--quiet', '--', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { cwd: repoDir, timeout: 60_000 })
      : run(['fetch', '--quiet', '--', 'origin', 'main'], { cwd: ctx.clone, timeout: 60_000 });
    if (fetched.status !== 0) return finish({ moved: false, reason: 'fetch-failed' });
    const rev = run(['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}'], { cwd: hasRepo ? repoDir : ctx.clone, timeout: 60_000 });
    const sha = String(rev.stdout ?? '').trim();
    if (rev.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return finish({ moved: false, reason: 'rev-parse-failed' });

    const cur = currentVersion(ctx, { fs });
    if (cur?.sha === sha) return finish({ moved: false, reason: 'up-to-date', head: sha });
    // A rollback holds the rejected sha until main moves: never rebuild it into a loop.
    const state = readJson(fs, join(ctx.dir, 'state.json'));
    if (state?.hold) {
      // The hold carries the rejected sha itself (gc may have pruned the version's record). Older holds
      // without one fall back to the record, and only after the version id passes the id gate.
      let heldSha = typeof state.hold.sha === 'string' ? state.hold.sha : null;
      if (!heldSha && typeof state.hold.version === 'string' && ID.test(state.hold.version)) {
        heldSha = readJson(fs, join(ctx.dir, 'versions', state.hold.version, '.version.json'))?.sha ?? null;
      }
      if (heldSha === sha) return finish({ moved: false, reason: 'held-after-rollback', head: sha });
    }
    // A transient / auth-broken / env-timeout smoke is retried with backoff, not recorded as permanent.
    const retryFile = join(ctx.dir, 'smoke-retry.json');
    const retry = readJson(fs, retryFile);
    if (retry?.sha === sha && Number.isFinite(retry.retryAt) && now() < retry.retryAt) {
      return finish({ moved: false, reason: 'smoke-backoff', head: sha, retryAt: retry.retryAt });
    }

    const built = await build({ clone: ctx.clone, home: ctx.home, sha, settings: ctx.settings, repo: hasRepo ? repoDir : undefined, deps: deps.buildDeps });
    if (built.status === 'disabled') return finish({ moved: false, reason: 'disabled' });
    const id = built.id;
    const record = readJson(fs, join(ctx.dir, 'versions', id, '.version.json'));
    if (record?.status !== 'built') {
      if (RETRYABLE_SMOKE.has(record?.smoke?.verdict)) {
        const failures = (retry?.sha === sha ? retry.failures : 0) + 1;
        const delay = Math.min(SMOKE_BACKOFF_BASE_MS * 2 ** (failures - 1), SMOKE_BACKOFF_MAX_MS);
        // Drop the failed folder (never switched to) so the next build is fresh, not a reuse of the failure.
        fs.rmSync(join(ctx.dir, 'versions', id), { recursive: true, force: true });
        writeAtomic(fs, retryFile, { sha, failures, verdict: record.smoke.verdict, retryAt: now() + delay });
        log.error?.(`daemon-version: smoke of ${sha} was ${record.smoke.verdict} — retrying in ${Math.round(delay / 1000)}s (failure ${failures})`);
        return finish({ moved: false, reason: 'smoke-retry', verdict: record.smoke.verdict, head: sha });
      }
      log.error?.(`daemon-version: version ${id} of ${sha} did not pass its smoke (${record?.status ?? 'unknown'}) — current stays put`);
      return finish({ moved: false, reason: 'smoke-failed', versionId: id, head: sha });
    }
    fs.rmSync(retryFile, { force: true });
    const switched = await swap({
      clone: ctx.clone, home: ctx.home, id, expectCurrent: cur?.id ?? null, settings: ctx.settings,
      by: 'in-tick', reason: `origin/main ${sha.slice(0, 12)}`,
    });
    if (switched.status === 'switched') {
      log.error?.(`daemon-version: switched ${ctx.name} current ${cur?.id ?? 'none'} -> ${id} (${sha.slice(0, 12)})`);
      return finish({ moved: true, adopted: true, reason: 'adopted', head: sha, versionId: id, versioned: true });
    }
    if (switched.status === 'noop') return finish({ moved: false, reason: 'up-to-date', head: sha, versionId: id });
    const reason = switched.status === 'busy' ? 'switch-busy' : (switched.reason ?? switched.status);
    return finish({ moved: false, reason, head: sha, versionId: id });
  } catch (error) {
    const reason = `error: ${String(error?.message ?? error).split('\n')[0]}`;
    finish({ moved: false, reason });
    return { moved: false, reason };
  }
}
