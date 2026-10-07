#!/usr/bin/env node
/**
 * @file scripts/operations/build-dispatch-hold-route-land.mjs
 * @description #4465 — THE LANE-BOUND LANDING PASS for a build-dispatch hold's routed action, planned by
 * we:scripts/conveyor/build-dispatch-hold-router.mjs#planHoldRouting. Mirrors the established shape
 * we:scripts/operations/health-file-request-land.mjs already uses for the SAME "acquire a lane, make one
 * small mechanical edit, commit, verify, open a self-labelled PR, release the lane" arc — the resident
 * build-dispatch daemon (we:skills-src/conveyor/build-dispatch-daemon.mjs) is NEVER touched by this: every
 * write below happens inside the freshly-acquired lane this pass gets back from `lane-pool.mjs acquire`.
 *
 * TWO ROUTES LAND HERE (route 'other' never does — it is a synchronous JSON-ledger append only, no lane, no
 * PR, no hold release; see the router module for why the hold is left to self-expire on its own TTL):
 *   'already-done'  — `backlog.mjs resolve <num> --graduated-to=<commit>` (the sanctioned resolve verb).
 *   'out-of-scope'  — clear the card's `scope:` (making it "unshaped" — the EXISTING dispatch-plan
 *       auto-prepare then re-scopes it on its own) and append the agent's finding to the card body.
 *
 * IDEMPOTENCY — same mechanism as health-file-request-land.mjs: a STABLE ref (`refFor(num)`) fixed for the
 * item's whole routing life, so a retried `open-pr` targets the SAME PR (`we:scripts/pr-land.mjs`'s own
 * same-`--ref` idempotency guarantee, not re-derived here).
 *
 * Usage:
 *   node scripts/operations/build-dispatch-hold-route-land.mjs --num=<n> --route=<already-done|out-of-scope>
 *     [--commit=<sha>] [--reason=<text>] [--json]
 */
import { retryTransientGit } from '../lib/git-fetch-retry.mjs';
import { machinePrTitle } from './machine-pr-title.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveChildTimeoutMs, resolveLaneAcquireTimeoutMs } from '../lib/bounded-child.mjs';
import { localToday } from '../lib/local-date.mjs';
import { isValidHoldNum } from '../conveyor/build-dispatch-hold-router.mjs';
import { normNum } from '../conveyor/queue-store.mjs';

import { findUnmarkedLocusRefs } from '../check-standards-rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
const VERIFY_TIMEOUT_MS = 30 * 60 * 1000;
// Same generous ceiling we:skills-src/conveyor/delivery-agent-brief.md step 8 gives a foreground `open-pr
// --mode=label-on-green` caller — it blocks until the required `test` check settles.
const OPEN_PR_TIMEOUT_MS = 10 * 60 * 1000;

// ── pure ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** PURE. A stable ref, fixed for this item's whole routing life. */
export function refFor(num) { return `lane/hold-route-${num}`; }

/** PURE. Find the backlog card's filename for `num` among the names `readdirSync('backlog')` returned —
 *  injected list so this needs no disk access to test. `null` when no card starts with `<num>-`. */
export function findCardFileName(names, num) {
  return (Array.isArray(names) ? names : []).find((f) => f.startsWith(`${num}-`)) ?? null;
}

/** PURE. Escape every regex metacharacter in `s` — #4465 review round 3 (live security finding):
 *  `commitReferencesItem` builds a `RegExp` straight out of an id read from an UNTRUSTED card file
 *  (`bornAs:`); an unescaped id containing metacharacters (e.g. a card whose `bornAs` was somehow set to
 *  `.*`) would make the "references this card" check match almost any commit message at all, or throw on an
 *  invalid pattern (e.g. a lone `(`). */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** PURE. Does a commit message reference ANY of the given item ids, in the `#<id>` shape this repo's own
 *  commit convention already uses everywhere ("WE #4465: ...", "backlog: resolve #4464", "…, #x5s8b47")?
 *  `ids` should carry BOTH the card's numeric id and its `bornAs` hash — a card lands with a numeric id only
 *  at JIT-numbering time (`we:AGENTS.md`'s own drain convention), so a commit that predates that (as any
 *  already-landed "this already does it" citation necessarily does) names the `bornAs` hash instead, never
 *  the number. Used to require that an already-done citation's commit is not merely SOME real commit on main
 *  (any old ancestor sha would pass an ancestry check alone) but one that actually names THIS card — a much
 *  narrower bar for an untrusted, agent-supplied citation to clear. Every id is regex-escaped (see
 *  `escapeRegExp` above) since `bornAs` is untrusted, card-file-supplied text, never a literal this module
 *  controls. */
