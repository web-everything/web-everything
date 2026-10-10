#!/usr/bin/env node
/**
 * @file scripts/operations/land-prevention-card.mjs
 * @description #4317 — THE DETACHED LANDING JOB for an approval-time prevention card. Spawned by
 *   `we:scripts/review-set-label.mjs#fileApprovalPreventionCard` (detached, unref'd — see
 *   `./detached-dispatch.mjs`), NEVER run inline: that caller runs inside `runApprovalPreventionFiling`,
 *   itself invoked synchronously right after an approval's own label swap + comment have ALREADY landed, so
 *   nothing here may cost or delay that approval — see that file's own docblock for the "can therefore NEVER
 *   cost the approval that already happened" invariant this whole design preserves.
 *
 * THE BUG THIS CLOSES. The prior code shelled `file-item` directly in WHATEVER checkout was reviewing the
 * PR — routinely a read-only daemon clone (`we:scripts/lib/daemon-clone-registry.mjs`), which is never
 * committed to and never pushes. The card it wrote sat there as an untracked `backlog/x*.md` file FOREVER:
 * the daemon rebuild's own dirty check reads `git status --untracked-files=no` BY DESIGN (an untracked
 * sidecar must never block a rebuild — `we:scripts/lib/daemon-rebuild.mjs` line ~415), so nothing ever
 * surfaced or landed it. Live 2026-09-28: 22 such orphans in `wev-review-daemon`, 1 in `wev-control`, dating
 * to PR #2807.
 *
 * WHAT THIS RUNS, IN ORDER — reusing the SAME lane + file-item/verify/open-pr sequence
 * `we:scripts/operations/file-item.mjs`'s own header names as the standard filing sequence, never a second
 * writer:
 *   1. `lane-pool.mjs acquire` — a REAL, writable lane clone (never the daemon clone that spawned this).
 *   2. `run.mjs file-item`, IN that lane — writes the card, exactly as the synchronous path used to.
 *   3. `git add` + `git commit` the one new card file, in the lane.
 *   4. `run.mjs verify --mode=run` — the lane's own gate, run for REAL. This process has no foreground-turn
 *      timeout to respect (unlike a dispatched agent's Bash tool) — `we:scripts/verify-lane.mjs`'s
 *      request/poll dance exists ONLY for that constraint, so a detached background process calls the home
 *      directly through `mode=run` and simply waits.
 *   5. `run.mjs open-pr --mode=label-on-green` — opens the PR, waits for the required check, labels it
 *      `ready-to-merge` on green. The resident drain daemon lands it; this process never merges.
 *   6. `lane-pool.mjs release` — the lane clone itself is no longer needed once its content is pushed to the
 *      `lane/*` ref (`pr-land`, underneath `open-pr`, publishes HEAD there) — releasing frees the pool slot.
 *
 * EVERY OPERATION CALL (2, 4, 5) RUNS THE ACQUIRED LANE'S OWN `run.mjs`, NEVER THIS SCRIPT'S OWN
 * (codex plan review, 2026-09-28 — a real, live-caught defect in this file's first cut): `file-item`'s IO shell
 * (`scaffold-io.mjs#REPO_ROOT`) and its siblings resolve their own repo root by SCRIPT LOCATION, never by
 * `cwd`. Running THIS script's own `run.mjs` with `cwd: lane` would still have written the card into THIS
 * checkout's `backlog/` — the exact bug this file exists to fix, just one hop further out. See
 * `landPreventionCard`'s `laneRunMjs` below.
 *
 * BEST-EFFORT, LOGGED, NEVER RETRIED FROM HERE. A failure at any step releases the lane (best-effort) and
 * exits non-zero; its narration lands in this process's own log file — the CALLER (`review-set-label.mjs
 * #fileApprovalPreventionCard`) picks that path, via `preventionCardLandingLogPath`, NEVER this file's own
 * default (see that function's own docblock for why: codex plan review, 2026-09-28, found the earlier default
 * — `./detached-dispatch.mjs#deliveryDispatchLogPath`'s in-checkout path — writing into the very daemon clone
 * this whole redesign exists to stop writing into). The `untracked-backlog-card` health smell
 * (`we:scripts/conveyor/health-smells/untracked-backlog-card.mjs`) is the defense-in-depth safety net for the
 * CLASS of failure this file exists to prevent: something writing an untracked backlog card straight into a
 * daemon clone again, by whatever future path.
 *
 * A FAILED JOB RETRACTS ITS OWN MARKER (#4317 advisory review, 2026-09-29). `runApprovalPreventionFiling` posts
 * its head-keyed idempotency marker when this job SPAWNS, not when it LANDS. So the spawner passes
 * `--retract-repo/--retract-pr/--retract-head`, and a job that fails (lane exhaustion, a red gate, a refused PR)
 * posts a retraction for its own head + session ({@link postLandingRetraction}). The next approval on that head
 * then files the guard again instead of losing it.
 *
 * CARD TEXT IS BOUNDED before it is filed ({@link boundLandPreventionCardInput}): reviewer-derived
 * title/digest/scope reach `main` with no human gate (`--mode=label-on-green`), so each field is length-capped,
 * stripped of control characters, and cannot carry an HTML-comment marker.
 *
 * DEDUPE BEFORE FILING (operator go 2026-10-10). Right after the lane is acquired, {@link runCardDedupe} matches each
 * finding of this filing against the OPEN cards (the lane's origin/main `backlog/` plus cards still in open filing PRs)
 * by target file, defect class and claim similarity (`we:scripts/lib/card-dedupe.mjs`). A matched finding becomes an
 * "Also raised by" line on the existing card — appended in THIS lane and landed through the SAME commit → verify →
 * open-pr sequence below, or, for a card that is still in an open PR, posted there as a PR comment. Only the unmatched
 * findings are filed; all matched → no new card. Off unless `cards.dedupe` resolves true (policy cascade in that
 * module); any dedupe failure files exactly as before.
 *
 * KNOWN RESIDUAL, FILED — not a silent gap. `we:backlog/xxe5jvs-a-partial-failure-in-the-detached-prevention-
 * card-landing-jo.md`: a marker-post failure racing a second approval can still spawn a DUPLICATE landing job
 * for the same guard (the on-disk idempotency lookup, `findApprovalPreventionCardOnDisk`, no longer sees a card
 * that is still landing in a lane).
 *
 * Usage:
 *   node scripts/operations/land-prevention-card.mjs --title=<t> --kind=<k> --size=<n> --digest=<d> \
 *     --scope=<s> [--parent=<NNN>] --queue=<true|false> --session=<slug>
 */
