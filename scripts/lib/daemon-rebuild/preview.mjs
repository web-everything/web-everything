/** @file scripts/lib/daemon-rebuild/preview.mjs — Read-only rebuild and conflict previews.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { gitRun } from '../main-staleness.mjs';
import { makeGit, verifyRev, OVERLAY_EDGE_RESOLVE_ENV } from './shared.mjs';
import { findUnsafeLocalState } from './local-state.mjs';
import { overlayFilePath, readOverlayState } from '../daemon-overlays.mjs';
import { readRebuildState } from './state.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, isAbsolute, resolve as resolvePath, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fetchMainAndOverlays, defaultPrState } from './edge-fetch.mjs';
import { planRebuild } from './plan.mjs';
import { isSafeBranchName } from '../daemon-self-sync.mjs';
import { resolveOverlayConflict } from './overlay-strategies.mjs';

// ── dryRunRebuild — STRICTLY read-only on `root` ────────────────────────────────────────────────────────────

/**
 * Preview what {@link rebuildClone} would do, WITHOUT ever writing an object/ref or moving anything in `root`.
 * Every command run directly against `root` is read-only (`rev-parse`, `symbolic-ref`, `status --porcelain`,
 * `remote get-url`, `rev-list`, `cherry`) and carries `GIT_OPTIONAL_LOCKS=0`; the actual merge-tree/commit-tree
 * computation happens in a disposable scratch bare repo that borrows `root`'s objects via
 * `objects/info/alternates` and does its OWN fresh fetch (never touching `root`'s remote-tracking refs).
 * `extraOverlays` (array of `{ref, pr}`) is appended AFTER the stored overlay list, VIRTUALLY — it is never
 * written to the overlay state file, only fed into this one `planRebuild` call, so a preview of "what if I
 * registered this ref too" (`daemon-load-overlay.mjs --dry-run`) never mutates anything on disk.
 * @param {{root:string, env?:NodeJS.ProcessEnv, prState?:(pr:number)=>(Promise<string|null>|string|null),
 *   originUrl?:string, run?:typeof gitRun, extraOverlays?:Array<{ref:string, pr?:number|null}>}} o
 * @returns {Promise<{dryRun:true, head:string|null, onMain:boolean|null, unsafe:object, plan:object,
 *   wouldDo:'nothing'|'nothing (still-rejected)'|'rebuild-and-smoke'|'refuse', overlayFile:string,
 *   overlays:Array<object>, overlayStateCorrupt:boolean, state:object, stillRejected:boolean}>}
 */