export function commitReferencesItem(message, ids) {
  const text = String(message ?? '');
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim()).filter(Boolean);
  return list.some((id) => new RegExp(`#${escapeRegExp(id)}\\b`).test(text));
}

// Subject-line words that mark a commit as only PART of a card's delivery — never the one that closes it.
const PARTIAL_DELIVERY_RE = /\b(?:part|slice|phase|stage)\s*\d+\b|\(\s*\d+\s*\/\s*\d+\s*\)|\bpartial(?:ly)?\b|\bgroundwork\b|\bscaffold(?:ing)?\b/i;

/** PURE. Does this commit's SUBJECT LINE name one of `ids` as the card it DELIVERS — not merely mention it?
 *  #4465 PR #2967 review (security finding): `commitReferencesItem` matches `#<id>` ANYWHERE in the message,
 *  so a related-but-not-delivering commit ("see #N", "follow-up to #N", a body-only mention) or a PARTIAL one
 *  ("WE #N: part 1") passed, and the card was auto-resolved with its spec unbuilt. Accepts exactly the two
 *  delivery shapes this repo's own history uses on the subject line:
 *   - the lead tag `WE #<id>: …` (any `<TAG> #<id>:` prefix, a bare `#<id>: …`, or a multi-id tag
 *     `WE #<a>/#<b>: …` naming this card among its ids);
 *   - the trailing reference `fix(x): … (#<id>)` a conventional-commit subject ends with (the shape #4380's
 *     own live citation, commit b93d13e29, actually has) — accepted for a `bornAs` HASH id only: a trailing
 *     `(#<number>)` is far more often a squash-merge PR number or the tool/epic card a drain commit cites
 *     ("drain: mark card 4498 resolved on land (#2748)"), and PR numbers overlap card numbers.
 *  Refuses a subject carrying a partial-delivery marker ({@link PARTIAL_DELIVERY_RE}: "part 2", "slice 1",
 *  "(1/3)", "partial", "groundwork", "scaffold") even in a delivery shape. Fails SAFE: a real delivery in some
 *  other shape is refused (the item falls back to ordinary build dispatch), never auto-resolved. */
export function commitDeliversItem(message, ids) {
  const subject = String(message ?? '').split(/\r?\n/)[0].trim();
  if (!subject || PARTIAL_DELIVERY_RE.test(subject)) return false;
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim()).filter(Boolean);
  return list.some((id) => {
    const e = escapeRegExp(id);
    if (new RegExp(`^(?:[A-Za-z][\\w-]*\\s+)?(?:#[\\w]+/)*#${e}(?:/#[\\w]+)*:`).test(subject)) return true;
    return !/^\d+$/.test(id) && new RegExp(`\\(#${e}\\)\\s*$`).test(subject);
  });
}

