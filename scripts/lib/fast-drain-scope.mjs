import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { writeJsonAtomic } from './atomic-json-file.mjs';
import { withWriteLock } from './daemon-clone-lock.mjs';
import { cascadePolicy, readPlatformPreferences } from './policy-cascade.mjs';
import { readDeclaredSettings } from './settings-files.mjs';
import { validDefaultBranch } from './default-branch-cache.mjs';
import { isPinnedQueueEntryCommand } from './merge-queue-enqueue.mjs';

export const FAST_DRAIN_DEFER_KINDS = Object.freeze(new Set([
  'ordered', 'couple', 'card-group', 'manifest-unreadable', 'red-team-override',
  'couple-unknown', 'sibling-unreadable', 'hydration-race', 'budget', 'index-age',
  'index-setting', 'queue-precondition', 'incomplete-context',
].map(kind => `defer-to-pass:${kind}`)));
export const FAST_DRAIN_WRITE_KINDS = Object.freeze(new Set([
  'merge', 'refresh', 'numbering-push', 'retarget', 'dequeue', 'label-removal', 'other-pr',
  'post-conflict-finding', 'workflow-run', 'labels', 'pr-edit', 'comment', 'pr', 'graphql', 'api', 'gh', 'git', 'exec', 'prior-refusal', 'ledger',
]));
export function isFastDrainDeferKind(kind) {
  return typeof kind === 'string' && (FAST_DRAIN_DEFER_KINDS.has(kind)
    || kind.startsWith('defer-to-pass:write-boundary:') && FAST_DRAIN_WRITE_KINDS.has(kind.slice('defer-to-pass:write-boundary:'.length)));
}

/** The cwd-repo sentinel must share the full pass's persistent cache namespace. */
export function shaCacheRepo(repo, localSlug) {
  return repo || localSlug;
}

/** Safety bounds: an invalid layer refuses rather than silently falling through to a lower value. */
export function resolveFastDrainIndexSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings,
  readPlatform = readPlatformPreferences } = {}) {
  const closed = () => ({ ok: false, kind: 'defer-to-pass:index-setting', line: 'fast-drain: defer-to-pass:index-setting' });
  try {
    if (tool === undefined) {
      const settings = readSettings();
      if (settings.errors?.length || settings.duplicates?.some(d => d.path.startsWith('mergeQueue.fastDrain.index'))) return closed();
      tool = settings.settings?.mergeQueue?.fastDrain;
    }
    if (platform === undefined) {
      const p = readPlatform({ env });
      if (p.errors?.length) return closed();
      platform = p.prefs?.['mergeQueue.fastDrain.index'] !== undefined
        ? { index: p.prefs['mergeQueue.fastDrain.index'] } : p.prefs?.['mergeQueue.fastDrain'];
    }
    const validAge = v => Number.isInteger(v) && v >= 1 && v <= 120;
    const validBudget = v => Number.isInteger(v) && v >= 0 && v <= 50;
    for (const block of [tool, platform]) {
      if (block !== undefined && (block === null || typeof block !== 'object' || Array.isArray(block))) return closed();
      if (block && Object.hasOwn(block, 'index') && (!block.index || typeof block.index !== 'object' || Array.isArray(block.index))) return closed();
    }
    const parseEnv = key => env[key] === undefined ? undefined : /^\d+$/.test(env[key]) ? Number(env[key]) : null;
    const c = cascadePolicy('mergeQueue.fastDrain.index', tool?.index, { env, platform: platform?.index,
      standard: { maxAgeMinutes: 40, hydrateBudget: 10 },
      envValues: { maxAgeMinutes: parseEnv('WE_FAST_DRAIN_INDEX_MAX_AGE_MINUTES'), hydrateBudget: parseEnv('WE_FAST_DRAIN_INDEX_HYDRATE_BUDGET') },
      valid: { maxAgeMinutes: validAge, hydrateBudget: validBudget }, log: () => {} });
    if (c.invalid.length) return closed();
    const { maxAgeMinutes, hydrateBudget } = c.value;
    if (!validAge(maxAgeMinutes) || !validBudget(hydrateBudget)) return closed();
    const line = `fast-drain: mergeQueue.fastDrain.index.maxAgeMinutes=${maxAgeMinutes} (${c.sources.maxAgeMinutes}), hydrateBudget=${hydrateBudget} (${c.sources.hydrateBudget})`;
    return { ok: true, maxAgeMinutes, hydrateBudget, sources: c.sources, line };
  } catch { return closed(); }
}