import { machinePrTitle, preventionCardTitle } from './machine-pr-title.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSubmitResult } from './open-pr.mjs';
import {
  buildApprovalPreventionRetraction, APPROVAL_PREVENTION_DIGEST_KEY_SEP, APPROVAL_PREVENTION_KEY_PREFIX,
} from '../lib/approval-prevention-notice.mjs';
import { execFileSyncThrottled } from '../lib/gh-throttle.mjs';
import { CONSTELLATION_REPOS } from '../lib/constellation-repos.mjs';
import {
  loadCardDedupePolicy, formatCardDedupePolicy, planDedupe, readOpenCards, readPrHostedCards, appendMentions, filingSource,
  remainingAfter,
} from '../lib/card-dedupe.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
export const REPO_ROOT = resolve(HERE, '..', '..');
// `LANE_POOL_CLI` is deliberately THIS checkout's copy — `lane-pool.mjs` resolves its own pool root from `cwd`
// (never script location), so running it with `cwd: REPO_ROOT` against a real, `origin`-bearing checkout is
// correct even when that checkout is a read-only-by-convention daemon clone. There is NO equivalent
// `RUN_MJS` constant: `file-item`/`verify`/`open-pr` all resolve their OWN repo root by script location
// (`scaffold-io.mjs#REPO_ROOT`, `verify-io.mjs`, …), so every one of those calls below builds the ACQUIRED
// LANE's own `run.mjs` path instead — see `landPreventionCard`'s `laneRunMjs`.
export const LANE_POOL_CLI = join(REPO_ROOT, 'scripts', 'lane-pool.mjs');

/** Refused rather than defaulted: a landing job with no card content or session has nothing to file. */
const REQUIRED_FLAGS = Object.freeze(['title', 'kind', 'size', 'digest', 'scope', 'queue', 'session']);

/**
 * #4317 advisory review (2026-09-29, security + codex-correctness) — the card's title/digest/scope are built from
 * review-finding text (a reviewer's prose, ultimately traceable to a reviewed PR's diff), and this job lands them
 * on `main` with no human gate (`--mode=label-on-green`). So every card this job files is BOUNDED first, here —
 * the one chokepoint every card crosses before it is written: a length cap per field, control characters
 * stripped, and HTML-comment delimiters neutralized so finding text can never forge a durable marker (e.g.
 * `approval-prevention-filed`) in the card or the PR body. Prompt-shaped prose itself cannot be "escaped" — it is
 * still ordinary card text a reader weighs — but it can no longer be unbounded or smuggle invisible markup.
 */
export const CARD_TEXT_CAPS = Object.freeze({ title: 200, scope: 2000, digest: 8000 });

