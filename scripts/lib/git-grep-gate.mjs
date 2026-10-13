/**
 * git-grep-gate.mjs — the ONE fail-closed wrapper for a citation gate's raw `git grep -n` scan (#4490).
 *
 * Gates 6f-ii-c and 6f-ii-d each hand-rolled `execFileSync('git', ['grep', …])` inside a try/catch. `git grep`
 * exits 1 on "no match" — the common, expected empty case — but ANY other outcome (git missing, output past
 * `maxBuffer`, exit ≥ 2) is NOT "no findings". A catch-all that treats it as clean reports a green gate for a
 * scan that never completed. This helper owns that one contract so every gate gets it:
 *
 *   exit 0            → `{ ok: true,  lines }`   (non-blank output lines)
 *   exit 1            → `{ ok: true,  lines: [] }` (genuine no match)
 *   anything else     → `emit(note, { kind, file, global: true })`, `{ ok: false, lines: [] }`
 *
 * `run` is injectable (default `execFileSync`) so the contract is unit-testable without a real git.
 */
import { execFileSync } from 'node:child_process';

const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * @param {string} pattern  ERE source; passed after `-e` so a leading `-` is never parsed as an option.
 * @param {object} opts
 * @param {string[]} [opts.pathspecs]  pathspecs placed after `--` (default `['.']`).
 * @param {string} [opts.cwd]
 * @param {Function} [opts.run]        `execFileSync`-shaped runner.
 * @param {Function} opts.emit         `(message, meta)` — how this gate reports a failed scan.
 * @param {string} opts.kind           finding kind handed to `emit`.
 * @param {string} [opts.file]         file recorded on the finding.
 * @param {string} [opts.label]        gate name used in the failure note.
 * @returns {{ ok: boolean, lines: string[] }}
 */
export function runGitGrepGate(pattern, { pathspecs = ['.'], cwd, run = execFileSync, emit, kind, file = 'scripts/check-standards.mjs', label = 'citation gate' } = {}) {
  try {
    const out = run(
      'git', ['grep', '--threads=1', '-nE', '-e', pattern, '--', ...pathspecs],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: MAX_BUFFER },
    );
    return { ok: true, lines: String(out).split('\n').filter(Boolean) };
  } catch (e) {
    if (e?.status === 1) return { ok: true, lines: [] };
    // First line only: an error message can carry a multi-line stderr tail (untrusted text into a note).
    const why = String(e?.message || e).split('\n')[0];
    emit(`${label}: git grep failed unexpectedly (${why}) — this run's findings may be INCOMPLETE, not clean.`,
      { kind, file, global: true });
    return { ok: false, lines: [] };
  }
}
