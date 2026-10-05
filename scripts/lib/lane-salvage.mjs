/**
 * @file scripts/lib/lane-salvage.mjs
 * @description SNAPSHOT-THEN-RECLAIM for an abandoned pool lane.
 *
 * WHY. The lane pool starved to ZERO acquirable lanes (2026-09-27, 90-lane WE pool: 16 leased, 74 unleased but
 * dirty). Finished or killed sessions left uncommitted edits, unpushed commits and `.claude/worktrees/*`
 * litter behind. `lane-whois.mjs` rightly refuses to auto-reclaim a lane whose content it cannot prove is
 * already on a remote ref (`finished-needs-review` / `unknown-work`). So those lanes were kept forever, and
 * the review daemon deferred every owed review ("no acquirable lane this tick").
 *
 * Deleting that work is unsafe. Keeping it forever starves the pool. This module is the third option: save
 * everything durably and recoverably FIRST, prove the save, and only then let `lane-pool.mjs reclaim
 * --salvage` reset the lane. The layout matches the operator's manual salvage of 2026-09-26 21:36 ET:
 *
 *   <salvageRoot>/<pool>/<stamp>/lane-N.bundle             git bundle of every salvage ref (minus origin/<branch>)
 *   <salvageRoot>/<pool>/<stamp>/lane-N.uncommitted.patch  `git diff --binary HEAD <wip>` (tracked + untracked)
 *   <salvageRoot>/<pool>/<stamp>/lane-N.unpushed.txt       `git log --oneline origin/<branch>..HEAD`
 *   <salvageRoot>/index.jsonl                              one line per salvaged lane (what, where, why)
 *   refs/salvage/lane-N-<stamp>-head / -wip                 also kept in the lane's own repo
 *
 * A registered worktree under `<lane>/.claude/worktrees/` (litter from the bg-isolation EnterWorktree episode)
 * is snapshotted the same way (`...-wt-<name>-head/-wip`) into the SAME bundle, then removed with
 * `git worktree remove --force` + `git worktree prune` — never an `rm -rf`.
 *
 * #4273 — an ORDINARY (non-git) file or directory sitting directly under `.claude/worktrees/` WITHOUT ever
 * having been registered via `git worktree add` is invisible to all of the above: it is not a dirty path
 * (`isWorktreeLitterPath` deliberately excludes the whole prefix, on the assumption registered-worktree
 * scanning already covers it) and it is not a registered worktree, so `git clean -fd` deletes it outright on
 * reclaim with nothing ever having captured it. {@link listUnregisteredWorktreeLitter} finds exactly that
 * content (including a file/dir sitting BESIDE a registered worktree, deeper in the tree — the mixed-ancestor
 * case), {@link newestContentMtimeMs} now folds its mtimes into the quiet-period check, and {@link salvageLane}
 * copies each item verbatim (never dereferencing a symlink) into `<prefix>.wt-litter/<relative-path>` —
 * mirroring the original layout under `.claude/worktrees/` exactly, so distinct items can never collide on a
 * shared destination — before the caller's `git clean -fd` runs. The copy is recorded on the salvage record's
 * `litter` array so it is indexed and findable exactly like the bundle/patches are.
 *
 * Recover: `git fetch <bundle> 'refs/salvage/*:refs/salvage/*'` in any WE clone, or `git apply` the patch, or
 * (for `litter` entries) just read/copy back the plain file(s) at each entry's `dest`.
 *
 * PURE CORE / IO SHELL: {@link salvageStamp}, {@link salvageRefNames}, {@link salvageEligibility},
 * {@link parseLsofCwds} and {@link isWorktreeLitterPath} are pure. Everything else shells git/lsof/fs.
 */
import { cachedClaudeAgents } from './claude-agents-cache.mjs';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, appendFileSync, statSync, existsSync, realpathSync,
  readFileSync, readdirSync, lstatSync, copyFileSync, symlinkSync, readlinkSync, constants as fsConstants,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { LEASE_FILENAME } from './lane-lease.mjs';

/** Env override for where salvage lands; default `~/.claude/lane-salvage` (the operator's manual location). */
export const SALVAGE_DIR_ENV = 'WE_LANE_SALVAGE_DIR';
/** Env override (minutes) for the quiet period: a lane touched more recently than this is never salvaged. */
export const SALVAGE_QUIET_ENV = 'WE_LANE_SALVAGE_QUIET_MIN';
export const DEFAULT_SALVAGE_QUIET_MIN = 30;
export const WORKTREE_LITTER_PREFIX = '.claude/worktrees/';

export function resolveSalvageRoot(env = process.env, home = homedir()) {
  return env[SALVAGE_DIR_ENV] && env[SALVAGE_DIR_ENV].trim() ? env[SALVAGE_DIR_ENV].trim() : join(home, '.claude', 'lane-salvage');
}