// A delivery verb, and the words that turn it around ("does not fix #N", "unable to fix #N", "will fix #N later").
const CREDIT_VERB = String.raw`(?:deliver(?:s|ed)?|closes?|closed|fix(?:es|ed)?|resolves?|resolved|implements?|implemented|lands?|landed)`;
// A contracted negation is `<word>n't` ("doesn't", "won't", "can't"), with a straight or typographic apostrophe, or
// the same with no apostrophe at all ("doesnt"). The standalone "n't" this once held could never match: its leading
// \b has no boundary inside a word (PR #4323 review: "doesn't fix #N" was credited).
const NEGATING_WORD_RE = /\b(?:not|never|without|cannot|\w+n['’ʼ`]t|(?:do|does|did|is|are|was|were|has|have|had|wo|ca|sha|could|would|should|must|need)nt|unable|fail(?:s|ed|ure)?|attempt(?:s|ed|ing)?|try|tries|tried|to|will|would|should|may|might|could|revert(?:s|ed)?|no longer)\b/i;
// Words right after the id that make it a partial delivery ("fixes #N, part of ...").
const PARTIAL_AFTER_RE = /^[\s,;:()-]*(?:in part\b|part\b|partial|partly|first step|step \d|slice\b|phase\b|groundwork|scaffold)/i;
// A bare (no "#") id form is only trusted for something shaped like a birth hash: card text is untrusted, and a
// bornAs of "the" must not let any "fixes the ..." credit it.
const BARE_ID_RE = /^[a-z0-9]{6,}$/i;
const idForm = (id) => (/^\d+$/.test(id) || !BARE_ID_RE.test(id) ? `#${escapeRegExp(id)}` : `#?${escapeRegExp(id)}`);

/** PURE. Does `text` name one of `ids` as a card reference? A numeric id counts only in its `#<id>` shape (a bare
 *  "4560" is as likely "4560 ms"); a birth hash counts as a whole word, with or without the `#`; any other
 *  untrusted-shaped id needs the `#`. Every id is regex-escaped. */
export function textNamesItem(text, ids) {
  const body = String(text ?? '');
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim()).filter(Boolean);
  return list.some((id) => new RegExp(`(?<![\\w/])${idForm(id)}(?![\\w])`).test(body));
}

/** PURE. Prepare-mode credit (2026-10-07, #4560): a commit that delivers a card often says so in prose, not in
 *  the strict `WE #<id>:` lead shape - "WE #4554: ... (also delivers xak56ki)" delivered card xak56ki and names
 *  it without a `#`. PR #4323 review (security + correctness): the first cut of this bar (an id ANYWHERE plus a
 *  delivery verb ANYWHERE) reopened the hole PR #2967 closed - "fixes retry loop (see #4560, follow-up)" credited
 *  #4560 - because the verb and the id were two unrelated tokens. The verb and the id must now be ONE phrase:
 *   - the strict subject shapes {@link commitDeliversItem} accepts (lead tag `WE #<id>:`, trailing `(#<hash>)`), or
 *   - a delivery verb IMMEDIATELY followed by the id ("also delivers xak56ki", "resolves card #4560"), with no
 *     negating/modal/infinitive/revert word earlier in the same clause ("does not fix", "unable to fix", "will
 *     fix", "Revert fixes") and no partial wording right after it ("fixes #N, part of ..."). A NUMERIC id is
 *     accepted this way on the subject line only (numbers overlap PR and issue numbers: "Fixes #4560" in a body
 *     usually names a PR); a birth hash may also appear in a body line.
 *  A partial-delivery marker on the subject, or on the line holding the phrase, refuses it. The other checks (real
 *  ancestor of origin/main, non-backlog files touched, tests the commit added or that name the card) and the test
 *  run still apply. */
export function commitCreditsItem(message, ids) {
  const text = String(message ?? '');
  const lines = text.split(/\r?\n/);
  const subject = (lines[0] ?? '').trim();
  if (!subject || PARTIAL_DELIVERY_RE.test(subject) || /^revert\b/i.test(subject)) return false;
  if (commitDeliversItem(text, ids)) return true;
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id ?? '').trim()).filter(Boolean);
  return list.some((id) => {
    const numeric = /^\d+$/.test(id);
    const re = new RegExp(`(?<![\\w/])${CREDIT_VERB}\\s+(?:(?:card|item)\\s+)?(${idForm(id)})(?![\\w])`, 'gi');
    return lines.some((line, i) => {
      if (numeric && i > 0) return false;
      if (PARTIAL_DELIVERY_RE.test(line)) return false;
      for (const m of line.matchAll(re)) {
        const clause = line.slice(0, m.index).split(/[;.:()]/).pop().slice(-80);
        if (NEGATING_WORD_RE.test(clause)) continue;
        if (PARTIAL_AFTER_RE.test(line.slice(m.index + m[0].length))) continue;
        return true;
      }
      return false;
    });
  });
}

/** PURE. The test files a commit touched, from `git show --name-only` text (deleted files cannot be told apart
 *  here, so the caller keeps only those that still exist in the lane). */
export function commitTestFiles(files) {
  const list = Array.isArray(files) ? files : String(files ?? '').split('\n');
  return list.map((f) => f.trim()).filter((f) => /\.(?:test|spec)\.(?:m?[jt]sx?|cjs)$/.test(f));
}

/** PURE. Extract a card's `bornAs:` hash from its frontmatter text, or `null` if absent/unparseable. */
export function extractBornAs(cardText) {
  const m = /^bornAs:\s*(\S+)/m.exec(String(cardText ?? ''));
  return m ? m[1] : null;
}

