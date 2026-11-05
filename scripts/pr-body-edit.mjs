#!/usr/bin/env node
/**
 * @file scripts/pr-body-edit.mjs
 * @description Replace a PR body while CARRYING THE `authored-by-actor` STAMP ACROSS — and, with `--repair`,
 *   RESTORE a stamp a body has already lost, from ROUTES no shell guard can reach (the web UI included).
 *
 * WHY (the base `--body-file` mode): `pr-land` writes the stamp at open and `review-independence.mjs` reads it
 * to refuse an author clearing its own PR. A raw `gh pr edit --body` replaces the whole body, dropping the
 * stamp, and the guard then reads `unknown-author` — which the invoked CLI deliberately permits. Permitting it
 * is correct for a PR opened before the stamp existed and wrong for one whose stamp was stripped, and after the
 * fact nothing can tell those apart. Keeping the stamp is what preserves the distinction.
 *
 * `guard-bash.mjs` denies the raw command and points here.
 *
 * WHY `--repair` (#3067): the carry-forward above only helps a body edited THROUGH this tool. A body edited in
 * the GitHub web UI — the one route no shell guard can intercept — loses its stamp with nothing here ever
 * observing the edit. GitHub's GraphQL userContentEdits records the historical snapshots and editors.
 * Recovery requires agreement across all stamped snapshots and a stamp supplied by the PR author.
 * Unreadable, incomplete, empty or ambiguous history refuses without changing the body.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readAuthorStampEdits, restoreAuthorStamp } from './lib/author-stamp-restore.mjs';
import { execFileSyncThrottled } from './lib/gh-throttle.mjs';
import {
  readAuthorActorStamps, buildAuthorActorMarker,
} from './lib/review-independence.mjs';
// #3061 — `process.exit()` discards a buffered `process.stdout.write`. This script exits on the value of
// `main()`, which is the shape that truncates most reliably.
import { writeLineSync } from './lib/write-all-sync.mjs';

/**
 * The body to write: `next`, plus the stamps `current` carried that `next` lacks.
 *
 * Carries EVERY distinct stamp, not just one. `parseAuthorActorId` resolves a two-stamp body to '' on purpose
 * (agreement-or-nothing), so dropping one here would silently convert an ambiguous body into a confident
 * single-author one — turning a refusal into a permit. Pure.
 *
 * @param {string} current - the body now on the PR.
 * @param {string} next - the replacement body.
 * @returns {{body: string, carried: string[]}}
 */
export function withCarriedStamps(current, next) {
  const have = new Set(readAuthorActorStamps(next));
  const carried = readAuthorActorStamps(current).filter((id) => !have.has(id));
  if (!carried.length) return { body: next, carried: [] };
  const markers = carried.map(buildAuthorActorMarker).filter(Boolean);
  return { body: `${next.replace(/\s*$/, '')}\n\n${markers.join('\n')}\n`, carried };
}

/**
 * #3067's RECOVERY — find the author stamp GitHub's own edit history still remembers, when the LIVE body has
 * none. `fromBodies` is every prior body state the caller read from GitHub's edit history (oldest or newest order does not matter — every one is scanned). Pure.
 *
 * AGREEMENT-OR-NOTHING, same discipline as `parseAuthorActorId` and for the same reason: if the history shows
 * two DIFFERENT ids across its edits (a re-authored PR, or a forge attempt) there is no honest basis to pick
 * one, so this answers '' rather than guess. Provenance must be checked separately before restoration.
 *
 * @param {string[]} fromBodies - prior body snapshots, in any order.
 * @returns {string} the single id every stamped snapshot agrees on, or '' when none/ambiguous.
 */
export function recoverAuthorIdFromHistory(fromBodies) {
  const ids = new Set();
  for (const body of Array.isArray(fromBodies) ? fromBodies : []) {
    for (const id of readAuthorActorStamps(body)) ids.add(id);
  }
  return ids.size === 1 ? [...ids][0] : '';
}

/** Write `body` back to the PR — same stdin-backed, sanctioned-override edit both modes below use. Shared so
 *  neither mode can drift on how the write actually happens.
 *
 *  `execFile` defaults to the real `execFileSync` and is only ever overridden by a test — real callers never
 *  pass it, so this default IS production behavior, not a seam that could silently diverge from it. */
function writeBody(pr, repo, body, execFile = execFileSync) {
  execFile('gh', ['pr', 'edit', pr, '--body-file', '-', ...(repo ? ['--repo', repo] : [])],
    { input: body, encoding: 'utf8', env: { ...process.env, PR_BODY_STAMP_OK: '1' } });
}

/** Restore only an author-proven stamp from complete GraphQL history; refuse without writes otherwise. */
export function repair(gh, pr, repo, execFile = execFileSyncThrottled) {
  try {
    const slug = repo || JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
    const result = restoreAuthorStamp({
      pr, repo: slug,
      readPr: () => JSON.parse(gh(['pr', 'view', pr, '--json', 'state,body,author'])),
      readEdits: () => readAuthorStampEdits(pr, { repo: slug, exec: execFile }),
      writeBody: (_, body) => writeBody(pr, repo, body, execFile),
      log: (line) => writeLineSync(1, line),
    });
    if (result.action === 'refuse') {
      writeLineSync(2, `pr-body-edit: #${pr} refused — ${result.reason}`);
      return 1;
    }
    return 0;
  } catch {
    writeLineSync(2, `pr-body-edit: #${pr} could not read repository or PR evidence; retry when readable`);
    return 1;
  }
}

function main(argv) {
  const arg = (n) => (argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=');
  const pr = arg('pr');
  const file = arg('body-file');
  const repo = arg('repo');
  const gh = (args) => execFileSync('gh', repo ? [...args, '--repo', repo] : args, { encoding: 'utf8' });
  if (argv.includes('--repair')) {
    if (!pr) {
      writeLineSync(2, 'usage: pr-body-edit.mjs --pr=<n> --repair [--repo=<owner/name>]');
      return 2;
    }
    if (file) {
      writeLineSync(2, 'pr-body-edit: --repair and --body-file are mutually exclusive');
      return 2;
    }
    return repair(gh, pr, repo);
  }
  if (!pr || !file) {
    writeLineSync(2, 'usage: pr-body-edit.mjs --pr=<n> --body-file=<path> [--repo=<owner/name>]\n'
      + '   or: pr-body-edit.mjs --pr=<n> --repair [--repo=<owner/name>]');
    return 2;
  }
  const current = JSON.parse(gh(['pr', 'view', pr, '--json', 'body'])).body || '';
  const { body, carried } = withCarriedStamps(current, readFileSync(file, 'utf8'));
  // Hand the body via stdin-backed file rather than argv: a long body overflows the arg limit.
  writeBody(pr, repo, body);
  writeLineSync(1, carried.length
    ? `pr-body-edit: #${pr} updated; carried ${carried.length} author stamp(s) across`
    : `pr-body-edit: #${pr} updated; no stamp to carry (body had none)`);
  return 0;
}

// `process.exitCode =`, not `process.exit()` — #3061's `exit-wraps-call` shape discards the callee's flush.
if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