export async function dryRunRebuild({
  root, env = process.env, prState, originUrl, run = gitRun, extraOverlays = [],
} = {}) {
  const rootGit = makeGit({ run, cwd: root, env, extraEnv: { GIT_OPTIONAL_LOCKS: '0' } });

  const head = verifyRev(rootGit, 'HEAD');
  const headRef = rootGit(['symbolic-ref', '--short', 'HEAD']);
  const onMain = headRef.status === 0 ? String(headRef.stdout ?? '').trim() === 'main' : null;
  const unsafe = findUnsafeLocalState({ git: rootGit });

  const overlayFile = overlayFilePath(root, env);
  const overlayState = readOverlayState(root, { env });
  const overlayStateCorrupt = overlayState.corrupt;
  const overlays = overlayState.overlays.concat(extraOverlays);
  const state = readRebuildState(root, env);

  let url = originUrl;
  if (!url) {
    const urlRes = rootGit(['remote', 'get-url', 'origin']);
    url = urlRes.status === 0 ? String(urlRes.stdout ?? '').trim() : null;
  }

  let scratchDir = null;
  let plan = { ok: false, reason: 'no-origin-url' };
  let untrackedCollision = [];
  try {
    if (url && head) {
      scratchDir = mkdtempSync(join(tmpdir(), 'we-daemon-rebuild-dryrun-'));
      const init = spawnSync('git', ['init', '--bare', '-q', scratchDir], {
        encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      });
      if (init.status !== 0) {
        plan = { ok: false, reason: 'scratch-init-failed' };
      } else {
        const gitCommonRes = rootGit(['rev-parse', '--git-common-dir']);
        const gitCommonRaw = gitCommonRes.status === 0 ? String(gitCommonRes.stdout ?? '').trim() : null;
        const gitCommonDir = gitCommonRaw
          ? (isAbsolute(gitCommonRaw) ? gitCommonRaw : resolvePath(root, gitCommonRaw))
          : null;
        if (!gitCommonDir) {
          plan = { ok: false, reason: 'git-common-dir-failed' };
        } else {
          const alternatesFile = join(scratchDir, 'objects', 'info', 'alternates');
          mkdirSync(dirname(alternatesFile), { recursive: true });
          writeFileSync(alternatesFile, `${join(gitCommonDir, 'objects')}\n`, 'utf8');

          const scratchGit = makeGit({ run, cwd: scratchDir, env });
          scratchGit(['remote', 'add', 'origin', url]);
          fetchMainAndOverlays({ git: scratchGit, overlays, edgeResolve: env[OVERLAY_EDGE_RESOLVE_ENV] !== '0' });

          plan = await planRebuild({
            git: scratchGit,
            headSha: head,
            mainRef: 'origin/main',
            overlays,
            prState: prState || ((pr) => defaultPrState({ pr, root })),
            mainOnly: false,
            edgeResolve: env[OVERLAY_EDGE_RESOLVE_ENV] !== '0',
          });

          // Same untracked-collision check `doRebuild` runs before its real `reset --hard` (see
          // findUnsafeLocalState's header) — computed here against the scratch repo, which shares `root`'s
          // objects via the alternates file above, so `cat-file -e <finalSha>:<path>` needs no extra fetch.
          if (plan.ok && unsafe.untracked.length > 0) {
            untrackedCollision = unsafe.untracked.filter(
              (p) => scratchGit(['cat-file', '-e', `${plan.finalSha}:${p}`]).status === 0,
            );
          }
        }
      }
    }
  } finally {
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  }

  const retryDue = Number.isFinite(Date.parse(state.rejected?.retryAt || '')) && Date.now() >= Date.parse(state.rejected.retryAt);
  const stillRejected = !!(plan.ok && state.rejected?.inputsKey === plan.inputsKey && !retryDue);

  let wouldDo = 'refuse';
  if (unsafe.safe && onMain === true && plan.ok) {
    if (untrackedCollision.length > 0 || overlayStateCorrupt) wouldDo = 'refuse'; // mirrors doRebuild's refusals
    else if (plan.finalSha === head) wouldDo = 'nothing';
    else if (stillRejected) wouldDo = 'nothing (still-rejected)';
    else wouldDo = 'rebuild-and-smoke';
  }

  return {
    dryRun: true, head, onMain, unsafe, plan, wouldDo, overlayFile, overlays, overlayStateCorrupt, state,
    stillRejected, untrackedCollision,
  };
}

// ── overlay-conflict guard (`scripts/daemon-overlay.mjs add`, epic #3383/#4075) ─────────────────────────────

/** Best-effort extraction of the file path(s) a `git merge-tree` conflict names, from TWO independent sources
 *  in its own stdout so neither shape's absence loses the path: the `CONFLICT (<kind>): ... in <path>` message
 *  line, and the raw numbered-stage index lines (`<mode> <oid> <stage>\t<path>`) `--write-tree` always emits
 *  for a conflicted path regardless of message wording. A rename/delete conflict's message can name two paths
 *  on one line ("deleted in HEAD and renamed ... in <path>") — the stage lines still pin the single path that
 *  actually landed in the index, which is what matters for "which file", so they are authoritative;
 *  the message regex is only the fallback when no stage line is present. */
function parseMergeTreeConflictFiles(output) {
  const stagePaths = new Set();
  const msgPaths = new Set();
  for (const line of String(output ?? '').split('\n')) {
    const stage = /^\d+\s+[0-9a-f]{7,40}\s+[123]\t(.+)$/.exec(line);
    if (stage) { stagePaths.add(stage[1].trim()); continue; }
    // Non-greedy: the FIRST ` in ` ends the prose. A rename/delete message carries later ` in HEAD.` / ` in tree.`.
    const msg = /^CONFLICT \([^)]*\):.*? in (\S.*)$/.exec(line.trim());
    if (msg) msgPaths.add(msg[1].trim());
  }
  // Stage lines are authoritative: when any exist the message text is never consulted (its wording can name
  // refs and oids after the path).
  return [...(stagePaths.size ? stagePaths : msgPaths)];
}

