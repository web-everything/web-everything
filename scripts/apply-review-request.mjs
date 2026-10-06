#!/usr/bin/env node
/**
 * @file scripts/apply-review-request.mjs
 * @description Apply ONE staged review request by running the SINGLE HOME (#2644) —
 *   `we:scripts/review-set-label.mjs` — on a host that can actually authenticate to GitHub.
 *
 * WHY THIS EXISTS. A judging host is not always a writing host. A Claude Code cloud VM can run the whole
 * `review-pr` operation — measured 2026-08-18: four PRs judged, ten findings, nine real defects — and then
 * cannot record a single verdict, because no local process there holds a GitHub credential and none can be
 * given one (see `we:agent-memory-src/workflow-cloud-vm-github-api-boundary.md`). Its ONE outbound write
 * channel is `git push`. So the verdict travels as a pushed FILE, and CI — which has `gh` and a token —
 * applies it.
 *
 * IT RUNS THE REAL SCRIPT. Nothing here re-implements the label arc. The markers
 * (`reviewed-sha`/`reviewed-diff`/`reviewed-contribution`), the #2964 write ordering, the #2844 independence
 * check and every refusal stay exactly where they are. This file's whole job is: read a request, refuse the
 * ones a bot must not perform, and shell the CLI. A second implementation of the label arc is the defect this
 * is forbidden to introduce.
 *
 * THE VERDICT IS DATA, NEVER PROSE. It arrives as JSON in a committed file — reviewable in a diff — and is
 * never parsed back out of a comment. #3060 records what happens when a clearance is inferred from a prose
 * line, and this must not re-open it.
 *
 * IT RUNS FROM THE VERDICTED REPO'S CHECKOUT, NOT ITS OWN (#3263). The CLI it shells fingerprints the reviewed
 * diff through git reads that take the PROCESS'S cwd, so which tree this applier stands in is part of the
 * verdict's correctness, not a detail of how it was launched. See `resolveVerdictedRoot`.
 *
 * Usage:
 *   node scripts/apply-review-request.mjs <request.json>                  # apply it, from the cwd
 *   node scripts/apply-review-request.mjs <request.json> --repoRoot=<dir> # apply it, from that checkout
 *   node scripts/apply-review-request.mjs <request.json> --check          # validate only, run nothing
 */
import { readGit } from './lib/proc-read.mjs';
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeLineSync } from './lib/write-all-sync.mjs';
import { canonicalizeSlug } from './lib/constellation-repos.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * WHERE THE SCRIPTS LIVE — resolved by SCRIPT LOCATION, never cwd, so the label CLI that runs is always the one
 * shipped beside this file. It is NOT where the child runs: that is `resolveVerdictedRoot` below, and conflating
 * the two is the defect #3263 records.
 */
export const REPO_ROOT = resolve(HERE, '..');

/**
 * The flag that names the verdicted repo's checkout. Mirrors the `--repoRoot` seam
 * `we:scripts/operations/record-verdict-io.mjs` took for the writer half (#3261), and deliberately shares its
 * spelling: the two halves of one transport should not ask for the same thing under two names.
 */
export const REPO_ROOT_FLAG = '--repoRoot=';

/** The verdicts this applier may carry out. */
export const APPLIABLE_TARGETS = Object.freeze(['accepted', 'changes', 'clear-human']);

/**
 * `clear-human` requires this field, and its NAME is the guard. You cannot populate `operatorInstruction`
 * without claiming, in writing, that an operator said something — and it is posted verbatim in the durable
 * comment, where a false one is legible to anyone who looks.
 */
export const CLEARANCE_FIELD = 'operatorInstruction';