export function assertFastDrainIndexAge(index, { now = Date.now(), maxAgeMinutes = 40 } = {}) {
  const stamp = index?.fetchedAtMs;
  if (!Number.isFinite(stamp) || stamp > now || now - stamp >= maxAgeMinutes * 60_000) throw new Error('defer-to-pass:index-age');
}

export function createFastDrainHydrationBudget(limit) {
  let used = 0;
  return { take({ target = false } = {}) {
    if (!target && ++used > limit) throw new Error('defer-to-pass:budget');
  }, get used() { return used; } };
}

/** Resolve standard → platform → tool → env; injected layers keep unit probes deterministic. */
export function resolveFastDrainScopeSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.mergeQueue?.fastDrain; } catch { block = undefined; }
  }
  const raw = String(env?.WE_FAST_DRAIN_SCOPE ?? '').trim().toLowerCase();
  const c = cascadePolicy('mergeQueue.fastDrain', block, {
    env, standard: { scope: 'target' }, envValues: { scope: raw || undefined },
    valid: { scope: (v) => v === 'target' || v === 'full' },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const scope = c.value.scope, source = c.sources.scope;
  const line = `fast-drain: mergeQueue.fastDrain.scope=${scope} (${source})${c.invalid.length ? ` · ignored invalid: ${c.invalid.join('; ')}` : ''}`;
  return { scope, source, line };
}

/** Resolve standard → platform → tool → env; injected layers keep unit probes deterministic. */
export function resolveFastDrainListingSetting({ env = process.env, tool, platform, readSettings = readDeclaredSettings } = {}) {
  let block = tool;
  if (block === undefined) {
    try { block = readSettings().settings?.mergeQueue?.fastDrain; } catch { block = undefined; }
  }
  const raw = String(env?.WE_FAST_DRAIN_LISTING ?? '').trim().toLowerCase();
  const contextRaw = String(env?.WE_FAST_DRAIN_CONTEXT ?? '').trim().toLowerCase();
  const c = cascadePolicy('mergeQueue.fastDrain', block, {
    env, standard: { listing: 'snapshot', context: 'snapshot' },
    envValues: { listing: raw || undefined, context: contextRaw || undefined },
    valid: { listing: (v) => v === 'snapshot' || v === 'live', context: (v) => v === 'snapshot' || v === 'live' },
    ...(platform !== undefined ? { platform } : {}), log: () => {},
  });
  const listing = c.value.listing, source = c.sources.listing;
  const context = c.value.context, contextSource = c.sources.context;
  const line = `fast-drain: mergeQueue.fastDrain.listing=${listing} (${source}), context=${context} (${contextSource})${c.invalid.length ? ` · ignored invalid: ${c.invalid.join('; ')}` : ''}`;
  return { listing, source, context, contextSource, line };
}

/** One boundary for injected writers and their subprocesses. Unknown mutations refuse. */
export function createFastDrainWriteBoundary({ writeScope = 'full', repo, num, log = () => {} } = {}) {
  const limited = writeScope === 'enqueue-only';
  let confirmed = false;
  const violations = [];
  const refuse = kind => {
    const reason = `defer-to-pass:write-boundary:${kind}`;
    violations.push(reason);
    throw Object.assign(new Error(reason), { kind: reason });
  };
  const target = (r, n) => { if (limited && (r !== repo || Number(n) !== Number(num))) refuse('other-pr'); };
  const allow = kind => { if (limited) log(`fast-drain write: ${repo}#${num} ${kind}`); };
  const labels = (r, n, plan) => {
    if (!limited) return;
    target(r, n);
    if (!Array.isArray(plan?.remove ?? [])) refuse('label-removal');
    const remove = plan.remove ?? [];
    if (remove.length && !(plan.add === 'red-team:clear' && remove.every(l => l === 'red-team:pending'))) refuse('label-removal');
    if (plan.add && !['review:changes', 'red-team:pending', 'red-team:blocked', 'red-team:clear'].includes(plan.add)) refuse('labels');
  };
  return {
    limited, violations, refuse, target, repo, num,
    fullPassDuty: (fn, fallback) => limited ? fallback : fn(),
    confirm: () => { confirmed = true; },
    helper: (kind, fn) => (...args) => {
      if (limited && !['hold-comment', 'red-team-request', 'local-state', 'operator-feed', 'enqueue'].includes(kind)
        && !(confirmed && ['clearance-stamp', 'ledger'].includes(kind))) refuse(kind);
      allow(kind); return fn(...args);
    },
    labelProvider: provider => !limited ? provider : { ...provider,
      // The full pass provisions repository labels; a child only edits target membership.
      ensureLabel: () => {},
      setLabels: (r, n, plan) => { labels(r, n, plan); allow('labels'); return provider.setLabels(r, n, plan); },
    },
    exec: run => (file, args, options) => {
      if (!limited) return run(file, args, options);
      const value = flag => args[args.indexOf(flag) + 1];
      if (file === 'git') {
        // Net-diff readers pin these inert settings before the verb. Unknown
        // configuration stays closed: stripping arbitrary -c options can run aliases.
        const safeConfig = new Set(['core.quotepath=false', 'color.ui=never', 'diff.noprefix=false',
          'diff.external=', 'diff.srcPrefix=a/', 'diff.dstPrefix=b/', 'diff.mnemonicPrefix=false',
          'core.attributesFile=/dev/null']);
        let verbArgs = args;
        while (verbArgs[0] === '-c') {
          if (!safeConfig.has(verbArgs[1])) refuse('git');
          verbArgs = verbArgs.slice(2);
        }
        if (verbArgs[0] === 'push') refuse('numbering-push');
        if (!(verbArgs[0] === 'commit-graph' && verbArgs[1] === 'verify') && !['diff', 'show', 'ls-tree', 'rev-parse', 'ls-remote', 'fetch', 'cat-file', 'grep', 'remote', 'status', 'log', 'config', 'merge-base'].includes(verbArgs[0])) refuse('git');
      } else if (file === 'gh') {
        if (args[0] === 'pr' && !['view', 'list', 'diff', 'checks'].includes(args[1])) {
          target(args.includes('--repo') ? value('--repo') : repo, args[2]);
          if (args[1] === 'merge') refuse('merge');
          if (args[1] === 'update-branch') refuse('refresh');
          if (args[1] === 'edit') {
            if (args.includes('--base')) refuse('retarget');
            const add = args.flatMap((a, i) => a === '--add-label' ? args[i + 1].split(',') : []);
            const remove = args.flatMap((a, i) => a === '--remove-label' ? args[i + 1].split(',') : []);
            labels(repo, num, { add: add.length === 1 ? add[0] : add.length ? 'unknown' : null, remove });
            if (args.some(a => a.startsWith('--') && !['--repo', '--add-label', '--remove-label'].includes(a))) refuse('pr-edit');
            allow('labels');
          } else if (args[1] === 'comment') {
            const body = value('--body');
            if (!(typeof body === 'string' && (/^<!-- we-drain-poison head=[a-f0-9]{40} kind=bornas-collision /.test(body)
              || confirmed && body.startsWith('<!-- we-drain-enqueue-clearance head=')))) refuse('comment');
            allow(confirmed ? 'clearance-stamp' : 'hold-comment');
          } else refuse('pr');
        } else if (args[0] === 'api') {
          const query = args.find(a => typeof a === 'string' && a.startsWith('query='));
          if (query && /\bmutation\b/.test(query)) {
            if (query.includes('dequeuePullRequest')) refuse('dequeue');
            if (!isPinnedQueueEntryCommand(args)) refuse('graphql');
            if (violations.length) refuse('prior-refusal');
            allow('enqueue');
          } else if (args.includes('--method') && value('--method') !== 'GET' || args.includes('-X') && value('-X') !== 'GET'
            || !query && args.some(a => ['-f', '-F', '--field', '--raw-field', '--input'].includes(a))) refuse('api');
        } else if (args[0] === 'run') {
          if (!['view', 'list'].includes(args[1])) refuse('workflow-run');
        } else if (!(args[0] === 'repo' && args[1] === 'view') && args[0] !== 'pr' && args[0] !== 'search') refuse('gh');
      } else refuse('exec');
      return run(file, args, options);
    },
  };
}

/** Replace the live target while preserving snapshot context without mutating either input. */
export function mergeLiveTargetIntoRows(snapshotRows, targetRow, onlyPr) {
  const keepTarget = targetRow != null && (targetRow.state === undefined || targetRow.state === 'OPEN');
  let found = false;
  const rows = snapshotRows.flatMap((row) => {
    if (String(row.number) !== String(onlyPr)) return [row];
    found = true;
    return keepTarget ? [targetRow] : [];
  });
  if (keepTarget && !found) rows.push(targetRow);
  return rows;
}

export function shouldReadContextCommits({ onlyPr, scope, isTarget }) {
  return onlyPr == null || scope !== 'target' || isTarget;
}

export function filterToFastDrainTarget(prs, { onlyPr, scope, isTarget }) {
  return onlyPr != null && scope === 'target' ? prs.filter(isTarget) : prs;
}

/**
 * Cache only an answer read from the head sha itself (`definitive`), found or absent. A fallback-ref read
 * (stale origin ref, same-named local branch, FETCH_HEAD another drain moved) is returned but stays retryable.
 */
export async function readLegacyManifestCached({ repo, num, sha, readCache, writeCache, readLegacy }) {
  if (!sha) { const r = await readLegacy(); return { manifest: r.manifest, definitive: false, unreadable: !!r.unreadable }; }
  // v2: entries written under the earlier fetchSucceeded rule could hold a fallback ref's manifest.
  const key = { repo, num, sha, kind: 'legacy-manifest-v2' };
  const cached = readCache(key);
  if (cached !== undefined) return { manifest: cached, definitive: true, unreadable: false };
  const { manifest, definitive, unreadable } = await readLegacy();
  if (definitive) writeCache({ ...key, value: manifest });
  return { manifest, definitive: !!definitive, unreadable: !!unreadable };
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const MANIFEST_PATH = '.lane-manifest.json';

/**
 * Read the tree-committed `.lane-manifest.json` for one PR head. `git(args)` returns stdout or throws.
 * With a full head sha, only that commit answers (fetching it when missing — the PR's own
 * `refs/pull/<n>/head` first, which origin keeps for every open PR, forks included, then `headRef`):
 * FETCH_HEAD, origin/<ref> and a same-named local branch can only name ANOTHER commit there, and FETCH_HEAD is
 * shared by every drain process in the clone. "No manifest" is definitive only when ls-tree lists the head
 * tree without the file. A head that stays unreadable (missing after both fetches, or an ls-tree/show error)
 * returns `unreadable` so the caller fails closed for this pass instead of reading it as "not a carrier".
 * Without a usable sha, nothing can be verified as the head, so it is `unreadable` too.
 * `headRef` is a gh-supplied refname and may lead with a dash, so every ref argument sits behind --end-of-options.
 * @returns {{manifest: object|null, definitive: boolean, unreadable: boolean}}
 */
export function readLegacyLocalManifestAt({ headRef, headSha, prNumber, git }) {
  const sha = typeof headSha === 'string' && FULL_SHA.test(headSha) ? headSha : null;
  const parse = (raw) => { try { const m = JSON.parse(raw); return m && m.item != null ? m : null; } catch { return null; } };
  const fetch = (ref) => {
    try { git(['fetch', '--quiet', '--end-of-options', 'origin', ref]); } catch { /* ref may be local */ }
  };
  const unreadable = { manifest: null, definitive: false, unreadable: true };
  if (sha) {
    const hasHead = () => {
      try { git(['cat-file', '-e', '--end-of-options', `${sha}^{commit}`]); return true; } catch { return false; }
    };
    if (!hasHead() && Number.isSafeInteger(prNumber) && prNumber > 0) fetch(`refs/pull/${prNumber}/head`);
    if (!hasHead() && headRef) fetch(headRef);
    if (!hasHead()) return unreadable;
    let listed;
    try { listed = git(['ls-tree', '--end-of-options', sha, '--', MANIFEST_PATH]); } catch { return unreadable; }
    if (!String(listed ?? '').trim()) return { manifest: null, definitive: true, unreadable: false };
    let raw;
    try { raw = git(['show', '--end-of-options', `${sha}:${MANIFEST_PATH}`]); } catch { return unreadable; }
    // A commit's bytes never change, so even an unparseable manifest is a final answer.
    return { manifest: parse(raw), definitive: true, unreadable: false };
  }
  // No usable head sha (the listing always supplies headRefOid, so this is not expected): no ref can be
  // verified as the head, and FETCH_HEAD may hold another process's PR — fail closed rather than guess.
  return unreadable;
}


/** Invalid bounds retain the standard 60s live-refresh fallback. */
export function roundSnapshotTtl(env) {
  const raw = env.WE_FAST_DRAIN_LISTING_SNAPSHOT_TTL_SEC;
  const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  const valid = Number.isFinite(number) && number >= 0;
  return { seconds: valid ? number : 60, source: valid ? 'env' : 'standard' };
}

/** A round cache is advisory context only: reject incomplete, foreign or expired evidence. */
function readFastDrainRoundRecord({ path, repo, now = Date.now(), env = process.env,
  read = (p) => { if (statSync(p).size > 64 * 1024 * 1024) throw new Error('snapshot too large'); return readFileSync(p, 'utf8'); },
} = {}) {
  const { seconds: ttlSec } = roundSnapshotTtl(env);
  try {
    const raw = read(path);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024 * 1024) return null;
    const snap = JSON.parse(raw);
    if (snap?.repo !== repo || typeof snap.writtenAt !== 'number' || !Number.isFinite(snap.writtenAt)
      || now < snap.writtenAt || now - snap.writtenAt >= ttlSec * 1000) return null;
    return snap;
  } catch { return null; }
}

export function readFastDrainRoundSnapshot(options) {
  const snap = readFastDrainRoundRecord(options);
  if ((options?.requireDefaultBranch && (typeof snap?.defaultBranch !== 'string' || !snap.defaultBranch.trim()))
      || !Array.isArray(snap?.rows)
      || !snap.rows.every(row => Number.isInteger(row?.number) && row.number > 0
        && typeof row.headRefOid === 'string' && row.headRefOid.length > 0
        && typeof row.baseRefName === 'string' && row.baseRefName.length > 0
        && Array.isArray(row.labels) && row.labels.every(l => typeof l?.name === 'string')
        && Array.isArray(row.statusCheckRollup))) return null;
  return snap;
}

/** Parent catch-up writes only branch metadata; it never claims a partial PR set is complete. */
export function writeFastDrainRoundDefaultBranch({ path, repo, defaultBranch, observedAt, write = writeJsonAtomic }) {
  if (!validDefaultBranch(defaultBranch) || !Number.isFinite(observedAt)) return false;
  try { write(path, { repo, writtenAt: observedAt, defaultBranch, defaultBranchReadAt: observedAt }); return true; } catch { return false; }
}

export function readFastDrainRoundDefaultBranch(options) {
  const name = readFastDrainRoundRecord(options)?.defaultBranch;
  return validDefaultBranch(name) ? name : null;
}

/** The shared writer lock waits for readers, but refuses another writer immediately. Wait for that
 * writer here so simultaneous cold children do not all fall back live. Directory identity stays stable
 * across creation of the snapshot file (realpath of an absent file can differ on symlinked temp roots).
 */
export async function withFastDrainRoundLock(path, fn, { owner = `${hostname()}:${randomUUID()}`, waitMs = 180_000, pollMs = 1000, sleep = delay } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const result = await withWriteLock(dirname(path), fn, { owner, lockRoot: `${path}.locks`, waitMs: Math.max(0, deadline - Date.now()) });
    // acquireWrite checks PID liveness and the heartbeat lease on EVERY attempt, reclaiming dead/stale
    // writers. A healthy writer may take longer than a cold listing; elapsed waiter time is not death.
    if (result.ok) return result;
    if (Date.now() >= deadline) return { ok: false, reason: 'round-lock-deadline' };
    if (result.reason !== 'concurrent-mover') return result;
    await sleep(Math.min(pollMs, deadline - Date.now()));
  }
}