/** PURE. Does this commit's OWN changed-file list include at least one path outside `backlog/`? #4465 review
 *  round 3 (live security finding): naming THIS card in a commit message is a weak bar on its own — a purely
 *  mechanical, bookkeeping commit ("backlog: file #4380", a drain resolve-splice, a JIT-numbering commit)
 *  also names the card without ever implementing its spec, so `commitReferencesItem` passing alone is not
 *  enough to trust "this commit already lands the spec". Every genuine implementation commit in this repo's
 *  own convention touches real source alongside (or instead of) the card file; a commit whose ENTIRE change
 *  is under `backlog/` is exactly the shape a pure filing/resolve/JIT-number commit has and an implementation
 *  commit does not. `files` is the commit's own changed-path list (`git show --name-only`, one per line) —
 *  injected as plain text/array so this needs no disk access to test. */
export function commitTouchesNonBacklogFile(files) {
  const list = Array.isArray(files) ? files : String(files ?? '').split('\n');
  return list.map((f) => f.trim()).filter(Boolean).some((f) => !f.startsWith('backlog/'));
}

export const MAX_REASON_CHARS = 500;

/** PURE. Neutralize an agent-supplied hold `reason` before it is written into an AUTO-MERGED card body or PR
 *  body — #4465 PR #2967 review (security finding): it was written verbatim (only `\n` quoted), so a steered
 *  agent could plant headings, fences, HTML comments or instructions aimed at the next prepare agent, with no
 *  length cap. Collapses every control character and line break (`\r`, `\n`, tabs, …) to one space, so the
 *  text stays ONE quoted line that cannot open a heading, list or new block; turns backticks into `'` so no
 *  code fence or inline code can open; escapes `<`/`>` so no HTML comment or tag can open; and caps the
 *  result at {@link MAX_REASON_CHARS}. Strip local absolute paths and qualify remaining code references
 *  with the same detector the standards gate uses before applying the length cap. */
