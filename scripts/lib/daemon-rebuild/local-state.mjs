/** @file scripts/lib/daemon-rebuild/local-state.mjs — Clone tree safety and daemon dirt recovery.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { isHash, idFromName, isNum } from '../../backlog/id.mjs';
import { createRequire } from 'node:module';
import { lstatSync, unlinkSync, readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { daemonConveyorStateRoot } from '../daemon-last-good.mjs';
import { verifyRev } from './shared.mjs';

// ── findUnsafeLocalState — pure over an injected git(args) runner ──────────────────────────────────────────

/** `git ls-files --others --exclude-standard -z` — every untracked, non-ignored path in the tree, NUL-separated
 *  so a filename with an embedded newline can never split into two entries. A failed call returns `null`, which
 *  {@link findUnsafeLocalState} treats as `status-failed` (fail closed): without the list, the collision check
 *  before `reset --hard` could not protect an untracked file from being overwritten. */
export function collectUntrackedPaths(git) {
  const r = git(['ls-files', '--others', '--exclude-standard', '-z']);
  if (r.status !== 0) return null;
  return String(r.stdout ?? '').split('\0').filter(Boolean);
}

/** Locked, post-fetch exception to untracked preservation: only main-proven birth identities. */
export function pruneLandedBacklogSidecars({ git, root, paths, mainSha, alert }) {
  const candidates = paths.filter((path) => /^backlog\/[^/]+\.md$/.test(path)
    && isHash(idFromName(path.slice('backlog/'.length, -3))));
  if (!candidates.length) return;
  const failed = (detail) => alert('backlog-sidecar-prune-failed', { mainSha, ...detail });
  if (!mainSha) { failed({ error: 'Cannot resolve fetched main commit; retaining sidecars' }); return; }
  try {
    // Grep is only a blob prefilter, NEVER deletion evidence. Pin every read to this one commit.
    const hashes = [...new Set(candidates.map((path) => idFromName(path.slice(8, -3))))];
    const matches = git(['grep', '--no-textconv', '-l', '-z', '-F', ...hashes.flatMap((hash) => ['-e', hash]), mainSha, '--', 'backlog']);
    if (matches.status === 1) return;
    if (matches.status !== 0) throw new Error('Cannot search fetched main backlog blobs');
    const landed = new Map();
    for (const match of String(matches.stdout ?? '').split('\0').filter(Boolean)) {
      const path = match.slice(mainSha.length + 1);
      if (!match.startsWith(`${mainSha}:`) || !/^backlog\/[^/]+\.md$/.test(path)
        || !isNum(idFromName(path.slice(8, -3)))) continue;
      const blob = git(['show', `${mainSha}:${path}`]);
      if (blob.status !== 0) { failed({ landedPath: path, error: 'Cannot read landing evidence; retaining dependent sidecars' }); continue; }
      const content = String(blob.stdout ?? '');
      const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!fm) continue;
      try {
        // Validate YAML as well as the scalar convention: duplicate keys, mismatched quotes,
        // malformed documents, aliases/merges and body examples cannot authorize unlinking.
        // gray-matter is loaded lazily (only when a landing blob is actually validated) so merely importing this
        // module never needs node_modules — throwaway script-tree clones (e.g. backlog.mjs CLI tests) have none.
        const data = createRequire(import.meta.url)('gray-matter')(fm[0]).data;
        const lines = fm[1].split(/\r?\n/).filter((line) => /^bornAs:/.test(line));
        if (lines.length !== 1 || !/^bornAs:[ \t]*(?:x[0-9a-z]{6}|'x[0-9a-z]{6}'|"x[0-9a-z]{6}")[ \t]*$/.test(lines[0])) continue;
        // Same scalar convention as backlog/frontmatter.mjs readField, after stricter validation.
        // Keep the editor/transition module out of the daemon's runtime dependency closure.
        const hash = lines[0].slice('bornAs:'.length).trim().replace(/^["']|["']$/g, '');
        if (isHash(hash) && data.bornAs === hash) landed.set(hash, path);
      } catch (error) { failed({ landedPath: path, error: `Invalid landing frontmatter: ${error.message}` }); }
    }
    for (const path of candidates) {
      const hash = idFromName(path.slice(8, -3));
      const landedPath = landed.get(hash);
      if (!landedPath) continue;
      try {
        const current = collectUntrackedPaths(git);
        if (current === null) throw new Error('Cannot recheck untracked membership; retaining sidecar');
        if (!current.includes(path)) continue;
        if (!lstatSync(join(root, 'backlog')).isDirectory() || !lstatSync(join(root, path)).isFile()) continue;
        unlinkSync(join(root, path));
        alert('backlog-sidecar-pruned', { path, hash, landedPath, mainSha });
      } catch (error) {
        if (error.code !== 'ENOENT') failed({ path, hash, landedPath, error: String(error.message || error) });
      }
    }
  } catch (error) { failed({ error: String(error.message || error) }); }
}

/**
 * PURE: is `root`'s current tree safe for {@link rebuildClone} to move with `git reset --hard`? Fail-closed at
 * every read — an unreadable `status` refuses outright, since we cannot then trust anything else. Precedence
 * (spec doesn't state one explicitly; chosen so a genuine `status`-read failure always dominates, and a live
 * `MERGE_HEAD` — which itself also shows up as "dirty" porcelain output — is reported as the MORE specific
 * `merge-in-progress` rather than the generic `dirty`): `status-failed` > `merge-in-progress` > `dirty` >
 * `local-commits` > safe.
 *
 * UNTRACKED FILES ARE NEVER PART OF THIS SAFETY VERDICT. `git reset --hard` moves tracked content only and
 * never deletes an untracked, non-ignored file sitting in the working tree (`git clean` does that, and this
 * module never calls it — see file header), so the dirty-tree check below reads `--untracked-files=no`: an
 * untracked file must never by itself freeze a rebuild (2026-09-24 freeze: a live daemon clone read as
 * permanently dirty because of an untracked `.conveyor/unsupported-repo.json` sidecar its own process had just
 * written). Every untracked, non-ignored path ({@link collectUntrackedPaths}) is still collected and returned
 * as `untracked` on EVERY result (safe or not) — {@link doRebuild} uses it, after the plan is computed and
 * just before its one `reset --hard`, to refuse with `untracked-collision` if the incoming tree actually has
 * content at one of those paths (the one case a `reset --hard` WOULD silently overwrite something); every
 * other kept untracked path is only reported (`untracked-kept`). The sole deletion exception is a
 * provisional backlog sidecar proven landed on fetched main, pruned under the write lock before planning.
 * @param {{git:(args:string[])=>{status:number,stdout:string,stderr:string}}} o
 * @returns {{safe:boolean, reason?:string, detail?:Array<string>|string, untracked:Array<string>}}
 */
export function findUnsafeLocalState({ git, knownInputs = [] }) {
  const listed = collectUntrackedPaths(git);
  if (listed === null) return { safe: false, reason: 'status-failed', detail: 'ls-files --others failed', untracked: [] };
  const untracked = listed;

  const status = git(['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0) return { safe: false, reason: 'status-failed', untracked };

  const mergeHead = git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (mergeHead.status === 0 && String(mergeHead.stdout ?? '').trim()) {
    return { safe: false, reason: 'merge-in-progress', untracked };
  }

  const dirtyOut = String(status.stdout ?? '').trim();
  if (dirtyOut) {
    return {
      safe: false, reason: 'dirty', detail: dirtyOut.split('\n').map((l) => l.trim()).filter(Boolean), untracked,
    };
  }

  // `knownInputs`: shas this clone was previously BUILT from (the last adopted head + its overlay tips). An
  // overlay whose origin branch was deleted after its PR merged (squash) leaves its commits reachable from HEAD
  // but from no remote ref — they are past inputs, not local work, and must never freeze the rebuild. Only
  // shas that actually exist locally are passed (an unknown sha would make rev-list fail => status-failed).
  const known = knownInputs.filter((sha) => typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha)
    && git(['cat-file', '-e', `${sha}^{commit}`]).status === 0);
  const revList = git(['rev-list', '--no-merges', 'HEAD', '--not', '--remotes=origin', ...known]);
  if (revList.status !== 0) {
    return {
      safe: false, reason: 'status-failed', detail: 'rev-list --no-merges failed', untracked,
    };
  }
  const localShas = String(revList.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (localShas.length === 0) return { safe: true, untracked };

  // Drop any that are upstream-equivalent (same patch already on origin/main under a different sha, e.g.
  // rebased-and-pushed-elsewhere) — a failed cherry is fail-closed the OTHER way here: keep every candidate
  // rather than risk silently clearing a real local commit off the unsafe list.
  const cherry = git(['cherry', 'origin/main', 'HEAD']);
  let remaining = localShas;
  if (cherry.status === 0) {
    const equivalent = new Set(
      String(cherry.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'))
        .map((l) => l.slice(1).trim()),
    );
    remaining = localShas.filter((sha) => !equivalent.has(sha));
  }
  if (remaining.length === 0) return { safe: true, untracked };
  return {
    safe: false, reason: 'local-commits', detail: remaining, untracked,
  };
}

// ── daemon runtime state that lands in TRACKED files — carried out of the tree, never a freeze ─────────────

/**
 * TRACKED files a daemon process (or a session it dispatched) appends runtime state to. A write there must
 * never freeze the rebuild: 2026-09-25 13:36 ET, a review session's scorecard row left
 * `scripts/conveyor/run-scorecards.json` modified in the review-daemon clone, the rebuild refused it as
 * `dirty`, the clone fell 10 commits behind, and every review and fix dispatch refused as STALE. So the
 * rebuild carries each such file's rows into {@link daemonConveyorStateRoot} (a union — no row is lost, none
 * is duplicated), restores the tracked copy, and proceeds. `pinned` is the path under that root; the store
 * module itself (`run-scorecard-store.mjs#resolveScorecardStorePath`) writes to the same place in a daemon
 * clone, so this is the recovery path for rows written by older code, not the normal one. Since #4155 the file
 * is no longer tracked at all and the store writes out-of-tree from every checkout; this entry stays for the one
 * window that still matters — a clone whose tracked copy an OLD-code process modified before the untracking
 * commit reached it: the carry restores it to HEAD so the rebuild can move onto the commit that deletes it.
 */
export const DAEMON_STATE_FILES = Object.freeze([
  Object.freeze({ path: 'scripts/conveyor/run-scorecards.json', pinned: '.conveyor/run-scorecards.json' }),
]);

/** `{version, records:[]}` from JSON text; `null` when it is not that shape (never guessed). */
function parseRecordsStore(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || !Array.isArray(parsed.records)) return null;
    // `migrations` (run-scorecard-store.mjs's one-time-migration stamps, #4155) rides along so a carry never
    // strips them and re-arms a migration that already ran.
    return Array.isArray(parsed.migrations)
      ? { version: parsed.version ?? 1, records: parsed.records, migrations: parsed.migrations }
      : { version: parsed.version ?? 1, records: parsed.records };
  } catch {
    return null;
  }
}

/**
 * The dirty paths in `git status --porcelain` lines, or `null` when any line is not a plain modification
 * (a rename, a delete, a conflict — nothing this module should carry away on its own).
 * @param {Array<string>} lines - trimmed porcelain lines, as {@link findUnsafeLocalState} reports them
 */
function modifiedPathsOf(lines) {
  const paths = [];
  for (const line of lines) {
    const m = /^(M{1,2})\s+(.+)$/.exec(line);
    if (!m) return null;
    paths.push(m[2].trim());
  }
  return paths;
}

/** PURE: only the two claim-owned top-level keys may differ; the body is byte-preserved. */
export function isClaimStampOnlyEdit(headText, workText) {
  const parse = (text) => {
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!fm) return null;
    const lines = fm[1].split(/\r?\n/);
    const statuses = lines.filter((line) => /^status:/.test(line));
    if (statuses.length !== 1) return null;
    const status = /^status:[ \t]*(open|active|preparing)[ \t]*$/.exec(statuses[0])?.[1];
    return {
      status,
      rest: lines.filter((line) => !/^(status|dateStarted):/.test(line)).join('\n'),
      body: text.slice(fm[0].length),
    };
  };
  const head = parse(headText);
  const work = parse(workText);
  return !!head && !!work && head.status === 'open'
    && ['active', 'preparing'].includes(work.status)
    && head.rest === work.rest && head.body === work.body;
}

/** Validate every non-state path before restoring any claim stamp. A concurrent write fails closed. */
export function restoreStrayClaimStamps({ git, root, dirty, fs = { read: (p) => readFileSync(p, 'utf8') } }) {
  const restored = [];
  const fail = (reason) => ({ ok: false, reason, restored });
  const paths = modifiedPathsOf(dirty || []);
  if (!paths?.length) return fail('not-claim-stamps');
  const known = new Set(DAEMON_STATE_FILES.map((entry) => entry.path));
  const backlog = paths.filter((path) => !known.has(path));
  if (!backlog.every((path) => /^backlog\/[^/]+\.md$/.test(path))) return fail('not-claim-stamps');
  const checked = [];
  for (const path of backlog) {
    const head = git(['show', `HEAD:${path}`]);
    if (head.status !== 0) return fail('head-unreadable');
    let text;
    try { text = fs.read(join(root, path)); } catch { return fail('file-busy'); }
    if (!isClaimStampOnlyEdit(String(head.stdout ?? ''), text)) return fail('not-claim-stamps');
    checked.push({ path, text });
  }
  for (const { path, text } of checked) {
    const diff = git(['diff', 'HEAD', '--', path]);
    if (diff.status !== 0) return fail('restore-failed');
    try {
      if (fs.read(join(root, path)) !== text) return fail('file-busy');
    } catch { return fail('file-busy'); }
    if (git(['checkout', 'HEAD', '--', path]).status !== 0) return fail('restore-failed');
    restored.push({ path, diff: String(diff.stdout ?? '') });
  }
  return { ok: true, restored };
}

/**
 * PURE over `git` + injected fs: when EVERY dirty path is a known {@link DAEMON_STATE_FILES} entry, union each
 * one's rows into its pinned file, then restore the tracked copy (`checkout HEAD -- <path>`). Any other dirt,
 * an unparsable file, or a failed write/restore migrates nothing it cannot prove and returns `ok:false` — the
 * caller then refuses as `dirty`, exactly as before.
 * @param {{git:Function, root:string, dirty:Array<string>, env?:NodeJS.ProcessEnv,
 *   fs?:{read:(p:string)=>string, write:(p:string, s:string)=>void, exists:(p:string)=>boolean}}} o
 * @returns {{ok:boolean, reason?:string, migrated:Array<{path:string, target:string, added:number, total:number}>}}
 */
export function migrateDaemonStateFiles({ git, root, dirty, env = process.env, fs: io }) {
  const fs = io ?? {
    read: (p) => readFileSync(p, 'utf8'),
    write: (p, s) => {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, s, 'utf8');
      renameSync(tmp, p);
    },
    exists: (p) => existsSync(p),
  };
  const paths = modifiedPathsOf(dirty || []);
  if (!paths || paths.length === 0) return { ok: false, reason: 'not-state-files', migrated: [] };
  const known = new Map(DAEMON_STATE_FILES.map((f) => [f.path, f]));
  if (!paths.every((p) => known.has(p))) return { ok: false, reason: 'not-state-files', migrated: [] };

  const migrated = [];
  for (const p of paths) {
    const target = join(daemonConveyorStateRoot(env), known.get(p).pinned);
    // Re-read until the tracked copy is stable across the merge, so a row appended mid-migration is not lost.
    let carried = false;
    for (let attempt = 0; attempt < 3 && !carried; attempt += 1) {
      let text;
      try { text = fs.read(join(root, p)); } catch { return { ok: false, reason: 'state-file-unreadable', migrated }; }
      const working = parseRecordsStore(text);
      if (!working) return { ok: false, reason: 'state-file-unparsable', migrated };
      let pinned = { version: working.version, records: [] };
      if (fs.exists(target)) {
        let pinnedText;
        try { pinnedText = fs.read(target); } catch { return { ok: false, reason: 'pinned-unreadable', migrated }; }
        pinned = parseRecordsStore(pinnedText);
        // Never overwrite a pinned store we cannot read — that would destroy the rows already there.
        if (!pinned) return { ok: false, reason: 'pinned-unparsable', migrated };
      }
      const seen = new Set(pinned.records.map((r) => JSON.stringify(r)));
      const add = working.records.filter((r) => !seen.has(JSON.stringify(r)));
      if (add.length > 0) {
        try {
          fs.write(target, `${JSON.stringify({ ...pinned, version: pinned.version ?? 1, records: [...pinned.records, ...add] }, null, 2)}\n`);
        } catch { return { ok: false, reason: 'pinned-write-failed', migrated }; }
      }
      let after;
      try { after = fs.read(join(root, p)); } catch { after = null; }
      if (after !== text) continue;
      const restore = git(['checkout', 'HEAD', '--', p]);
      if (restore.status !== 0) return { ok: false, reason: 'restore-failed', migrated };
      migrated.push({ path: p, target, added: add.length, total: pinned.records.length + add.length });
      carried = true;
    }
    if (!carried) return { ok: false, reason: 'state-file-busy', migrated };
  }
  return { ok: true, migrated };
}

