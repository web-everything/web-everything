/**
 * @file scripts/lib/probation-launcher.mjs
 * @description THE PURE HALF OF THE PROBATION LAUNCHER (agy-launcher-probation, operator 2026-09-27) — every
 *   decision `we:scripts/operations/probation-heal-run.mjs` (`ci-heal`) and
 *   `we:scripts/operations/probation-build-run.mjs` (`doc-fix`, #4291) make, as data in, data out. No fs, no
 *   spawn, no clock.
 *
 * WHAT IT LAUNCHES. A {@link ./provider-routing.mjs#selectProbationWorker} pick — Codex, Antigravity-Claude or
 * Antigravity-Gemini — through the two synchronous launcher scripts that already exist and already block until
 * the model's turn ends: `we:scripts/gemini-direct-task.mjs` (agy) and `we:scripts/codex-direct-task.mjs`. Both
 * NEVER commit or push; the run script owns the commit, the push and every PR write, so a probation worker
 * only ever edits files in its lane.
 *
 * THE CHECKS AROUND THE MODEL (deterministic core, thin judgment):
 *   - {@link healDiffWithinEnvelope} — a launch's own diff must fit its taskType's row in `PROVEN_TASK_ENVELOPES`
 *     (`'ci-heal'` for a heal, `'doc-fix'` for a doc-fix build, #4291), or it is not pushed (the router cannot
 *     bound the diff up front; this bounds it after the run).
 *   - {@link parseCheckerVerdict} — a worker with a `checker` (Antigravity-Gemini, #3922) is pushed only when the
 *     checker's first line is `APPROVE`. Anything else — silence, a parse failure, `REJECT` — blocks the push.
 *
 * #4291 (doc-fix launcher) ADDS {@link buildDocFixTask} and {@link buildDocFixCommitMessage} beside the ci-heal
 * pair {@link buildCiHealTask}/{@link buildHealCommitMessage} — same shape, same rules (no commit/push/PR from
 * the worker, stay in scope, never weaken a test), aimed at BUILDING a backlog item to spec instead of REPAIRING
 * a red check. Every other helper here (`buildWorkerArgv`, `summarizeNumstat`, `newUntrackedPaths`,
 * `healDiffWithinEnvelope`, `launchScorecardRow`, `coAuthorTrailerForWorker`) is already generic over taskType
 * and is reused as-is by both run scripts.
 */

import { machinePrTitle, boundedTitle } from '../operations/machine-pr-title.mjs';
import { isTestPath } from './dispatch-task-type.mjs';
import { DISPATCH_MACHINERY_PATHS, isStatuteTierPath, PROVEN_TASK_ENVELOPES } from './provider-routing.mjs';

/** The launcher scripts a probation worker may name, repo-relative. */
export const PROBATION_LAUNCHERS = Object.freeze(['scripts/gemini-direct-task.mjs', 'scripts/codex-direct-task.mjs']);

/** Per-attempt model wall for one heal turn (both launchers accept `--timeout-ms`). */
export const PROBATION_TURN_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * argv (after `node`) for ONE synchronous worker run in `dir`. PURE.
 * @param {{worker: {launcher: string, model: string}, weRoot: string, dir: string, taskFile: string,
 *   timeoutMs?: number}} o
 * @returns {string[]}
 */
export function buildWorkerArgv({ worker, weRoot, dir, taskFile, timeoutMs = PROBATION_TURN_TIMEOUT_MS }) {
  if (!PROBATION_LAUNCHERS.includes(worker?.launcher)) {
    throw new TypeError(`probation-launcher: unknown launcher ${JSON.stringify(worker?.launcher)} — one of ${PROBATION_LAUNCHERS.join(', ')}`);
  }
  for (const [name, v] of Object.entries({ weRoot, dir, taskFile, model: worker.model })) {
    if (typeof v !== 'string' || !v.trim()) throw new TypeError(`probation-launcher: ${name} is required`);
  }
  return [
    `${weRoot}/${worker.launcher}`,
    `--dir=${dir}`,
    `--task-file=${taskFile}`,
    `--model=${worker.model}`,
    `--effort=${worker.effort ?? "medium"}`,
    `--timeout-ms=${timeoutMs}`,
    '--gate=none',
    '--json',
  ];
}

