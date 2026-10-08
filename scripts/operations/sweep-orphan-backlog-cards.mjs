#!/usr/bin/env node
/**
 * @file scripts/operations/sweep-orphan-backlog-cards.mjs
 * @description #4317 FOLLOW-UP — THE SANCTIONED SWEEP for the BACKLOG of orphans #4317's own fix left behind.
 *   `we:scripts/operations/land-prevention-card.mjs` (that fix) stops the CLASS of failure going forward: a
 *   NEW approval-time prevention card now lands through a real lane, never straight into a daemon clone. It
 *   never touched the EXISTING orphans the pre-fix code path had already written — untracked `backlog/x*.md`
 *   cards sitting in a daemon clone's own working tree, invisible to a rebuild's dirty check by design
 *   (`we:scripts/lib/daemon-rebuild.mjs`), never landing on their own. Live 2026-09-29: 73 in
 *   `wev-review-daemon`, 0 in `wev-control`.
 *
 * WHY A SWEEP, NOT A HAND FIX (#1826/operator rule — failures improve the product, never manual intervention):
 *   hand-copying 73 files one at a time is exactly the "manual step" this repo's own doctrine refuses as a
 *   default. This is the DECLARED, RE-RUNNABLE tool the next daemon clone (or the next bug that writes into
 *   one) can be pointed at again — `we:scripts/conveyor/health-smells/untracked-backlog-card.mjs` already
 *   flags the condition this sweep clears.
 *
 * WHAT IT DOES, READ-ONLY ON THE CLONE, IN ORDER (mirrors `land-prevention-card.mjs`'s own acquire → commit →
 *   verify → open-pr → release sequence, but for a BATCH of already-written cards rather than one freshly
 *   filed one):
 *   1. `git status --porcelain --untracked-files=all -- backlog` on `--clone=<path>` — READ ONLY, never `add`,
 *      never `git -C <clone> ...` writes. The clone's own copies are left exactly as found; see the file's own
 *      `KNOWN RESIDUAL` note below for what removes them.
 *   2. Reads each orphan's content directly ({@link parseOrphanCard}) — no `fs` write into the clone at any
 *      point.
 *   3. DEDUPE ({@link selectOrphanSurvivors}), against two things:
 *        - `origin/main`'s own backlog (freshly fetched, read in THIS repo, never wherever the process
 *          started): an orphan whose `bornAs:` id — or, for a card with no such landed twin, whose source PR
 *          AND guard lines — already has a card on `main` is DROPPED; its debt is already tracked, landing it
 *          again would double it. A main card for the same PR with a DIFFERENT guard drops nothing.
 *        - An untracked card that is not a mechanically-filed prevention card, or is not a regular file (a
 *          symlink is never read through), is never landed.
 *        - EVERY OTHER ORPHAN in this same sweep: two orphans citing the SAME source PR AND the SAME guard
 *          text are the same debt filed twice (a marker-post race, #4317's own `xxe5jvs` residual) — the
 *          second is DROPPED. Two orphans citing the same PR with GENUINELY DIFFERENT guards are kept BOTH —
 *          same PR, different debt, never collapsed.
 *   4. The survivors are copied — byte-for-byte, filename unchanged (still `x<hash>-*.md`; JIT-numbering
 *      (`we:scripts/lane-drain.mjs`) assigns the real `bornAs`-carrying number at land, exactly as it does for
 *      any other hash-id card) — into ONE lane (`lane-pool.mjs acquire`) and `git add`ed.
 *   5. CONTENT VALIDATION ({@link findContentInvalidSurvivors}) — a LIVE-CAUGHT defect, not a hypothetical:
 *      the 2026-09-29 live run hit orphan `x3hxr6i` (PR #2872), whose reviewer-authored guard text *described*
 *      `[[memory-link]]` syntax and so *contained* it, tripping `check-standards.mjs`'s wiki-link rule (that
 *      finding carries no `descriptor.file` at all — a path-less, message-only finding — so it can NEVER be
 *      caught by scoping to `--files=`/`--local`; `verify-lane-gate.mjs`'s own header says exactly this is why a
 *      backlog-touching lane's check:standards half stays UNSCOPED). Landing 50 good cards in the same commit
 *      as one that fails the write-time gate would fail ALL of them, so this step runs the LANE's own
 *      unscoped `check-standards.mjs --json` (matching the real gate's own backlog-touching behaviour) BEFORE
 *      the commit, attributes each error to a survivor by its hash id appearing in the error's own message text
 *      (the same id check-standards' own backlog-item errors always name), unstages + drops any survivor an
 *      error implicates, and loops (bounded) until the remaining set is clean — never silently mutating a
 *      dropped card's content, never landing it either. A dropped-for-content card needs a human's eyes on the
 *      original guard text; this sweep leaves it exactly as found in the clone for the next run to re-attempt
 *      once it is fixed (by hand, or by a follow-up product fix to the write-time rule / the filer's own
 *      bounding pass — see the report this run's caller writes up).
 *   6. The surviving batch is committed as ONE commit, then the lane's OWN `run.mjs verify --mode=run` gate
 *      runs for real (see `land-prevention-card.mjs`'s header for why every operation call below runs the
 *      ACQUIRED LANE's `run.mjs`, never this script's own).
 *   7. Best-effort, non-blocking: each landed survivor is cleared for the conveyor
 *      ({@link queueLandedSurvivors}) exactly as `file-item` would at ordinary filing time — the conveyor
 *      queue is a machine-local, gitignored sidecar (`we:scripts/conveyor/queue-store.mjs`), never part of the
 *      commit, so a card this sweep lands is not merely landed but also pickable up by the conveyor.
 *   8. The lane's OWN `run.mjs open-pr --mode=label-on-green` opens ONE PR for every survivor. The resident
 *      drain daemon lands it; this script never merges.
 *   9. The lane is released on every exit path (`finally`), same reasoning as `land-prevention-card.mjs`.
 *
 * KNOWN RESIDUAL, FILED NOT SILENT: this sweep is explicitly forbidden from writing to or deleting from the
 *   daemon clone (`--clone=<path>` is read-only in, never in). Its landed cards are copies — the clone's own
 *   originals become harmless untracked leftovers once their content is on `main` (the dedupe in step 3 will
 *   then drop them on any RE-RUN of this sweep, by the `bornAs:` match). There is currently NO sanctioned
 *   cleanup that removes them from the clone itself; the report this tool's caller writes up proposes one
 *   (a daemon-rebuild-time prune of untracked `backlog/x*.md` whose id is already `bornAs:` on `main`) rather
 *   than this file reaching into the clone to delete them.
 *
 * Usage:
 *   node scripts/operations/sweep-orphan-backlog-cards.mjs --clone=<path to a daemon clone> [--session=<slug>]
 *     [--dry-run=true]
 */
import { execFileSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  basename, dirname, join, resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractSubmitResult } from './open-pr.mjs';
import { parseRunJsonTail } from './land-prevention-card.mjs';
import { readField } from '../backlog/frontmatter.mjs';
import { NON_DISPATCHABLE_KINDS } from './file-item.mjs';
import {
  readQueueFile, writeQueueFile, addToQueue, queueHas, resolveQueuePath,
} from '../conveyor/queue-store.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
export const REPO_ROOT = resolve(HERE, '..', '..');
// Same reasoning as `land-prevention-card.mjs#LANE_POOL_CLI`: THIS checkout's own copy, resolved by script
// location — `lane-pool.mjs` resolves its pool root from `cwd`, never script location, so running it with
// `cwd: REPO_ROOT` against a real, `origin`-bearing checkout is correct even when THIS script itself happens
// to be invoked from a daemon clone's copy of the same file.
export const LANE_POOL_CLI = join(REPO_ROOT, 'scripts', 'lane-pool.mjs');

export const ACQUIRE_TIMEOUT_MS = 3 * 60_000;
export const VERIFY_TIMEOUT_MS = 70 * 60_000;
export const OPEN_PR_TIMEOUT_MS = 45 * 60_000;

/** An untracked backlog card `git status --porcelain --untracked-files=all` reports — the SAME shape
 *  `we:scripts/conveyor/health-watch.mjs#probeUntrackedBacklogCards` already matches (a provisional hash id,
 *  never a numbered card — a numbered card is never untracked by construction, `check-backlog-item.mjs`). */
const ORPHAN_LINE_RE = /^\?\?\s+(backlog\/(x[0-9a-z]{6})-[^/]*\.md)$/;

/** Both card shapes this sweep has actually found carry this exact title — the #4317 approval-time filer
 *  and its #2749 unattended-review-loop sibling both build it from the same `${repo}#${pr}` pair
 *  (`we:scripts/lib/approval-prevention-notice.mjs#buildApprovalPreventionFilingInput`,
 *  `we:scripts/lib/review-loop-policy.mjs#buildPreventionFilingInput`) — so the title alone is a reliable
 *  source-PR extractor across both, with no dependency on either builder's own digest shape. */
const TITLE_SOURCE_RE = /^# File the prevention guard\(s\) owed by (\S+?)'s independent review\s*$/m;
/** The #4317 approval-time shape's own idempotency key line — read FIRST when present (it pins the exact head
 *  the card was filed for, not just the PR), title-derived `TITLE_SOURCE_RE` is the fallback every other
 *  shape (the #2749 loop's own cards carry no such key) still has. */