export const DIRTY_TREE_RECOVERIES = Object.freeze([
  {
    name: 'claim-stamps',
    run(ctx) {
      const { git, root, stEnv, alert, dirty } = ctx;
      const recovery = restoreStrayClaimStamps({ git, root, dirty });
      for (const entry of recovery.restored) alert('backlog-claim-stamp-restored', entry);
      if (!recovery.ok && recovery.reason !== 'not-claim-stamps') alert('backlog-claim-stamp-restore-failed', { reason: recovery.reason });
      return recovery.ok;
    },
  },
  {
    name: 'daemon-state-files',
    run(ctx) {
      const { git, root, stEnv, alert, dirty } = ctx;
      const mig = migrateDaemonStateFiles({ git, root, dirty, env: stEnv });
      for (const m of mig.migrated) alert('state-file-migrated', m);
      if (!mig.ok && mig.reason !== 'not-state-files') alert('state-file-migrate-failed', { reason: mig.reason });
      return mig.ok;
    },
  },
]);

/**
 * PURE-ish (one alert side-effect): is `root` still safe to move, migrating known daemon-state-file dirt out of
 * the way first (see {@link migrateDaemonStateFiles}) exactly as the old single-phase `doRebuild` did at its own
 * Step 1 — shared by {@link prepareRebuild} (before the candidate is even built) and {@link finalizeRebuild}
 * (re-checked right before the one `reset --hard`, since real time — an unlocked smoke — passed in between).
 * @returns {{safe:boolean, reason?:string, detail?:*, untracked:Array<string>}}
 */