/**
 * TASK — `scripts/daemon-overlay.mjs add`'s pre-registration GUARD (live incident: `lane/promote-stale-green`
 * / #2826 was registered at 19:53Z while KNOWINGLY conflicting with `lane/fix-procedure` / #2821 in
 * `scripts/conveyor/review-status-tag.mjs` — nothing refused it, so the next rebuild silently drops #2826 and
 * the fix it carries never goes live). Answers one narrow, register-time question: does `ref` (the candidate
 * overlay) merge cleanly against `origin/main` PLUS every ALREADY-registered overlay, applied in the SAME list
 * order {@link planRebuild} itself uses for a real rebuild — and if not, which file(s) and which registered
 * overlay(s) it conflicts with.
 *
 * READ-ONLY, exactly like {@link dryRunRebuild}: every command against `root` is read-only, and the actual
 * merge-tree/commit-tree computation happens in a disposable scratch bare repo that borrows `root`'s objects
 * via `objects/info/alternates` and does its OWN fresh fetch — `root`'s remote-tracking refs, working tree,
 * index and refs are never touched, so this needs no lock (same posture `daemon-overlay.mjs`'s own file header
 * already documents for `add`/`remove`).
 *
 * DISTINCT FROM {@link dryRunRebuild}'s own `extraOverlays` preview, which asks the WHOLE-REBUILD question
 * ("what would the clone actually build with this ref folded in" — a conflicting entry is silently DROPPED
 * there, `ok:true` either way, because a real rebuild must never let one bad overlay refuse the whole clone).
 * This function asks the narrower, REGISTRATION-time question and surfaces the conflict as the primary
 * result precisely because the caller (`add`) has a THIRD option `dryRunRebuild`'s own caller does not:
 * refuse to register at all.
 * @param {{root:string, ref:string, pr?:number|null, existingOverlays:Array<{ref:string,pr?:number|null}>,
 *   env?:NodeJS.ProcessEnv, originUrl?:string, run?:typeof gitRun}} o
 * `setAside` (every result) lists already-registered PINNED overlays that no longer fold onto main and were
 * left out of the check — the caller must surface them, since a real rebuild refuses until they are fixed.
 * @returns {Promise<{ok:true, clean:true, mainSha:string, cur:string, candSha:string, setAside:Array<object>}
 *   |{ok:true, clean:false, mainSha:string, cur:string, candSha:string, files:string[],
 *      conflicting:Array<{ref:string,pr:number|null}>, setAside:Array<object>}
 *   |{ok:false, reason:string, detail?:object, setAside?:Array<object>}>}
 */