const IDEMPOTENCY_KEY_RE = /approval-prevention-key:([^@\s]+)@/;
/** `git grep`'s own basic-regex reading of the same title (always run with an explicit `-G`, so a user's
 *  `grep.extendedRegexp` config can never turn `(s)` into a group), scoped so a hand-typed card that merely
 *  CONTAINS this phrase mid-sentence is never mistaken for the mechanically-filed title line itself. */
const MAIN_GREP_PATTERN = '^# File the prevention guard(s) owed by';
/** One numbered guard line of the card body (`1. \`we:...\` — ...`) — the card's actual debt. */
const GUARD_LINE_RE = /^\d+\.\s+\S.*$/gm;

/**
 * PURE. Shape one card's raw text into the facts {@link selectOrphanSurvivors} dedupes on.
 * `digestHash` covers the numbered GUARD LINES only — never the frontmatter (`dateOpened`, `scope`, a landed
 * card's `bornAs`), the intro paragraph (the #2749 loop shape names its `reviewed head` sha there) or the
 * idempotency key (which pins a head) — so the same guard for the same PR hashes identically whatever day or
 * head it was filed at. The `## Acceptance` (or legacy `## Done when`) boilerplate is cut before the guard lines are read. A card with no
 * numbered guard line at all falls back to its whole body minus frontmatter.
 * @param {string} rel - `backlog/x......-*.md`, as `git status` reported it.
 * @param {string} content
 * @returns {{rel:string, hashId:(string|null), status:string, kind:string, sourceRef:(string|null),
 *   isPreventionCard:boolean, digestHash:string, content:string}}
 */