/** Every INVISIBLE or text-reordering character, by Unicode class so the whole family is covered by construction
 *  (#4317 advisory review, 2026-09-29 04:47 — the first cut stripped only C0/DEL): `\p{Cc}` is every control char
 *  (C0, DEL, C1), `\p{Cf}` every format char (bidi embeddings/overrides/isolates, zero-width space/joiners, BOM,
 *  soft hyphen, word joiner), plus the two Unicode line/paragraph separators (`\p{Zl}`/`\p{Zp}`). `\n` and `\t`
 *  are the only exceptions — ordinary card layout. Deliberately broad: it also splits ZWJ emoji sequences and drops
 *  ZWNJ/tag characters, a cosmetic loss accepted for card text that lands on `main` with no human gate. */
const INVISIBLE_CHARS_RE = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * PURE. Bound one untrusted card field: strip control, format, bidi and line-separator characters (keeping
 * `\n`/`\t` unless `singleLine`), neutralize `<!--`/`-->`, and cap the length with a visible truncation note.
 * @param {string} text
 * @param {number} max
 * @param {{singleLine?: boolean}} [o]
 * @returns {string}
 */
export function boundCardText(text, max, { singleLine = false, escapeWikiLinks = true } = {}) {
  let s = String(text ?? '')
    // A SPACE, never '': joining the text around a control char could mint a new bare path (`foo\u0007.mjs` →
    // `foo.mjs`) that the #883 locus-prefix write gate would then refuse.
    .replace(INVISIBLE_CHARS_RE, ' ')
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;');
  // Quoted reviewer prose can describe wiki-link syntax; check-standards rejects any `[[…]]` in a card body (#4457).
  // A backslash after each bracket that precedes the same bracket leaves no adjacent pair, and renders as the literal.
  // Body text only: a YAML double-quoted frontmatter value (`scope`) must NOT get it — `\[` is an invalid YAML escape.
  if (escapeWikiLinks) s = s.replace(/\[(?=\[)/g, '[\\').replace(/\](?=\])/g, ']\\');
  if (singleLine) s = s.replace(/[\n\t]+/g, ' ');
  if (s.length <= max) return s;
  const note = ` … [truncated: ${s.length - max} chars over the ${max}-char cap]`;
  return `${s.slice(0, Math.max(0, max - note.length))}${note}`;
}

/**
 * PURE. {@link boundCardText} applied to every reviewer-derived field. The digest's trailing idempotency-key line
 * (`buildApprovalPreventionFilingInput`) is kept verbatim at the end, so truncation never breaks the on-disk
 * idempotency lookup that matches it byte for byte.
 * @template {{title:string, digest:string, scope:string}} T
 * @param {T} input
 * @returns {T}
 */
export function boundLandPreventionCardInput(input) {
  const digest = String(input.digest ?? '');
  const at = digest.lastIndexOf(APPROVAL_PREVENTION_DIGEST_KEY_SEP);
  // Only a REAL key line (one short token, the builder's own shape) is kept verbatim; anything else is ordinary
  // digest text and is bounded like the rest.
  const tail = at === -1 ? '' : digest.slice(at + APPROVAL_PREVENTION_DIGEST_KEY_SEP.length);
  const isKey = tail.startsWith(APPROVAL_PREVENTION_KEY_PREFIX)
    // Printable ASCII only — the builder's own key is always ASCII, and `\S` would admit bidi/zero-width chars
    // into a line that is kept verbatim, bypassing `boundCardText`. `[`/`]` are excluded too: the builder's key never
    // has them, and a bracketed tail must be escaped as ordinary text (#4457).
    && /^[\x21-\x5a\x5c\x5e-\x7e]{1,300}$/.test(tail.slice(APPROVAL_PREVENTION_KEY_PREFIX.length));
  const keyLine = isKey ? digest.slice(at) : '';
  const body = isKey ? digest.slice(0, at) : digest;
  // Scope is capped by dropping WHOLE entries, never by slicing one mid-path (a sliced entry would be a fake path
  // in the frontmatter `scope:` the conveyor uses to keep lanes apart).
  const scopeEntries = boundCardText(input.scope, Number.MAX_SAFE_INTEGER, { singleLine: true, escapeWikiLinks: false }).split(',');
  let scope = '';
  for (const entry of scopeEntries) {
    const next = scope ? `${scope},${entry}` : entry;
    if (next.length > CARD_TEXT_CAPS.scope) break;
    scope = next;
  }
  return {
    ...input,
    title: boundCardText(input.title, CARD_TEXT_CAPS.title, { singleLine: true }),
    scope,
    digest: `${boundCardText(body, CARD_TEXT_CAPS.digest - keyLine.length)}${keyLine}`,
  };
}

/**
 * PURE. `--k=v` argv → the flat flag map this script acts on. Mirrors `deliver-item-run.mjs`'s own parser
 * (`parseDeliverItemRunArgv`) — same shape, same "throw on a missing required flag, by name" contract. The card
 * text comes back already bounded ({@link boundLandPreventionCardInput}). `retract` is set only when all three
 * `--retract-repo/--retract-pr/--retract-head` flags are present (see {@link postLandingRetraction}).
 * @param {string[]} argv
 * @returns {{title:string, kind:string, size:string, digest:string, scope:string, parent:string, queue:string,
 *   session:string, retract:({repo:string, pr:string, headSha:string}|null)}}
 */