/**
 * argv (after `node`) for the READ-ONLY checker run over a heal diff. PURE. The checker is Codex today (the only
 * value `PROBATION_WORKERS` names); its `--review` mode runs under `-s read-only` and answers in `lastMessage`.
 * @param {{checker: string, weRoot: string, dir: string, taskFile: string}} o
 * @returns {string[]}
 */
export function buildCheckerArgv({ checker, weRoot, dir, taskFile }) {
  if (checker !== 'codex') throw new TypeError(`probation-launcher: unsupported checker ${JSON.stringify(checker)}`);
  return [`${weRoot}/scripts/codex-direct-task.mjs`, '--review', `--dir=${dir}`, `--task-file=${taskFile}`, '--gate=none', '--json'];
}

/**
 * The task text a worker gets for one CI heal. PURE. It carries everything the worker needs, because the worker
 * has no brief of its own: the PR, why the heal fired, what failed, and the rules a heal keeps.
 * @param {{pr: number, reason: string, scope: string[], failingChecks: string, gateOutput: string, logTail?: string}} o
 * @returns {string}
 */
export function buildCiHealTask({ pr, reason, scope = [], failingChecks = '', gateOutput = '', logTail = '' }) {
  const clip = (text, max) => {
    const t = String(text ?? '').trim();
    return t.length > max ? `…(clipped)\n${t.slice(-max)}` : t;
  };
  return [
    `# CI heal for pull request #${pr} (${reason})`,
    '',
    'This working directory is the pull request\'s branch, already rebased onto the current `main`.',
    'Its required CI is red (or it was behind `main`). Make the SMALLEST change that turns the failing check green.',
    '',
    'Rules:',
    '- Repair ONLY the CI break. Do not change what the pull request is for, and do not fold in unrelated work.',
    '- Never weaken, skip or delete a test to make it pass.',
    `- Stay inside the pull request's own scope where you can: ${scope.length ? scope.join(', ') : '(no declared scope)'}.`,
    '- Keep the repair small: at most 3 files and about 150 changed lines. A bigger repair is not a CI heal — stop and say so.',
    '- If the red is not a CI break at all (the change itself is wrong, or it needs a design call), change nothing and say so in your final message.',
    '- Do not commit, push, open a pull request, or touch any label. The launcher that started you does those.',
    '',
    '## Failing required checks',
    clip(failingChecks, 4000) || '(none reported by GitHub — the local gate below is red)',
    '',
    '## Local gate output (the diff-selected gate, run after the rebase)',
    clip(gateOutput, 8000) || '(not run)',
    ...(logTail ? ['', '## Failing CI log (tail)', clip(logTail, 8000)] : []),
    '',
  ].join('\n');
}

/**
 * The checker's task: the heal diff and the question. PURE.
 * @param {{pr: number, reason: string, diff: string, failingChecks: string}} o
 */
export function buildCheckerTask({ pr, reason, diff, failingChecks = '' }) {
  const d = String(diff ?? '');
  return [
    `You are checking a small CI repair another model made on pull request #${pr} (${reason}).`,
    'Answer on the FIRST line with exactly `APPROVE` or `REJECT`, then one short paragraph of reasons.',
    'REJECT if the repair weakens, skips or deletes a test, changes what the pull request is for, is broader than the',
    'failing check needs, or would not plausibly turn the failing check green.',
    '',
    '## Failing checks',
    String(failingChecks || '(none reported)').slice(0, 4000),
    '',
    '## The repair diff',
    d.length > 20000 ? `${d.slice(0, 20000)}\n…(clipped)` : d,
  ].join('\n');
}

/**
 * The task text a worker gets for one probation BUILD (doc-fix by default, or bugfix). PURE. Mirrors {@link buildCiHealTask}'s
 * shape (name the surface, state the rules, forbid commit/push/PR, hand over what the worker needs) for a
 * BUILD rather than a REPAIR: the worker has no brief of its own, so the item's own spec text is the whole task.
 * @param {{num: string|number, title?: string, spec: string, scope?: string[], taskType?: 'doc-fix'|'bugfix'}} o
 * @returns {string}
 */
