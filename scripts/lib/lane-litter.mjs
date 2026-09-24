/**
 * @file scripts/lib/lane-litter.mjs
 * @description The shared "known-safe scratch litter" allowlist + cleanup core for `we:backlog/3568-*.md`.
 *
 * WHY THIS EXISTS. Live-observed 2026-09-07: 46 of 48 web-everything lanes were simultaneously DIRTY —
 * every one of them carrying only untracked scratch files (`.commit-msg.txt`, `.pr-body.md`, `.pr-body.txt`,
 * `review-*-output.json`, `commit-msg-fix-*.txt`) that `we:skills-src/conveyor/delivery-agent-brief.md`
 * explicitly instructs every delivery agent to write INSIDE its lane — while `lane-pool.mjs`'s `cmdRelease`
 * only ever dropped the lease marker, never the tree. The pool read 0 acquirable at once as a direct result.
 *
 * A release-time fix and a periodic reap pass both need to answer the exact same question — "is this file a
 * known-safe scratch file, safe to discard?" — and MUST agree, or the pool degrades again the moment either
 * one lags the other. This module is that single source of truth: `we:scripts/lane-pool.mjs#cmdRelease` and
 * `we:scripts/conveyor/lane-pool-health-watch.mjs` both import it rather than re-deriving it.
 *
 * #3383 — the SAME allowlist also answers a second, ACQUIRE-time question: is a lane misread as "dirty" only
 * because of this litter? `we:scripts/lane-pool.mjs`'s auto-pick (`infoFor`), its pre-reset re-verify, and the
 * read-only `list --acquirable` / `provision --acquirable` picker (`laneAcquirableInfo`) all consult
 * {@link planLitterCleanup} (via `lane-pool.mjs`'s own `litterAdjustedDirty` helper) to set aside allowlisted
 * untracked paths before deciding `dirty`. Reusing this exact list — never a second, separately-maintained one
 * — is what keeps "a lane the picker calls acquirable" and "a lane whose litter release/reap will discard"
 * answering the same question from the same data.
 *
 * PURE CORE / IO SPLIT:
 *   • {@link LANE_RELEASE_LITTER_ALLOWLIST}, {@link isAllowlistedLitterPath}, {@link planLitterCleanup} are
 *     PURE — no fs/git/process.
 *   • {@link cleanLaneLitter} is the one IO caller (`git status --porcelain` + a scoped `git clean -f --`
 *     per allowlisted path) — never a blanket `git clean -fdx` / `reset --hard`. A tracked-file modification,
 *     or any untracked file NOT on the allowlist, is left exactly as-is: this only shrinks the false-positive
 *     "dirty" set (#2267's data-loss guard), it never widens what counts as safe to discard.
 */
import { execFileSync } from 'node:child_process';

/**
 * The exact live-observed set of scratch files a delivery agent's own arc (`delivery-agent-brief.md`) writes
 * INSIDE its lane. Extend this list, don't loosen the mechanism, if another safe pattern is found later.
 * `*` matches any run of characters within one path segment (no directory traversal).
 * @type {string[]}
 */