export function parseLandPreventionCardArgv(argv = []) {
  const flags = {};
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = 'true';
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const missing = REQUIRED_FLAGS.filter((name) => !String(flags[name] ?? '').trim());
  if (missing.length) {
    throw new TypeError(
      `land-prevention-card: missing required flag(s) ${missing.map((m) => `--${m}=`).join(', ')} — a card `
      + 'cannot be filed with no content and no session slug',
    );
  }
  const retractFlags = ['retract-repo', 'retract-pr', 'retract-head'].map((k) => String(flags[k] ?? '').trim());
  return boundLandPreventionCardInput({
    title: String(flags.title),
    kind: String(flags.kind),
    size: String(flags.size),
    digest: String(flags.digest),
    scope: String(flags.scope),
    parent: String(flags.parent ?? ''),
    queue: String(flags.queue),
    session: String(flags.session),
    retract: retractFlags.every(Boolean)
      ? { repo: retractFlags[0], pr: retractFlags[1], headSha: retractFlags[2] }
      : null,
  });
}

/**
 * PURE. The comment a FAILED landing job posts on the PR whose approval spawned it: the retraction marker for
 * this job's own head + session (`we:scripts/lib/approval-prevention-notice.mjs#buildApprovalPreventionRetraction`)
 * plus a one-line human-readable reason. `''` when the head/session cannot form a valid marker.
 * @param {{headSha:string, session:string, result?:{step?:string, reason?:string}}} o
 * @returns {string}
 */
export function buildLandingRetractionComment({ headSha, session, result } = {}) {
  const marker = buildApprovalPreventionRetraction({ headSha, session });
  if (!marker) return '';
  const why = boundCardText(`${result?.step ?? 'unknown'}: ${result?.reason ?? 'no reason recorded'}`, 300, { singleLine: true });
  return `${marker}\nThe approval-time prevention card for this head did not land (\`${session}\` failed at ${why}). `
    + 'Its filing marker above is retracted, so the next approval on this head files the guard again.';
}

/**
 * Best-effort: post {@link buildLandingRetractionComment} on `repo#pr`. Never throws — a failure is narrated to
 * `write` and the job still exits non-zero with its own reason.
 * @param {{repo:string, pr:string, headSha:string, session:string, result:object}} o
 * @param {{exec?: Function, write?: Function}} [io]
 * @returns {boolean} whether the comment was posted
 */
export function postLandingRetraction({ repo, pr, headSha, session, result }, {
  exec = execFileSyncThrottled,
  write = (line) => process.stderr.write(line),
} = {}) {
  const body = buildLandingRetractionComment({ headSha, session, result });
  if (!body) {
    write(`land-prevention-card: no retraction posted — invalid head/session (${headSha} / ${session})\n`);
    return false;
  }
  try {
    exec('gh', ['pr', 'comment', String(pr), '--repo', String(repo), '--body', body], { encoding: 'utf8' });
    return true;
  } catch (e) {
    write(`land-prevention-card: retraction comment failed to post on ${repo}#${pr} — ${String(e?.message || e).split('\n')[0]}\n`);
    return false;
  }
}

/** Best-effort parse of a `run.mjs <op> --json` invocation's stdout, tolerant of a leading warning line — the
 *  local copy of the same tolerance `review-set-label.mjs` used to need for its own (now-deleted) synchronous
 *  `file-item` call; this file's own `file-item`/`verify`/`open-pr` calls all print the same envelope shape.
 *  `null` on no parseable `{…}`. */
export function parseRunJsonTail(out) {
  const text = String(out ?? '');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith('{'));
  if (start === -1) return null;
  try { return JSON.parse(lines.slice(start).join('\n')); } catch { return null; }
}

/** Generous but bounded: this process has no foreground-turn window, but a wedged child must still die
 *  eventually rather than hold a lane and a pool slot forever. Mirrors `verify-io.mjs#verifySpawnTimeoutMs`'s
 *  own reasoning (heavy-admission queueing + the suites themselves can legitimately run long). */
export const ACQUIRE_TIMEOUT_MS = 3 * 60_000;
export const FILE_ITEM_TIMEOUT_MS = 2 * 60_000;
export const VERIFY_TIMEOUT_MS = 70 * 60_000;
export const OPEN_PR_TIMEOUT_MS = 45 * 60_000;