export function buildDocFixTask({ num, title = '', spec, scope = [], taskType = 'doc-fix' }) {
  if (!num) throw new TypeError('probation-launcher: num is required');
  if (typeof spec !== 'string' || !spec.trim()) throw new TypeError('probation-launcher: spec is required');
  return [
    `# Build backlog item #${num}${title ? `: ${title}` : ''} (${taskType} probation launch)`,
    '',
    'This working directory is a fresh lane clone, freshly reset onto the current `main`. Build the item below',
    'to spec — every `## Done when` clause it states must hold when you are finished.',
    '',
    'Rules:',
    taskType === 'test-fix'
      ? '- Touch ONLY test files or test fixtures. If production code is wrong, stop and report it; do not change production code.'
      : taskType === 'doc-fix'
      ? '- This is a `doc-fix` task: touch ONLY documentation/prose files. Do not change source code, tests, or config.'
      : '- This is a bugfix task: repair only the specified bug. Simple mechanical work only when using Gemini Flash.',
    `- Stay inside the item's own scope: ${scope.length ? scope.join(', ') : '(no declared scope — stay inside documentation paths only)'}.`,
    `- Keep the change small: at most ${PROVEN_TASK_ENVELOPES[taskType].maxFiles} files and about ${PROVEN_TASK_ENVELOPES[taskType].maxLoc} changed lines (the proven \`${taskType}\` envelope). A bigger`,
    '  change exceeds the envelope — stop and say so in your final message rather than exceeding it.',
    '- Never weaken, skip or delete a test.',
    '- If the item is not buildable as written (the spec is unclear, contradictory, or already done), change',
    '  nothing and say so in your final message.',
    '- Do not commit, push, open a pull request, resolve the backlog item, or touch any label — the launcher',
    '  that started you does all of those once your change is verified.',
    '',
    '## The item\'s own spec',
    spec.trim(),
    '',
  ].join('\n');
}

/**
 * The commit message for a probation doc-fix build (#4291). PURE. Mirrors {@link buildHealCommitMessage}: the
 * trailers name who did the work, so the review and the trial record can tell a probation build from a Claude
 * one.
 * @param {{num: string|number, worker: object, taskType?: 'doc-fix'|'bugfix'}} o
 */
export function buildDocFixCommitMessage({ num, worker, taskType = 'doc-fix', title }) {
  return [
    machinePrTitle({ item: num, kind: taskType === 'prepare' ? 'prepare' : `${taskType}-build`, subject: title }),
    '',
    `Built by the ${worker.id} probation worker (agy-launcher-probation, #4291); the launcher claimed the item,`,
    'ran the gate, resolved it, and committed. Full review and a run rating are owed on this change.',
    '',
    `Probation-Worker: ${worker.id}`,
    `Executor: ${worker.executor}`,
    `Model: ${worker.model}`,
    coAuthorTrailerForWorker(worker),
    '',
  ].join('\n');
}

/**
 * Frontmatter keys the SANCTIONED item-lifecycle scripts (`claim`/`resolve`/`prepare-stamp`) are allowed to
 * write. Anything else changing in the item's frontmatter means something other than that bookkeeping touched
 * it (#4291 plan review — a doc-fix worker directly tampering with `scope:`/`blockedBy:`/etc., which a
 * body-only check would miss).
 *
 * Ground-truthed against `we:scripts/backlog/frontmatter.mjs#applyTransition` and `we:scripts/backlog.mjs`'s
 * `prepareStamp`, not guessed: `claim` writes only `status`+`dateStarted`; `resolve` writes `status`+
 * `dateResolved` and, only for a `kind: decision`, `graduatedTo`/`codifiedIn` (the field IS `codifiedIn` — the
 * CLI flag that sets it is spelled `--codified-to`, a distinct name for a distinct thing); `release` writes only
 * `status`; `prepare-stamp` writes `status`+`preparedDate`+`preparedAgainstSha`.
 */