export function resolveSalvageQuietMs(env = process.env) {
  const n = Number(env[SALVAGE_QUIET_ENV]);
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_SALVAGE_QUIET_MIN) * 60_000;
}

/** PURE: a sortable UTC stamp, `YYYYMMDD-HHMMSS`. */
export function salvageStamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
}

/** PURE: the salvage ref pair for a lane (or one of its worktrees). Same shape as the manual salvage's refs. */
export function salvageRefNames({ lane, stamp, worktree = null }) {
  const safeWt = worktree ? String(worktree).replace(/[^A-Za-z0-9._-]/g, '_') : null;
  const base = `refs/salvage/lane-${lane}-${stamp}${safeWt ? `-wt-${safeWt}` : ''}`;
  return { head: `${base}-head`, wip: `${base}-wip` };
}

/** PURE: is a porcelain path worktree litter (handled by the worktree snapshot, never by `git add`)? */
export function isWorktreeLitterPath(p) {
  return String(p || '').replace(/^\.\//, '').startsWith(WORKTREE_LITTER_PREFIX);
}

/**
 * PURE: parse `lsof -d cwd -Fpn` output into `[{pid, cwd}]`.
 * @param {string} text
 */
export function parseLsofCwds(text) {
  const out = [];
  let pid = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && Number.isInteger(pid)) out.push({ pid, cwd: line.slice(1) });
  }
  return out;
}

/** PURE: the not-finished `claude agents` entries that belong to this lane — the session is one of `sessionIds`,
 *  (supplied only from the current lease), or its cwd is the lane or anywhere inside it (a `.claude/worktrees/<x>` agent counts). An entry with no
 *  state at all is kept: only an explicit terminal state proves a session finished. The ONE match rule shared by
 *  {@link liveAgentInLane} (fail-safe) and whois's stricter `liveWorker` (#4544). */
export function agentsInLane(agents, dir, sessionIds = []) {
  const DONE = new Set(['done', 'failed', 'stopped', 'completed', 'killed']);
  const root = resolve(dir);
  const ids = new Set(sessionIds.filter((id) => typeof id === 'string' && id.trim() && !/^.+:\d+$/.test(id)));
  return (Array.isArray(agents) ? agents : []).filter((a) => {
    if (!a || DONE.has(a.state)) return false;
    const cwd = typeof a.cwd === 'string' && a.cwd.trim() ? resolve(a.cwd) : '';
    return ids.has(a.sessionId) || cwd === root || cwd.startsWith(root + sep);
  });
}

/** Only a CURRENT lease supplies owner identities. Ledger entries are attribution, never ownership.
 * Host:pid fallback slugs are excluded by agentsInLane: a reused pid is not a session identity. */
export function leaseSessionIds(lease) {
  return [lease?.ownerSession, lease?.workerSession, lease?.session];
}

/** PURE: does any not-finished `claude agents` entry belong to this lane? Fail-safe: a merely-listed entry counts. */
export function liveAgentInLane(agents, dir, sessionIds = []) {
  return agentsInLane(agents, dir, sessionIds).length > 0;
}