/**
 * THE DEDUPE STEP, run in the acquired lane before `file-item`. Returns the plan from
 * `we:scripts/lib/card-dedupe.mjs#planDedupe` (`action` 'off' | 'file' | 'mention' | 'partial'), or `null` when it could
 * not run (no lane backlog to read). Never throws on a lookup miss: an unreadable PR list only means fewer candidates.
 * @param {object} input - the bounded filing input.
 * @param {{lane: string, root?: string, env?: object, write?: Function, readCards?: Function, readPrCards?: Function,
 *   loadPolicy?: Function}} o
 */
export function runCardDedupe(input, {
  lane, root = REPO_ROOT, env = process.env, write = () => {},
  loadPolicy = () => loadCardDedupePolicy({ root, env }),
  readCards = (dir) => readOpenCards(dir),
  readPrCards = (dir) => readPrHostedCards({ exec: (c, a, o) => String(execFileSyncThrottled(c, a, o)), cwd: dir }),
} = {}) {
  const policy = loadPolicy();
  write(`land-prevention-card: dedupe policy ${formatCardDedupePolicy(policy)}\n`);
  if (!policy.dedupe) return planDedupe({ input, cards: [], policy });
  if (!existsSync(join(lane, 'backlog'))) return null;
  const cards = [...readCards(lane), ...readPrCards(lane)];
  const plan = planDedupe({ input, cards, policy });
  write(`land-prevention-card: dedupe → ${plan.action} (${plan.matches.length} finding(s) already on open cards, `
    + `${cards.length} open card(s) read)\n`);
  for (const m of plan.matches) {
    write(`  finding ${m.item.n} → #${m.card.id} (${m.card.rel}, score ${m.score.toFixed(2)}, class ${m.item.cls})\n`);
  }
  return plan;
}

/**
 * PURE. The "Also raised by" comment posted on an open filing PR whose (not yet landed) card a finding matched.
 * @param {{lines: string[]}} mention
 */
export function buildPrMentionComment({ card, lines }) {
  return `Dedupe before filing: these findings match \`${card.rel}\` on this PR, so they were recorded here instead of `
    + `filing a new card. Carry them onto the card when it lands.\n\n${lines.join('\n')}\n`;
}

/**
 * THE ORCHESTRATION, INJECTABLE FOR TESTS. `exec` has the SAME `(cmd, args, opts) => string` shape as
 * `execFileSync` (throttled or not) elsewhere in this repo — a test hands it a scripted stub, never a real
 * subprocess. `write` is where narration goes (real stdout in production, captured in a test). `mkTmp`/
 * `writeFile`/`rmTmp` are the fs calls this function makes directly (ONE scratch dir for the commit message +
 * PR body, removed on every exit path), also injectable so a test can stub the filesystem (or, for the
 * cleanup proof, hand in a real scratch dir and assert it is gone).
 *
 * RETURNS a structured outcome for every step this function can itself name a reason for (acquire refused,
 * file-item refused, the gate red, the PR refused) rather than throwing — the CLI wrapper below still exits
 * non-zero for any `ok:false`, but a caller (a test, or a future richer caller) gets a shape it can act on.
 *
 * THE LANE IS ALWAYS RELEASED, on every exit path once one was acquired — best-effort (a release failure is
 * narrated, never thrown), because a landing job that leaks its lane on a downstream failure would slowly
 * starve the pool for every OTHER item. The ENTIRE post-acquire sequence (codex plan review, 2026-09-28) runs
 * under one enclosing try/catch, not just the steps that already had their own — an unexpected throw (a full
 * disk during the PR-body write, say) must still release the lane and return a clean failure, never leak or
 * propagate an unhandled rejection out of this async function. The release and the scratch-dir cleanup both run
 * in this function's ONE `finally` (#4317 advisory review, 2026-09-29), so no early return added later can skip
 * them — one plain sequential `try/catch/finally`, no helper layers or callbacks to trace.
 *
 * @param {{title:string,kind:string,size:string,digest:string,scope:string,parent:string,queue:string,
 *   session:string}} input
 * @returns {Promise<{ok:boolean, step:string, num:(number|string|null), rel:(string|null), pr:(number|null),
 *   url:(string|null), reason:(string|null)}>}
 */
