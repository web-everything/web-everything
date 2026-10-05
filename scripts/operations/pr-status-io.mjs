/**
 * @file scripts/operations/pr-status-io.mjs
 * @description The INJECTED READER for the `pr-status` operation — the only half that shells `gh`. Kept out
 *   of `pr-status.mjs` for the same reason `gate-health-io.mjs` is kept out of its declaration: that file's
 *   import graph is asserted free of `node:` specifiers, so its step functions provably hold no writer in
 *   lexical scope. Everything here READS.
 */
import { execFileSync } from 'node:child_process';
import { standDownComments } from '../conveyor/stand-down.mjs';

/** How long a `gh` call may take before it is abandoned. A kill lands as a throw, never as an empty list. */
export const GH_TIMEOUT_MS = 60 * 1000;

/**
 * How many open PRs one listing may return.
 *
 * A CAP THAT IS REPORTED, NOT ONE THAT IS SILENT (PR #1521 juror). The first cut asked for 100 and said
 * nothing when a repo had more, so PR 101 was simply absent from a report whose whole purpose is noticing a
 * PR nobody is looking at. That is this operation's own defect turned on itself: silence reading as absence.
 *
 * Raised, and — more importantly — `createPrReader` now detects a listing that came back FULL and marks the
 * result `truncated`, because the honest answer to "were there more?" is either "no" or "I cannot tell", and
 * a bare list cannot distinguish them. `no silent caps` is the rule; this is it applied to itself.
 */
export const LIST_LIMIT = 200;

/**
 * The argv for the open-PR listing. PURE, and exported so a test can assert the exact command with no
 * subprocess — the discipline `verify-io.mjs` applies to its own spawn.
 *
 * `headRefOid` IS THE FIELD THAT MATTERS. Every state this operation reports is a claim about one commit, and
 * asking `gh` for the PR without it yields a PR whose head is unknown — which `shapeReadFinding` refuses
 * rather than assessing optimistically. The checks are fetched per-head separately, because `gh pr list`
 * cannot return check runs keyed to a sha.
 */
export function listArgv({ repo, pr = 0, state = 'open', limit = LIST_LIMIT }) {
  const fields = 'number,title,labels,mergeable,headRefOid' + (state === 'all' ? ',state' : '');
  return pr > 0
    ? ['pr', 'view', String(pr), '--repo', repo, '--json', fields]
    : ['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', fields];
}

/**
 * The argv for one head's check runs.
 *
 * KEYED TO THE SHA, NOT THE PR, and that is the whole point of the operation. `gh pr checks <n>` answers for
 * the PR and will happily report a run recorded against a SUPERSEDED commit, which is exactly the reading
 * that let two PRs display green marks belonging to commits that were no longer their heads. Asking the
 * commit-statuses endpoint for an explicit sha cannot do that.
 */
export function checksArgv({ repo, sha }) {
  return [
    'api',
    // `--paginate` FOR THE SAME REASON `LIST_LIMIT` REPORTS ITSELF, and it was missing here even after that
    // one was fixed (PR #1521 round 2). The REST default page size is 30, so a head with more check runs than
    // that would silently drop the later ones — and `reduceCheckState` reads only what it is handed, so a
    // dropped FAILING check turns a `red` head into a `green` one. That is the worst direction available.
    //
    // This operation exists so silence does not read as absence, and one call along from the cap I had just
    // fixed it was doing exactly that. Fixing one site and leaving its sibling is the recurring shape here:
    // the same reasoning has to be carried to every call it applies to, not only the one under the cursor.
    '--paginate',
    `repos/${repo}/commits/${sha}/check-runs`,
    // `id` — this feed is NEWEST-first (the rollup is oldest-first), so `collapseRollupToLatestPerName` ranks a
    // check's reruns by run id rather than by position (PR #2894 review).
    '--jq', '.check_runs[] | {id,name,status,conclusion,completed_at}',
  ];
}

/** One `gh` invocation. Throws on failure — a reader that could not read must never return an empty list. */
function gh(argv, { run = execFileSync } = {}) {
  return String(run('gh', argv, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }) ?? '');
}

/** Parse `--jq`'s newline-delimited JSON objects. A blank stream is legitimately zero check runs. */
export function parseJsonLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Normalize `gh`'s label objects (`{name}`) to bare names, tolerating either shape. */
export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map((l) => String(l?.name ?? l ?? '')).filter(Boolean);
}