/** `claude agents --json`, FAIL-CLOSED: `null` when it cannot be read (callers then refuse to salvage). */
export function readAgentsStrict({ exec = execFileSync } = {}) {
  try {
    const parsed = JSON.parse(cachedClaudeAgents({ fetch: () => exec('claude', ['agents', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 }) }));
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

/** PURE: the pids (other than `selfPid`) whose cwd is `dir` or inside it. */
export function pidsWithCwdIn(cwds, dir, selfPid = process.pid) {
  const root = resolve(dir);
  let real = root;
  try { real = realpathSync(root); } catch { /* pure callers pass synthetic paths */ }
  return cwds
    .filter((c) => c.pid !== selfPid && [root, real].some((r) => c.cwd === r || c.cwd.startsWith(r + sep)))
    .map((c) => c.pid);
}

/**
 * PURE: may this lane be salvaged-and-reset automatically right now? Every guard must pass:
 *   - not leased (a live lease means someone is using it),
 *   - no live owner session (`lane-whois.mjs`'s `liveOwner` — a `claude agents` hit),
 *   - no live process has its cwd inside the lane (a shell or agent still sitting there),
 *   - quiet: nothing in the lane changed within `quietMs` (a session mid-edit is never snapshotted under it).
 * @param {{leased:boolean, liveOwner:boolean, livePids:number[], newestMtimeMs:(number|null), nowMs:number, quietMs:number}} f
 * @returns {{eligible:boolean, reason:string}}
 */
export function salvageEligibility({ leased, liveOwner, livePids = [], newestMtimeMs = null, nowMs, quietMs }) {
  if (leased) return { eligible: false, reason: 'lane is leased — never salvaged under a live holder' };
  if (liveOwner) return { eligible: false, reason: 'owning session is still live (claude agents)' };
  if (livePids.length) return { eligible: false, reason: `live process(es) have cwd in the lane: pid ${livePids.join(', ')}` };
  if (Number.isFinite(newestMtimeMs)) {
    // #xl5xhmj — CLAMPED to 0: a file's on-disk mtime can land a few ms AFTER `nowMs` was sampled (ordinary
    // mtime/clock granularity between the write and the later `Date.now()` read — no specific file needs to be
    // implicated for this to happen). An unclamped negative "elapsed" is nonsensical: a NEGATIVE number
    // and a CLAMPED zero read identically (both < any positive `quietMs`) at every quiet period big enough to
    // dwarf a few ms of skew — the real 30-minute production default (`lane-pool.mjs#cmdReclaim` never overrides
    // `quietMs`) among them, so the clamp changes no production verdict there. It matters at `quietMs: 0` — an
    // immediate-reset caller, which today is only THIS ITEM'S OWN test suite
    // (`lane-pool-reclaim.test.mjs`'s `WE_LANE_SALVAGE_QUIET_MIN=0`) — where a negative elapsed would wrongly
    // refuse a lane that is, at a zero threshold, trivially already quiet.
    const elapsedMs = Math.max(0, nowMs - newestMtimeMs);
    if (elapsedMs < quietMs) {
      const mins = Math.round(elapsedMs / 60_000);
      return { eligible: false, reason: `lane content changed ${mins} min ago (< ${Math.round(quietMs / 60_000)} min quiet period)` };
    }
  }
  return { eligible: true, reason: 'unleased, no live owner or process, quiet' };
}

// ── IO shell ────────────────────────────────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 120_000;
const git = (dir, args, extra = {}) => execFileSync('git', args, {
  cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: GIT_TIMEOUT_MS, ...extra,
});

/** Every live process's cwd, via one `lsof` call. `null` when lsof is unavailable (callers treat as unknown ⇒ not eligible). */
export function readLiveCwds({ exec = execFileSync } = {}) {
  try {
    // lsof exits 1 when some processes are unreadable; the output is still valid, so read it from the error too.
    return parseLsofCwds(exec('lsof', ['-n', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }));
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout.length) return parseLsofCwds(e.stdout);
    return null;
  }
}

/** Porcelain paths (NUL-safe), `-uall`, split into tracked-changed and untracked, worktree litter excluded. */
function dirtyPaths(dir) {
  const raw = git(dir, ['status', '--porcelain=v1', '-z', '-uall']);
  const entries = raw.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const code = e.slice(0, 2);
    const p = e.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // rename/copy: next entry is the source path
    if (!isWorktreeLitterPath(p)) paths.push(p);
  }
  return paths;
}

/** Registered worktrees physically under `<dir>/.claude/worktrees/`. */
export function listLitterWorktrees(dir) {
  // `git worktree list` prints REAL paths (macOS: /private/var/… for a /var/… tmpdir) — compare real to real.
  let root = resolve(dir, '.claude', 'worktrees');
  try { root = join(realpathSync(dir), '.claude', 'worktrees'); } catch { /* keep the resolved path */ }
  const out = [];
  let cur = null;
  for (const line of git(dir, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9) }; out.push(cur); }
  }
  return out
    .filter((w) => w.path.startsWith(root + sep))
    .map((w) => ({ path: w.path, name: w.path.slice(root.length + 1) }));
}

/** Does `dirAbs` (a real, absolute path) have any registered worktree root somewhere beneath it? PURE-ish
 *  (no IO — `registered` is a Set of already-resolved worktree paths). */
function containsRegisteredDescendant(dirAbs, registered) {
  const prefix = dirAbs + sep;
  for (const r of registered) if (r.startsWith(prefix)) return true;
  return false;
}

/**
 * Ordinary (non-git-worktree) content sitting directly under `<dir>/.claude/worktrees/`, or nested beside a
 * registered worktree deeper in that tree — content that was never `git worktree add`-ed, so
 * {@link listLitterWorktrees} never sees it, and `isWorktreeLitterPath` keeps it out of `dirtyPaths()` too
 * (on the — here false — assumption registered-worktree scanning already covers it). #4273.
 *
 * Returns the SHALLOWEST unregistered path at each spot: a whole directory when none of its descendants is a
 * registered worktree root (so a caller can copy it whole), or, when a directory MIXES an unregistered sibling
 * with a registered worktree root ANYWHERE beneath it, descends into it (recursively, to whatever depth the
 * mixing actually occurs at — not just one level) to still catch that sibling. Uses `lstatSync` throughout
 * (never follows a symlink) so a symlinked entry is treated as one leaf item, never dereferenced into — no
 * loops, and no copying content the symlink merely points at. Each item's `rel` is its path relative to
 * `.claude/worktrees/`, stable regardless of the lane's raw vs. real path.
 *
 * Only a genuinely absent `.claude/worktrees/` (no worktree/isolation feature ever touched this lane) returns
 * `[]`; any OTHER read failure (permission, a path that vanished mid-walk) propagates — this must never read
 * as "nothing here" the way a lost race could.
 */