export const LANE_RELEASE_LITTER_ALLOWLIST = [
  '.commit-msg.txt',
  '.pr-body.md',
  '.pr-body.txt',
  'review-*-output.json',
  'commit-msg-fix-*.txt',
  // The dot-prefixed form of the two patterns above that didn't already have one (`review-*-output.json`,
  // `commit-msg-fix-*.txt` — the other three already start with a dot) — live-caught 2026-09-22: several
  // lanes' ONLY dirty file was `.review-loop-output.json` (leading dot), which `review-*-output.json` never
  // matched (a glob has no implicit "optionally dotted" behavior), so
  // `we:scripts/conveyor/lane-pool-health-watch.mjs` left them dirty forever even though the content is
  // exactly the same already-vetted-safe scratch, just written with a leading dot. Added as explicit new
  // entries, per this list's own stated philosophy ("extend this list, don't loosen the mechanism") — not a
  // change to the matcher's semantics, and not a license to assume every dotfile is safe: only these two
  // already-vetted patterns, dotted.
  '.commit-msg-fix-*.txt',
  '.review-*-output.json',
  // #3383 — live-observed 2026-09-23 on the plateau-app pool: `.pr-body.md`/`.pr-body.txt` above are the
  // EXACT-name forms, but `we:scripts/operations/deliver-item-wrapper.mjs` and the open-PR / land-PR steps
  // also write a per-item/per-round SUFFIXED name (`.pr-body-2759.md`, `.pr-body-wip-postdeploy-smoke.md`),
  // an `.open-pr*.json` result file (`.open-pr.json`, `.open-pr-out.json`), and a fixed `.pr-land-result.json`
  // — none of which any existing pattern matched, so lanes carrying ONLY these were misread as dirty forever
  // (the exact #3568 failure mode, just with a scratch name this list hadn't caught up to yet).
  '.pr-body-*.md',
  '.open-pr*.json',
  '.pr-land-result.json',
  // #3383 — the converge loop (`we:scripts/operations/deliver-item-wrapper.mjs`'s per-round bookkeeping,
  // `we:scripts/converge-cli.mjs`) writes a whole family of `.converge-*` scratch files per round
  // (`.converge-state.json`, `.converge-material-r1.txt`, `.converge-panel-r1-result.stderr`,
  // `.converge-*.diff`, …) — live-caught 2026-09-23 with one plateau-app lane carrying 44 of them as its
  // ONLY dirty content. One prefix pattern (not one entry per extension/round) since the round number and
  // extension both vary and `[^/]*` already matches across dots within a path segment.
  '.converge-*',
  // #x01u7az — live-observed 2026-09-24 on the web-everything pool: `.conveyor/` (the session sidecar
  // `we:scripts/conveyor/infra-blocked.mjs`'s own header describes — a per-clone, GITIGNORED directory of
  // operational state: `queue.json`, `infra-blocked.json`, `run-scorecards.json`, lock files, `.log`s) was the
  // ONLY dirty entry on roughly two dozen of the ~90-lane pool at once, none of them holding a live lease —
  // `git status --porcelain` reports a wholly-untracked directory as one `?? .conveyor/` line, which none of
  // the file-shaped patterns above (`[^/]*` never crosses the trailing `/`) could ever match. That falsely
  // "dirty" majority is what starved `we:scripts/lane-pool.mjs acquire --purpose=review-loop`: seven straight
  // `review-2582` dispatches over more than an hour each read "no free lane … (N all held/dirty)" and reported
  // `blocked-on-infra` with no advisory ever posted, while the pool's real free capacity sat locked behind
  // nothing but this directory. Safe to allowlist: every concrete path this repo's own `.gitignore` names under
  // `.conveyor/` is generated, regenerable session state, never product content, and a genuinely-leased lane's
  // `.conveyor/` is never reachable here at all — `isLeasedNow` (this module's own knob) still refuses to touch
  // a lane a live occupant is standing in, on this path exactly as on every other. `git clean -f` (no `-d`) on
  // an explicit directory pathspec DOES remove it when every entry beneath is untracked (verified against this
  // repo's own git before relying on it) — so `cleanLaneLitter`'s existing removal call needs no change, only
  // the allowlist did.
  '.conveyor/',
  // #x01u7az — same live incident: two lanes' only dirty entries were `.delivery-commit-msg-build.txt` /
  // `.delivery-commit-msg-gate-fix.txt` — a `.delivery-`-prefixed sibling of the already-allowlisted
  // `.commit-msg-fix-*.txt` / `commit-msg-fix-*.txt` family above, one more naming drift of the exact scratch
  // shape #3568 already vetted, not a new kind of file.
  '.delivery-commit-msg-*.txt',
];

/**
 * One allowlist glob → an anchored RegExp. Pure. `*` → `[^/]*` — NOT `.*` — so it stays within one path
 * segment, matching this file's own documented contract ("no directory traversal"): a candidate like
 * `review-foo/bar-output.json` must never match `review-*-output.json` just because `.*` would happily
 * consume the `/`. Everything else is escaped literally.
 */
function globToRegExp(pattern) {
  // `?` is a real regex meta-character (single-char wildcard) and was missing from this escape set — an
  // allowlist entry containing a literal `?` would otherwise silently widen its own match instead of being
  // escaped. `-` is deliberately NOT escaped: it is only special inside a `[...]` character class, and this
  // function never emits one (there is no `[...]` in the replacement), so an unescaped literal `-` is inert.
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

/**
 * Does this (relative) path match one of the allowlist's known-safe litter patterns? Pure.
 * @param {string} path
 * @param {string[]} [allowlist]
 * @returns {boolean}
 */
export function isAllowlistedLitterPath(path, allowlist = LANE_RELEASE_LITTER_ALLOWLIST) {
  const p = String(path || '');
  return allowlist.some((pattern) => globToRegExp(pattern).test(p));
}

/**
 * THE WHOLE DECISION: given a lane's raw `git status --porcelain` output, which paths are safe to discard and
 * which must be left exactly as `laneDirtyOrAhead` already sees them (still dirty, still correctly refused by
 * auto-pick)? Pure — no fs/git. Only an UNTRACKED entry (`??`) matching the allowlist is ever a candidate: a
 * tracked-file modification/staged change is never eligible no matter its name, since `git status --porcelain`
 * never reports those with the `??` prefix.
 *
 * Parses plain (not `-z`/NUL-terminated) porcelain output, so a filename git C-quotes (containing a quote,
 * backslash, or non-ASCII byte) would be read with its quoting still attached. Not a live gap: every
 * `LANE_RELEASE_LITTER_ALLOWLIST` pattern is a fixed, plain-ASCII prefix/suffix around a `[^/]*` segment, so no
 * name it can ever match requires C-quoting in the first place — this only matters if the allowlist is later
 * extended with a pattern permitting such characters, at which point switching to `-z` parsing here (and in
 * every caller) becomes load-bearing, not merely tidy.
 * @param {string|null} porcelain - raw `git status --porcelain` stdout (or null on a git failure).
 * @param {string[]} [allowlist]
 * @returns {{toRemove: string[], leaveDirty: string[]}}
 */
export function planLitterCleanup(porcelain, allowlist = LANE_RELEASE_LITTER_ALLOWLIST) {
  const lines = String(porcelain || '').split('\n').filter(Boolean);
  const toRemove = [];
  const leaveDirty = [];
  for (const line of lines) {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (status === '??' && isAllowlistedLitterPath(path, allowlist)) toRemove.push(path);
    else leaveDirty.push(path);
  }
  return { toRemove, leaveDirty };
}

const tryGit = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
};