/**
 * Validate a staged request. PURE — returns `{ok, request}` or `{ok:false, error}`; never throws, never reads
 * the world, so every refusal below is testable without a runner.
 *
 * ── `clear-human`: REFUSED UNTIL 2026-08-19, NOW ALLOWED WITH ITS AUTHORISATION ATTACHED ────────────────────
 *
 * This file used to refuse `clear-human` outright, on the grounds that CI holding a write token is a machine
 * and a token is not a ceremony. Operator ruling, 2026-08-19, made with the weakness stated in front of them:
 *
 *   "For now, I want to allow you to accept an explicit demand to remove human tag. We will build the ui
 *    approved later."
 *
 * WHAT THAT DOES AND DOES NOT GIVE UP. The sanctioned workstation path is `review-set-label.mjs
 * --to=clear-human --actor=<name> --reason=<quote the operator instruction authorising this>`, and NOTHING
 * there verifies that a human said it either — #2895 shipped the clearance as "the raw command with better
 * manners" and deferred the unforgeable signal to #2946. So relaying an operator's instruction through a
 * request file is exactly as strong as running the command on a laptop, and no stronger. It is not a new
 * weakness; it is the SAME one, reachable from one more place.
 *
 * A day earlier this same session built a comment-triggered clearance that claimed GitHub had authenticated
 * the operator. It had not: every comment an agent posts through the session's GitHub connector carries the
 * operator's own login and `author_association: OWNER`. That design was reverted. The lesson is kept here as
 * the reason this one claims nothing: an honest weak path beats a path that overstates itself.
 *
 * WHAT STILL HOLDS THE LINE, given the signal cannot:
 *   · `operatorInstruction` is MANDATORY and travels verbatim into the durable comment. A clearance nobody
 *     asked for now requires inventing a quote and publishing it under your own name.
 *   · The trust boundary is unchanged in kind and wider in blast radius: whoever can push to
 *     `ops/review-requests` can now also clear a gate-self hold. On a solo repo that is already the same
 *     authority as pushing the code. On a repo with more than one writer it would need revisiting FIRST.
 *   · #2946 (a WebAuthn gesture) remains the durable fix and remains open. This does not close it, and every
 *     record this path writes says so.
 *
 * @param {unknown} raw - the parsed request object
 * @returns {{ok: true, request: object} | {ok: false, error: string}}
 */
export function validateRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'request must be a JSON object' };
  }
  const { repo, pr, to, actor, body, sessionId, channel } = raw;
  const operatorInstruction = raw[CLEARANCE_FIELD];

  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, error: `\`repo\` must be <owner/name>, got ${JSON.stringify(repo)}` };
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    return { ok: false, error: `\`pr\` must be a positive integer, got ${JSON.stringify(pr)}` };
  }
  // THE TARGET IS CHECKED FIRST, and the order is the fix rather than a tidy-up. With the field guards ahead of
  // it, a request naming an unknown target AND carrying a stray instruction was refused for the stray field —
  // reporting the second-most-wrong thing about it, and sending a reader to fix the wrong line
  // (review-pr correctness juror on #1477). Whether `to` is a target at all is the more fundamental question,
  // so it is asked first.
  if (!APPLIABLE_TARGETS.includes(to)) {
    return { ok: false, error: `\`to\` must be one of ${APPLIABLE_TARGETS.join('|')}, got ${JSON.stringify(to)}` };
  }
  if (to === 'clear-human' && (typeof operatorInstruction !== 'string' || !operatorInstruction.trim())) {
    return {
      ok: false,
      error: `REFUSED: \`clear-human\` requires \`${CLEARANCE_FIELD}\` — the operator's own words authorising `
        + 'this clearance, quoted verbatim. Nothing verifies them (#2946 is the durable fix and is open), so '
        + 'the record has to be WRITTEN: it is posted in the durable comment under the actor named here.',
    };
  }
  if (to !== 'clear-human' && operatorInstruction !== undefined) {
    // A stray instruction on an ordinary verdict means someone copied a clearance request and edited the
    // target. Refuse rather than silently ignore the field: the next edit is the one that flips it back.
    return { ok: false, error: `\`${CLEARANCE_FIELD}\` belongs only on a \`clear-human\` request` };
  }
  // The single home REFUSES an empty `--to=changes` (#xd6moh1) — a bounce with no findings tells an author
  // nothing. Catch it here too so the request is rejected at validation rather than after a subprocess.
  if (to === 'changes' && (typeof body !== 'string' || !body.trim())) {
    return { ok: false, error: '`changes` requires a non-empty `body` — a bounce with no findings lands nothing' };
  }
  if (typeof actor !== 'string' || !actor.trim()) {
    return { ok: false, error: '`actor` is required — a verdict with no named actor is not attributable' };
  }
  // OPTIONAL, and its absence is honest rather than fatal: without it `currentActorId()` finds nothing and the
  // durable comment records independence as UNPROVEN, which is the truth. Fabricating one here would be worse.
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
    return { ok: false, error: '`sessionId`, when present, must be a non-empty string' };
  }
  if (channel !== undefined && (typeof channel !== 'string' || !channel.trim())) {
    return { ok: false, error: '`channel`, when present, must be a non-empty string' };
  }
  return { ok: true, request: { repo, pr, to, actor, body: body ?? '', sessionId, channel, operatorInstruction } };
}