export function listUnregisteredWorktreeLitter(dir) {
  let root = resolve(dir, '.claude', 'worktrees');
  try { root = join(realpathSync(dir), '.claude', 'worktrees'); } catch { /* keep the resolved path */ }
  // `existsSync` alone would swallow ANY stat failure (a permission error partway up the path, a dangling
  // symlink) and read it as "absent" — exactly the "unreadable silently looks like nothing here" outcome this
  // function must never produce (#4273 review). Only a genuine ENOENT means "no worktree/isolation feature
  // ever touched this lane"; anything else propagates.
  try { lstatSync(root); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const registered = new Set(listLitterWorktrees(dir).map((w) => w.path));
  const out = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      const r = rel ? join(rel, name) : name;
      if (registered.has(p)) continue; // exactly a registered worktree root — handled elsewhere
      const st = lstatSync(p);
      if (st.isDirectory() && containsRegisteredDescendant(p, registered)) walk(p, r); // mixed ancestor — descend
      else out.push({ path: p, rel: r });
    }
  };
  walk(root, '');
  return out;
}

/** Newest mtime (ms) across a set of paths, recursing into real directories only (never a symlink). No
 *  try/catch: an unreadable entry must never be silently treated as absent/quiet (#4273) — it propagates to
 *  the caller instead. (`we:scripts/lane-pool.mjs`'s salvage gate, at the time of writing, wraps its own call
 *  to {@link newestContentMtimeMs} in a try/catch that treats any thrown error as "changed just now" —
 *  fail-closed — but that is that OTHER file's contract, unverified by any test in THIS one; read it there
 *  rather than trusting this comment alone.) */