/** Populate once across concurrent catch-up children; always replace the target with a live read.
 * The shared host snapshot still seeds listLive's heavy fields. This short-lived round file saves the
 * pages/checks reads too. A failed target read propagates; it can never resurrect the cached target.
 */
export async function readFastDrainRoundListing({ path, repo, onlyPr, env = process.env, now,
  read, write = writeJsonAtomic, listLive, readTarget, defaultBranch = () => null,
  reuseDefaultBranch = () => {}, requireDefaultBranch = false,
  log = line => process.stderr.write(`${line}\n`),
  lock = fn => withFastDrainRoundLock(path, fn),
}) {
  const clock = () => now ?? Date.now();
  const ttl = roundSnapshotTtl(env);
  const hasBranch = snap => !requireDefaultBranch || (typeof snap?.defaultBranch === 'string' && !!snap.defaultBranch.trim());
  const populate = async ({ liveOnly = false, stillHeld } = {}) => {
    const snap = liveOnly ? null : readFastDrainRoundSnapshot({ path, repo, env, now: clock(), read });
    if (snap && hasBranch(snap)) return { ...snap, hit: true };
    const rows = snap?.rows ?? await listLive();
    const branch = await defaultBranch();
    if (requireDefaultBranch && !hasBranch({ defaultBranch: branch })) throw new Error('round listing default branch unreadable — retry next pass');
    if (!liveOnly && (typeof stillHeld !== 'function' || !stillHeld())) {
      throw new Error('round listing lock unavailable (lock-lost) — retry next pass');
    }
    try { if (!liveOnly) write(path, { repo, writtenAt: snap?.writtenAt ?? clock(), rows, defaultBranch: branch }); }
    catch { /* Unwritable cache costs a live listing next time; it never authorizes a cached target. */ }
    return { rows, defaultBranch: branch, hit: !!snap };
  };
  // Hits do not need the population lock. Misses re-check inside it after a sibling's write.
  const snap = readFastDrainRoundSnapshot({ path, repo, env, now: clock(), read });
  let base;
  if (snap && hasBranch(snap)) base = { ...snap, hit: true };
  else {
    let entered = false;
    let locked;
    try { locked = await lock(stillHeld => { entered = true; return populate({ stillHeld }); }); }
    catch (error) {
      if (entered) throw error; // The live reader failed: propagate it, never retry it as a cache error.
      throw new Error('round listing lock unreadable — retry next pass', { cause: error });
    }
    if (!locked.ok && locked.reason === 'round-lock-deadline') {
      log('fast-drain: round listing lock wait deadline expired — falling back to exact live listing');
      base = await populate({ liveOnly: true });
    } else {
      if (!locked.ok) throw new Error(`round listing lock unavailable (${locked.reason || 'unknown'}) — retry next pass`);
      base = locked.value;
    }
  }
  log(`fast-drain: ${base.hit ? 'served-from-snapshot' : 'listed-live'} (round listing; TTL=${ttl.seconds}s, source=${ttl.source})`);
  reuseDefaultBranch(base.defaultBranch);
  if (typeof readTarget !== 'function') throw new Error('round listing live target reader missing — retry next pass');
  const target = await readTarget();
  if (!target || String(target.number) !== String(onlyPr) || !['OPEN', 'CLOSED', 'MERGED'].includes(target.state)) {
    throw new Error('round listing live target unreadable');
  }
  return mergeLiveTargetIntoRows(base.rows, target, onlyPr);
}