export function parseOrphanCard(rel, content) {
  const hashId = /^backlog\/(x[0-9a-z]{6})-/.exec(rel)?.[1] ?? null;
  const status = readField(content, 'status') ?? 'open';
  const kind = readField(content, 'kind') ?? '';
  const titleRef = TITLE_SOURCE_RE.exec(content)?.[1] ?? null;
  const sourceRef = IDEMPOTENCY_KEY_RE.exec(content)?.[1] ?? titleRef;
  const body = String(content)
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split(/\n##\s+(?:Done when|Acceptance)\b[\s\S]*$/)[0];
  const guards = body.match(GUARD_LINE_RE) ?? [];
  const digestBody = guards.length ? guards.map((g) => g.trim()).join('\n') : body.trim();
  const digestHash = createHash('sha256').update(digestBody).digest('hex');
  return { rel, hashId, status, kind, sourceRef, isPreventionCard: titleRef != null, digestHash, content };
}

/** PURE. The one dedupe identity — same source PR + same guard lines — shared by the orphan-vs-orphan pass
 *  and the orphan-vs-main pass, so the two can never disagree about what "the same debt" means. */
export function orphanDedupeKey(card) {
  return card.sourceRef ? `${card.sourceRef}::${card.digestHash}` : `content::${card.digestHash}`;
}

/**
 * PURE. Split parsed orphan cards into survivors (land these) and dropped (why each was dropped) — see the
 * file header's step 3 for the two dedupe passes. Deterministic: ties within a duplicate group always keep
 * the alphabetically-first `rel` (the lowest hash id sorts first), never input order, so re-running the sweep
 * on an unchanged clone always reaches the same verdict.
 * A card that is not a mechanically-filed prevention card (no {@link TITLE_SOURCE_RE} title) is never landed:
 * this sweep only knows those two shapes, and anything else untracked in a clone needs a human's eyes.
 * @param {ReturnType<typeof parseOrphanCard>[]} cards
 * @param {{mainBornAsIds?:Set<string>, mainGuardKeys?:Set<string>}} [mainSets] - `mainGuardKeys` holds
 *   {@link orphanDedupeKey} of every prevention card on main, so a main card for the same PR with a DIFFERENT
 *   guard never drops an orphan.
 * @returns {{survivors:Array, dropped:Array<{rel:string, reason:string, duplicateOf?:string}>}}
 */
export function selectOrphanSurvivors(cards, { mainBornAsIds = new Set(), mainGuardKeys = new Set() } = {}) {
  const dropped = [];
  const remaining = [];
  for (const c of cards) {
    if (!c.isPreventionCard) {
      dropped.push({ ...c, reason: 'not a mechanically-filed prevention card — left in the clone for a human' });
    } else if (c.hashId && mainBornAsIds.has(c.hashId)) {
      dropped.push({ ...c, reason: `already landed on origin/main (a card there carries bornAs: ${c.hashId})` });
    } else if (mainGuardKeys.has(orphanDedupeKey(c))) {
      dropped.push({ ...c, reason: `already landed on origin/main (a card already covers ${c.sourceRef} with the same guard)` });
    } else {
      remaining.push(c);
    }
  }
  const sorted = [...remaining].sort((a, b) => a.rel.localeCompare(b.rel));
  const seen = new Map();
  const survivors = [];
  for (const c of sorted) {
    const key = orphanDedupeKey(c);
    const first = seen.get(key);
    if (first) {
      dropped.push({ ...c, reason: `duplicate of ${first.rel} — same source + same guard`, duplicateOf: first.rel });
    } else {
      seen.set(key, c);
      survivors.push(c);
    }
  }
  return { survivors, dropped };
}

/**
 * READ-ONLY scan of `clone` for untracked backlog cards. `exec`/`readFile`/`lstat` injected — no real
 * subprocess or `fs` call in a test. NEVER runs `git add`/`git commit`/anything that mutates `clone`'s working
 * tree. Anything but a regular file (a planted symlink above all) is skipped unread: `readFile` follows
 * symlinks, and the bytes it returns would be committed and pushed to a PR.
 * @param {string} clone
 * @param {{exec:Function, readFile?:Function, lstat?:Function}} io
 * @returns {Array<{rel:string, content:string}>}
 */
export function listUntrackedBacklogCards(clone, {
  exec, readFile = (p) => readFileSync(p, 'utf8'), lstat = lstatSync,
} = {}) {
  const status = exec('git', ['-C', clone, 'status', '--porcelain', '--untracked-files=all', '--', 'backlog'], {});
  const lines = String(status || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const m = ORPHAN_LINE_RE.exec(line);
    if (!m) continue; // tracked/modified/deleted entries, and any non-hash-id backlog path, are out of scope
    const abs = join(clone, m[1]);
    const st = lstat(abs);
    if (st.isSymbolicLink() || !st.isFile()) continue;
    out.push({ rel: m[1], content: readFile(abs) });
  }
  return out;
}

/**
 * READ `ref`'s own backlog for the two dedupe sets `selectOrphanSurvivors` needs, in THIS repo (`cwd`, never
 * wherever the process happened to start). First refreshes an `origin/<branch>` ref and verifies it resolves,
 * so a stale or missing ref can never pass for "main has nothing". Then one `git grep` for `bornAs:` ids and
 * one `git grep -l` for prevention-card titles, whose few matches (~dozens, never the ~4k backlog) are each
 * read with `git show` to key them by PR + guard ({@link orphanDedupeKey}). `git grep` exits 1 with no output
 * on zero matches — the ONLY failure read as empty; any other (exit 128: bad ref, not a repo) is thrown.
 * @param {{exec:Function, ref?:string, cwd?:string}} io
 * @returns {{mainBornAsIds:Set<string>, mainGuardKeys:Set<string>}}
 */
export function readMainDedupeSets({ exec, ref = 'origin/main', cwd = REPO_ROOT }) {
  // Bounded and never interactive: a dry run fetches too, and a stuck fetch or a credential prompt must fail
  // the read (surfaced as `read-main`), never hang an unattended sweep.
  const git = (args) => exec('git', args, {
    cwd, timeout: ACQUIRE_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const remoteBranch = /^origin\/(.+)$/.exec(ref)?.[1];
  if (remoteBranch) git(['fetch', '--quiet', 'origin', remoteBranch]);
  git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const grep = (flags, pattern) => {
    try {
      return String(git(['grep', ...flags, '-G', '-e', pattern, ref, '--', 'backlog']));
    } catch (e) {
      if (e?.status === 1 && !String(e?.stderr ?? '').trim()) return '';
      throw e;
    }
  };
  const mainBornAsIds = new Set([...grep(['-h'], '^bornAs:').matchAll(/^bornAs:\s*(\S+)/gm)].map((m) => m[1]));
  const mainGuardKeys = new Set();
  // `-z`: NUL-separated, so `core.quotePath` can never hand `git show` a quoted name.
  for (const blob of grep(['-l', '-z'], MAIN_GREP_PATTERN).split(/[\0\n]/).map((l) => l.trim()).filter(Boolean)) {
    const rel = blob.slice(blob.indexOf(':') + 1);
    const card = parseOrphanCard(rel, String(git(['show', blob])));
    if (card.isPreventionCard) mainGuardKeys.add(orphanDedupeKey(card));
  }
  return { mainBornAsIds, mainGuardKeys };
}

/**
 * Best-effort, NEVER thrown out of the caller: clear every landed survivor for the conveyor exactly as
 * `file-item` would at ordinary filing time ({@link ../operations/file-item-io.mjs}) — the queue is a
 * machine-local sidecar (`we:scripts/conveyor/queue-store.mjs`), never part of the commit/PR, so this can run
 * regardless of whether the PR has merged yet, and re-running it is idempotent (`addToQueue`'s own contract).
 * Skips a card whose `kind` the conveyor can never dispatch (epic/decision) or that was born anything but
 * `open` — the same two refusals `file-item.mjs#planQueueing` already applies at ordinary filing time.
 * @param {Array<{hashId:(string|null), kind:string, status:string}>} survivors
 * @param {{read?:Function, writeQ?:Function, has?:Function, add?:Function, queuePath?:Function, now?:Function}} [io]
 * @returns {string[]} the hash ids actually queued (already-queued ids are skipped, not re-listed)
 */
export function queueLandedSurvivors(survivors, {
  read = readQueueFile,
  writeQ = writeQueueFile,
  has = queueHas,
  add = addToQueue,
  queuePath = resolveQueuePath,
  now = () => new Date().toISOString(),
} = {}) {
  const path = queuePath();
  let q = read(path);
  let changed = false;
  const queued = [];
  for (const s of survivors) {
    if (!s.hashId || NON_DISPATCHABLE_KINDS.includes(s.kind) || s.status !== 'open') continue;
    if (has(q, s.hashId)) continue;
    q = add(q, s.hashId, now());
    changed = true;
    queued.push(s.hashId);
  }
  if (changed) writeQ(q, path);
  return queued;
}

/**
 * PURE. Best-effort JSON parse of `check-standards.mjs --json`'s own stdout — a single `console.log(JSON
 * .stringify(...))`, so a plain `JSON.parse` normally suffices; this only guards the case a caller hands in
 * the raw text of a THROWN child-process error (whose `.stdout` is passed here, not re-derived), which is
 * still exactly that one JSON line. `null` on anything unparseable, never a throw — the caller decides what an
 * unreadable report means.
 * @param {string} text
 * @returns {object|null}
 */
export function parseCheckStandardsJson(text) {
  try { return JSON.parse(String(text ?? '')); } catch { return null; }
}

/**
 * PURE. Which of `survivors` does at least one `check-standards.mjs --json` error implicate? Matches by the
 * survivor's own hash id appearing in the error's `message` text — check-standards' backlog-item findings
 * always name the item by that id (`"Backlog item \"x3hxr6i-...\" uses..."`), and this specific finding class
 * carries NO `descriptor.file` at all (a path-less, message-only finding — see the file header's step 5), so
 * matching on the message is the ONLY attribution available, not a fallback from something more precise.
 * @param {Array<{message:string}>} errors
 * @param {Array<{rel:string, hashId:(string|null)}>} survivors
 * @returns {Array<{rel:string, hashId:(string|null), reason:string}>}
 */
export function findContentInvalidSurvivors(errors, survivors) {
  const bad = [];
  for (const s of survivors) {
    if (!s.hashId) continue;
    const hit = (Array.isArray(errors) ? errors : []).find((e) => String(e?.message ?? '').includes(s.hashId));
    if (hit) bad.push({ ...s, reason: `content itself fails check:standards, dropped (needs a human's eyes on the guard text) — ${hit.message}` });
  }
  return bad;
}

/** Bounded — a genuine cross-card cycle is not expected among independent prevention cards, but this can
 *  never spin forever even if one somehow existed. */
export const CONTENT_VALIDATION_MAX_ATTEMPTS = 5;

/** PURE. The ONE commit message for every survivor this sweep lands. Names the clone by its basename only —
 *  the absolute local path (home dir, username) never reaches git history. */
export function buildSweepCommitMessage(survivors, clone) {
  const rels = survivors.map((s) => s.rel).sort();
  const shown = rels.length <= 10 ? rels.join(', ') : `${rels.slice(0, 10).join(', ')}, … (+${rels.length - 10} more)`;
  return `Land ${survivors.length} orphaned backlog card(s) rescued from ${basename(clone)}\n\n`
    + 'Untracked backlog cards written straight into a daemon clone by the pre-#4317 filing path never landed '
    + '(we:scripts/conveyor/health-smells/untracked-backlog-card.mjs flags the condition). This sweep '
    + '(we:scripts/operations/sweep-orphan-backlog-cards.mjs) copies the survivors — after dropping ones '
    + `already on main or duplicating another orphan — into one lane and lands them as one PR:\n${shown}\n\n`
    + 'Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n';
}

/** PURE. The PR body for the same commit — names what was dropped and why, so a reviewer can spot-check the
 *  dedupe without re-deriving it. The clone is named by basename only, as in the commit message. */
export function buildSweepPrBody(survivors, dropped, clone) {
  const rels = survivors.map((s) => s.rel).sort();
  const shownDropped = dropped.slice(0, 20);
  const droppedLines = shownDropped.map((d) => `- \`${d.rel}\` — ${d.reason}`).join('\n');
  const more = dropped.length > shownDropped.length ? `\n… (+${dropped.length - shownDropped.length} more)` : '';
  return 'Mechanically landed by the orphan-backlog-card sweep (#4317 follow-up).\n\n'
    + `Source clone: \`${basename(clone)}\`\n\n`
    + `## Landed (${rels.length})\n${rels.map((r) => `- \`${r}\``).join('\n')}\n\n`
    + `## Dropped — duplicate, already on main, not a prevention card, or failed check:standards (${dropped.length})\n${droppedLines}${more}\n`;
}

/**
 * THE ORCHESTRATION, INJECTABLE FOR TESTS — mirrors `land-prevention-card.mjs#landPreventionCard`'s own shape:
 * `exec` stands in for every subprocess call, `write` for narration, `mkTmp`/`writeFile`/`rmTmp` for the ONE
 * scratch dir this run makes (commit message + PR body), removed on every exit path, and `rmFile` for unstaging
 * a single card the content-validation step (see the file header's step 5) drops from the batch.
 * `listOrphans`/`readMain`/`queueSurvivors` are the three additional seams this sweep needs beyond that file's
 * own (a read-only clone scan, a read-only `origin/main` dedupe read, and the best-effort conveyor queue-clear)
 * — each independently stubbable so a test never touches a real clone, a real `origin/main`, or the real
 * machine-wide queue sidecar.
 *
 * NEVER WRITES TO `input.clone`: every write in this function targets the ACQUIRED LANE, never the clone the
 * orphans were read from — see the file header's own invariant.
 *
 * A lane is acquired ONLY once there is at least one survivor to land (an empty or fully-deduped clone returns
 * `ok:true` having touched no lane at all) and is ALWAYS released once acquired, on every exit path, exactly
 * like `land-prevention-card.mjs`'s own `finally`.
 *
 * @param {{clone:string, session:string, dryRun?:boolean}} input
 * @returns {Promise<{ok:boolean, step:string, reason:(string|null), landed:string[],
 *   dropped:Array<{rel:string,reason:string}>, pr:(number|null), url:(string|null)}>}
 */
export async function sweepOrphanBacklogCards({ clone, session, dryRun = false }, {
  exec = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts })),
  write = (line) => process.stdout.write(line),
  listOrphans = listUntrackedBacklogCards,
  readMain = readMainDedupeSets,
  queueSurvivors = queueLandedSurvivors,
  mkTmp = () => mkdtempSync(join(tmpdir(), 'sweep-orphan-cards-')),
  writeFile = writeFileSync,
  rmFile = (p) => rmSync(p, { force: true }),
  rmTmp = (dir) => rmSync(dir, { recursive: true, force: true }),
} = {}) {
  const fail = (step, reason, extra = {}) => {
    write(`sweep-orphan-backlog-cards: FAILED at ${step} — ${reason}\n`);
    return {
      ok: false, step, reason, landed: extra.landed ?? [], dropped: extra.dropped ?? [],
      pr: extra.pr ?? null, url: extra.url ?? null,
    };
  };

  write(`sweep-orphan-backlog-cards: scanning ${clone} for untracked backlog cards…\n`);
  let raw;
  try {
    raw = listOrphans(clone, { exec });
  } catch (e) {
    return fail('scan', String(e?.message || e).split('\n')[0]);
  }
  const cards = raw.map((r) => parseOrphanCard(r.rel, r.content));
  write(`sweep-orphan-backlog-cards: found ${cards.length} untracked card(s) in ${clone}\n`);
  if (!cards.length) return { ok: true, step: 'done', reason: 'no untracked backlog cards found', landed: [], dropped: [], pr: null, url: null };

  let mainSets;
  try {
    mainSets = readMain({ exec });
  } catch (e) {
    return fail('read-main', String(e?.message || e).split('\n')[0]);
  }

  const selected = selectOrphanSurvivors(cards, mainSets);
  let survivors = selected.survivors;
  const dropped = [...selected.dropped];
  write(`sweep-orphan-backlog-cards: ${survivors.length} survivor(s), ${dropped.length} dropped\n`);
  for (const d of dropped) write(`  drop ${d.rel} — ${d.reason}\n`);

  if (!survivors.length) {
    return {
      ok: true, step: 'done', reason: 'nothing to land — every orphan was a duplicate, already landed, or not a prevention card',
      landed: [], dropped, pr: null, url: null,
    };
  }
  if (dryRun) return { ok: true, step: 'dry-run', reason: null, landed: survivors.map((s) => s.rel), dropped, pr: null, url: null };

  let scratch = null;
  const scratchFile = (name) => join(scratch ??= mkTmp(), name);
  let laneNum = null;
  try {
    let acquired;
    try {
      write(`sweep-orphan-backlog-cards: acquiring a lane (session ${session})…\n`);
      acquired = parseRunJsonTail(exec('node', [
        LANE_POOL_CLI, 'acquire', '--purpose=orphan-card-sweep', `--session=${session}`, '--json',
      ], { cwd: REPO_ROOT, timeout: ACQUIRE_TIMEOUT_MS }));
    } catch (e) {
      return fail('acquire', String(e?.message || e).split('\n')[0], { dropped });
    }
    const lane = acquired?.path ?? null;
    laneNum = acquired?.lane ?? null;
    if (!lane) return fail('acquire', 'lane-pool acquire produced no usable lane path', { dropped });
    const laneRunMjs = join(lane, 'scripts', 'operations', 'run.mjs');

    write(`sweep-orphan-backlog-cards: copying ${survivors.length} card(s) into ${lane}…\n`);
    try {
      for (const s of survivors) writeFile(join(lane, s.rel), s.content, 'utf8');
      exec('git', ['-C', lane, 'add', '--', ...survivors.map((s) => s.rel)], {});
    } catch (e) {
      return fail('copy', String(e?.message || e).split('\n')[0], { dropped });
    }

    // CONTENT VALIDATION (see the file header's step 5 — a live-caught defect, not a hypothetical: PR #2872's
    // own orphan tripped check-standards' wiki-link rule with reviewer prose that merely DESCRIBED that syntax).
    // UNSCOPED, exactly like the real gate stays for a backlog-touching lane (`verify-lane-gate.mjs`'s own
    // header) — this finding class carries no `descriptor.file`, so `--files=`/`--local` would silently hide it.
    write('sweep-orphan-backlog-cards: validating card content against check:standards…\n');
    for (let attempt = 0; attempt < CONTENT_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
      let report;
      try {
        report = parseCheckStandardsJson(exec('node', [join(lane, 'scripts', 'check-standards.mjs'), '--json'], { cwd: lane, timeout: VERIFY_TIMEOUT_MS }));
      } catch (e) {
        report = parseCheckStandardsJson(e?.stdout);
      }
      if (!report) return fail('content-check', 'check-standards.mjs --json produced no parseable output', { dropped });
      if (report.ok) break;
      const bad = findContentInvalidSurvivors(report.errors, survivors);
      if (!bad.length) {
        return fail('content-check', `check:standards failed with no error attributable to a survivor: ${JSON.stringify(report.errors)}`, { dropped });
      }
      const badRels = new Set(bad.map((b) => b.rel));
      write(`sweep-orphan-backlog-cards: dropping ${bad.length} card(s) that fail check:standards on their own content…\n`);
      for (const b of bad) write(`  drop ${b.rel} — ${b.reason}\n`);
      try {
        exec('git', ['-C', lane, 'reset', '--', ...bad.map((b) => b.rel)], {});
        for (const b of bad) rmFile(join(lane, b.rel));
      } catch (e) {
        return fail('content-check', String(e?.message || e).split('\n')[0], { dropped });
      }
      dropped.push(...bad);
      survivors = survivors.filter((s) => !badRels.has(s.rel));
      if (!survivors.length) {
        return {
          ok: true, step: 'done',
          reason: 'nothing to land — every surviving orphan failed check:standards on its own content',
          landed: [], dropped, pr: null, url: null,
        };
      }
    }

    write('sweep-orphan-backlog-cards: committing…\n');
    try {
      const msgPath = scratchFile('commit-msg.txt');
      writeFile(msgPath, buildSweepCommitMessage(survivors, clone), 'utf8');
      exec('git', ['-C', lane, 'commit', '-F', msgPath], {});
    } catch (e) {
      return fail('commit', String(e?.message || e).split('\n')[0], { dropped });
    }

    write('sweep-orphan-backlog-cards: running the gate…\n');
    let verified;
    try {
      verified = parseRunJsonTail(exec('node', [laneRunMjs, 'verify', `--checkout=${lane}`, '--mode=run', '--json'], { cwd: lane, timeout: VERIFY_TIMEOUT_MS }));
    } catch (e) {
      verified = parseRunJsonTail(e?.stdout);
    }
    if (!verified?.verdict?.ok) {
      return fail('verify', `gate not green: ${JSON.stringify(verified?.verdict?.blocking ?? verified?.error ?? 'unrun')}`, { dropped });
    }

    write('sweep-orphan-backlog-cards: opening the PR…\n');
    const bodyPath = scratchFile('pr-body.md');
    writeFile(bodyPath, buildSweepPrBody(survivors, dropped, clone), 'utf8');
    const ref = `lane/orphan-card-sweep-${session}`;
    let opened;
    try {
      opened = parseRunJsonTail(exec('node', [
        laneRunMjs, 'open-pr', `--ref=${ref}`, '--base=main', `--bodyFile=${bodyPath}`,
        '--mode=label-on-green', '--requireVerified=true', '--json',
      ], { cwd: lane, timeout: OPEN_PR_TIMEOUT_MS }));
    } catch (e) {
      opened = parseRunJsonTail(e?.stdout);
      if (!opened) return fail('open-pr', String(e?.message || e).split('\n')[0], { dropped });
    }
    const submit = extractSubmitResult(opened || {});
    if (submit?.outcome !== 'opened') {
      return fail('open-pr', submit?.reason ?? 'PR was not opened', { dropped, pr: submit?.pr, url: submit?.url });
    }

    try {
      const queued = queueSurvivors(survivors);
      if (queued.length) write(`sweep-orphan-backlog-cards: cleared ${queued.length} card(s) for the conveyor\n`);
    } catch (e) {
      write(`sweep-orphan-backlog-cards: conveyor queue-clear failed (non-fatal) — ${String(e?.message || e).split('\n')[0]}\n`);
    }

    write(`sweep-orphan-backlog-cards: landed — PR #${submit.pr} (${submit.url})\n`);
    return { ok: true, step: 'done', reason: null, landed: survivors.map((s) => s.rel), dropped, pr: submit.pr ?? null, url: submit.url ?? null };
  } catch (e) {
    return fail('unexpected', String(e?.message || e), { dropped });
  } finally {
    if (laneNum != null) {
      try {
        exec('node', [LANE_POOL_CLI, 'release', `--lane=${laneNum}`, `--session=${session}`], { cwd: REPO_ROOT, timeout: ACQUIRE_TIMEOUT_MS });
      } catch (e) {
        write(`sweep-orphan-backlog-cards: lane-${laneNum} release failed (non-fatal, will age out on its own TTL) — ${String(e?.message || e)}\n`);
      }
    }
    if (scratch) {
      try { rmTmp(scratch); } catch (e) { write(`sweep-orphan-backlog-cards: scratch cleanup failed (non-fatal) — ${String(e?.message || e)}\n`); }
    }
  }
}