export async function landPreventionCard(input, {
  exec = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts })),
  write = (line) => process.stdout.write(line),
  mkTmp = () => mkdtempSync(join(tmpdir(), 'land-prevention-card-')),
  writeFile = writeFileSync,
  readFile = (p) => readFileSync(p, 'utf8'),
  rmTmp = (dir) => rmSync(dir, { recursive: true, force: true }),
  dedupe = runCardDedupe,
} = {}) {
  // ONE scratch dir per run, created lazily and removed on every exit path (#4317 advisory review, 2026-09-29 —
  // the first cut made a fresh `mkdtempSync` dir for each file and never removed either, leaking two per filing).
  let scratch = null;
  const scratchFile = (name) => join(scratch ??= mkTmp(), name);
  let laneNum = null; // set once acquired; the `finally` releases it on every exit path
  const fail = (step, reason, extra = {}) => {
    write(`land-prevention-card: FAILED at ${step} — ${reason}\n`);
    return { ok: false, step, num: extra.num ?? null, rel: extra.rel ?? null, pr: extra.pr ?? null, url: extra.url ?? null, reason };
  };
  // EVERYTHING runs under ONE enclosing try/catch/finally — the #4317-review fix for the "PR-body prep throws and
  // leaks the lane" gap: `mkTmp()`/`writeFile()` (and any other step that is not its own already-labelled failure
  // mode below) must still release the lane and return a clean failure, never propagate an unhandled rejection.
  try {
    const generic = /^File the prevention guard\(s\) owed by (\S+)#(\d+)'s/i.exec(input.title);
    if (generic) input = { ...input, title: preventionCardTitle({ repo: generic[1], pr: generic[2], digest: input.digest }) };
    let acquired;
    try {
      write(`land-prevention-card: acquiring a lane (session ${input.session})…\n`);
      acquired = parseRunJsonTail(exec('node', [
        LANE_POOL_CLI, 'acquire', '--purpose=prevention-card', `--session=${input.session}`, '--json',
      ], { cwd: REPO_ROOT, timeout: ACQUIRE_TIMEOUT_MS }));
    } catch (e) {
      return fail('acquire', String(e?.message || e).split('\n')[0]);
    }
    const lane = acquired?.path ?? null;
    laneNum = acquired?.lane ?? null;
    if (!lane) return fail('acquire', 'lane-pool acquire produced no usable lane path');
    // THE #4317-REVIEW FIX (codex plan review, 2026-09-28): every operation from here on must run the ACQUIRED
    // LANE's OWN `run.mjs`, never a `run.mjs` resolved from wherever THIS script itself lives (the checkout that
    // spawned this job, e.g. a daemon clone). `scaffold-io.mjs#REPO_ROOT` (and its siblings) resolve their own
    // repo root by SCRIPT LOCATION, not by `cwd` — so running the CALLER's `run.mjs` with `cwd: lane` would still
    // have written the card into the CALLER's own `backlog/`, the exact bug this whole file exists to fix, just
    // one hop further out. A real delivery agent avoids this by `cd $LANE` + a RELATIVE `scripts/...` path; this
    // does the equivalent by building the lane's own absolute path explicitly.
    const laneRunMjs = join(lane, 'scripts', 'operations', 'run.mjs');

    // DEDUPE BEFORE FILING. A failure here never blocks the filing: it files exactly as before.
    let plan = null;
    try {
      plan = dedupe(input, { lane, write });
    } catch (e) {
      write(`land-prevention-card: dedupe failed, filing as before — ${String(e?.message || e).split('\n')[0]}\n`);
    }
    const mentioned = []; // mentions appended to a card in THIS lane (landed by the PR below)
    const recorded = []; // every match now written somewhere (this lane, an open PR, or already on the card)
    if (plan && (plan.action === 'mention' || plan.action === 'partial')) {
      for (const m of plan.mentions) {
        const asMatches = m.items.map((item) => ({ item, card: m.card }));
        if (m.card.host === 'main') {
          const path = join(lane, m.card.rel);
          const text = readFileSafe(readFile, path);
          // Re-checked at write time on the lane's own copy: a claimed (active) or closed card is never touched.
          if (!/^status:[ \t]*"?open"?[ \t]*$/m.test(text)) {
            write(`land-prevention-card: ${m.card.rel} is no longer open — filing its finding(s) instead\n`);
            continue;
          }
          const next = appendMentions(text, m.lines);
          if (next !== text) {
            writeFile(path, next, 'utf8');
            exec('git', ['-C', lane, 'add', '--', m.card.rel], {});
            mentioned.push(m);
          }
          recorded.push(...asMatches);
        } else if (m.card.host?.pr) {
          try {
            exec('gh', ['pr', 'comment', String(m.card.host.pr), '--repo', CONSTELLATION_REPOS.we.slug, '--body', buildPrMentionComment(m)], { cwd: lane });
            recorded.push(...asMatches);
          } catch (e) {
            write(`land-prevention-card: mention comment on PR #${m.card.host.pr} failed, filing instead — ${String(e?.message || e).split('\n')[0]}\n`);
          }
        }
      }
    }
    // A match whose mention could not be recorded anywhere is filed after all — never dropped.
    const filingInput = !plan || !recorded.length ? input : remainingAfter(input, recorded);

    let num = null;
    let rel = null;
    if (filingInput) {
      write(`land-prevention-card: filing the card in ${lane}…\n`);
      const fileArgv = [
        laneRunMjs, 'file-item', `--title=${retitle(filingInput, input)}`, `--kind=${filingInput.kind}`, `--size=${filingInput.size}`,
        `--digest=${filingInput.digest}`, `--scope=${filingInput.scope}`,
        ...(filingInput.parent ? [`--parent=${filingInput.parent}`] : []),
        `--queue=${filingInput.queue}`, '--json',
      ];
      let filed;
      try {
        filed = parseRunJsonTail(exec('node', fileArgv, { cwd: lane, timeout: FILE_ITEM_TIMEOUT_MS }));
      } catch (e) {
        filed = parseRunJsonTail(e?.stdout);
        if (!filed) return fail('file-item', String(e?.message || e).split('\n')[0]);
      }
      num = filed?.verdict?.num ?? null;
      rel = filed?.verdict?.rel ?? null;
      if (!rel) return fail('file-item', filed?.error || 'file-item produced no card path', { num });
    } else if (!mentioned.length) {
      // Every finding is already recorded (on an open PR's card, or verbatim on the card from a retried filing).
      write('land-prevention-card: every finding is already on an open card — nothing to file or land\n');
      return { ok: true, step: 'mentioned', num: null, rel: null, pr: null, url: null, reason: null, mentions: recorded.length };
    }

    write(`land-prevention-card: committing ${[rel, ...mentioned.map((m) => m.card.rel)].filter(Boolean).join(', ')}…\n`);
    try {
      if (rel) exec('git', ['-C', lane, 'add', '--', rel], {});
      const msgPath = scratchFile('commit-msg.txt');
      const item = rel
        ? (num ?? /^(x[0-9a-z]{6})-/.exec(basename(rel))?.[1] ?? '?')
        : mentioned[0].card.id;
      const subject = rel
        // This card is being created now and cannot exist on origin/main yet.
        ? machinePrTitle({ item, kind: 'prevention', card: { title: input.title, raw: input.digest } })
        : machinePrTitle({ item, kind: 'prevention', card: { title: mentionTitle(input, mentioned[0].items[0]) } });
      writeFile(msgPath, `${subject}\n\n`
        + 'Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>\n', 'utf8');
      exec('git', ['-C', lane, 'commit', '-F', msgPath], {});
    } catch (e) {
      return fail('commit', String(e?.message || e).split('\n')[0], { num, rel });
    }

    write('land-prevention-card: running the gate…\n');
    let verified;
    try {
      verified = parseRunJsonTail(exec('node', [laneRunMjs, 'verify', `--checkout=${lane}`, '--mode=run', '--json'], { cwd: lane, timeout: VERIFY_TIMEOUT_MS }));
    } catch (e) {
      verified = parseRunJsonTail(e?.stdout);
    }
    if (!verified?.verdict?.ok) {
      return fail('verify', `gate not green: ${JSON.stringify(verified?.verdict?.blocking ?? verified?.error ?? 'unrun')}`, { num, rel });
    }

    write('land-prevention-card: opening the PR…\n');
    const bodyPath = scratchFile('pr-body.md');
    const mentionNote = mentioned.length
      ? `\n\nDedupe before filing: ${mentioned.length} existing open card(s) got "Also raised by" lines instead of a new card: `
        + `${mentioned.map((m) => `\`${m.card.rel}\``).join(', ')}.\n`
      : '';
    writeFile(bodyPath, `Mechanically filed by the approval-time prevention filer (#4317).${mentionNote}\n\n${input.digest}\n`, 'utf8');
    const ref = preventionCardRef({ num, rel, session: input.session });
    let opened;
    try {
      opened = parseRunJsonTail(exec('node', [
        laneRunMjs, 'open-pr', `--ref=${ref}`, '--base=main', `--bodyFile=${bodyPath}`,
        '--mode=label-on-green', '--requireVerified=true', '--json',
      ], { cwd: lane, timeout: OPEN_PR_TIMEOUT_MS }));
    } catch (e) {
      opened = parseRunJsonTail(e?.stdout);
      if (!opened) return fail('open-pr', String(e?.message || e).split('\n')[0], { num, rel });
    }
    const submit = extractSubmitResult(opened || {});
    if (submit?.outcome !== 'opened') {
      return fail('open-pr', submit?.reason ?? 'PR was not opened', { num, rel, pr: submit?.pr, url: submit?.url });
    }
    write(`land-prevention-card: landed — PR #${submit.pr} (${submit.url})\n`);
    return {
      ok: true, step: 'done', num, rel, pr: submit.pr ?? null, url: submit.url ?? null, reason: null,
      ...(recorded.length ? { mentions: recorded.length } : {}),
    };
  } catch (e) {
    return fail('unexpected', String(e?.message || e));
  } finally {
    if (laneNum != null) {
      try {
        exec('node', [LANE_POOL_CLI, 'release', `--lane=${laneNum}`, `--session=${input.session}`], { cwd: REPO_ROOT, timeout: ACQUIRE_TIMEOUT_MS });
      } catch (e) {
        write(`land-prevention-card: lane-${laneNum} release failed (non-fatal, will age out on its own TTL) — ${String(e?.message || e)}\n`);
      }
    }
    if (scratch) {
      try { rmTmp(scratch); } catch (e) { write(`land-prevention-card: scratch cleanup failed (non-fatal) — ${String(e?.message || e)}\n`); }
    }
  }
}