/**
 * The argv handed to the single home. PURE, and exported so a test can assert it without running anything —
 * the same discipline `we:scripts/lib/review-label-provider.mjs` applies to its own `gh` argv.
 */
export function buildLabelArgv(request, bodyFile) {
  const argv = [
    join(REPO_ROOT, 'scripts', 'review-set-label.mjs'),
    String(request.pr),
    `--repo=${request.repo}`,
    `--to=${request.to}`,
    `--actor=${request.actor}`,
  ];
  if (bodyFile) argv.push(`--body-file=${bodyFile}`);
  if (request.channel) argv.push(`--channel=${request.channel}`);
  // The single home requires `--reason` for `clear-human` (#2895) and posts it verbatim. The operator's words
  // ARE the reason — nothing is paraphrased, because a paraphrase is the agent's account of what it was told
  // rather than what it was told.
  if (request.to === 'clear-human') argv.push(`--reason=${request.operatorInstruction}`);
  return argv;
}

/**
 * The environment the CLI runs under. `CLAUDE_CODE_SESSION_ID` carries the JUDGING session's identity so
 * `currentActorId()` records who decided — not the runner, which decided nothing.
 *
 * STATE THE LIMIT PLAINLY: the request declares that id and nothing verifies it, exactly as an env var on a
 * workstation is unverified today. This relocates the self-assertion; it does not remove it. #2946 (the
 * unforgeable human-presence signal) is the durable fix and this does not pretend to be it.
 */
export function buildEnv(request, base = process.env) {
  const env = { ...base };
  if (request.sessionId) env.CLAUDE_CODE_SESSION_ID = request.sessionId;
  else delete env.CLAUDE_CODE_SESSION_ID;
  return env;
}

/**
 * `owner/name` of a checkout's `origin`, or '' when it cannot be read. Probing must NEVER throw: a tree that is
 * not a git repo at all has to arrive at `resolveVerdictedRoot`'s refusal, which names both repos and the flag
 * that fixes it, rather than escaping as a raw git error that names neither.
 *
 * NOT IMPORTED from `we:scripts/operations/record-verdict-io.mjs`, which holds the identical probe for the
 * writer half (#3261). That module pulls the whole `record-verdict` declaration in behind it — the run store,
 * the review-pr IO — and this applier is the one script that has to load on a runner installed with
 * `--ignore-scripts` (see the note in `we:.github/workflows/apply-review-request.yml` about the first live run
 * failing at module resolution). A six-line git read is a cheaper duplicate than a dependency edge from the
 * applier into the operations tree. Same shape on purpose, so a reader sees one rule stated twice rather than
 * two rules; `stdio` is quieted here so a probe of a non-repo does not print git's own complaint over the
 * applier's JSON contract on stdout's neighbour.
 */