/** PURE. `--k=v` argv → this script's own flat flag map. `--clone=` is required (there is no default clone —
 *  this tool never guesses which checkout to read); `--session=` defaults to a timestamped slug so an
 *  interactive run needs no ceremony; `--dry-run=true` reports the survivors/dropped without acquiring a lane
 *  or writing anything. */
export function parseSweepArgv(argv = []) {
  const flags = {};
  for (const a of Array.isArray(argv) ? argv : []) {
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq === -1) flags[a.slice(2)] = 'true';
    else flags[a.slice(2, eq)] = a.slice(eq + 1);
  }
  const clone = String(flags.clone ?? '').trim();
  if (!clone) {
    throw new TypeError('sweep-orphan-backlog-cards: --clone=<path to a daemon clone> is required — this tool never guesses which checkout to read');
  }
  const session = String(flags.session ?? '').trim() || `orphan-card-sweep-${Date.now()}`;
  const dryRun = ['1', 'true', 'yes'].includes(String(flags['dry-run'] ?? '').trim().toLowerCase());
  return { clone: resolve(clone), session, dryRun };
}

/** THE CLI, AS A FUNCTION — same reason `land-prevention-card.mjs#runLandPreventionCardCli` is extracted: the
 *  argv parse, the exit-code mapping and the failure text are all reachable from a test with no subprocess. */
export async function runSweepOrphanBacklogCardsCli(argv = [], {
  sweep = sweepOrphanBacklogCards,
  write = (line) => process.stdout.write(line),
  writeErr = (line) => process.stderr.write(line),
} = {}) {
  let input;
  try {
    input = parseSweepArgv(argv);
  } catch (e) {
    writeErr(`error: ${String(e?.message ?? e)}\n`);
    return { code: 1, result: null };
  }
  write(`sweep-orphan-backlog-cards: starting (clone ${input.clone}, session ${input.session}${input.dryRun ? ', dry-run' : ''})\n`);
  const result = await sweep(input, { write });
  if (!result.ok) {
    writeErr(`sweep-orphan-backlog-cards: did not land — ${result.step}: ${result.reason}\n`);
    return { code: 1, result };
  }
  write(`sweep-orphan-backlog-cards: done — landed ${result.landed.length} card(s), dropped ${result.dropped.length}`
    + `${result.pr ? `, PR #${result.pr}` : ''}\n`);
  return { code: 0, result };
}

const IS_CLI = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_CLI) {
  const { code } = await runSweepOrphanBacklogCardsCli(process.argv.slice(2));
  process.exitCode = code;
}
