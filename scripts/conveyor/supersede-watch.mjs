/**
 * @file scripts/conveyor/supersede-watch.mjs — card xiqtf7w. The IO shell around `supersede-rule.mjs`.
 *
 * Per repo, per tick of the fix daemon (`reconcile-fix-dispatch-daemon.mjs#runTickAllRepos`, BEFORE its fix and
 * ci-heal halves): read the PRs merged in the last `lookbackDays` (with bodies) and the open PR numbers, read the
 * comments of only the open PRs a merged PR names in a `Supersedes` line, plan with `planSupersedeHolds`, and for each
 * hold post the terminal stand-down through `stand-down.mjs` (`--reason=superseded`, which also adds the
 * `review-status:stood-down` and `superseded` labels). It never closes a PR: that is an operator decision.
 *
 * Setting off (`supersede-settings.json` / `WE_SUPERSEDE_HOLD`) = no read, no write. Every read is bounded; a failed
 * read skips the repo for this tick (reported, never thrown). Usage as a one-off: `node supersede-watch.mjs
 * [--repo=<owner/name>] [--apply]` (dry run without `--apply`).
 */
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import { isTrustedSupersedeAuthor, parseSupersedes, planSupersedeHolds, resolveSupersedeSettings, supersedeCandidates } from './supersede-rule.mjs';
import { readCompletePrComments } from './pr-comments-complete.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAND_DOWN_CLI = join(HERE, 'stand-down.mjs');
export const SUPERSEDE_WATCH_ACTOR = 'supersede-watch (card xiqtf7w)';
const LIST_LIMIT = 200;

const slugOf = (repo) => CONSTELLATION_REPOS[repo]?.slug ?? repo;
const ghJson = (args, exec) => JSON.parse(String(exec('gh', args, {
  stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024,
}) || 'null'));

/**
 * Merged PRs (number, body, state, mergedAt, author) merged within `lookbackDays` of `now`. `gh pr list` returns the newest
 * first; the window is applied here on `mergedAt` (a search qualifier would hide behind GitHub's search index).
 */
export function defaultReadMergedPrs({ repo, lookbackDays, now = Date.now(), exec = execFileSync }) {
  const since = now - lookbackDays * 86_400_000;
  return (ghJson(['pr', 'list', '--repo', slugOf(repo), '--state', 'merged',
    '--limit', String(LIST_LIMIT), '--json', 'number,body,state,mergedAt,author'], exec) ?? [])
    .filter((p) => (Date.parse(p?.mergedAt ?? '') || 0) >= since);
}

/**
 * When a merged PR's body was last edited and by whom (GraphQL: `gh pr list` has no such field). Read only for the few
 * merged PRs that carry a marker. `{ lastEditedAt: null, editor: null }` = never edited.
 */
export function defaultReadBodyEdit({ repo, pr, exec = execFileSync }) {
  const [owner, name] = slugOf(repo).split('/');
  const out = ghJson(['api', 'graphql', '-f', 'query=query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){lastEditedAt editor{login}}}}',
    '-f', `o=${owner}`, '-f', `n=${name}`, '-F', `p=${Number(pr)}`], exec);
  const node = out?.data?.repository?.pullRequest;
  if (!node) throw new Error(`no pull request #${pr} in ${slugOf(repo)}`);
  return { lastEditedAt: node.lastEditedAt ?? null, editor: node.editor ? { login: node.editor.login } : null };
}

/**
 * Put the body-edit facts on each merged PR whose marker could matter (trusted author, at least one target that is
 * still OPEN, so a read costs a call only when a hold is actually possible). A failed read marks that one PR
 * `bodyEditUnknown` (the rule then ignores it: a missed hold costs one fixer run, a false one stops an unrelated PR);
 * it never throws and never blocks the others. Returns `{ rows, failures }` so a persistent failure (no GraphQL access,
 * a rate limit) is reported instead of silently switching every hold off.
 */
export function withBodyEdits({ repo, mergedPrs, openNumbers, readBodyEdit = defaultReadBodyEdit }) {
  const open = new Set(openNumbers.map(Number));
  let failures = 0;
  const rows = mergedPrs.map((m) => {
    if (!isTrustedSupersedeAuthor(m) || !parseSupersedes(m.body).some((t) => open.has(t))) return m;
    try { return { ...m, ...readBodyEdit({ repo, pr: m.number }) }; } catch { failures += 1; return { ...m, bodyEditUnknown: true }; }
  });
  return { rows, failures };
}