const readFileSafe = (read, path) => { try { return read(path); } catch { return ''; } };

/**
 * PURE. The title the (possibly reduced) filing is filed under: a descriptive "Prevention — <first finding> (from …)"
 * title is rebuilt from the reduced digest, so it names a finding the new card still carries.
 */
export function retitle(filingInput, original) {
  if (filingInput === original) return original.title;
  const m = /^Prevention — .+ \(from (\S+)#(\d+) review\)$/.exec(original.title);
  if (!m) return original.title;
  try { return preventionCardTitle({ repo: m[1], pr: m[2], digest: filingInput.digest }); } catch { return original.title; }
}

/** PURE. The machine title of a mention-only change: the first mentioned finding, from its source PR. */
export function mentionTitle(input, item) {
  const src = filingSource(input) ?? { repo: 'unknown', pr: 0 };
  return `Prevention — also raised: ${item?.claim ?? 'a finding already on this card'} (from ${src.repo}#${src.pr} review)`;
}

/**
 * PURE. The `lane/*` ref a filed card's PR opens on — unique per card (#4317 advisory review, 2026-09-29 04:47:
 * the first cut fell back to ONE shared `lane/x-prevention-card` for every unnumbered card, so two in-flight
 * hash-id cards collided on the same branch). Uses the card's `num` when it has one, else the hash id that
 * leads the card's own filename (`backlog/<id>-<slug>.md`), else the job's own unique session slug.
 * @param {{num:(number|string|null), rel:(string|null), session:string}} o
 * @returns {string}
 */
export function preventionCardRef({ num, rel, session }) {
  if (num != null && String(num).trim()) return `lane/${String(num).trim()}-prevention-card`;
  // The backlog's own provisional hash-id shape (`x` + 6, as `check-backlog-item.mjs` reads it) — never a looser
  // pattern that a plain slug word (`file-the-…`) could also match and so collide again.
  const id = /^(x[0-9a-z]{6})-/.exec(basename(String(rel ?? '')))?.[1];
  if (id) return `lane/${id}-prevention-card`;
  return `lane/${session}`;
}

/**
 * THE CLI, AS A FUNCTION — same reason `we:scripts/operations/deliver-item-run.mjs#runDeliverItemCli` is
 * extracted: the argv parse, the exit-code mapping and the failure text are all reachable from a test with no
 * subprocess. Exit 0 iff `landPreventionCard` reports `ok:true`; every named failure (a bad argv, a refused
 * acquire, a red gate, a refused PR) is exit 1 with the reason on stderr — this process's own log file is the
 * durable record (see the file header), there is no caller polling it.
 * @param {string[]} argv
 * @param {{land?: Function, write?: Function, writeErr?: Function}} [io]
 * @returns {Promise<{code:number, result:object|null}>}
 */
export async function runLandPreventionCardCli(argv = [], {
  land = landPreventionCard,
  write = (line) => process.stdout.write(line),
  writeErr = (line) => process.stderr.write(line),
  retract = (r) => postLandingRetraction(r, { write: writeErr }),
} = {}) {
  let input;
  try {
    input = parseLandPreventionCardArgv(argv);
  } catch (e) {
    writeErr(`error: ${String(e?.message ?? e)}\n`);
    return { code: 1, result: null };
  }
  write(`land-prevention-card: starting (session ${input.session}) — pid ${process.pid}\n`);
  const result = await land(input, { write });
  if (!result.ok) {
    writeErr(`land-prevention-card: did not land — ${result.step}: ${result.reason}\n`);
    // The approval that spawned this job already posted its filing marker; retract it so the guard is retried on
    // the next approval of this head instead of being lost (#4317 advisory review, 2026-09-29).
    // Not when a PR may already exist (open-pr reported a number/url but not `opened`): retracting then would
    // trade a lost guard for a duplicate card. That ambiguous case stays with the residual card xxe5jvs.
    if (input.retract && result.pr == null && result.url == null) {
      try { retract({ ...input.retract, session: input.session, result }); } catch (e) {
        writeErr(`land-prevention-card: retraction threw (non-fatal) — ${String(e?.message || e)}\n`);
      }
    }
    return { code: 1, result };
  }
  write(`land-prevention-card: done — PR #${result.pr}\n`);
  return { code: 0, result };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const { code } = await runLandPreventionCardCli(process.argv.slice(2));
  process.exitCode = code;
}