export function ensureSafeToMove({
  git, root, env, stEnv, alert, knownInputs,
}) {
  let unsafe = findUnsafeLocalState({ git, knownInputs });
  for (const recovery of DIRTY_TREE_RECOVERIES) {
    if (!unsafe.safe && unsafe.reason === 'dirty') {
      if (recovery.run({ git, root, stEnv, alert, dirty: unsafe.detail })) unsafe = findUnsafeLocalState({ git, knownInputs });
    }
  }
  return unsafe;
}

/** Shas a clone was previously built from — see {@link findUnsafeLocalState}'s `knownInputs`. */
export function knownInputsOf(state) {
  return [
    state?.adopted?.head, state?.adopted?.mainSha, ...((state?.adopted?.applied) || []).map((a) => a?.sha),
    state?.quarantine?.prevHead,
  ].filter(Boolean);
}

/**
 * Under the write lock: move `root` off a never-smoked build back onto `prevHead` (its last verified head), with
 * the same "clean" test the quarantine recovery uses — no tracked change, and no untracked file prevHead has
 * content at (the reset would silently overwrite it). Returns whether HEAD is now `prevHead`.
 */
export function rollbackUnverified({ git, prevHead }) {
  if (!prevHead || !verifyRev(git, `${prevHead}^{commit}`)) return false;
  const status = git(['status', '--porcelain', '--untracked-files=no']);
  const untracked = collectUntrackedPaths(git);
  const clean = status.status === 0 && !String(status.stdout ?? '').trim() && untracked !== null
    && !untracked.some((p) => git(['cat-file', '-e', `${prevHead}:${p}`]).status === 0);
  if (!clean) return false;
  return git(['reset', '--hard', prevHead]).status === 0;
}
