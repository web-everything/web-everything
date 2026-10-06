/**
 * rust-scan-bridge.mjs — the ONE call site that invokes the optional `we-scan` Rust binary (#3417),
 * falling back to the caller's JS implementation whenever it's unavailable: unbuilt (no
 * `cargo build --release` ever run in `scripts/rust-scan`), STALE (built before a later edit to the JS
 * reference it must match — see `referenceFiles` below), wrongly-shaped, or erroring. Never throws — a Rust
 * problem must never break `check:standards` itself, only forfeit its speedup for that run.
 *
 * `runWeScan` returns the SAME shape `we-scan`'s JSON output already matches its JS counterpart's return
 * value (verified byte-identical by `scripts/__tests__/rust-scan-*-parity.test.mjs`), so a caller does
 * `runWeScan(...) ?? theJsFunction(...)` and needs no other change.
 *
 * Concurrency (`--max-workers`) is NOT passed here — `we-scan` reads `WE_SCAN_MAX_WORKERS` itself when the
 * flag is omitted (default: a fixed 3, until the planned operation manager sets the env var per run). This
 * bridge stays a pure pass-through of that control, not a second place it could drift from the binary's own.
 *
 * ── PR #1741 review findings, both fixed here ───────────────────────────────────────────────────────────
 *   1. CORRECTNESS — `??` only falls back on `null`/`undefined`. A binary that emits syntactically valid but
 *      wrongly-shaped JSON (a build predating an output-contract change) would have been returned as-is,
 *      and an uncaught exception downstream (`check-standards.mjs` is a flat script with no wrapping try)
 *      would crash the WHOLE gate — not the "never breaks a caller" guarantee this module claims. Fixed by
 *      validating the shape here, centrally, once — every current and future call site inherits it, instead
 *      of depending on each one independently remembering to wrap itself.
 *   2. SECURITY — the header claimed "stale" handling but nothing detected it: a binary built once, then a
 *      JS reference file (e.g. `secret-scrub.mjs`, gaining a new credential pattern) edited afterward with
 *      no rebuild in between, would have its now-outdated output trusted as authoritative by a REAL security
 *      gate (secret-scrub) — a credential the JS detector would catch could silently reach a COMMITTED,
 *      PUSHED file. Fixed with an mtime-based freshness check: a caller passes `referenceFiles` (the JS
 *      source(s) this subcommand's binary output must match); if any is newer than the binary, it's treated
 *      as stale — same `null` fallback as every other failure mode. Deliberately mtime-based, not a
 *      source-hash embedded in the binary (the review's suggested alternative): far simpler to implement
 *      and test, and its only failure direction is SAFE — a false "stale" reading (e.g. a fresh git clone
 *      touching file mtimes) costs an extra JS fallback run, never a missed detection, since editing a file
 *      always moves its mtime forward relative to whenever the binary was last built.
 *
 * ── #4168 — `opts.scoped` ───────────────────────────────────────────────────────────────────────────────
 *   The binary always does its OWN full-corpus file walk (no `--files` flag it understands) — it has no
 *   scoped mode to fall INTO, unlike the JS implementations each caller passes as its fallback. A caller
 *   running under `--local --files=<lane files>` (check-standards.mjs's `SCOPE_TO_FILES`) passes
 *   `opts.scoped: true` to say so; this bridge then skips invoking the binary entirely and returns `null`
 *   straight away, exactly like the missing/stale/erroring cases, so the caller's own (now file-scoped) JS
 *   fallback runs instead — never the binary silently re-doing the whole-corpus walk the caller scoped
 *   down specifically to avoid, and never a wrong/ignored `--files`-shaped flag invented for a binary that
 *   doesn't parse one. One choke point for this instead of every call site re-deciding it.
 *
 * ── #70d — the shared, content-keyed binary (`deps.resolveSharedBin`) ───────────────────────────────────
 *   The mtime check above misjudges a lane clone both ways: a fresh clone resets every mtime (an old binary reads
 *   "stale", so lanes fell back to JS), and an old clone keeps a binary built from OLDER Rust source that still
 *   reads "fresh". The default runner now first asks we:scripts/lib/we-scan-cache.mjs for a host-wide binary
 *   built from origin/main's Rust source and trusted by CONTENT against the call's reference files. Only with no
 *   trusted match does it use this checkout's own binary under the original mtime check — then JS, as before.
 */
import { existsSync, statSync } from 'node:fs';
import { resolveSharedWeScan } from './we-scan-cache.mjs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = join(HERE, '..', 'rust-scan', 'target', 'release', 'we-scan');

function mtimeMs(path) {
  try { return statSync(path).mtimeMs; } catch { return null; }
}