export const CLAIM_OWNED_FRONTMATTER_KEYS = Object.freeze([
  'status', 'dateStarted', 'dateResolved', 'preparedDate', 'preparedAgainstSha', 'graduatedTo', 'codifiedIn',
]);

/**
 * Frontmatter keys a standalone PREPARE worker run may change: the card's own `scope:` (factual drift
 * correction, #4658), `size:` (operator ruling on #4670, 2026-10-03: a prepare worker may change it directly,
 * grounded in file:line evidence and stated in `## Progress`) plus the two stamps `prepare-stamp` writes. The
 * prepare worker brief (`skills-src/conveyor/prepare-item-worker-brief.md`) names exactly these, and a contract
 * test asserts it — one constant so the brief and the runner's tamper check cannot drift apart.
 *
 * `blockedBy` is deliberately NOT here (same ruling): a worker may only PROPOSE edge changes, in the card's
 * `## Proposed blockedBy changes` section ({@link parseProposedBlockedBy}); the frontmatter stays untouched
 * until an independent reviewer confirms (the parked PR's review), so a direct `blockedBy:` edit is still tamper.
 */
export const PREPARE_OWNED_FRONTMATTER_KEYS = Object.freeze(['scope', 'size', 'preparedDate', 'preparedAgainstSha']);

// Two-form backlog id; the contract test keeps this aligned with check-standards' ITEM_REF_RX.
export const BACKLOG_ID_SOURCE = '\\d{1,5}|x[0-9a-z]{6}';
const PROPOSED_BLOCKED_BY_BULLET = new RegExp(`^\\s*[-*]\\s+(add|remove)\\s+#?(${BACKLOG_ID_SOURCE})\\b`, 'i');

/**
 * The edges a prepare worker PROPOSED in the card's `## Proposed blockedBy changes` section. PURE.
 * One bullet per edge: `- add ID — reason (file:line)` or `- remove ID — reason (file:line)`.
 * IDs are numeric or provisional hashes, as defined by {@link BACKLOG_ID_SOURCE}.
 * @param {string} raw - the card's whole text.
 * @returns {{op: 'add'|'remove', target: string, line: string}[]}
 */
export function parseProposedBlockedBy(raw) {
  const m = /^## Proposed blockedBy changes[^\n]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(String(raw ?? ''));
  if (!m) return [];
  const out = [];
  for (const line of m[1].split(/\r?\n/)) {
    const b = PROPOSED_BLOCKED_BY_BULLET.exec(line);
    if (b) out.push({ op: b[1].toLowerCase(), target: b[2], line: line.trim() });
  }
  return out;
}

/**
 * Validate proposed `blockedBy` edges against the backlog graph, mirroring the `check:standards` DAG rules
 * (scripts/check-standards.mjs, "6d-ter"): no self edge, the target must exist, an ADDED edge may never point
 * at a resolved card, and the resulting graph must stay acyclic. PURE. An empty result means valid.
 * @param {string} self - the card's number.
 * @param {{op: string, target: string}[]} proposals
 * @param {Map<string, {status: string, blockedBy: string[]}>} graph - num -> card state (this card included).
 * @returns {string[]} violations.
 */
export function validateProposedBlockedBy(self, proposals, graph) {
  const bad = [];
  const edges = new Map([...graph].map(([n, c]) => [n, [...(c.blockedBy ?? []).map(String)]]));
  const mine = edges.get(self) ?? [];
  edges.set(self, mine);
  for (const { op, target } of proposals) {
    if (op === 'add') {
      if (target === self) { bad.push(`#${target}: an item cannot block itself`); continue; }
      if (!graph.has(target)) { bad.push(`#${target}: does not resolve to an existing item`); continue; }
      if (graph.get(target).status === 'resolved') { bad.push(`#${target}: is resolved — a blockedBy edge may never point at a resolved card`); continue; }
      if (!mine.includes(target)) mine.push(target);
    } else {
      const i = mine.indexOf(target);
      if (i < 0) bad.push(`#${target}: cannot remove an edge the card does not have`); else mine.splice(i, 1);
    }
  }
  const state = new Map();
  const walk = (n, stack) => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    for (const t of edges.get(n) ?? []) { const c = walk(t, [...stack, n]); if (c) return c; }
    state.set(n, 2);
    return null;
  };
  const cycle = walk(self, []);
  if (cycle) bad.push(`blockedBy cycle: #${cycle.join(' → #')}`);
  return bad;
}

