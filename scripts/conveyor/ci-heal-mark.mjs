/**
 * ci-heal-mark.mjs — post the durable CI-HEAL comment on a conveyor PR that a CI-heal agent has rebased + repaired
 * (#2666). This is the CI-half sibling of `rearm-review.mjs`, with ONE deliberate difference: it posts a durable
 * marker comment and restores missing review routing after a heal. A CI-heal repairs only the CI axis, so it must
 * NEVER touch a live `review:human` / `review:pending` / `review:changes` (the human review gate stays exactly as
 * it was).
 *
 * An existing acceptance is carried only through the shared CLI's head-bound coverage proof.
 * Failed proof/restamp falls back to the existing accepted-only rearm; other live verdicts remain protected.
 * Both operations are best-effort and report their outcomes separately from the durable heal comment.
 * Without a live review label, a fresh, head-bound shared re-arm permits adding review:pending and removes stale landing signals.
 * CI lifecycle labels alone are insufficient: the drain removes them when checks turn green.
 * `--restore-routing-only` repairs historical routing loss on the freshly read PR head,
 * posting only a restoration explanation, with no heal marker, restamp, or rearm.
 *
 * WHY A DURABLE COMMENT (the whole point — mirrors #2643). The conveyor bounds auto CI-heal at N attempts per PR so
 * a genuinely-broken diff can't flap forever. That cap must survive a conveyor RESTART, which wipes the in-session
 * `ciHealAttempts` map. So each completed heal posts exactly ONE comment whose leading line is
 * {@link CI_HEAL_COMMENT_MARKER}, and the tick core recovers the attempt count by counting those comments
 * ({@link countCiHealComments}) — the count IS PR state, read back off the PR's own thread, with NO parallel state
 * store (#2612). Build and count share ONE marker (single-sourced here) so they can never drift; treat the marker
 * line as fixed — changing it orphans the count on every open CI-heal PR's history (a burned PR would read as zero
 * attempts again, re-exposing the exact restart reset this design prevents).
 *
 * Scripted per [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment] (#2607): the "how many heals
 * has this PR cost" question is a pure, script-decidable count over the PR's comments — it lives here as a pure
 * function the tick core shells, never a rule the conveyor SKILL re-derives in prose.
 */