function newestLitterMtimeMs(items) {
  let newest = null;
  const visit = (p) => {
    const st = lstatSync(p);
    if (newest === null || st.mtimeMs > newest) newest = st.mtimeMs;
    if (st.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
  };
  for (const it of items) visit(it.path);
  return newest;
}

/** Nearest statable parent mtime, bounded by the scanned lane/worktree root (inclusive).
 * Returns null when no ancestor within that boundary can be statted; callers remain fail-closed.
 */
export function nearestAncestorMtimeMs(path, stop, stat = statSync) {
  const root = resolve(stop);
  let parent = dirname(resolve(path));
  while (parent === root || parent.startsWith(root.endsWith(sep) ? root : root + sep)) {
    try {
      const mtime = stat(parent).mtimeMs;
      if (Number.isFinite(mtime)) return mtime;
    } catch { /* try the next surviving ancestor, never above the scanned root */ }
    if (parent === root) break;
    parent = dirname(parent);
  }
  return null;
}

/**
 * Newest mtime (ms) across the lane's dirty paths, its HEAD reflog, each litter worktree's own, and (#4273)
 * any UNREGISTERED content under `.claude/worktrees/` too — a lane touched only there is not quiet.
 *
 * #xl5xhmj — deliberately does NOT stat `.git/index`. A plain, read-only `git status` can itself REWRITE
 * `.git/index` on disk (git's own "racy index" cache refresh, opportunistically re-recording each entry's
 * cached stat data), bumping the index's own mtime to "now" with no real content change involved — live-
 * verified (`we:scripts/__tests__/lane-pool-reclaim.test.mjs`'s "genuinely quiet" test reddened intermittently,
 * ~2 of 3 runs, from exactly this). Reading the index before THIS function's own `dirtyPaths` call cannot close
 * that race: `laneLivenessGate` is reached from `cmdReclaim` AFTER `laneReclaimPreservationProof` has ALREADY
 * run its own `git status` (`gitStatusSummary`, `we:scripts/lane-whois.mjs`) moments earlier in the same call —
 * so ANY ordering local to this one function still reads an index an EARLIER, unrelated status call may have
 * just rewritten. The race lives in "a status call ran somewhere in the surrounding pipeline", which no
 * ordering within this one function can bound.
 *
 * Coverage this still keeps for a STAGED/WORKING-TREE DELETION (a path `dirtyPaths` reports as dirty that no
 * longer exists on disk to `stat`, e.g. `git rm`, or a plain `rm` of a tracked file): rather than reach for the
 * index's own unreliable mtime, use the nearest surviving ancestor directory's mtime, bounded by the
 * scanned lane/worktree root. A deletion updates its parent directory; that stable timestamp lets the
 * deletion eventually age out. Only when no ancestor can be statted do we fall back to Date.now()
 * (fail-closed). `.git/logs/HEAD` needs
 * no such fallback: it is only ever written by a REAL ref-moving operation (commit/reset/checkout/merge), never
 * as a side effect of a read-only status call, so its own mtime is trustworthy exactly as read.
 */
export function newestContentMtimeMs(dir) {
  let newest = null;
  const bump = (m) => { if (Number.isFinite(m) && (newest === null || m > newest)) newest = m; };
  const statMtime = (p) => { try { return statSync(p).mtimeMs; } catch { return null; } };
  const scan = (d) => {
    for (const p of dirtyPaths(d)) {
      const m = statMtime(join(d, p));
      bump(m ?? nearestAncestorMtimeMs(join(d, p), d) ?? Date.now());
    }
    const gitDir = resolve(d, git(d, ['rev-parse', '--git-dir']).trim());
    bump(statMtime(join(gitDir, 'logs', 'HEAD')));
  };
  scan(dir);
  for (const w of listLitterWorktrees(dir)) { try { scan(w.path); } catch { /* broken worktree — its salvage will say so */ } }
  const litterNewest = newestLitterMtimeMs(listUnregisteredWorktreeLitter(dir));
  if (litterNewest !== null && (newest === null || litterNewest > newest)) newest = litterNewest;
  return newest;
}

/**
 * THE ONE liveness gate — "is it safe to act on this unleased lane RIGHT NOW, or does something still call it
 * home?" (#xl5xhmj). Originally inline in `we:scripts/lane-pool.mjs#cmdReclaimSalvage`'s own `gate()`, extracted
 * here so every caller that resets/reaps an UNLEASED lane shares the identical read — never a second
 * hand-rolled liveness check that can silently drift from this one (the exact #xl5xhmj bug: a lane whose
 * content was already pushed skipped this gate entirely and went straight to `git reset --hard`, because only
 * the SALVAGE path called it).
 *
 * Fails CLOSED like every read it composes: an unreadable `claude agents` or `lsof` never reads as "safe" —
 * see {@link salvageEligibility}. Only the current lease can match a session outside the lane.
 * Released/historical holders never establish ownership. A current cwd inside the lane remains an
 * independent protection. Under the reclaim hold, ignore only that call's exact temporary session.
 * @param {{dir:string, ignoreLeaseSession?:string, readAgents?:Function, readCwds?:Function, quietMs?:number, nowMs?:number}} o
 * @returns {{eligible:boolean, reason:string}}
 */
export function laneLivenessGate({
  dir, ignoreLeaseSession, readAgents = readAgentsStrict, readCwds = readLiveCwds,
  quietMs = resolveSalvageQuietMs(), nowMs = Date.now(),
} = {}) {
  let lease = null;
  try {
    lease = JSON.parse(readFileSync(join(dir, '.git', LEASE_FILENAME), 'utf8'));
    if (!lease || typeof lease !== 'object' || Array.isArray(lease)) throw new Error('invalid lease');
  } catch (error) {
    if (error.code !== 'ENOENT') return { eligible: false, reason: 'cannot read current lease — never treating a lane as safe to act on blind' };
  }
  if (ignoreLeaseSession && lease?.session === ignoreLeaseSession) lease = null;
  const agents = readAgents();
  const cwds = readCwds();
  if (agents === null || cwds === null) {
    return {
      eligible: false,
      reason: `cannot read ${agents === null ? '\`claude agents\`' : 'live process cwds (lsof)'} — never treating a lane as safe to act on blind`,
    };
  }
  const liveOwner = liveAgentInLane(agents, dir, leaseSessionIds(lease));
  const livePids = pidsWithCwdIn(cwds, dir);
  let newestMtimeMs = null;
  try { newestMtimeMs = newestContentMtimeMs(dir); } catch { newestMtimeMs = nowMs; }
  return salvageEligibility({ leased: false, liveOwner, livePids, newestMtimeMs, nowMs, quietMs });
}

/**
 * Snapshot ONE working tree (lane or worktree) into refs WITHOUT touching its working tree or real index: a
 * throwaway index gets HEAD + every tracked change + every untracked (non-ignored) file, written as a `wip`
 * commit whose parent is HEAD. Returns what it saved.
 */
export function snapshotWorkTree(dir, { refs, branchRef }) {
  const headSha = git(dir, ['rev-parse', 'HEAD']).trim();
  const paths = dirtyPaths(dir);
  let wipSha = null;
  if (paths.length) {
    const tmp = mkdtempSync(join(tmpdir(), 'lane-salvage-idx-'));
    try {
      const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
      git(dir, ['read-tree', 'HEAD'], { env });
      git(dir, ['add', '-A', '--', '.', `:(exclude)${WORKTREE_LITTER_PREFIX.slice(0, -1)}`], { env });
      const tree = git(dir, ['write-tree'], { env }).trim();
      wipSha = git(dir, ['-c', 'user.name=lane-salvage', '-c', 'user.email=lane-salvage@noreply.local',
        'commit-tree', tree, '-p', headSha, '-m', `lane-salvage: uncommitted + untracked state of ${dir}`], { env }).trim();
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  let aheadCount = 0;
  try { aheadCount = Number(git(dir, ['rev-list', '--count', `${branchRef}..${headSha}`]).trim()) || 0; } catch { aheadCount = 0; }
  // Refs always go into the lane's shared repo (a worktree shares it), so one bundle carries everything.
  git(dir, ['update-ref', refs.head, headSha]);
  if (wipSha) git(dir, ['update-ref', refs.wip, wipSha]);
  return { dir, headSha, wipSha, aheadCount, dirtyCount: paths.length, refs: { head: refs.head, wip: wipSha ? refs.wip : null } };
}

/**
 * #4273 (CI run 36516127216, `test-shard (1)`, exit 134) — copies one litter item (file, dir, or symlink,
 * any depth) using ONLY plain libuv-backed `fs` calls, never `fs.cpSync({recursive:true, ...})`. LIVE
 * REPRODUCED root cause, not a hypothesis: on Node 22.23.2 (the exact version `actions/setup-node@v4`
 * resolved `node-version: 22` to at the time, Linux x64 — reproduced with `docker run node:22.23.2-bookworm`
 * as a NON-root user, since root ignores the POSIX permission bits this needs), `cpSync`'s own native
 * recursive directory walk throws an UNCAUGHT `std::filesystem::filesystem_error` when it meets a
 * permission-denied subdirectory — `terminate called after throwing …`, `Aborted (core dumped)`, exit 134 —
 * not a catchable JS error, a process-aborting SIGABRT that takes the whole test-shard worker down with it.
 * Isolating `lane-salvage.test.mjs` into its own fork (an earlier commit on this PR) did NOT fix this: the
 * SAME crash recurred (CI run 36516127216) because the abort was never cross-file contention, it was this
 * function's own `cpSync` call meeting the test's `locked/` fixture in-process. A REAL lane whose litter
 * happened to contain a permission-denied directory (e.g. a half-torn-down worktree) would take the whole
 * reclaim daemon process down with it exactly the same way — this is a live product bug, not a test-only one.
 *
 * `readdirSync`/`lstatSync`/`copyFileSync`/`symlinkSync`/`mkdirSync` are ordinary libuv wrappers: every one
 * throws a normal, catchable JS `Error` (e.g. EACCES) on failure, never a native abort. This preserves the
 * exact contract `salvageLane` relies on from the old `cpSync` options: a symlink is copied AS a symlink,
 * verbatim target, never dereferenced (`readlinkSync` + `symlinkSync`, which never follow a link on their
 * own — the old `dereference:false`+`verbatimSymlinks:true`). Copying onto an EXISTING regular file or
 * symlink throws rather than silently clobbering it (`COPYFILE_EXCL` / `symlinkSync`'s own natural `EEXIST`
 * — the old `errorOnExist:true`+`force:false`); an existing DIRECTORY merges instead — not a special case
 * here, `mkdirSync(dest, {recursive:true})` is itself already a silent no-op when `dest` already exists,
 * exactly matching `cpSync`'s own documented directory-merge behavior.
 */
function copyLitterTreeSync(src, dest) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) { symlinkSync(readlinkSync(src), dest); return; }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) copyLitterTreeSync(join(src, name), join(dest, name));
    return;
  }
  copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
}