/**
 * The reader the declaration is injected with. `run` is injected so every branch is reachable with no `gh`,
 * no network and no credential.
 *
 * A FAILED CHECK FETCH THROWS rather than yielding `[]`. An empty check list is what this operation reads as
 * `unchecked` — a real, actionable finding — so letting a network error produce one would manufacture the
 * exact alarm the operation exists to raise, and the next person to see a false `unchecked` would learn to
 * ignore a true one.
 */
export function createPrReader({ run = execFileSync, reconcile = false } = {}) {
  return ({ repo, pr = 0 }) => {
    let limit = LIST_LIMIT;
    let rows;
    do {
      const raw = gh(listArgv({ repo, pr, state: reconcile ? 'all' : 'open', limit }), { run });
      const parsed = JSON.parse(reconcile ? raw : raw || (pr > 0 ? '{}' : '[]'));
      if (reconcile && (pr > 0 ? !parsed?.number : !Array.isArray(parsed))) {
        throw new Error('pr-reconcile: unreadable PR listing');
      }
      rows = Array.isArray(parsed) ? parsed : [parsed];
      if (reconcile && rows.some((r) => !Number.isInteger(r?.number) || r.number <= 0)) {
        throw new Error('pr-reconcile: unidentified PR in listing');
      }
      if (!reconcile || pr > 0 || rows.length < limit) break;
      // gh paginates internally up to --limit. Grow until it proves the listing is complete;
      // the open-only status reader keeps its existing, explicitly reported cap.
      limit *= 2;
    } while (true);

    const prs = rows.filter((r) => r && r.number != null).map((r) => {
      const headSha = String(r.headRefOid ?? '');
      let detail = {};
      if (reconcile) {
        const parsed = JSON.parse(gh(commentsArgv({ repo, pr: r.number }), { run }));
        if (!Array.isArray(parsed.comments)) throw new Error('pr-reconcile: unreadable comments');
        const comments = parsed.comments.map((c) => {
          if (typeof c?.body !== 'string') throw new Error('pr-reconcile: unreadable comment body');
          // #3383 — `author`/`viewerDidAuthor` MUST survive this normalization: `standDownComments` (and
          // every other durable marker counter) now requires a trusted author
          // (`we:scripts/lib/marker-authorship.mjs`) before a marker counts at all. Dropping these fields here
          // would silently blind `standDownEvidence` to every REAL stand-down (a false negative — the escalation
          // gets lost, not merely spoofed), never just close the forgery this item actually targets.
          return {
            body: c.body, createdAt: String(c.createdAt ?? ''), url: String(c.url ?? ''),
            ...(c.author && typeof c.author === 'object' ? { author: { login: String(c.author.login ?? '') } } : {}),
            ...(typeof c.viewerDidAuthor === 'boolean' ? { viewerDidAuthor: c.viewerDidAuthor } : {}),
          };
        });
        detail = {
          state: String(r.state ?? '').toLowerCase(),
          comments,
          standDownEvidence: comments.filter((c) => standDownComments([c]).length > 0),
        };
      }
      return {
        ...detail,
        number: Number(r.number),
        title: String(r.title ?? ''),
        labels: labelNames(r.labels),
        mergeable: String(r.mergeable ?? 'UNKNOWN').toLowerCase(),
        headSha,
        checks: headSha ? parseJsonLines(gh(checksArgv({ repo, sha: headSha }), { run })) : [],
      };
    });

    // A listing that came back FULL may have been cut off — `gh` does not say. Reported rather than assumed
    // either way: the reader's job is to state what it knows, and `assessPrs` turns it into a finding.
    return { repo, prs, truncated: !reconcile && pr === 0 && rows.length >= LIST_LIMIT };
  };
}

/** Read the actual comment bodies; labels alone miss durable conveyor stand-downs. */
export function commentsArgv({ repo, pr }) {
  return ['pr', 'view', String(pr), '--repo', repo, '--json', 'comments'];
}

/** Same reader, all states and comments, with an exhaustive listing instead of a capped snapshot. */
export function createPrReconcileReader({ run = execFileSync } = {}) {
  return createPrReader({ run, reconcile: true });
}