export async function previewOverlayConflict({
  root, ref, pr = null, existingOverlays, env = process.env, originUrl, run = gitRun,
} = {}) {
  if (!isSafeBranchName(ref)) return { ok: false, reason: 'unsafe-ref' };
  const rootGit = makeGit({ run, cwd: root, env, extraEnv: { GIT_OPTIONAL_LOCKS: '0' } });

  let url = originUrl;
  if (!url) {
    const urlRes = rootGit(['remote', 'get-url', 'origin']);
    url = urlRes.status === 0 ? String(urlRes.stdout ?? '').trim() : null;
  }
  if (!url) return { ok: false, reason: 'no-origin-url' };

  const scratchDir = mkdtempSync(join(tmpdir(), 'we-daemon-overlay-guard-'));
  try {
    const init = spawnSync('git', ['init', '--bare', '-q', scratchDir], {
      encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
    });
    if (init.status !== 0) return { ok: false, reason: 'scratch-init-failed' };

    const gitCommonRes = rootGit(['rev-parse', '--git-common-dir']);
    const gitCommonRaw = gitCommonRes.status === 0 ? String(gitCommonRes.stdout ?? '').trim() : null;
    const gitCommonDir = gitCommonRaw ? (isAbsolute(gitCommonRaw) ? gitCommonRaw : resolvePath(root, gitCommonRaw)) : null;
    if (!gitCommonDir) return { ok: false, reason: 'git-common-dir-failed' };

    const alternatesFile = join(scratchDir, 'objects', 'info', 'alternates');
    mkdirSync(dirname(alternatesFile), { recursive: true });
    writeFileSync(alternatesFile, `${join(gitCommonDir, 'objects')}\n`, 'utf8');

    const scratchGit = makeGit({ run, cwd: scratchDir, env });
    scratchGit(['remote', 'add', 'origin', url]);
    const allRefs = existingOverlays.concat([{ ref, pr }]);
    const fetched = fetchMainAndOverlays({ git: scratchGit, overlays: allRefs, edgeResolve: env[OVERLAY_EDGE_RESOLVE_ENV] !== '0' });
    if (!fetched.ok) return { ok: false, reason: 'fetch-failed' };

    const mainSha = verifyRev(scratchGit, 'origin/main^{commit}');
    if (!mainSha) return { ok: false, reason: 'main-unresolved' };

    // 1. Fold every ALREADY-registered overlay, in list order — the SAME `planRebuild` a real rebuild runs —
    // to compute `cur`, the exact tree the candidate would land on top of (never re-derived by hand here).
    // A PINNED overlay that no longer folds (it conflicts with main, or its PR/ref is gone) makes `planRebuild`
    // refuse the whole plan, naming that overlay. That is a problem with the EXISTING list, not with the
    // candidate — so set it aside, re-plan without it, and REPORT it (`setAside`), rather than refusing every
    // unrelated add until someone repairs the stuck overlay (PR #2827 review). Any other plan failure still
    // fails closed.
    const setAside = [];
    let folding = existingOverlays;
    let planExisting;
    for (;;) {
      planExisting = await planRebuild({
        git: scratchGit, headSha: mainSha, mainRef: 'origin/main', overlays: folding,
        prState: (p) => defaultPrState({ pr: p, root }),
        edgeResolve: env[OVERLAY_EDGE_RESOLVE_ENV] !== '0',
      });
      const stuckRef = !planExisting.ok && /^pinned-overlay-/.test(planExisting.reason) ? planExisting.detail?.ref : null;
      if (!stuckRef || !folding.some((o) => o.ref === stuckRef)) break;
      setAside.push({
        ref: stuckRef, pr: planExisting.detail.pr ?? null, reason: planExisting.reason, dropReason: planExisting.detail.dropReason,
      });
      folding = folding.filter((o) => o.ref !== stuckRef);
    }
    if (!planExisting.ok) return { ok: false, reason: 'existing-overlays-unresolved', detail: planExisting, setAside };
    const cur = planExisting.finalSha;

    // 2. The candidate's own tip (already fetched above).
    const candSha = fetched.goneRefs.includes(ref) ? null : verifyRev(scratchGit, `origin/${ref}^{commit}`);
    if (!candSha) return { ok: false, reason: 'ref-unresolved' };

    // 3. THE CHECK — deliberately WITH messages (unlike planRebuild's own internal folds), so a real conflict
    // names its file(s) for the refusal/`--allow-conflict` print.
    const mt = scratchGit(['merge-tree', '--write-tree', cur, candSha]);
    if (mt.status === 0) return { ok: true, clean: true, mainSha, cur, candSha, setAside };
    if (mt.status === 1 && env[OVERLAY_EDGE_RESOLVE_ENV] !== '0'
      && resolveOverlayConflict({ git: scratchGit, cur, ovSha: candSha, ref }).ok) {
      return { ok: true, clean: true, mainSha, cur, candSha, setAside };
    }

    // Only status 1 is merge-tree's documented "merge had conflicts". Anything else (unrelated histories, a
    // missing object, a crash) proves nothing about mergeability — it must fail closed as `ok:false`, never read
    // as a confirmed conflict that `--allow-conflict` could then override (PR #2827 review).
    const files = mt.status === 1 ? parseMergeTreeConflictFiles(mt.stdout) : [];
    if (files.length === 0) {
      return {
        ok: false, reason: 'merge-tree-failed', setAside,
        detail: { status: mt.status, stderr: String(mt.stderr ?? '').trim().slice(0, 500) },
      };
    }

    // 4. Attribute: which already-registered overlay(s) ALSO touch one of the conflicting files, off the SAME
    // object data (a `git diff --name-only` against main), never a guess at intent.
    const conflicting = [];
    for (const o of existingOverlays) {
      const ovSha = verifyRev(scratchGit, `origin/${o.ref}^{commit}`);
      if (!ovSha) continue;
      // Three-dot: only what the overlay ITSELF changed since it branched — a two-dot diff would also count main's later edits.
      const d = scratchGit(['diff', '--name-only', `${mainSha}...${ovSha}`]);
      if (d.status !== 0) continue;
      const touched = new Set(String(d.stdout ?? '').split('\n').filter(Boolean));
      if (files.some((f) => touched.has(f))) conflicting.push({ ref: o.ref, pr: o.pr ?? null });
    }

    return { ok: true, clean: false, mainSha, cur, candSha, files, conflicting, setAside };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