/**
 * Salvage a whole lane: snapshot the lane + every litter worktree, copy every UNREGISTERED
 * `.claude/worktrees/` item verbatim (#4273 — it cannot be captured as a git ref; it isn't one), write
 * bundle/patch/unpushed files, VERIFY the bundle carries every salvage ref, and append an index line. Throws
 * on any failure — the caller must not reset a lane whose salvage did not verify. Does NOT remove worktrees
 * or reset (see {@link removeLitterWorktrees}).
 * @returns {{stamp:string, outDir:string, bundle:(string|null), refs:string[], snapshots:object[], worktrees:object[], litter:object[]}}
 */
export function salvageLane({ dir, lane, pool, branchRef, salvageRoot = resolveSalvageRoot(), now = new Date(), reason = '', meta = {}, includeLocalBranches = false }) {
  const stamp = salvageStamp(now);
  const outDir = join(salvageRoot, pool, stamp);
  mkdirSync(outDir, { recursive: true });
  const worktrees = listLitterWorktrees(dir);
  const litter = listUnregisteredWorktreeLitter(dir);
  const snapshots = [snapshotWorkTree(dir, { refs: salvageRefNames({ lane, stamp }), branchRef })];
  for (const w of worktrees) {
    snapshots.push({ worktree: w.name, ...snapshotWorkTree(w.path, { refs: salvageRefNames({ lane, stamp, worktree: w.name }), branchRef }) });
  }
  // Only refs with content not already on origin/<branch> go in the bundle (an all-prerequisite ref would make
  // git refuse or silently drop it). Prerequisites are origin/<branch> commits — never force-pushed, always fetchable.
  const bundleRefs = [];
  for (const s of snapshots) {
    if (s.aheadCount > 0) bundleRefs.push({ ref: s.refs.head, sha: s.headSha });
    if (s.refs.wip) bundleRefs.push({ ref: s.refs.wip, sha: s.wipSha });
  }
  // A clone about to be DELETED (not just reset) also carries every local branch / stash with commits no remote
  // ref has — those die with the directory otherwise.
  if (includeLocalBranches) {
    const { head } = salvageRefNames({ lane, stamp });
    const base = head.replace(/-head$/, '');
    for (const line of git(dir, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/stash']).split('\n').filter(Boolean)) {
      const [sha, ref] = line.split(' ');
      let unique = 0;
      try { unique = Number(git(dir, ['rev-list', '--count', sha, '--not', '--remotes']).trim()) || 0; } catch { unique = 0; }
      if (!unique || bundleRefs.some((r) => r.sha === sha)) continue;
      const salvRef = `${base}-ref-${ref.replace(/^refs\//, '').replace(/[^A-Za-z0-9._-]/g, '_')}`;
      git(dir, ['update-ref', salvRef, sha]);
      bundleRefs.push({ ref: salvRef, sha });
    }
  }
  const prefix = join(outDir, `lane-${lane}`);
  // #4273 — copy every unregistered `.claude/worktrees/` item BEFORE the caller's `git clean -fd` can delete
  // it. Mirrors each item's own relative path under `.claude/worktrees/` (never a sanitized/collapsed name),
  // so distinct items can never collide on a shared destination. A symlink is copied as itself, never
  // followed (no loops, no silently including a link's target content). Copying onto an existing regular
  // file or symlink refuses to silently clobber — a genuine failure here throws, aborting the whole salvage
  // exactly like a failed bundle-verify does (this function's existing throw-on-any-failure contract; the
  // caller must never reset/clean a lane whose salvage did not fully succeed). See `copyLitterTreeSync`'s own
  // docblock for why this is a hand-rolled walk rather than `fs.cpSync({recursive:true})` — a real, live-
  // reproduced crash, not a style preference.
  const litterDestRoot = `${prefix}.wt-litter`;
  const litterCopies = litter.map((item) => {
    const dest = join(litterDestRoot, item.rel);
    mkdirSync(dirname(dest), { recursive: true });
    copyLitterTreeSync(item.path, dest);
    return { rel: item.rel, dest };
  });
  let bundle = null;
  if (bundleRefs.length) {
    bundle = `${prefix}.bundle`;
    git(dir, ['bundle', 'create', bundle, ...bundleRefs.map((r) => r.ref), '--not', branchRef]);
    git(dir, ['bundle', 'verify', bundle]);
    const heads = git(dir, ['bundle', 'list-heads', bundle]);
    for (const r of bundleRefs) {
      if (!heads.includes(`${r.sha} ${r.ref}`)) throw new Error(`salvage bundle ${bundle} is missing ${r.ref} (${r.sha}) — not resetting lane-${lane}`);
    }
  }
  for (const s of snapshots) {
    const p = s.worktree ? `${prefix}.wt-${String(s.worktree).replace(/[^A-Za-z0-9._-]/g, '_')}` : prefix;
    writeFileSync(`${p}.uncommitted.patch`, s.wipSha ? git(dir, ['diff', '--binary', s.headSha, s.wipSha]) : '');
    writeFileSync(`${p}.unpushed.txt`, s.aheadCount ? git(dir, ['log', '--oneline', `${branchRef}..${s.headSha}`]) : '');
  }
  const changedFiles = new Set();
  for (const s of snapshots) {
    const tip = s.wipSha || s.headSha;
    try {
      const base = git(dir, ['merge-base', branchRef, tip]).trim();
      for (const f of git(dir, ['diff', '--name-only', base, tip]).split('\n').filter(Boolean)) changedFiles.add(f);
    } catch { /* unrelated history — the patch file still holds the diff */ }
  }
  let branch = null;
  try { branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { branch = null; }
  const worktreeBranches = worktrees.map((w) => { try { return git(w.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(); } catch { return null; } }).filter(Boolean);
  const record = buildSalvageRecord({
    now, pool, lane, dir, stamp, outDir, bundle, reason, branch, meta: { ...meta, worktreeBranches: [...(meta.worktreeBranches || []), ...worktreeBranches] },
    refs: bundleRefs.map((r) => r.ref),
    localRefs: snapshots.flatMap((s) => [s.refs.head, s.refs.wip].filter(Boolean)),
    snapshots: snapshots.map((s) => ({ worktree: s.worktree ?? null, headSha: s.headSha, wipSha: s.wipSha, aheadCount: s.aheadCount, dirtyCount: s.dirtyCount })),
    changedFiles: [...changedFiles].sort(),
    patches: snapshots.map((s) => `${s.worktree ? `${prefix}.wt-${String(s.worktree).replace(/[^A-Za-z0-9._-]/g, '_')}` : prefix}.uncommitted.patch`),
    litter: litterCopies,
  });
  appendSalvageIndex(salvageRoot, record);
  return { ...record, worktrees };
}

/** Card ids (`NNNN` / `xSLUG`) and PR numbers derivable from a lane's lease purpose/holder/session and branch
 *  names (`fix-2748`, `ci-heal-2783`, `review-2778`, `build-4229`, `lane/4229-slug`, `lane/x9fbg1x-slug`). PURE. */
export function deriveSalvageTargets({ purpose = '', holder = '', session = '', branches = [], cards = [], prs = [] } = {}) {
  const cardIds = new Set(cards.map(String));
  const prNumbers = new Set(prs.map(Number).filter(Number.isInteger));
  for (const s of [purpose, holder, session].filter(Boolean)) {
    const m = /(?:^|[-_])(fix|ci-heal|review|rebase|heal)-(\d{3,5})(?:$|[-_])/.exec(s);
    if (m) prNumbers.add(Number(m[2]));
    const b = /(?:^|[-_])(?:build|conveyor|prepare|item)-(\d{3,5}|x[a-z0-9]{5,7})(?:$|[-_])/i.exec(s);
    if (b) cardIds.add(b[1]);
  }
  for (const br of branches.filter(Boolean)) {
    const m = /^(?:lane\/)?(\d{3,5}|x[a-z0-9]{5,7})-/i.exec(br) || /^worktree-(?:fix|ci-heal|review)-(\d{3,5})$/.exec(br);
    if (m && /^worktree-/.test(br)) prNumbers.add(Number(m[1]));
    else if (m) cardIds.add(m[1]);
  }
  return { cards: [...cardIds], prs: [...prNumbers] };
}

/** PURE: the index row. `landed:false` until {@link refreshSalvageIndex} proves the content is on main.
 *  `litter` (#4273) is the `{rel, dest}` list of unregistered `.claude/worktrees/` content copied verbatim
 *  (never a git ref — it isn't git content), so a later audit / recovery can find it the same way as the
 *  bundle/patches. */
export function buildSalvageRecord({ now, pool, lane, dir, stamp, outDir, bundle, reason = '', branch = null, meta = {}, refs, localRefs = refs, snapshots, changedFiles = [], patches = [], litter = [] }) {
  const lh = meta.lastHolder || {};
  const targets = deriveSalvageTargets({
    purpose: lh.purpose, holder: lh.holder, session: lh.session,
    branches: [branch, ...(meta.worktreeBranches || [])],
    cards: [...(meta.cards || []), ...(lh.item ? [lh.item] : [])],
    prs: [...(meta.prs || []), ...(lh.pr ? [lh.pr] : [])],
  });
  return {
    ts: now.toISOString(), pool, lane, dir, stamp, outDir, bundle, patches, litter, reason,
    lastHolder: { purpose: lh.purpose ?? null, holder: lh.holder ?? null, session: lh.session ?? null, item: lh.item ?? null, pr: lh.pr ?? null },
    branch, head: snapshots[0]?.headSha ?? null, cards: targets.cards, prs: targets.prs,
    changedFiles, refs, localRefs, snapshots, landed: false,
    recover: bundle ? `git fetch ${bundle} 'refs/salvage/*:refs/salvage/*'` : null,
  };
}

export function salvageIndexPath(salvageRoot = resolveSalvageRoot()) { return join(salvageRoot, 'index.jsonl'); }

export function appendSalvageIndex(salvageRoot, record) {
  mkdirSync(salvageRoot, { recursive: true });
  appendFileSync(salvageIndexPath(salvageRoot), `${JSON.stringify(record)}\n`);
}

/** Remove the (already-salvaged) litter worktrees properly, then prune stale worktree metadata. */
export function removeLitterWorktrees(dir, worktrees) {
  const removed = [];
  for (const w of worktrees) {
    try { git(dir, ['worktree', 'remove', '--force', '--force', w.path]); removed.push(w.name); } catch { /* prune below; clean handles dirs */ }
  }
  try { git(dir, ['worktree', 'prune']); } catch { /* best-effort */ }
  const litterRoot = join(dir, '.claude', 'worktrees');
  if (existsSync(litterRoot)) { try { rmSync(litterRoot, { recursive: false }); } catch { /* not empty — left for the report */ } }
  return removed;
}
