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
  return CARD_ONLY_PREFIXES.some((p) => path.startsWith(p) && path.length > p.length);
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

function main() {
  const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const i = a.indexOf('=');
    return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
  }));
  let files = [];
  if (flags.event === 'pull_request') {
    try {
      // --no-renames lists BOTH sides of a rename, so a move out of backlog/ is never hidden.
      files = execFileSync('git', ['diff', '--name-only', '--no-renames', String(flags.base), String(flags.head || 'HEAD')],
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