/**
 * The `---\n...\n---\n` frontmatter block's own text (no delimiters), or `''` if the file has none. PURE.
 * Accepts CRLF (`\r\n`) as well as LF line endings at both delimiters (#4395) — a card saved with CRLF
 * previously failed to match at all, so its frontmatter went invisible to every caller instead of parsed.
 */
function frontmatterBlock(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(String(raw ?? ''));
  return m ? m[1] : '';
}

/**
 * Did an item's frontmatter change anywhere OTHER than an ALLOWED key's line, between two reads of the same
 * file? PURE. `true` means something besides the caller's own sanctioned bookkeeping edited the frontmatter —
 * a worker directly rewriting `scope:`, `blockedBy:`, or any other field.
 *
 * `allowedKeys` defaults to the FULL {@link CLAIM_OWNED_FRONTMATTER_KEYS} table, but a caller that only ever
 * runs a SUBSET of the lifecycle verbs should narrow it to just the keys ITS OWN calls can legitimately
 * produce (#4291 plan-review finding, round 8): a doc-fix build only ever calls plain `claim`/`resolve` (never
 * `prepare-stamp`, never `resolve --graduated-to=`/`--codified-to=`), so treating `preparedDate`/
 * `preparedAgainstSha`/`graduatedTo`/`codifiedIn` as "always fine to change" there would let a worker forge one
 * of those directly and have it ride into the commit unnoticed — those keys legitimately change only through a
 * DIFFERENT verb this caller never invokes, so for THIS caller a change to any of them IS tamper.
 * @param {string} before - the file's raw text before.
 * @param {string} after - the file's raw text after.
 * @param {readonly string[]} [allowedKeys]
 * @returns {boolean}
 */
export function frontmatterTamperedBeyondClaim(before, after, allowedKeys = CLAIM_OWNED_FRONTMATTER_KEYS) {
  // Split on \r?\n (#4395), not '\n' alone: a plain '\n' split leaves a trailing '\r' on every CRLF line but
  // the block's last one, so removing/adding an allowed-key line shifts WHICH lines carry that stray '\r' and
  // strip(before) !== strip(after) even when only an allowed key changed — a false positive, not a real tamper.
  const strip = (raw) => frontmatterBlock(raw)
    .split(/\r?\n/)
    .filter((line) => !allowedKeys.some((k) => line.startsWith(`${k}:`)))
    .join('\n');
  return strip(before) !== strip(after);
}

/**
 * The checker's verdict from its final message. PURE, fail-closed: only a first non-empty line that is exactly
 * `APPROVE` (case-insensitive, markdown emphasis stripped) approves.
 * @param {string|null|undefined} message
 * @returns {{approved: boolean, verdict: 'approve'|'reject'|'unreadable', reason: string}}
 */
