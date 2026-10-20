#!/usr/bin/env node
/**
 * CI light-path detection (actions-queue-relief). A pull request whose diff touches ONLY backlog cards
 * (`backlog/**`) does not need the full sharded suite; `ci.yml`'s `changes` job runs this and the `test` /
 * `smoke` jobs read its output.
 *
 * FAIL-CLOSED by construction: only a `pull_request` event with a NON-EMPTY file list, every path of which is
 * under `backlog/`, is light. A push (main must always run the full suite), a manual dispatch, an empty or
 * unreadable diff, and any path outside `backlog/` (including `..` tricks and look-alike prefixes such as
 * `backlog-tools/`) are all full.
 *
 * Usage: node scripts/ci-card-only.mjs --event=<name> [--base=<sha>] [--head=<ref>]
 * Prints `light=true|false` (the GITHUB_OUTPUT line) and the reason on stderr.
 */
import { execFileSync } from 'node:child_process';

export const CARD_ONLY_PREFIXES = Object.freeze(['backlog/']);

/** @param {string} path */
export function isCardPath(path) {
  if (typeof path !== 'string' || !path || path.includes('\0')) return false;
  if (path.split('/').includes('..')) return false;
  if (/^backlog\/raised-by\/(?:\d{1,5}|x[a-z0-9]{6})\/\d+-[a-f0-9]{24}\.md$/.test(path)) return true;
  return /^backlog\/[^/\\\s]+\.md$/.test(path);
}

/**
 * @param {{event?: string, files?: string[]}} input
 * @returns {{light: boolean, reason: string}}
 */
export function classifyCardOnly({ event, files } = {}) {
  if (event !== 'pull_request') return { light: false, reason: `event "${event}" always runs the full suite` };
  if (!Array.isArray(files) || files.length === 0) return { light: false, reason: 'no changed-file list; running the full suite' };
  const outside = files.filter((f) => !isCardPath(f));
  if (outside.length) return { light: false, reason: `touches non-card path(s): ${outside.slice(0, 5).join(', ')}` };
  return { light: true, reason: `card-only: ${files.length} file(s), all under ${CARD_ONLY_PREFIXES.join(', ')}` };
}

/**
 * THE one definition of "card-only", shared by CI (`main` below) and the local verify gate
 * (`resolveDefaultGate`, skipLocalForCardOnly). Takes the `--no-renames` changed-file list of a PR.
 * @param {string[]|null|undefined} files
 */
export function isCardOnlyDiff(files) {
  return classifyCardOnly({ event: 'pull_request', files: files ?? undefined }).light;
}

/** The fetched main ref the workflow refreshes before this runs (fixed refspec; nothing PR-supplied reaches it). */
export const FRESH_MAIN_REF = 'refs/remotes/origin/main';

/**
 * Pick the diff basis for the card-only check. FRESH MAIN BASIS (PR #5619, same idea as the soak gate's #5939):
 * the event's `base.sha` can be FROZEN hours behind main. Once the drain merges a newer main into the lane, a
 * diff from that stale sha counts main's own commits as the PR's, so a one-card PR read as 47 files of code and
 * ran the full suite. For a main-targeted PR the basis is `git merge-base <fresh main> <head>`: only what the
 * PR itself changes against main. Any failure falls back to the event base — the old, wider diff, so the error
 * direction is always "more files, full suite", never "fewer files".
 * @param {{exec: (cmd: string, args: string[]) => string, base?: string, head?: string, baseRef?: string}} o
 * @returns {{diffBase: string, basis: 'fresh-main-merge-base'|'event-base', note?: string}}
 */
export function resolveCardOnlyBase({ exec, base, head = 'HEAD', baseRef } = {}) {
  const eventBase = { diffBase: String(base), basis: 'event-base' };
  if (baseRef !== 'main') return eventBase;
  try {
    const tip = exec('git', ['rev-parse', '--verify', '--end-of-options', `${FRESH_MAIN_REF}^{commit}`]).trim();
    const mb = exec('git', ['merge-base', '--end-of-options', tip, String(head)]).split('\n')[0].trim();
    if (/^[0-9a-f]{40,64}$/i.test(mb)) return { diffBase: mb, basis: 'fresh-main-merge-base' };
    return { ...eventBase, note: 'merge-base with fresh main was empty' };
  } catch (e) {
    return { ...eventBase, note: `fresh main unavailable (${String(e?.message || e).split('\n')[0]})` };
  }
}

function main() {
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }));
  let files = [];
  if (flags.event === 'pull_request') {
    try {
      const head = String(flags.head || 'HEAD');
      const exec = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const { diffBase, basis, note } = resolveCardOnlyBase({ exec, base: flags.base, head, baseRef: flags['base-ref'] });
      process.stderr.write(`ci-card-only: diff basis ${basis} ${diffBase} (event base ${flags.base})${note ? ` — ${note}` : ''}\n`);
      // --no-renames lists BOTH sides of a rename, so a move out of backlog/ is never hidden.
      files = execFileSync('git', ['diff', '--name-only', '--no-renames', diffBase, head],
        { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch (e) {
      process.stderr.write(`ci-card-only: git diff failed (${String(e.message).split('\n')[0]}); full suite\n`);
    }
  }
  const { light, reason } = classifyCardOnly({ event: flags.event, files });
  process.stderr.write(`ci-card-only: ${reason}\n`);
  process.stdout.write(`light=${light}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
