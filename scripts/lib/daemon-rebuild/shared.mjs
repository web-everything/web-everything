/** @file scripts/lib/daemon-rebuild/shared.mjs — Shared rebuild helpers.
 * Split out of daemon-rebuild.mjs (move-only).
 */



// ── Fixed rebuild identity (see file header — DETERMINISM) ─────────────────────────────────────────────────

/** `daemon-rebuild <daemon-rebuild@localhost>` — the ONE identity every `commit-tree` this module mints uses,
 *  whatever machine/user runs it, so the same inputs always produce the same commit sha. */
export const REBUILD_IDENTITY_ENV = Object.freeze({
  GIT_AUTHOR_NAME: 'daemon-rebuild',
  GIT_AUTHOR_EMAIL: 'daemon-rebuild@localhost',
  GIT_COMMITTER_NAME: 'daemon-rebuild',
  GIT_COMMITTER_EMAIL: 'daemon-rebuild@localhost',
});

export const OVERLAY_EDGE_RESOLVE_ENV = 'WE_DAEMON_OVERLAY_EDGE_RESOLVE';

export function rebuildCommitEnv(git, ...parents) {
  const committerDate = (sha) => {
    const r = git(['log', '-1', '--format=%ct', sha]);
    const n = Number(String(r.stdout ?? '').trim());
    return r.status === 0 && Number.isFinite(n) ? n : 0;
  };
  const date = `@${Math.max(...parents.map(committerDate))} +0000`;
  return { ...REBUILD_IDENTITY_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** One git-runner factory shared by every call site in this file — always carries the fixed rebuild identity
 *  (harmless for anything but `commit-tree`), a `timeout` + `killSignal:'SIGKILL'` (house style: a hung git
 *  child can never hang this module), and an optional per-call `env` override (`opts.env`, used only for the
 *  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` a single `commit-tree` call needs — see {@link planRebuild}). */
export function makeGit({ run, cwd, env, timeoutMs = 60_000, extraEnv = {} }) {
  return (args, opts = {}) => run(args, {
    cwd,
    ...(Object.hasOwn(opts, 'input') ? { input: opts.input } : {}),
    ...(Object.hasOwn(opts, 'encoding') ? { encoding: opts.encoding } : {}),
    ...(Object.hasOwn(opts, 'maxBuffer') ? { maxBuffer: opts.maxBuffer } : {}),
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: { ...env, ...REBUILD_IDENTITY_ENV, ...extraEnv, ...(opts.env || {}) },
  });
}

/** `--verify --end-of-options` is this codebase's established pattern (`diff-branch-coverage.mjs`) for
 *  resolving a ref that might contain attacker-controlled text without git reading it as an option — plain
 *  `git rev-parse -- <ref>` does NOT do this (rev-parse echoes `--` back literally rather than treating it as
 *  an end-of-options marker); `--end-of-options` is the flag that actually does. Returns the resolved sha, or
 *  `null` on any failure (unknown ref, timeout, non-zero exit) — never coerced into a false positive. */
export function verifyRev(git, rev) {
  const r = git(['rev-parse', '--verify', '--end-of-options', rev]);
  const out = String(r.stdout ?? '').trim();
  return r.status === 0 && out ? out : null;
}

/** Registered carriers whose archived sources (including nested archives) are absent from a candidate.
 * Throws on unverifiable evidence so callers refuse rather than silently discard archived content. */
export function archiveUncovered(git, overlays, finalSha) {
  const uncovered = [];
  const covered = new Map();
  const carries = (sha) => {
    if (!FULL_SHA_RE.test(sha ?? '') || !FULL_SHA_RE.test(finalSha ?? '')) throw new Error('invalid archived commit');
    if (covered.has(sha)) return covered.get(sha);
    // A restored source may have advanced beyond its archived SHA. Prove the archive is in the
    // proposed build by ancestry; requiring equality with the live tip would hold recovery forever.
    const ancestor = git(['merge-base', '--is-ancestor', sha, finalSha]);
    if (ancestor.error || ![0, 1].includes(ancestor.status)) throw new Error('archive ancestry unavailable');
    let present = ancestor.status === 0;
    if (!present) {
      // Squash-landed/rebased content is safe only with whole-tree equivalence, as in retirement.
      const merged = git(['merge-tree', '--write-tree', '--no-messages', finalSha, sha]);
      if (merged.error || ![0, 1].includes(merged.status)) throw new Error('archive content unavailable');
      if (merged.status === 0) {
        const tree = verifyRev(git, `${finalSha}^{tree}`);
        const mergedTree = String(merged.stdout ?? '').split('\n')[0].trim();
        if (!FULL_SHA_RE.test(tree ?? '') || !FULL_SHA_RE.test(mergedTree)) throw new Error('archive tree unavailable');
        present = tree === mergedTree;
      }
    }
    covered.set(sha, present);
    return present;
  };
  for (const carrier of overlays) {
    const pending = [...(carrier.retiredSources ?? [])];
    let missing = false;
    while (pending.length) {
      const source = pending.pop();
      if (!carries(source?.sha)) missing = true;
      pending.push(...(source.entry?.retiredSources ?? []));
    }
    if (missing) uncovered.push(carrier);
  }
  return uncovered;
}