export function defaultOriginRepo(cwd) {
  try {
    const url = String(readGit(['remote', 'get-url', 'origin'], {
      encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m ? canonicalizeSlug(m[1]) : '';
  } catch { return ''; }
}

/**
 * WHICH CHECKOUT the label CLI runs from, and a REFUSAL when the one offered is not the verdicted repo's (#3263).
 *
 * WHAT WAS WRONG. This applier used to spawn the child with `cwd: REPO_ROOT` — its OWN script dirname. That was
 * correct for exactly as long as the only applier lived inside the repo it verdicted, which was true until
 * `plateau-app:.github/workflows/apply-review-request.yml` made web-everything a SIBLING checkout (`webeverything/`)
 * beside the repo being judged. The child then ran from `.../plateau-app/webeverything`, and
 * `we:scripts/review-set-label.mjs` states in capitals what that costs: its `computeNetDiffText` call takes NO
 * explicit `cwd`, so it fetched the PR's head ref against web-everything's origin, could not resolve it, and the
 * fail-soft `catch` degraded `reviewedDiff` to `''`. No marker, so `acceptanceCoversHead` falls back to SHA
 * identity and a content-preserving rebase re-parks an already-accepted PR. Degradation, never a false accept —
 * which is why PR #145 was accepted with this carved out — but a silent one.
 *
 * WHY THE PROCESS AND NOT THE CALL. A `cwd` on that single git read would not be enough, and the CLI says so:
 * the `--body-file` allowlist is rooted at `process.cwd()` too, so the PROCESS'S location is the contract. That
 * is also why this pins the child rather than threading a flag into the CLI — pinning covers every git read the
 * CLI makes, including the ones nobody has written yet, exactly as `restampAcceptance` in
 * `we:scripts/merge-ai-prs.mjs` pins its own child for the same reason (#3202).
 *
 * WHY IT REFUSES RATHER THAN DEFAULTING TO WHATEVER IT IS STANDING IN. `process.cwd()` happens to be right in
 * both layouts today — web-everything's applier runs from the repo root, and the plateau-app workflow runs from
 * the plateau-app root — but "happens to be right" is precisely the property that stopped holding for
 * `REPO_ROOT`. So the value is CHOSEN and then CHECKED: if the tree's `origin` is not the repo the verdict names,
 * that is an error naming both, not another empty fingerprint that nobody notices until a PR re-parks for the
 * third time.
 *
 * `originRepo` is INJECTED so this is testable with no git, and so a caller that already knows the checkout can
 * say so instead of being probed.
 *
 * @param {{repo: string, root?: string, repoRoot?: string, originRepo?: Function}} o
 * @returns {string} the checkout whose `origin` is `repo`
 */
export function resolveVerdictedRoot({ repo, root = process.cwd(), repoRoot = '', originRepo = defaultOriginRepo } = {}) {
  const want = String(repo ?? '').trim();
  if (!want) throw new Error('apply-review-request: no `repo` on the request — cannot decide which checkout to run from');
  const candidate = String(repoRoot ?? '').trim() || root;
  const have = originRepo(candidate);
  if (canonicalizeSlug(have) === canonicalizeSlug(want)) return candidate;
  throw new Error(
    `apply-review-request: refusing to record a verdict for ${want} from ${have || '(not a checkout)'}'s tree (#3263). `
    + '`review-set-label.mjs` fingerprints the reviewed diff from the PROCESS\'s own cwd — its header states that '
    + 'contract in capitals — so running it from the wrong tree does not fail loudly: the head ref does not '
    + 'resolve, `reviewedDiff` degrades to empty, no `reviewed-diff` marker is stamped, and the next '
    + 'content-preserving rebase re-parks a PR that was already accepted. '
    + `Pass \`${REPO_ROOT_FLAG}<path to a ${want} checkout>\`, or run this applier from one.`,
  );
}

/**
 * @param {string[]} argv
 * @param {{spawn?: Function, originRepo?: Function, cwd?: string}} deps - injected so the CHILD'S PINNING is
 *   assertable without a subprocess and without a second clone on disk, the same discipline
 *   `we:scripts/merge-ai-prs.mjs`'s `restampAcceptance` applies to its own spawn.
 */
export function main(argv, { spawn = spawnSync, originRepo = defaultOriginRepo, cwd = process.cwd() } = {}) {
  const path = argv.find((a) => !a.startsWith('-'));
  if (!path) throw new Error(`usage: apply-review-request.mjs <request.json> [${REPO_ROOT_FLAG}<dir>] [--check]`);
  const checkOnly = argv.includes('--check');
  const repoRoot = (argv.find((a) => a.startsWith(REPO_ROOT_FLAG)) || '').slice(REPO_ROOT_FLAG.length);

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`could not read ${path} — ${e.message}`);
  }

  const verdict = validateRequest(parsed);
  if (!verdict.ok) throw new Error(`${path}: ${verdict.error}`);
  const { request } = verdict;

  if (checkOnly) {
    // DELIBERATELY NOT RESOLVED HERE. `--check` promises to validate the request and touch nothing, and
    // `resolveVerdictedRoot` reads the world (a `git remote` probe). A validate-only run also legitimately
    // happens far from the verdicted checkout — linting the staged files on `ops/review-requests`, where a
    // sibling repo's tree need not exist at all — and refusing those would make the flag useless for the one
    // job it has. The tree is the APPLY path's contract, and that is where it is enforced.
    writeLineSync(1, `ok — ${request.repo}#${request.pr} → ${request.to} (validated, nothing run)`);
    return 0;
  }

  // #3263 — WHICH TREE, decided BEFORE the body is staged and before anything is spawned. A wrong tree is a
  // refusal that names both repos, never a silent empty fingerprint; see `resolveVerdictedRoot`.
  const verdictedRoot = resolveVerdictedRoot({ repo: request.repo, root: cwd, repoRoot, originRepo });

  // The body reaches the CLI by FILE for the same reason the CLI passes it to `gh` by file: it carries
  // newlines and emoji, and shell-quoting them works until one verdict does not.
  //
  // IT IS STAGED IN `tmpdir()`, AND THAT IS LOAD-BEARING NOW THAT THE CHILD IS PINNED ELSEWHERE (#3263). The
  // CLI's `--body-file` allowlist is `[process.cwd(), tmpdir(), '/tmp']` — a body written under THIS checkout
  // would be refused by a child standing in the verdicted repo, which is the trap `restampAcceptance` avoids by
  // passing no body at all. A temp path is outside both trees and inside the allowlist either way.
  const bodyFile = request.body ? join(tmpdir(), `review-request-${request.pr}-${process.pid}.md`) : null;
  try {
    if (bodyFile) writeFileSync(bodyFile, request.body, 'utf8');
    // `cwd` IS THE VERDICTED REPO'S CHECKOUT, NEVER `REPO_ROOT` (#3263). The SCRIPT still comes from this
    // checkout — `buildLabelArgv` resolves it from `REPO_ROOT` — so the two are separated on purpose: run OUR
    // code, from THEIR tree.
    const r = spawn(process.execPath, buildLabelArgv(request, bodyFile), {
      encoding: 'utf8', env: buildEnv(request), cwd: verdictedRoot,
    });
    // The CLI speaks the `{"error":…}` / `{"ok":true,…}` JSON contract on stdout. Pass it straight through:
    // this file adds no interpretation, so an operator reads the single home's own words.
    if (r.stdout) writeLineSync(1, r.stdout.trim());
    if (r.status !== 0) {
      if (r.stderr) writeLineSync(2, r.stderr.trim());
      return r.status ?? 1;
    }
    return 0;
  } finally {
    if (bodyFile) { try { unlinkSync(bodyFile); } catch { /* best-effort */ } }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    writeLineSync(2, `apply-review-request: ${e.message}`);
    process.exitCode = 2;
  }
}