export function parseCheckerVerdict(message) {
  const lines = String(message ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { approved: false, verdict: 'unreadable', reason: 'the checker gave no answer' };
  const head = lines[0].replace(/[*_`#>\s]/g, '').toUpperCase();
  if (head === 'APPROVE') return { approved: true, verdict: 'approve', reason: lines.slice(1).join(' ').slice(0, 500) };
  if (head === 'REJECT') return { approved: false, verdict: 'reject', reason: lines.slice(1).join(' ').slice(0, 500) };
  return { approved: false, verdict: 'unreadable', reason: `the first line was not APPROVE or REJECT: ${lines[0].slice(0, 120)}` };
}

/**
 * Sum `git diff --numstat` output. PURE. Binary files (`-\t-\tpath`) count as one file and zero lines.
 * `exclude` drops paths that were untracked BEFORE the worker ran: `gemini-direct-task.mjs` intent-adds every
 * untracked file for its own diff capture, so such a path shows up in the numstat without being the worker's
 * (live-caught 2026-09-27: a `node_modules` symlink was committed with the first real agy heal).
 * @param {string} numstat
 * @param {{exclude?: string[]}} [o]
 * @returns {{files: number, loc: number, paths: string[]}}
 */
export function summarizeNumstat(numstat, { exclude = [] } = {}) {
  const skip = new Set(exclude);
  const paths = [];
  let loc = 0;
  const text = String(numstat ?? '');
  // `git diff -z --numstat --no-renames` records are `added\tdeleted\tpath\0` (paths verbatim, never C-quoted); the
  // newline shape is kept for callers (the build arc) that still read the plain output.
  const nul = text.includes('\0');
  for (const line of text.split(nul ? '\0' : '\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(nul ? line.replace(/^\n/, '') : line.trim());
    if (!m || skip.has(m[3])) continue;
    paths.push(m[3]);
    loc += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  return { files: paths.length, loc, paths };
}

/**
 * The untracked paths the WORKER created: `after` minus whatever was already untracked before it ran. PURE.
 * Live-caught on the first real agy run (2026-09-27): an untracked `node_modules` symlink present in the lane
 * before the worker started was swept into the heal commit. Only these paths may be intent-added to the diff.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]}
 */
export function newUntrackedPaths(before, after) {
  const had = new Set(Array.isArray(before) ? before : []);
  return (Array.isArray(after) ? after : []).filter((p) => !had.has(p));
}

/**
 * Does a heal diff fit the probation envelope for `ci-heal`? PURE.
 * @param {{files: number, loc: number}} summary
 * @returns {{ok: boolean, reason: string}}
 */
export function healDiffWithinEnvelope(summary, envelope = PROVEN_TASK_ENVELOPES['ci-heal']) {
  if (envelope.testOnly && (!summary.paths?.length || !summary.paths.every(isTestPath))) {
    return { ok: false, reason: 'test-fix refused non-test or missing paths; use the normal route for production changes' };
  }
  if (summary.files > envelope.maxFiles) return { ok: false, reason: `the heal touched ${summary.files} files (limit ${envelope.maxFiles})` };
  if (summary.loc > envelope.maxLoc) return { ok: false, reason: `the heal changed ${summary.loc} lines (limit ${envelope.maxLoc})` };
  return { ok: true, reason: `${summary.files} file(s), ${summary.loc} line(s) — within the ci-heal envelope` };
}

/**
 * The scope entries that name a path in THIS (WE) lane: bare paths and explicit `we:` entries, prefix stripped.
 * PURE. A foreign-repo entry (`frontierui:docs/a.md`) must never allowlist a same-named WE path. Mirrors
 * `probation-build-run.mjs#declaredScopePaths`.
 * @param {string[]} scope
 * @returns {string[]}
 */
function weScopeEntries(scope) {
  return (scope || []).map(String)
    .filter((p) => !/^[a-z][\w-]*:/.test(p) || p.startsWith('we:'))
    .map((p) => p.replace(/^we:/, ''));
}

/**
 * Post-diff PATH gate for a heal, next to {@link healDiffWithinEnvelope}. PURE. A small diff can still be the
 * wrong diff: reject when any path is statute-tier, dispatch machinery, or (with a non-empty scope) outside the
 * dispatch's declared scope. A scope entry ending in `/` is a directory prefix; an empty scope applies only the
 * statute/machinery checks.
 * @param {string[]} paths
 * @param {{scope?: string[]}} [o]
 * @returns {{ok: boolean, reason: string}}
 */
export function healDiffPathsAllowed(paths, { scope = [] } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  const statute = list.find(isStatuteTierPath);
  if (statute) return { ok: false, reason: `the heal touched a statute-tier path (${statute})` };
  const machinery = list.find((p) => DISPATCH_MACHINERY_PATHS.includes(p));
  if (machinery) return { ok: false, reason: `the heal touched dispatch machinery (${machinery})` };
  const entries = weScopeEntries(scope);
  if (entries.length) {
    const outside = list.find((p) => !entries.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e)));
    if (outside) return { ok: false, reason: `the heal touched a path outside the dispatch's declared scope (${outside})` };
  }
  return { ok: true, reason: 'every path is allowed' };
}

/**
 * Should the worker run at all? PURE. The deterministic rebase + gate go first; a model is only spent when there
 * is something to repair: the local gate is red, or CI was red and the rebase changed nothing (so the local gate
 * cannot have fixed what CI saw).
 * @param {{gateGreen: boolean, reason: string, rebaseMovedHead: boolean}} o
 */
export function workerNeeded({ gateGreen, reason, rebaseMovedHead }) {
  if (!gateGreen) return { needed: true, why: 'the local gate is red after the rebase' };
  if (reason === 'red-ci' && !rebaseMovedHead) return { needed: true, why: 'CI is red and the rebase changed nothing, so the local gate cannot explain the red' };
  return { needed: false, why: rebaseMovedHead ? 'the rebase alone turned the local gate green' : 'nothing to repair' };
}

/**
 * The `Co-Authored-By` trailer for a commit made on a probation worker's behalf. PURE. Mirrors
 * `deliver-item-wrapper.mjs#coAuthorTrailerFor` (Codex's trailer is that file's), adding the two agy families.
 * @param {{provider: string, model: string}} worker
 */
export function coAuthorTrailerForWorker(worker) {
  if (worker?.provider === 'codex') return 'Co-Authored-By: Codex <noreply@openai.com>';
  if (String(worker?.model ?? '').startsWith('gemini-')) return `Co-Authored-By: Gemini (${worker.model}, via Antigravity) <noreply@google.com>`;
  return `Co-Authored-By: Claude (${worker?.model ?? 'unknown'}, via Antigravity) <noreply@anthropic.com>`;
}

/**
 * The commit message for a probation heal. PURE. The trailers name who did the work, so the review and the
 * trial record can tell a probation heal from a Claude one.
 * @param {{pr: number, reason: string, worker: object, item?: string|null}} o
 */
export function buildHealCommitMessage({ pr, reason, worker, item = null, subject }) {
  const title = boundedTitle(`${item ? `WE #${item}` : `PR #${pr}`}: ci-heal — `, subject || reason, ` (PR ${pr})`);
  return [
    title,
    '',
    `Repaired by the ${worker.id} probation worker (agy-launcher-probation); the launcher rebased, ran the gate,`,
    'and committed. Full review and a run rating are owed on this change.',
    '',
    `Probation-Worker: ${worker.id}`,
    `Executor: ${worker.executor}`,
    `Model: ${worker.model}`,
    coAuthorTrailerForWorker(worker),
    '',
  ].join('\n');
}

/**
 * The scorecard row one launch appends (store: `run-scorecard-store.mjs`). PURE. `outcome` and `verifiedBy`
 * stay null: a launch is not a judged trial until its review lands, so it never counts toward graduation — it
 * only moves `selectProbationWorker`'s rotation on and shows up in the probation report as "launched".
 * @param {object} o
 */
export function launchScorecardRow({ worker, pr, repo, handle, item = null, launchOutcome, checker = null, diff = null, scoredAt, modelEvidence = {} }) {
  return {
    rubricVersion: 'probation-launch.1',
    provider: worker.provider,
    effort: worker.effort ?? 'medium',
    model: worker.provider === 'antigravity' ? (modelEvidence.servedModel ?? 'unknown') : worker.model,
    ...(worker.provider === 'antigravity' ? { requestedModel: worker.model, servedModel: 'unknown', servedBackend: 'unknown', modelEvidence: 'unavailable', ...modelEvidence } : {}),
    subjectClass: 'work-agent',
    dispatchKind: 'probation-launch',
    taskType: worker.taskType,
    criteriaEvaluated: 0,
    score: null,
    deductions: [],
    outcome: null,
    verifiedBy: null,
    executor: worker.executor,
    worker: worker.id,
    launchOutcome,
    checker,
    diff,
    pr,
    repo,
    handle,
    item,
    ...(scoredAt ? { scoredAt } : {}),
  };
}
