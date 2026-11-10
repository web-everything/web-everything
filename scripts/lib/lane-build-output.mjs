/** Ignored build cleanup, separate from the lane-pool CLI so importing it never dispatches a command. */
import { readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

/** Bind the pool's bounded, hardened Git runner without changing its error semantics. */
export function createBuildOutputCleaner(git) {
  /** List eligible top-level build directories using the fixed naming convention (_site, _site-*). */
  function ignoredBuildOutputDirs(dir) {
    const denied = new Set(['node_modules', '.git', '.claude', 'src', 'scripts', 'docs']);
    return readdirSync(dir).filter((name) => {
      // Only literal children in the fixed naming convention (_site, _site-*) are eligible.
      if (!(name === '_site' || /^_site-[A-Za-z0-9_.-]+$/.test(name)) || name.includes('..')) return false;
      if (denied.has(name)) return false;
      // Absent or symlinked outputs are never cleaned, so they need no git evidence (git rejects symlink pathspecs).
      try { if (!lstatSync(join(dir, name)).isDirectory()) return false; } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
      // Unknown Git evidence aborts cleanup; only check-ignore's exit 1 means not ignored.
      const path = `${name}/`;
      if (git(['ls-files', '--', path], dir) !== '') return false;
      try {
        return git(['check-ignore', '-q', '--', path], dir) === '';
      } catch (error) {
        if (error.code === 'exit' && error.status === 1) return false;
        throw error;
      }
    });
  }

  /** Remove eligible ignored build directories; failure must prevent handing out a dirty lane. */
  function cleanIgnoredBuildOutput(dir) {
    try {
      const dirs = ignoredBuildOutputDirs(dir).filter((name) => {
        try { return lstatSync(join(dir, name)).isDirectory(); } catch (e) { if (e?.code === 'ENOENT') return false; throw e; }
      });
      // Never invoke clean with an empty pathspec (which would target the whole repository).
      if (dirs.length) git(['clean', '-fdX', '--quiet', '--', ...dirs.map((name) => `${name}/`)], dir);
    } catch (e) {
      const message = `${e && e.message ? e.message : e}\n${e && e.stderr ? e.stderr : ''}`
        .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ');
      throw Object.assign(new Error(`ignored build output cleanup failed: ${message}`, { cause: e }), {
        ignoredBuildOutputCleanupFailure: true,
      });
    }
  }

  return { ignoredBuildOutputDirs, cleanIgnoredBuildOutput };
}