/**
 * THE ONE IO CALLER. Reads `dir`'s current porcelain status, plans the cleanup ({@link planLitterCleanup}),
 * and — for every allowlisted untracked path — runs a PATH-SCOPED, literal-pathspec `git clean -f --`
 * (never `-d`/`-x`, never a bare `git clean -fdx` / `reset --hard`). Non-allowlisted dirty state, and any
 * TRACKED file sharing an allowlisted name, are left untouched. A failed status read returns `skipped: true`
 * — never conflated with "verified clean" (see the inline comment). `complete` is `true` only when every path
 * THIS call's own fresh read found removable was actually removed — judged against that fresh count, never a
 * caller's own (possibly stale) expectation of how many there should be.
 *
 * `isLeasedNow` (optional; `cmdRelease` omits it, `we:scripts/conveyor/lane-pool-health-watch.mjs` passes its
 * `defaultIsLeasedNow`) is the ONE knob for "no live occupant vouches for this lane, so be conservative" —
 * its mere presence ALSO requires `leaveDirty` to be EMPTY (the health-watch pass's own plan is built from an
 * earlier snapshot, and real dirty state can appear before this call runs; gating on this call's own fresh
 * read, not a separate caller pre-check, keeps read-then-act one atomic step). When given, it is additionally
 * re-checked before EVERY `git clean` call, not once up front — `toRemove` can hold several entries, and a
 * lane's status read alone cannot tell "old abandoned litter" from "a file a brand-new occupant just wrote",
 * so ownership must be re-verified as close to each mutation as possible. A `true` result stops the loop,
 * keeping whatever was already removed.
 * @param {string} dir - the lane's working tree.
 * @param {{allowlist?: string[], isLeasedNow?: ((dir: string) => boolean)|null}} [o]
 * @returns {{removed: string[], leaveDirty: string[], skipped: boolean, complete: boolean}}
 */
export function cleanLaneLitter(dir, { allowlist = LANE_RELEASE_LITTER_ALLOWLIST, isLeasedNow = null } = {}) {
  const porcelain = tryGit(['status', '--porcelain'], dir);
  // A `null` porcelain means the status read itself FAILED (dir vanished, permission fault, …) — this must
  // never be conflated with "verified clean, nothing to remove" (`planLitterCleanup(null)` would otherwise
  // report empty `toRemove`/`leaveDirty`, which reads identically to a genuinely clean lane). `skipped: true`
  // regardless of `isLeasedNow`: a caller that could not verify anything must never be told "not skipped" —
  // the SAME "read failure is never silently reported as clean" rule
  // `we:scripts/conveyor/lane-pool-health-watch.mjs#planLaneReap`'s own `read-error` action already applies.
  if (porcelain === null) {
    return { removed: [], leaveDirty: [], skipped: true, complete: false };
  }
  const { toRemove, leaveDirty } = planLitterCleanup(porcelain, allowlist);
  if (isLeasedNow && leaveDirty.length > 0) {
    return { removed: [], leaveDirty, skipped: true, complete: false };
  }
  const removed = [];
  for (const path of toRemove) {
    // Re-checked on EVERY iteration, not once before the loop: a multi-entry `toRemove` spans several
    // sequential `git clean` spawns, and checking only once up front would leave every removal AFTER the
    // first one unguarded if a lease were acquired mid-loop. A trip here is a DECLINE, not a partial success
    // — `complete` must read false, never derived from comparing against a caller's own (possibly stale)
    // count of what it expected to remove.
    if (isLeasedNow && isLeasedNow(dir)) {
      return { removed, leaveDirty, skipped: true, complete: false };
    }
    // `:(literal)` forces git's pathspec parser to match this LITERAL string, not a glob — without it, a
    // real filename that happens to contain a `*`/`?`/`[` (and still matches this module's own allowlist
    // regex, e.g. a file literally named `review-*-output.json`) would have git's OWN glob semantics expand
    // the pathspec and delete OTHER untracked files beyond the single one intended.
    // `tryGit` returns `null` on failure (never throws) — only count `path` as removed when the clean call
    // itself actually succeeded, not merely attempted.
    if (tryGit(['clean', '-f', '--quiet', '--', `:(literal)${path}`], dir) !== null) removed.push(path);
  }
  // `complete` is judged against THIS call's own freshly-computed `toRemove`, never a caller's earlier
  // snapshot — a caller comparing against a stale count would misjudge a lane whose real litter set changed
  // size between its snapshot and this call as incomplete even when this run fully succeeded (or vice versa).
  return { removed, leaveDirty, skipped: false, complete: removed.length === toRemove.length };
}
