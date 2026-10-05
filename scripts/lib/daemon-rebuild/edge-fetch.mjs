/** @file scripts/lib/daemon-rebuild/edge-fetch.mjs — Edge-ref fetch, provenance, and remote PR state.
 * Split out of daemon-rebuild.mjs (move-only).
 */

import { FULL_SHA_RE, verifyRev } from './shared.mjs';
import { isSafeBranchName } from '../daemon-self-sync.mjs';
import { spawnSync } from 'node:child_process';

/** The edge-resolution sha an operator recorded on an overlay entry (`edgeResolution: {sha, by, at}`, written by
 *  `daemon-overlays.mjs#recordEdgeResolution`), or `null`. Only a full lowercase 40-hex sha counts — a short,
 *  upper-case, empty or non-string value is read as "nothing recorded", never matched loosely. */
export function recordedEdgeSha(entry) {
  const sha = entry?.edgeResolution?.sha;
  return typeof sha === 'string' && FULL_SHA_RE.test(sha) ? sha : null;
}

// ── fetch helper shared by rebuildClone and dryRunRebuild ───────────────────────────────────────────────────

/** Fetch `origin/main` + every (safe-named) overlay ref via explicit refspecs. A batched fetch failure refetches
 *  `main` alone; if THAT also fails the caller gets `{ok:false, reason:'fetch-failed'}` (transient — main itself
 *  is unreachable). Otherwise each overlay ref is fetched individually and a failure there is `ref-gone` (its
 *  stale remote-tracking ref is deleted so a later `--not --remotes=origin`/`refs/remotes/origin/<ref>` read
 *  never sees stale data for it). */
export function fetchMainAndOverlays({ git, overlays, edgeResolve = true }) {
  const safeOverlays = overlays.filter((o) => isSafeBranchName(o?.ref));
  const refspecs = [
    '+refs/heads/main:refs/remotes/origin/main',
    ...safeOverlays.map((o) => `+refs/heads/${o.ref}:refs/remotes/origin/${o.ref}`),
  ];
  const batch = git(['fetch', '--quiet', '--prune', 'origin', ...refspecs]);
  // FAIL CLOSED. An edge ref is usable only if THIS run re-confirmed it: every cached `origin/edge/<ref>` is
  // deleted first, so a failed `ls-remote`/`fetch`, a deleted remote branch, or a thrown git call leaves it
  // unavailable (the conflict then drops visibly) instead of resolving against a stale branch from an earlier
  // run. Only an overlay with a recorded resolution (`recordedEdgeSha`) is a candidate at all, and its edge is
  // fetched only while the remote still advertises exactly the recorded sha — an arbitrary pushed `edge/*`
  // branch is never even fetched.
  const fetchEdges = () => {
    if (!edgeResolve) return;
    const edgeRef = (ref) => `refs/remotes/origin/edge/${ref}`;
    // An overlay may itself be named `edge/<x>`: its OWN tracking ref is the same path as overlay `<x>`'s edge
    // ref, and must never be deleted or re-fetched here.
    const overlayTracking = new Set(safeOverlays.map((o) => `refs/remotes/origin/${o.ref}`));
    const edgeCandidates = safeOverlays.filter((o) => !overlayTracking.has(edgeRef(o.ref)));
    // A delete that fails (lock, I/O) ends edge discovery for the run. The surviving ref is still adopted only
    // while its tip equals the operator-recorded sha (see `resolveOverlayConflict`) — provenance holds, but it is
    // not re-confirmed against the remote on that run.
    const dropCached = () => {
      let ok = true;
      for (const { ref } of edgeCandidates) {
        try { if (git(['update-ref', '-d', edgeRef(ref)]).status !== 0) ok = false; } catch { ok = false; }
      }
      return ok;
    };
    if (!dropCached()) return;
    try {
      const approved = new Map(edgeCandidates.map((o) => [o.ref, recordedEdgeSha(o)]).filter(([, sha]) => sha));
      if (approved.size === 0) return;
      const listed = git(['ls-remote', '--heads', 'origin', 'refs/heads/edge/*']);
      if (listed.status !== 0) return;
      const advertised = new Map(String(listed.stdout ?? '').trim().split('\n')
        .map((line) => line.trim().split(/\s+/)).filter((p) => p.length >= 2).map(([sha, name]) => [name, sha]));
      const edges = [];
      for (const [ref, sha] of approved) {
        if (advertised.get(`refs/heads/edge/${ref}`) === sha) edges.push(`+refs/heads/edge/${ref}:${edgeRef(ref)}`);
      }
      if (edges.length === 0) return;
      if (git(['fetch', '--quiet', 'origin', ...edges]).status !== 0) { dropCached(); return; }
      // The branch may have moved between `ls-remote` and `fetch`: keep only a ref whose tip is the recorded sha.
      for (const [ref, sha] of approved) {
        if (verifyRev(git, `${edgeRef(ref)}^{commit}`) !== sha) git(['update-ref', '-d', edgeRef(ref)]);
      }
    } catch { dropCached(); /* edge discovery must never block a rebuild */ }
  };
  if (batch.status === 0) {
    fetchEdges();
    return { ok: true, goneRefs: [] };
  }

  const mainOnlyFetch = git(['fetch', '--quiet', '--prune', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  if (mainOnlyFetch.status !== 0) return { ok: false, reason: 'fetch-failed' };

  const goneRefs = [];
  for (const o of safeOverlays) {
    const one = git(['fetch', '--quiet', 'origin', `+refs/heads/${o.ref}:refs/remotes/origin/${o.ref}`]);
    if (one.status !== 0) {
      git(['update-ref', '-d', `refs/remotes/origin/${o.ref}`]);
      goneRefs.push(o.ref);
    }
  }
  fetchEdges();
  return { ok: true, goneRefs };
}

// ── defaultPrState — the CLI's real PR-state lookup ─────────────────────────────────────────────────────────

function slugFromOriginUrl(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/]+)\/([^/.]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Real-world `prState`: `gh pr view <n> --repo <slug from origin's url> --json state -q .state`, 20s timeout.
 * ANY failure (no `gh`, no auth, unresolvable slug, timeout) reads as `null` — unknown, and {@link planRebuild}
 * never removes an overlay on an unknown PR state, only on a confirmed MERGED/CLOSED.
 * @param {{pr:number, root:string}} o
 * @returns {string|null}
 */
export function defaultPrState({ pr, root }) {
  if (pr == null) return null;
  try {
    const urlRes = spawnSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
    });
    const slug = urlRes.status === 0 ? slugFromOriginUrl(urlRes.stdout) : null;
    if (!slug) return null;
    const ghRes = spawnSync('gh', ['pr', 'view', String(pr), '--repo', slug, '--json', 'state', '-q', '.state'], {
      encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL',
    });
    if (ghRes.status !== 0) return null;
    const out = String(ghRes.stdout || '').trim();
    return out || null;
  } catch {
    return null;
  }
}