export function sanitizeHoldReason(reason, { max = MAX_REASON_CHARS } = {}) {
  let flat = String(reason ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/(?<![\w:/])(?:[A-Za-z]:[\\/]|\/(?!\/))[^\s`'"<>)]*/g, '[local path]')
    .replace(/`/g, "'")
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\s+/g, ' ')
    .trim();
  for (const ref of findUnmarkedLocusRefs(flat).sort((a, b) => b.length - a.length)) {
    const escaped = escapeRegExp(ref);
    flat = flat.replace(new RegExp(`(?<![\\w./@-])(?<!(?:we|fui|plateau|webeverything|frontierui|plateau-app):)${escaped}(?![\\w./-])`, 'g'), `we:${ref}`);
  }
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A frontmatter `scope:` key and every indented continuation line under it — covers the inline form
// (`scope: [a, b]`), a bracket list wrapped over several lines, AND a YAML block list (`scope:\n  - a\n  - b`).
const SCOPE_KEY_RE = /^scope:[^\n]*(?:\n[ \t]+[^\n]*)*/m;

/** PURE. Clear a card's `scope:` (making it "unshaped" for dispatch-plan's own existing auto-prepare) and
 *  append the routing agent's finding as a new section — text in, text out, no IO. Only the FRONTMATTER's own
 *  `scope:` key is touched, in any of its list shapes (#4465 PR #2967 review: an earlier revision matched only
 *  the inline `scope: [..]` form, so a YAML block-list scope was left in place while the finding claimed the
 *  card was routed to prepare). */
export function clearScopeAndAppendFinding(cardText, { num, reason, today = localToday() } = {}) {
  const text = String(cardText ?? '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---(?=\n|$)/.exec(text);
  // No frontmatter → no `scope:` to clear, and the finding below would falsely claim it was: refuse (landOne
  // turns the throw into a `failed` result, so nothing lands).
  if (!fm) throw new Error(`clearScopeAndAppendFinding: card #${num} has no frontmatter — cannot clear its scope`);
  const standalone = /^worker-declined(?:\s*:|$)/.test(String(reason ?? ''));
  // Standalone declines remove the key: check:standards forbids an empty scope array.
  const builder = /^worker-declined: scope exceeds the [\w-]+ envelope — route to the builder/.test(String(reason ?? ''));
  const cleared = builder ? text : `---\n${fm[1].replace(SCOPE_KEY_RE, standalone ? '' : 'scope: []').trimEnd()}\n---${text.slice(fm[0].length)}`;
  const quoted = sanitizeHoldReason(reason, { max: standalone ? 620 : MAX_REASON_CHARS }) || '(no reason recorded)';
  // Advisory only: prepare must verify these references before setting blockedBy.
  const blockers = standalone ? [...new Set([...String(reason).matchAll(
    /#(\d+)\b[^.!?\n#]{0,160}\b(?:incomplete|unfinished|blocked|not (?:done|complete)|required|prerequisite)\b/gi,
  ), ...String(reason).matchAll(/\b(?:blocked by|depends on|requires|waiting (?:for|on)|required|prerequisite)\s+#(\d+)\b/gi)]
    .map((m) => m[1]).filter((id) => id !== String(num)))] : [];
  const section = [
    '',
    standalone ? `## Findings (standalone worker, ${today})` : `## Held finding — auto-routed by #4465 (${today})`,
    '',
    `The build-dispatch daemon held #${num} with:`,
    '',
    `> ${quoted}`,
    ...blockers.flatMap((id) => ['', `possible blocker: #${id}`]),
    '',
    ...(builder ? ['Implementation changes were discarded. The card is held for the builder; its declared scope is preserved.'] : [
      "`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;",
      'a prepare pass re-scopes it against the finding.',
    ]),
    '',
  ].join('\n');
  return `${cleared.replace(/\n+$/, '')}\n${section}`;
}

// ── IO shell ─────────────────────────────────────────────────────────────────────────────────────────────────

export function runCmd(cmd, args, cwd, { timeoutMs = resolveChildTimeoutMs() } = {}) {
  return execFileSync(cmd, args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL',
  });
}

export function acquireLane(runFn = runCmd) {
  return JSON.parse(runFn('node', [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'acquire', '--purpose=build-dispatch-hold-route', '--json'], REPO_ROOT, { timeoutMs: resolveLaneAcquireTimeoutMs() }));
}

export function releaseLane(acq, runFn = runCmd) {
  return runFn('node', [join(REPO_ROOT, 'scripts', 'lane-pool.mjs'), 'release', `--lane=${acq.lane}`, `--session=${acq.holder}`], REPO_ROOT);
}

export function parseOpenPrResult(out) {
  try {
    const parsed = JSON.parse(out);
    const effects = parsed?.findings?.submit?.effects;
    const applied = Array.isArray(effects) ? effects.find((e) => e?.type === 'open-pr.submit' && e?.status === 'applied') : null;
    const result = applied?.result;
    return { pr: result?.pr ?? null, url: result?.url ?? null };
  } catch { return { pr: null, url: null }; }
}

function renderPrBody({ num, route, commit, reason }) {
  const lines = [
    '## Build-dispatch hold, auto-routed (#4465)', '',
    `Card #${num} was held by the build-dispatch daemon; this PR is the router's own routed fix, landed`,
    'mechanically — no agent turn, no judgment beyond the classification already recorded on the card.', '',
  ];
  if (route === 'already-done') {
    lines.push(`Route: **already-done**. Resolved with \`graduatedTo=${commit}\` — the cited commit already`, 'lands the spec.', '');
  } else {
    lines.push('Route: **out-of-scope / superseded**. `scope:` cleared and the agent\'s finding appended to', 'the card body so the existing unshaped-item auto-prepare path re-scopes it.', '');
  }
  lines.push('Original hold reason:', '', `> ${sanitizeHoldReason(reason)}`, '');
  return lines.join('\n');
}

/**
 * Land ONE routed item. Every effect goes through `runFn`/`acquireFn`/`releaseFn` (defaults above) so a test
 * can substitute recording fakes and assert every `(cmd, args, cwd)` triple used the LANE path, never
 * `REPO_ROOT`/the daemon clone's own cwd (beyond the two lane-pool calls, legitimately run from `REPO_ROOT` —
 * acquiring/releasing a lane is the pool's own bookkeeping, not "editing the daemon clone").
 * @returns {{status:'landed'|'failed', pr?, prUrl?, error?}}
 */
export function landOne({ num, route, commit = null, reason = null, citation = 'strict' }, {
  runFn = runCmd, acquireFn = acquireLane, releaseFn = releaseLane,
  readFile = readFileSync, writeFile = writeFileSync, listCardNames = (lane) => readdirSync(join(lane, 'backlog')),
  existsFile = (p) => existsSync(p),
} = {}) {
  if (route !== 'already-done' && route !== 'out-of-scope') {
    return { status: 'failed', error: `landOne: unroutable route '${route}' — only 'already-done'/'out-of-scope' land here` };
  }
  // PR #2967 review — `num` names a git ref, a card filename prefix and a commit subject below; refuse anything
  // that is not a real card id before any of them is built from it.
  if (!isValidHoldNum(normNum(num))) {
    return { status: 'failed', error: `landOne: '${String(num).slice(0, 40)}' is not a card id — refusing to route it` };
  }
  let acq = null;
  try {
    acq = acquireFn(runFn);
    const lane = acq.path;
    let msg;
    if (route === 'already-done') {
      if (!commit) throw new Error('landOne: already-done route requires a cited commit');
      // Never trust the build agent's free-text citation blind — it is untrusted input (an agent can
      // hallucinate a sha, or be steered by prompt-injected card content). Refresh this lane's view of main,
      // then run THREE independent checks, ALL required:
      //  (1) the cited commit is a REAL ancestor of `origin/main` — `merge-base --is-ancestor` fails on BOTH
      //      an unknown/hallucinated sha and a real sha that never reached main (e.g. a throwaway branch);
      //  (2) #4465 review round 2 (live security finding) — ancestry ALONE is not enough: a real, unrelated
      //      old commit on main is also a valid ancestor, so (1) alone would let an agent close an unbuilt
      //      card as done by citing any real sha at all. Require the commit's OWN message to reference THIS
      //      card (`commitReferencesItem`, above) — this repo's own commit convention already names the card
      //      on every commit ("WE #4465: ...", "backlog: resolve #4464"), so a commit that genuinely lands
      //      this spec passes for free, and an unrelated-but-real ancestor almost never does;
      //  (3) #4465 review round 3 (live security finding) — (2) ALONE is still not enough: a purely
      //      mechanical bookkeeping commit ("backlog: file #4380", a drain resolve-splice, a JIT-numbering
      //      commit) also names the card without ever implementing its spec. Require the commit to touch at
      //      least one file OUTSIDE `backlog/` (`commitTouchesNonBacklogFile`, above) — every genuine
      //      implementation commit in this repo's convention touches real source, a pure card-bookkeeping
      //      commit never does.
      // A failure on ANY check refuses the auto-resolve entirely — no partial edit, no PR — rather than
      // closing an unbuilt card as done on an unverified claim.
      retryTransientGit(() => runFn('git', ['fetch', 'origin', 'main'], lane));
      try {
        runFn('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], lane);
      } catch {
        throw new Error(`landOne: cited commit ${commit} is not a verified ancestor of origin/main — refusing to auto-resolve on an unverified citation`);
      }
      const commitMessage = runFn('git', ['log', '-1', '--format=%B', commit], lane);
      // Best-effort: the bornAs lookup is a BONUS second candidate id, never a reason to fail the whole check
      // if the card can't be read for some unrelated reason — the primary `#<num>` match still applies.
      let bornAs = null;
      let deliveredCard = null;
      try {
        const cardFileForBornAs = findCardFileName(listCardNames(lane), num);
        if (cardFileForBornAs) {
          const raw = readFile(join(lane, 'backlog', cardFileForBornAs), 'utf8');
          bornAs = extractBornAs(raw);
          deliveredCard = { title: /^#\s+(.+)$/m.exec(raw)?.[1], raw };
        }
      } catch { /* best-effort — fall through with bornAs: null */ }
      const prepareCitation = citation === 'prepare';
      if (!prepareCitation && !commitReferencesItem(commitMessage, [num, bornAs])) {
        throw new Error(`landOne: cited commit ${commit} is on main but its own message never references #${num}${bornAs ? ` or #${bornAs}` : ''} — refusing to auto-resolve on an unrelated-but-real citation`);
      }
      const commitFiles = runFn('git', ['show', '--name-only', '--format=', commit], lane);
      if (!commitTouchesNonBacklogFile(commitFiles)) {
        throw new Error(`landOne: cited commit ${commit} references #${num} but touches only backlog/ files — refusing to auto-resolve on a bookkeeping-only citation`);
      }
      //  (4) PR #2967 review (security finding) — a mention is not a delivery: the SUBJECT must name this card
      //      as what the commit delivers, with no partial-delivery marker (`commitDeliversItem`, above), or a
      //      "see #N" / "follow-up to #N" / "WE #N: part 1" commit would close a card whose spec is unbuilt.
      if (prepareCitation) {
        // A prepare worker's "already done" is checked independently, never taken on its word: the message must
        // credit THIS card (either id), and the tests the commit touched must pass on current main.
        if (!commitCreditsItem(commitMessage, [num, bornAs])) {
          throw new Error(`landOne: cited commit ${commit} does not credit #${num}${bornAs ? ` or ${bornAs}` : ''} as delivered (no id with a delivery verb, or a partial subject) — refusing to auto-resolve`);
        }
        // The tests that prove the delivery are the ones the commit ADDED (`--diff-filter=A`), or a test file it
        // only modified that itself names this card: a commit that merely touched some unrelated passing test
        // proves nothing about THIS card (PR #4323 review).
        const addedFiles = runFn('git', ['show', '--diff-filter=A', '--name-only', '--format=', commit], lane);
        // "Names the card" is judged on the lines THIS commit added to the file (not the file's current text, where
        // any old "#NNNN" comment would satisfy it).
        const addedLinesNameCard = (f) => {
          try {
            const diff = runFn('git', ['show', '--format=', '-U0', commit, '--', f], lane);
            const added = String(diff).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
            return textNamesItem(added, [num, bornAs]);
          } catch { return false; }
        };
        // A path that could be read as an option is never handed to vitest.
        const testFiles = [...new Set([...commitTestFiles(addedFiles), ...commitTestFiles(commitFiles).filter(addedLinesNameCard)])]
          .filter((f) => !f.startsWith('-') && existsFile(join(lane, f)));
        if (!testFiles.length) {
          throw new Error(`landOne: cited commit ${commit} touches no test file that still exists and was added by it or names the card - nothing to prove the delivery - refusing to auto-resolve`);
        }
        try {
          runFn('node', [join(lane, 'scripts', 'readiness', 'heavy-admission.mjs'), 'run', '--', 'npx', 'vitest', 'run', ...testFiles], lane, { timeoutMs: VERIFY_TIMEOUT_MS });
        } catch (e) {
          throw new Error(`landOne: the tests cited commit ${commit} added fail on current main (${testFiles.length} file(s)) - refusing to auto-resolve: ${String(e?.stderr || e?.stdout || e?.message || e).trim().split('\n')[0].slice(0, 160)}`);
        }
      } else if (!commitDeliversItem(commitMessage, [num, bornAs])) {
        throw new Error(`landOne: cited commit ${commit} mentions #${num} but its subject does not deliver it (a related, follow-up or partial commit) — refusing to auto-resolve`);
      }
      runFn('node', [join(lane, 'scripts', 'backlog.mjs'), 'resolve', String(num), `--graduated-to=${commit}`], lane);
      msg = `${machinePrTitle({ item: num, kind: 'auto-resolve', card: deliveredCard, subject: commitMessage.split('\n')[0].replace(/^[^:]+: /, '') })}\n\nRouted by #4465's hold router; no agent turn.\n`;
    } else {
      const cardFile = findCardFileName(listCardNames(lane), num);
      if (!cardFile) throw new Error(`landOne: no backlog card found for #${num}`);
      const cardPath = join(lane, 'backlog', cardFile);
      const text = readFile(cardPath, 'utf8');
      writeFile(cardPath, clearScopeAndAppendFinding(text, { num, reason }));
      msg = `${machinePrTitle({ item: num, kind: 'auto-route', card: { title: /^#\s+(.+)$/m.exec(text)?.[1] }, subject: reason || cardFile.replace(/-/g, ' ') })}\n\nRouted by #4465's hold router; scope cleared for auto-prepare, finding attached to the card.\n`;
    }
    runFn('git', ['add', '--', 'backlog'], lane);
    runFn('git', ['commit', '-m', msg], lane);
    const ref = refFor(num);
    runFn('git', ['push', '--force', 'origin', `HEAD:refs/heads/${ref}`], lane);
    runFn('node', [join(lane, 'scripts', 'operations', 'run.mjs'), 'verify', `--checkout=${lane}`], lane, { timeoutMs: VERIFY_TIMEOUT_MS });
    const bodyFile = join(lane, '.git', 'hold-route-body.md');
    writeFile(bodyFile, renderPrBody({ num, route, commit, reason }));
    const out = runFn('node', [
      join(lane, 'scripts', 'operations', 'run.mjs'), 'open-pr',
      `--ref=${ref}`, '--sha=HEAD', '--base=main', `--bodyFile=${bodyFile}`, '--mode=label-on-green', '--json',
    ], lane, { timeoutMs: OPEN_PR_TIMEOUT_MS });
    const { pr, url } = parseOpenPrResult(out);
    return { status: 'landed', pr, prUrl: url };
  } catch (e) {
    return { status: 'failed', error: String(e?.stderr || e?.message || e).trim().split('\n')[0] };
  } finally {
    if (acq) { try { releaseFn(acq, runFn); } catch { /* the lease reaper reclaims it once unpaused */ } }
  }
}

/** The full routed landing — this is the entry point run inside the DETACHED process
 *  we:skills-src/conveyor/build-dispatch-daemon.mjs#cliSpawnHoldLand starts, so its own outcome (landed OR
 *  failed) is invisible to the daemon's own tick; there is no run-store/settle channel back to it the way
 *  we:scripts/operations/deliver-item-settle.mjs gives the `build` dispatch path. Deliberately does NOT
 *  release the build-dispatch hold or the router's own dedup lease, on EITHER outcome:
 *   - `landOne` reaching `'landed'` means only that the PR OPENED, not that it merged, so the card edit is
 *     not yet on main — releasing either would let the very next tick dispatch a fresh build agent onto a
 *     card whose scope/status has not actually changed yet.
 *   - a `'failed'` result (the citation checks refused it, no card file found, `verify` failed, …) is a
 *     KNOWN, ACCEPTED MVP GAP (#4465 review round 3), not a retried case: with no feedback channel to the
 *     daemon, nothing here can trigger a prompt retry — the item simply rides out the lease TTL and then the
 *     (shorter) hold TTL, falling back to ordinary build dispatch. Only a spawn that never even STARTS (the
 *     detached process itself failing to launch) is retried promptly, one level up in
 *     we:scripts/conveyor/build-dispatch-hold-router.mjs#routeHeldItems, which DOES observe that failure and
 *     releases the lease for it — see that function's own docblock.
 *  Both leases self-expire on their own TTL either way
 *  (`we:scripts/conveyor/build-dispatch-hold-router.mjs#DEFAULT_ROUTE_LEASE_MINUTES` and
 *  `we:scripts/conveyor/build-dispatch-claim.mjs#DEFAULT_BUILD_DISPATCH_HOLD_MINUTES`). Named separately from
 *  `landOne` (even though it is currently a plain passthrough) as the stable "this is the routed-landing
 *  entry point" name `main()` and every test call through, independent of `landOne`'s own internal shape. */
export function landRoute(args, deps = {}) {
  return landOne(args, deps);
}

function parseFlags(argv) {
  const f = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const i = a.indexOf('=');
    f[i === -1 ? a.slice(2) : a.slice(2, i)] = i === -1 ? true : a.slice(i + 1);
  }
  return f;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags.num || !flags.route) {
    process.stderr.write('usage: build-dispatch-hold-route-land.mjs --num=<n> --route=<already-done|out-of-scope> [--commit=<sha>] [--reason=<text>] [--json]\n');
    process.exitCode = 2;
    return;
  }
  const result = landRoute({ num: String(flags.num), route: String(flags.route), commit: flags.commit ? String(flags.commit) : null, reason: flags.reason ? String(flags.reason) : null });
  // No `process.exit` after this write — nothing else runs after `main()` returns, so `process.exitCode` alone
  // ends the process with this output fully drained (never truncated, unlike an explicit `exit()` right after
  // a write — we:scripts/lib/write-all-sync.mjs's own header on this exact footgun).
  if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(`${result.status}${result.pr ? ` PR #${result.pr}` : ''}${result.error ? ` — ${result.error}` : ''}\n`);
  process.exitCode = result.status === 'landed' ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