import { readGh } from '../lib/proc-read.mjs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveChildTimeoutMs } from '../lib/bounded-child.mjs';
import { writeAllSync } from '../lib/write-all-sync.mjs';
import { isTrustedMarkerAuthor } from '../lib/marker-authorship.mjs';
import { REVIEW_LABELS, hasReviewLabel } from '../lib/review-escalation.mjs';
import { isBudgetRefusal, postPrComment, recordOwedWrite, resolveOwedRepo } from './ci-heal-owed.mjs';

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#CI_HEAL_COMMENT_MARKER — the stable FIRST LINE of the durable CI-heal comment.
 * Single-sourced and used two ways: the CLI POSTS a comment starting with it on every completed heal, and
 * {@link countCiHealComments} MATCHES it to recover the attempt count from the PR (#2666). Distinct from the fix
 * loop's re-arm marker so the two durable floors never cross-count.
 */
export const CI_HEAL_FAILURE_MARKER = '🩹 conveyor CI-heal — failed attempt';

export const CI_HEAL_COMMENT_MARKER = '🩹 conveyor CI-heal — rebased & re-pushed';

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#countCiHealComments — the DURABLE, restart-surviving CI-heal attempt count for
 * a PR (#2666). Every completed CI-heal posts exactly ONE comment whose leading line is {@link CI_HEAL_COMMENT_MARKER},
 * so counting those comments recovers "how many times this PR was auto-CI-healed" from the PR ITSELF — the retry cap
 * then binds even after a conveyor restart wipes the in-session `ciHealAttempts` map (the exact unbounded heal↔red
 * loop the cap exists to prevent). Pure — the caller passes the PR's `comments` exactly as `gh pr view <pr> --json
 * comments` returns them (`[{ body }]`); a bare-string array is tolerated too. A comment is counted only when the
 * marker is its leading line (`trimStart().startsWith`), so a human QUOTING the comment in a reply never inflates it.
 * @param {Array<{body?:string}|string>|null|undefined} comments
 * @returns {number} the number of conveyor CI-heal comments on the PR (0 for a non-array / empty input)
 */
export function countCiHealComments(comments) {
  if (!Array.isArray(comments)) return 0;
  let n = 0;
  const attempts = new Set();
  for (const c of comments) {
    const body = typeof c === 'string' ? c : c?.body;
    // #3383 — a forged CI-heal marker from an untrusted login must not inflate this PR's CI-heal round cap.
    if (typeof body !== 'string' || !isTrustedMarkerAuthor(c)) continue;
    const first = body.trimStart().split('\n')[0];
    if (!first.startsWith(CI_HEAL_COMMENT_MARKER) && first !== CI_HEAL_FAILURE_MARKER) continue;
    const attempt = /^attempt: ([a-zA-Z0-9_-]+)$/m.exec(body)?.[1];
    if (first === CI_HEAL_FAILURE_MARKER && !attempt) continue;
    if (attempt && attempts.has(attempt)) continue;
    if (attempt) attempts.add(attempt);
    n += 1;
  }
  return n;
}

// Duplicated to avoid the main-red-recovery → reconcile-core import cycle; #3794 live case, 2026-10-04.
const REBASE_ONTO_MAIN_COMMENT_MARKER = '🔀 conveyor rebase-onto-main';

/** Restore defaults on; #3794 live case, 2026-10-04. */
export function resolveCiHealBudgetRestore(env = {}) {
  return !['0', 'false'].includes(String(env.WE_CI_HEAL_BUDGET_RESTORE ?? '').trim().toLowerCase());
}

/** Trusted durable refund windows; #3794 live case, 2026-10-04. */
export function readAttributedWindows(comments) {
  return (Array.isArray(comments) ? comments : []).flatMap((c) => {
    if (!isTrustedMarkerAuthor(c) || typeof c?.body !== 'string'
        || !c.body.trimStart().split('\n')[0].startsWith(REBASE_ONTO_MAIN_COMMENT_MARKER)) return [];
    const match = /^attributed-window: (\S+) (\S+)\s*$/m.exec(c.body);
    if (!match) return [];
    const [, from, to] = match;
    return Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(from) <= Date.parse(to)
      ? [{ from, to }] : [];
  });
}

/** Refund heals spent during attributed main bugs; #3794 live case, 2026-10-04. */
export function countChargeableCiHealComments(comments, { restore = true } = {}) {
  if (!restore) return countCiHealComments(comments);
  const windows = readAttributedWindows(comments);
  return countCiHealComments((Array.isArray(comments) ? comments : []).filter((c) => {
    const at = Date.parse(c?.createdAt);
    return !windows.some(({ from, to }) => Date.parse(from) <= at && at <= Date.parse(to));
  }));
}

/** Built from code points, not literals, so no invisible character lives in this source (#2866). */
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const CONTROL_AND_LINE_SEPARATORS = new RegExp(`[\\r\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#sanitizeForPublicComment — make untrusted worker/log text safe to quote in a
 * public comment posted under the trusted automation login (#3577 review). Redacts secret-shaped strings, URL
 * credentials and home paths, defuses HTML-comment markers and @mentions, drops control characters, keeps only the
 * last `max` characters, and indents every line so none can start with a line-anchored marker (`attempt:`/`head:`)
 * that a trusted-marker reader would take as authoritative. Pure.
 * @param {unknown} text
 * @param {{max?:number}} [o]
 * @returns {string}
 */
export function sanitizeForPublicComment(text, { max = 1000 } = {}) {
  // Redact BEFORE truncating: a cut that slices a secret's prefix off would otherwise leave its tail unrecognisable.
  return redactSecrets(text).slice(-max).split('\n').map((line) => `    ${line}`).join('\n');
}

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#redactSecrets — the redaction half of {@link sanitizeForPublicComment}, with
 * NO truncation or indentation. Every caller that must shorten untrusted text (worker output, a log tail) calls
 * this FIRST and cuts the result: a cut taken before redaction can slice a credential's recognisable prefix off and
 * leave its tail unredactable (#3577 round 2). A denylist, so it is hygiene for local records, never the only thing
 * standing between untrusted text and a public comment. Pure.
 * @param {unknown} text
 * @returns {string}
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(CONTROL_AND_LINE_SEPARATORS, '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/(\/\/)[^/\s@]+@/g, '$1[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    // key=value, key: value, "key": "value", --key value — quoted values may hold spaces.
    // The leading run is BOUNDED: an unbounded `[A-Za-z0-9_]*` re-scans a long alphanumeric run from every start
    // position (quadratic — 80k chars took ~17s), and callers now redact before they cut.
    .replace(/(["']?)(--?)?([A-Za-z0-9_]{0,48}(?:token|secret|password|passwd|api[_-]?key|auth|credential)[A-Za-z0-9_-]*)\1(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi, (m, _q, dashes, key, sep) => (dashes || /[=:]/.test(sep) ? `${dashes ?? ''}${key}=[redacted]` : m))
    .replace(/(?:\/Users|\/home)\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
    .replace(/<!--|-->/g, '[comment]')
    .replace(/@(?=[A-Za-z0-9])/g, `@${ZERO_WIDTH_SPACE}`);
}

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#buildCiHealComment — the durable comment body a completed heal posts. Its
 * FIRST line MUST be {@link CI_HEAL_COMMENT_MARKER} (single-sourced) so posting and counting can never drift. Pure.
 *
 * #4352 — when `headSha` is known it rides on the SECOND line as `head: <sha>` (the same field shape
 * `ci-heal-escalation-mark.mjs` already uses), so an owed retry can tell "THIS heal's comment already landed" from
 * "an older, unrelated heal posted its own marker" (`ci-heal-owed.mjs#owedWriteAlreadyLive`). Additive only: the
 * count above matches the first line alone, so the cap is unaffected.
 * @param {{ actor?:string, reason?:string, headSha?:string }} o
 * @returns {string}
 */
export function buildCiHealComment({ actor = 'conveyor CI-heal agent', reason = '', headSha = '', attemptId = null, failed = false, detail = '' } = {}) {
  const why = reason === 'behind' ? 'the branch had fallen BEHIND `main`'
    : reason === 'red-ci' ? 'a required check had gone red after open'
    : 'a required check regressed after open';
  const head = typeof headSha === 'string' ? headSha.trim().toLowerCase() : '';
  return [
    failed ? CI_HEAL_FAILURE_MARKER : CI_HEAL_COMMENT_MARKER,
    ...(attemptId ? [`attempt: ${attemptId}`] : []),
    ...(head ? [`head: ${head}`] : []),
    '',
    failed ? `The executor did not complete a repair. Diagnostics (untrusted, redacted, truncated):\n\n${sanitizeForPublicComment(detail)}\n\nExit/quota evidence is unknown unless explicitly recorded. CI remains unproven.` : `${why}; ${actor} rebased onto current \`main\`, repaired the failing check, and re-pushed HEAD.`,
    'This records the CI repair, not a review verdict. Existing `review:human` / `review:pending` holds stay in place; ' +
      'a live `review:accepted` may be re-armed separately for review. The drain lands it once green and reviewed.',
  ].join('\n');
}

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#resolveHealHead — the head sha this heal's comment is FOR (#4352).
 * `--head` wins; otherwise the local `HEAD` of the lane clone the agent just pushed from — a local git read,
 * never a GitHub one (a budget block that refused the comment would refuse that read too). `''` when neither.
 * @param {{headFlag?:string, cwd?:string, exec?:Function}} o
 * @returns {string}
 */
export function resolveHealHead({ headFlag, cwd, exec = execFileSync } = {}) {
  if (typeof headFlag === 'string' && /^[0-9a-f]{40}$/i.test(headFlag.trim())) return headFlag.trim().toLowerCase();
  if (headFlag !== undefined && !/^[0-9a-f]{7,39}$/i.test(headFlag.trim())) return '';
  try {
    const sha = String(exec('git', ['rev-parse', '--verify', headFlag ? `${headFlag.trim()}^{commit}` : 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : '';
  } catch { return ''; }
}

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#postOrOweCiHealComment — post the heal comment; on a BUDGET refusal
 * (`gh-throttle.mjs`'s `budget_blocked`/`budget_exhausted`), record it owed for
 * `ci-heal-pr-dispatch.mjs#runReconcileCiHealDispatch`'s next-tick flush instead of dropping it (#4352, the
 * `ci-heal-2821` incident). Any OTHER failure still throws — it is not a budget problem a later retry fixes.
 * An owe needs a head sha (the dedupe key) and a constellation repo; without either the refusal throws as before.
 * @returns {{commented:true}|{commented:false, owed:object}}
 */
export function postOrOweCiHealComment({ pr, body, headSha, repo, post = postPrComment, owe = recordOwedWrite }) {
  try {
    post({ pr, repo: repo?.slug, body });
    return { commented: true };
  } catch (e) {
    if (!isBudgetRefusal(e) || !headSha || !repo) throw e;
    const owed = owe({ repo: repo.key, slug: repo.slug, pr, kind: 'ci-heal', headSha, body });
    return { commented: false, owed };
  }
}

/**
 * we:scripts/conveyor/ci-heal-mark.mjs#spawnCiHealRearm — #2811. Hand a STALE `review:accepted` back for
 * re-review through the EXISTING, invariant-guarded `rearm-review.mjs` swap (never a second, hand-rolled label
 * write here) — mirrors `we:scripts/merge-ai-prs.mjs#restampAcceptance`'s own child-process shape exactly. The
 * child does its own fresh `gh pr view` and its own idempotent refusal (`decideSetLabel`'s `rearm` branch, #2811
 * follow-up: also re-armable from `review:accepted` alone, never just `review:changes`) — so this is safe to call
 * whenever the caller already knows (or merely suspects) an acceptance might be live; a PR with nothing to
 * re-arm just reports `{ok:false}` and changes nothing.
 * @param {{pr:number|string, repo?:string, cwd?:string, actor?:string, onlyIfAccepted?:boolean, spawn?:Function}} o
 * @returns {{ok:boolean, reason?:string}}
 */
export function spawnCiHealRearm({ pr, repo, cwd, actor = 'conveyor CI-heal agent', onlyIfAccepted = true, onlyIf, headSha, spawn = spawnSync } = {}) {
  const args = [new URL('./rearm-review.mjs', import.meta.url).pathname, String(pr), `--actor=${actor}`];
  if (repo) args.push(`--repo=${repo}`);
  // #4333 — validated at the CHILD's mutation boundary: both callers only ever re-arm a stale acceptance, so a
  // `review:changes` verdict that lands between the caller's read and the child's read is never overwritten.
  if (onlyIf === 'missing') args.push('--only-if=missing', `--expect-head=${headSha || ''}`);
  else if (onlyIfAccepted) args.push('--only-if=accepted');
  try {
    // `spawnSync`-shaped (mirrors `restampAcceptance`'s own seam exactly) — NEVER throws on a non-zero exit, so
    // a refused re-arm (nothing to re-arm — the common case, no `review:accepted` live) is a plain `{ok:false}`
    // result, never a reason to fail the heal that already succeeded.
    const r = spawn(process.execPath, args, { encoding: 'utf8', cwd });
    if (r.status === 0) return { ok: true };
    return { ok: false, reason: String(r.stdout || r.stderr || `exit ${r.status}`).trim().split('\n').pop() };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

/** Head-bound carry through the shared review write boundary; no new review is granted. */
export function spawnCiHealRestamp({ pr, repo, cwd, headSha, actor = 'conveyor CI-heal agent', spawn = spawnSync } = {}) {
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) return { ok: false, reason: 'heal head is not a full commit SHA' };
  const args = [new URL('../review-set-label.mjs', import.meta.url).pathname, String(pr),
    '--to=restamp', `--expect-head=${headSha}`, `--actor=${actor}`, '--channel=ci-heal',
    '--reason=CI-heal hand-back; carry the existing review only if coverage is proven.'];
  if (repo) args.push(`--repo=${repo}`);
  try {
    const r = spawn(process.execPath, args, { encoding: 'utf8', cwd });
    return r.status === 0 ? { ok: true } : { ok: false, reason: String(r.stdout || r.stderr || `exit ${r.status}`).trim() };
  } catch (e) { return { ok: false, reason: String(e.message || e) }; }
}

// Unknown/malformed labels are not evidence of an absent routing label. Keep any
// review disposition (including future ones) and the producer's merge-path label.
function missingHealRouting(labels) {
  return Array.isArray(labels)
    && labels.every(label => label && typeof label.name === 'string' && label.name.length > 0)
    && !labels.some(({ name }) => name.startsWith('review:') || name === 'ready-to-merge');
}

/** Add only the missing hold; never swap a verdict or manufacture merge clearance. */
function restoreHealRouting({ pr, repo, headSha, currentHead = false }) {
  const skip = reason => ({ skipped: true, reason });
  const repoArgs = repo ? [`--repo=${repo}`] : [];
  const gh = args => readGh(args, {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL',
  });
  const read = () => JSON.parse(gh(['pr', 'view', String(pr), ...repoArgs, '--json', 'state,isDraft,headRefOid,labels']));
  if (currentHead) headSha = read().headRefOid;
  if (!/^[0-9a-f]{40}$/.test(headSha || '')) return skip('PR head is not a full commit SHA');
  // This read is at the mutation boundary, after the caller's label observation.
  const live = read();
  if (live.state !== 'OPEN') return skip('PR is not open');
  if (live.isDraft !== false) return skip('PR is draft or draft status is unknown');
  if (live.headRefOid !== headSha) return skip('PR head changed during restoration');
  if (!missingHealRouting(live.labels)) return skip('PR has a review:* or ready-to-merge label, or labels are unreadable');
  gh(['pr', 'edit', String(pr), ...repoArgs, '--add-label', REVIEW_LABELS.pending]);
  const after = read();
  if (after.state !== 'OPEN' || after.isDraft !== false || after.headRefOid !== headSha
    || !Array.isArray(after.labels) || !after.labels.every(label => label && typeof label.name === 'string')
    || !hasReviewLabel(after.labels, REVIEW_LABELS.pending)
    || after.labels.some(({ name }) => (name.startsWith('review:') && name !== REVIEW_LABELS.pending) || name === 'ready-to-merge')) {
    throw new Error('CI-heal routing restoration could not be verified');
  }
  return { restored: REVIEW_LABELS.pending };
}

// ── IO SHELL (runs only as a CLI — the pure exports above stay side-effect-free on import) ────────────────────────
/** Existing successful-heal review hand-back, shared with attempt-accounted probation heals. */
export function handBackCiHealReview({ pr, repo, headSha, cwd = process.cwd(), actor,
  exec = execFileSync, restamp = spawnCiHealRestamp, rearm = spawnCiHealRearm } = {}) {
  let rearmed = false;
  let restamped = false;
  let restored;
  let carryReason;
  try {
    const viewArgs = ['pr', 'view', String(pr), '--json', 'labels,isDraft'];
    if (repo) viewArgs.push(`--repo=${repo}`);
    const raw = exec('gh', viewArgs, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: resolveChildTimeoutMs(), killSignal: 'SIGKILL' });
    const observed = JSON.parse(raw || '{}');
    const labels = observed.labels;
    if (!Array.isArray(labels) || !labels.every(l => l && typeof l.name === 'string' && l.name.length > 0)) throw new Error('CI-heal review labels are unreadable');
    if (hasReviewLabel(labels, REVIEW_LABELS.accepted)) {
      const handback = {
        pr, repo, cwd, actor,
      };
      const carry = restamp({ ...handback, headSha });
      restamped = carry.ok;
      if (!restamped) {
        carryReason = carry.reason;
        const fallback = rearm(handback);
        rearmed = fallback.ok;
        if (!fallback.ok) carryReason = `${carryReason || ''}; re-arm failed: ${fallback.reason || 'unknown failure'}`;
      }
    } else if (observed.isDraft === false && !labels.some(l => l.name.startsWith('review:') || l.name === 'ready-to-merge')) {
      // Only a PR KNOWN to be ready (`isDraft === false`) with neither a verdict nor the producer's own merge
      // clearance is handed back; an unknown draft status or a `ready-to-merge` PR is left exactly as it is.
      const result = rearm({ pr, repo, cwd, actor, headSha, onlyIf: 'missing' });
      if (result.ok) restored = REVIEW_LABELS.pending;
      else carryReason = result.reason || 'missing review handoff refused';
    }
  } catch (e) {
    carryReason = String(e.message || e);
    // Best-effort (see the header) — an unreadable label state or a failed rearm never fails this CLI's own
    // exit code; the stale acceptance (if any) is caught by the next push through this same path, or by a human.
  }
  return { restamped, rearmed, ...(restored ? { restored } : {}), ...(carryReason ? { carryReason } : {}) };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (IS_CLI) {
  const argv = process.argv.slice(2);
  const flags = {};
  const positionals = [];
  for (const a of argv) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) flags[a.slice(2)] = true;
      else flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else positionals.push(a);
  }
  const fail = (m) => {
    process.stderr.write(`✗ ${m}\n`);
    process.exit(1);
  };
  const pr = Number(positionals[0]);
  if (!Number.isInteger(pr) || pr <= 0) {
    fail('usage: ci-heal-mark.mjs <pr> [--repo=<owner/name>] [--restore-routing-only] [--reason=<red-ci|behind>] [--actor=<name>] [--head=<sha>]  (pr must be a positive integer)');
  }
  if (flags['restore-routing-only']) {
    const repo = typeof flags.repo === 'string' ? flags.repo : undefined;
    try {
      const result = restoreHealRouting({ pr, repo, currentHead: true });
      if (result.restored) {
        postPrComment({ pr, repo, body: 'Review routing restored: this PR had lost all routing labels after an earlier CI heal (fixed by #3475); added review:pending so review picks it up.' });
      }
      writeAllSync(1, JSON.stringify({ pr, ...result, reason: result.reason || 'Missing review routing restored' }) + '\n');
    } catch (e) {
      fail(`could not restore review routing on PR #${pr}: ${String(e.message || e).split('\n')[0]}`);
    }
    process.exit(0);
  }
  const headSha = resolveHealHead({ headFlag: typeof flags.head === 'string' ? flags.head : undefined });
  const body = buildCiHealComment({
    actor: typeof flags.actor === 'string' ? flags.actor : undefined,
    reason: typeof flags.reason === 'string' ? flags.reason : undefined,
    headSha,
  });
  // The heal agent runs in its WE lane clone; a missing --repo derives from cwd (gh's own inference for the post,
  // the local `origin` remote for the owed record's key).
  const owedRepo = resolveOwedRepo({ repoFlag: typeof flags.repo === 'string' ? flags.repo : undefined });
  let posted;
  try {
    posted = postOrOweCiHealComment({
      pr, body, headSha, repo: owedRepo,
      // The post itself targets exactly what the caller named (or gh's cwd inference) — unchanged from before.
      post: ({ pr: n, body: b }) => postPrComment({ pr: n, repo: typeof flags.repo === 'string' ? flags.repo : undefined, body: b }),
    });
  } catch (e) {
    fail(`could not post CI-heal comment on PR #${pr}: ${String(e.message || e).split('\n')[0]}`);
  }
  if (!posted.commented) {
    process.stderr.write(`⚠ CI-heal comment on PR #${pr} refused by the GitHub budget — recorded owed (head ${headSha}); the next ci-heal-pr-dispatch tick posts it\n`);
  }
  const handback = handBackCiHealReview({ pr, repo: typeof flags.repo === 'string' ? flags.repo : owedRepo?.slug, headSha, actor: typeof flags.actor === 'string' ? flags.actor : undefined });
  process.stdout.write(JSON.stringify({ ok: true, pr, commented: posted.commented, ...(posted.owed ? { owed: true } : {}), ...handback }) + '\n');
}
