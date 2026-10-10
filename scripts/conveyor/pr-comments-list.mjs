/**
 * @file pr-comments-list.mjs — the paginated REST read of one PR's issue comments, as a LEAF module.
 *
 * Lives apart from `parked-pr-conflict-watch.mjs` (which re-exports {@link defaultListPrComments}) because that file's
 * import graph reaches `reconcile-core.mjs` → `rearm-review.mjs`. A review-side module that needs only the comment
 * reader (`review-stack-base.mjs` via `pr-comments-complete.mjs`) would otherwise close an import cycle through
 * `rearm-review.mjs`, and `reconcile-core.mjs` then reads `REARM_COMMENT_MARKER` before it is initialised
 * (`ReferenceError`, every daemon host exits before ready). Keep this file's imports to `lib/` leaves.
 */
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';

/** Undo jq's `@tsv` per-field escaping (`\\`, `\t`, `\n`, `\r`) — the inverse of what the paginated readers' own jq
 *  filters apply to reconstitute a multi-line body or patch onto one output line. */
export function unescapeTsvField(s) {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const n = s[i + 1];
      if (n === 'n') { out += '\n'; i += 1; continue; }
      if (n === 't') { out += '\t'; i += 1; continue; }
      if (n === 'r') { out += '\r'; i += 1; continue; }
      if (n === '\\') { out += '\\'; i += 1; continue; }
    }
    out += s[i];
  }
  return out;
}

/**
 * we:scripts/conveyor/pr-comments-list.mjs#defaultListPrComments — `#3383`'s idempotency read for the
 * grace-expired stand-down routing: a COMPLETE, injectable read of every issue comment on the PR, so
 * {@link standDownComments} (`we:scripts/conveyor/stand-down.mjs`) can tell "did a fixer already stand down
 * here" from the PR itself before posting a SECOND one. Unlike the fresh-detection stand-down (naturally
 * one-shot: it only fires on the label's absent→present transition), the grace-expired check re-evaluates on
 * EVERY sweep for as long as the PR stays queued+conflicting+labelled — a stand-down leaves no label change
 * (`we:scripts/conveyor/stand-down.mjs`'s own contract), so without this read it would re-post every tick.
 *
 * Same paginated-REST shape as `defaultListPrPatches` (`issues/{number}/comments`, not `pulls/{n}/files` —
 * comments live on the issue side of a PR) and the same `@tsv`-then-{@link unescapeTsvField} round trip, for the
 * same reason: a comment body legitimately spans many lines, and jq's default per-line JSON rendering would
 * break a "one record per line" reader.
 * `.created_at` (#4118) is projected alongside `.body` — `hasRecentConflictAlertComment` /
 * `hasRecentConflictFindingComment` / `latestConflictAlertCreatedAtMs` need a comment's own
 * timestamp to tell a still-in-progress crash-retry from a past, already-resolved episode's leftover marker.
 * `.user.login` (also #4118, review finding security/authz) is projected too, reshaped to the `author: {login}`
 * field `isTrustedMarkerAuthor`/`we:scripts/lib/marker-authorship.mjs` reads on every OTHER marker counter
 * in this repo — the REST issue-comments endpoint this function calls names the poster `.user.login`, not
 * `.author.login` (that is the GraphQL `gh pr view --json comments` shape's own naming, used by this file's
 * siblings) — so callers see the ONE shape `isTrustedMarkerAuthor` already expects either way. This was NOT
 * purely additive the way `.created_at` was: `standDownComments` (`we:scripts/conveyor/stand-down.mjs`),
 * already read on this function's own output at both the watch's `graceDue` stand-down check and the
 * newly-detected `standDown` path, itself requires `isTrustedMarkerAuthor` (#3383) — with no `author` field to
 * read, EVERY comment this function returned failed that check, so `alreadyStoodDown`/the fresh-path stand-down
 * dedup silently never matched a real stand-down at all. Adding `.user.login` here fixes that latent gap too,
 * not only the three #4118 marker readers it was added for.
 * @param {{number:number|string, repo?:string|null, exec?:Function}} o
 * @returns {Array<{body:string, createdAt:?string, author:?{login:string}}>}
 */
export function defaultListPrComments({ number, repo, exec = execFileSyncThrottled }) {
  const path = repo ? `repos/${repo}/issues/${number}/comments` : `repos/{owner}/{repo}/issues/${number}/comments`;
  const argv = ['api', '--paginate', '--method', 'GET', '-F', 'per_page=100', path, '--jq', '.[] | [.body, .created_at, .user.login, .node_id] | @tsv'];
  // #x5n4zn3 — was bare (no timeout).
  const out = exec('gh', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024, timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
  return String(out || '').split('\n').filter((l) => l !== '').map((line) => {
    const tab1 = line.indexOf('\t');
    if (tab1 === -1) return { body: unescapeTsvField(line), createdAt: null, author: null };
    const rest = line.slice(tab1 + 1);
    const tab2 = rest.indexOf('\t');
    const createdAtRaw = tab2 === -1 ? rest : rest.slice(0, tab2);
    const afterCreated = tab2 === -1 ? '' : rest.slice(tab2 + 1);
    const tab3 = afterCreated.indexOf('\t');
    const loginRaw = tab3 === -1 ? afterCreated : afterCreated.slice(0, tab3);
    // The GraphQL node id (`IC_kwDO…`) — the id an operator stand-down answer names in `Supersedes stand-down
    // comment \`<id>\``. Without it the answer can never be matched to the stand-down it resolves.
    const idRaw = tab3 === -1 ? '' : afterCreated.slice(tab3 + 1);
    const login = unescapeTsvField(loginRaw) || null;
    const id = unescapeTsvField(idRaw) || null;
    return {
      body: unescapeTsvField(line.slice(0, tab1)),
      createdAt: unescapeTsvField(createdAtRaw) || null,
      author: login ? { login } : null,
      ...(id ? { id } : {}),
    };
  });
}