/** Open PR numbers only (cheap); comments are read just for the candidates. */
export function defaultReadOpenNumbers({ repo, exec = execFileSync }) {
  return (ghJson(['pr', 'list', '--repo', slugOf(repo), '--state', 'open', '--limit', String(LIST_LIMIT), '--json', 'number'], exec) ?? [])
    .map((p) => p.number);
}

/** One candidate's state, read fresh, with its COMPLETE comment thread (paginated — a hold past comment 100 still counts). */
export function defaultReadPr({ repo, pr, exec = execFileSync, readComments = readCompletePrComments }) {
  const view = ghJson(['pr', 'view', String(pr), '--repo', slugOf(repo), '--json', 'number,state,labels'], exec);
  return { ...view, comments: readComments(pr, { repo: slugOf(repo) }) };
}

/** Post the hold through the stand-down CLI (comment + `review-status:stood-down` + `superseded` labels). */
export function defaultPostHold({ repo, hold, exec = execFileSync }) {
  try {
    const out = exec(process.execPath, [STAND_DOWN_CLI, String(hold.pr), `--repo=${slugOf(repo)}`, '--reason=superseded',
      `--superseded-by=${hold.by}`, ...(hold.mergedAt ? [`--merged-at=${hold.mergedAt}`] : []), `--actor=${SUPERSEDE_WATCH_ACTOR}`], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
    });
    const last = String(out || '').trim().split('\n').at(-1) || '{}';
    const parsed = JSON.parse(last);
    return { ok: !!parsed.ok, labeled: !!parsed.labeled };
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).trim().split('\n')[0] };
  }
}

/**
 * One repo's pass. Never throws.
 * @returns {{repo:string, holds:Array<object>, applied:Array<object>, skipped?:string, error?:string}}
 */
export function runSupersedeWatch({
  repo, apply = true, settings = resolveSupersedeSettings(), now = Date.now(),
  readMergedPrs = defaultReadMergedPrs, readOpenNumbers = defaultReadOpenNumbers, readPr = defaultReadPr, postHold = defaultPostHold,
  readBodyEdit = defaultReadBodyEdit,
} = {}) {
  if (!settings?.hold) return { repo, holds: [], applied: [], skipped: 'supersede hold is off' };
  try {
    const openNumbers = readOpenNumbers({ repo });
    const { rows: mergedPrs, failures: bodyEditFailures } = withBodyEdits({
      repo, mergedPrs: readMergedPrs({ repo, lookbackDays: settings.lookbackDays, now }), openNumbers, readBodyEdit });
    const candidates = supersedeCandidates({ mergedPrs, openNumbers });
    // Re-read each candidate: it must still be OPEN, and its own thread decides idempotency.
    const openPrs = candidates.map((pr) => readPr({ repo, pr })).filter((p) => String(p?.state ?? '').toUpperCase() === 'OPEN');
    const holds = planSupersedeHolds({ mergedPrs, openPrs, settings });
    const applied = apply ? holds.map((hold) => ({ ...hold, ...postHold({ repo, hold }) })) : [];
    return { repo, holds, applied, ...(bodyEditFailures ? { bodyEditFailures } : {}) };
  } catch (e) {
    return { repo, holds: [], applied: [], error: String(e?.message || e).split('\n')[0] };
  }
}

/** One printable line per hold this pass planned or posted. */
export function formatSupersedeLines(result) {
  const lines = [];
  for (const r of result?.repos ?? []) {
    if (r.error) lines.push(`supersede-watch ${r.repo} — read failed (non-fatal, retried next tick): ${r.error}`);
    if (r.bodyEditFailures) lines.push(`supersede-watch ${r.repo} — ${r.bodyEditFailures} merged-PR body-edit read(s) failed; those PRs' Supersedes lines are ignored this tick (retried next tick)`);
    const applied = new Map((r.applied ?? []).map((a) => [a.pr, a]));
    for (const h of r.holds ?? []) {
      const a = applied.get(h.pr);
      const outcome = !a ? 'planned (dry run)' : a.ok ? `stood down${a.labeled ? ', labelled superseded' : ' (label failed)'}` : `FAILED (${a.error ?? 'unknown'})`;
      lines.push(`supersede-watch ${r.repo} PR #${h.pr} — superseded by merged #${h.by} — ${outcome}; closing needs an operator decision`);
    }
  }
  return lines;
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const flags = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
  const repos = typeof flags.repo === 'string' ? [flags.repo] : Object.values(CONSTELLATION_REPOS).map((r) => r.slug);
  const result = { repos: repos.map((repo) => runSupersedeWatch({ repo, apply: flags.apply === true })) };
  for (const line of formatSupersedeLines(result)) process.stderr.write(`${line}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