/**
 * Build a `runWeScan`-shaped function bound to a specific binary path — the injection seam a test uses to
 * exercise the missing/stale/malformed/erroring fallback paths without needing a real `cargo build` (see
 * scripts/lib/__tests__/rust-scan-bridge.test.mjs). `runWeScan` below is just this bound to the real path.
 * @param {string} binPath
 * @param {{resolveSharedBin?: (referenceFiles: string[], subcommand: string) => string|null}} [deps] #70d — a
 *   content-trusted shared binary for this call, tried BEFORE `binPath`; null → `binPath` with its usual checks.
 * @returns {(subcommand: string, args: string[], opts?: {referenceFiles?: string[], scoped?: boolean}) => unknown|null}
 */
export function createWeScanRunner(binPath, { resolveSharedBin } = {}) {
  // One notice per RUNNER, not per call — check-standards.mjs calls this from more than one section, and a
  // missing/stale binary is one fact worth stating once, not once per subcommand.
  const warned = new Set(); // reasons already logged this run
  const note = (reason, msg) => {
    if (warned.has(reason)) return;
    warned.add(reason);
    process.stderr.write(msg);
  };

  return function runWeScan(subcommand, args, opts = {}) {
    const { referenceFiles = [], scoped = false } = opts;

    if (scoped) {
      note('scoped', `note: we-scan ${subcommand} has no file-scoped mode (#4168) — using the caller's own ` +
        'file-scoped JS fallback instead of the whole-corpus binary walk\n');
      return null;
    }

    // #70d — a content-trusted shared build (see we-scan-cache.mjs) wins over this checkout's own binary, whose
    // freshness is only an mtime guess; with no trusted shared build, the original local checks apply unchanged.
    let bin = null;
    try { bin = resolveSharedBin ? resolveSharedBin(referenceFiles, subcommand) : null; } catch { bin = null; }
    if (bin) {
      note('shared', `note: using the shared we-scan build ${bin} (#70d)\n`);
    } else {
      if (!existsSync(binPath)) {
        note('missing', `note: ${binPath} not built — falling back to the JS scan(s) it would otherwise ` +
          'replace (run `cargo build --release` in scripts/rust-scan for the faster, parallel path)\n');
        return null;
      }

      const binMtime = mtimeMs(binPath);
      const staleAgainst = referenceFiles.find((f) => {
        const m = mtimeMs(f);
        return m != null && binMtime != null && m > binMtime;
      });
      if (staleAgainst) {
        note('stale', `note: ${binPath} is STALE (older than ${staleAgainst}) — falling back to the JS scan ` +
          'until it is rebuilt (`cargo build --release` in scripts/rust-scan)\n');
        return null;
      }
      bin = binPath;
    }

    let out;
    try {
      out = execFileSync(bin, [subcommand, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    } catch (e) {
      note(`exec-${subcommand}`, `note: we-scan ${subcommand} failed (${e.message}) — falling back to the JS scan\n`);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (e) {
      note(`parse-${subcommand}`, `note: we-scan ${subcommand} produced unparseable output (${e.message}) — falling back to the JS scan\n`);
      return null;
    }
    // Every current we-scan subcommand returns a JSON ARRAY of findings — the one contract shape every
    // caller relies on. A parseable-but-wrongly-shaped result (a stale build predating an output-contract
    // change, or any future drift) must be refused here, not returned as if valid (finding 1 above).
    if (!Array.isArray(parsed)) {
      note(`shape-${subcommand}`, `note: we-scan ${subcommand} returned non-array output (unexpected shape) — falling back to the JS scan\n`);
      return null;
    }
    return parsed;
  };
}

/**
 * Run a `we-scan` subcommand and return its parsed JSON array, or `null` on ANY failure (binary missing,
 * STALE — see `opts.referenceFiles` — non-zero exit, unparseable stdout, or non-array output). `null` is
 * the whole contract: "fall back to the JS scan", never a thrown error a caller has to handle.
 * @param {string} subcommand e.g. 'stdout-flush', 'secret-scrub'
 * @param {string[]} args e.g. [`--root=${ROOT}`]
 * @param {{referenceFiles?: string[], scoped?: boolean}} [opts] `referenceFiles` — absolute paths to the JS
 *   source(s) this subcommand's Rust output must match; if any is newer than the binary, it's treated as
 *   stale. `scoped` (#4168) — the caller is running under `--local --files=…` and has its own file-scoped
 *   JS fallback ready; skip the (always whole-corpus) binary and return `null` immediately.
 * @returns {unknown[]|null}
 */
/**
 * #70d — subcommands the shared build may serve: only those measured NOT slower than their JS fallback. Measured
 * 2026-10-06 on this repo (host load ~15 on 12 cores): secret-scrub 0.9 s vs JS 1.7 s; stdout-flush 0.9 s vs JS
 * 1.1 s; citation-check 12.3 s vs JS 1.5 s — so citation-check stays JS unless a checkout built its own binary.
 */
export const SHARED_SUBCOMMANDS = new Set(['secret-scrub', 'stdout-flush']);

export const runWeScan = createWeScanRunner(DEFAULT_BIN, {
  resolveSharedBin: (referenceFiles, subcommand) => (SHARED_SUBCOMMANDS.has(subcommand)
    ? resolveSharedWeScan({ root: join(HERE, '..', '..'), referenceFiles })
    : null),
});
