/**
 * open-pr-items.mjs — the active-PR exclusion source (companion to main-staleness.mjs) for the readiness
 * ranker. An item that already has an OPEN pull request is producer-complete: its lane resolved it and is
 * waiting on the drain to land, so re-offering it (this session's mis-pack, 2026-07-08) hands a batch work
 * that's already done — often already merged+closed by the time the human looks. This module lists the open
 * PRs and maps each back to the backlog item number(s) it lands, so the CLI boundary can drop them from the
 * selection surfaces (exactly like the prepare-hold `dropHeld`).
 *
 * Fail-soft by construction: no `gh`, no auth, or offline → `{ nums:[], unavailable:true }`, never a throw and
 * never a hard fail (the ranker still runs, just without this extra exclusion). The pure extractor
 * (`extractItemNums`) is unit-tested separately from the `gh` IO (`openPrItemNums` takes an injected `run`).
 */

import { spawnSync } from 'node:child_process';
import { CONSTELLATION_REPOS } from './constellation-repos.mjs';
import { isAnnotationPr } from '../backlog-stranded-sweep.mjs'; // #3441 round 2 — reused (identical shape, not mirrored) to exclude a scope-authoring/prepare-decision PR from crediting a delivery

/** Default gh runner — spawnSync (returns non-zero without throwing). */
export function ghRun(args, opts = {}) {
  const r = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts }) // #74d: oversize => status null => status 1, never a truncated success;
  return { status: r.status == null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Extract the backlog item number(s) a PR lands from its head branch and title. Pure.
 * The lane transport names its ref `lane/<slug>-<NNN>` (batch) or `lane/<NNN>-<slug>` / `lane/<NNN>-…`, and a
 * `/pr` title carries the `#NNN`. We take any 3-4 digit run that looks like an item number from either. A hash
 * id (born-active, pre-number) never matches — it lands as a number, so a pre-number PR simply isn't excluded
 * (correct: the item isn't in the numbered selection surface yet either).
 * @param {string} headRefName
 * @param {string} title
 * @returns {string[]} zero or more zero-padded item numbers
 */
export function itemNumsFromPr(headRefName = '', title = '') {
  const nums = new Set();
  const ref = String(headRefName);
  const laneMatch = ref.match(/(?:^|\/)lane\/(.+)$/);
  if (laneMatch) {
    // Strip a `batch-YYYY-MM-DD` date prefix FIRST — a batch slug is `batch-<date>-<NNN>-<NNN>…`, so the year
    // (2026) and month/day would otherwise read as item numbers. The remaining `-<NNN>` segments are the items
    // (batch chain) or the single leading/trailing NNN (a /pr ref). The date is `YYYY-MM-DD` only — there is
    // no HHMM segment (a batch slug is `batch-<date>-<NNN>…`, the first post-date group is already an item, so
    // do NOT strip one). Single digits (`\d{2,5}` needs ≥2) and mid-word numbers (segment-bounded) are
    // excluded; the caller intersects with the real backlog anyway.
    const slug = laneMatch[1].replace(/^batch-\d{4}-\d{2}-\d{2}/, '');
    for (const m of slug.matchAll(/(?:^|[-/])(\d{2,5})(?=$|[-/])/g)) nums.add(m[1]);
  }
  for (const m of String(title).replace(/\(from #\d+ review\)/g, '').matchAll(/#(\d{2,5})\b/g)) nums.add(m[1]);
  return [...nums].map((n) => n.padStart(3, '0'));
}

/**
 * Given an array of PR objects (`{ headRefName, title }`), return the deduped set of item numbers they land.
 * Pure.
 * @param {Array<{headRefName?:string,title?:string}>} prs
 * @returns {string[]}
 */
/**
 * #3441 — extract the item id(s) a merged PR's branch/title actually DELIVERS. STRICTER than
 * `itemNumsFromPr` above, which this module's own docstring scopes to a LOW-STAKES use (excluding an item
 * from the readiness-ranking selection surface — a false positive there just means an already-covered item
 * isn't re-offered). This extractor instead feeds an AUTO-COMMITTED `status: resolved` flip on `main`
 * (the resolve-on-land path in `../merge-ai-prs.mjs`), so a false positive here wrongly resolves a real,
 * unrelated, possibly still-in-progress item — a much higher stake that needs a much stricter match.
 *
 * Mirrors (does not import — the shapes differ: this EXTRACTS candidate ids with no known target, while
 * `prDeliveredItem` in `../backlog-stranded-sweep.mjs` TESTS one already-known id against a PR) the two rules
 * that sibling tool's own docstring already learned the hard way:
 *   1. A BATCH lane ref (`lane/batch-<date>-<id>-<id>-…-<id>`) names EVERY item in the batch in its slug —
 *      only the TRAILING segment is the id THIS PR actually built; crediting an earlier segment would resolve
 *      a sibling item this PR never touched, often while that sibling's own lane is still mid-flight.
 *   2. A bare `#NNN` anywhere in the title is a CITATION ("see #2330 for background"), not a delivery claim —
 *      only an explicit `<id>:` / `#<id>:` subject-line marker or `resolve[sd]? #<id>` counts.
 * Plus one ref-only guard `itemNumsFromPr` also lacks: a `YYYY-MM-DD` run in the ref (`lane/calibrate-2026-08-02`)
 * is a date, never an id.
 *   4. (round 2) An ANNOTATION pass — `/prepare` scope-authoring or decision-prep — lands a real, merged, 
 *      non-manifest WE PR that names the item in both ref and title without ever building it (the dominant 
 *      real false-positive class per `isAnnotationPr`'s own docstring: "30+ of the first 71 hits … were 
 *      'author scope: for #NNNN'"). Excluded via `isAnnotationPr`, reused directly (identical input shape) 
 *      rather than re-mirrored.
 *   5. (round 2) The delivery-agent-brief's own retry-letter ref shape
 *      (`lane/<NNN><letter>-<slug>`, e.g. `lane/3441b-…` — #3110) still names item `<NNN>`; a segment may
 *      carry one trailing lowercase letter and still count.
 *
 * #3473 — two FURTHER guards, each proven necessary by a real merged false positive that #3441's eight rounds
 * never considered: a MULTI-PR/graduation-tracked item (`#3443`, "covers the whole ongoing effort, not one
 * PR") whose own constituent PRs use this repo's ordinary `"WE #NNN: <subject>"` / `lane/<NNN>-<slug>`
 * conventions like any single-PR leaf story does — so a real PR that only lands ONE increment (round-1's
 * `leadTitleMatch`, or the ref-lead-segment rule) still sails through every #3441-era check unchanged. Rather
 * than teach this extractor to know which items are multi-PR (a per-item marker would require editing #3443's
 * own card, and more lexical title-parsing was already tried for 8 rounds) these two guards are DELIBERATELY
 * generic, checking the PR itself rather than the target item:
 *   6. "does not resolve #NNN" BODY DISCLAIMER — PR #1866 (`lane/3443-computefreeslots-excludes-dirty-lanes`,
 *      `"WE #3443: readiness/computeFreeSlots excludes dirty (orphaned) unleased lanes"`) is a REAL code PR
 *      (touches `.mjs` files) whose own body says outright: "this PR does not resolve #3443, it lands one
 *      increment of it." No file-shape heuristic can catch this one — the author's own words are the only
 *      signal — so a PR body matching `/\bdoes\s+not\s+resolve\s+#?(\d{2,5})\b/i` for a given id excludes
 *      exactly that id from the credited set (scoped to the disclaimed id only — an unrelated id in the same
 *      title is still credited normally).
 *   7. ALL-MARKDOWN DIFF — PR #1886 (`lane/3443-reopen-and-3441-gap-followup`,
 *      `"backlog/3443: reopen (false auto-resolve) + file the extractor gap it exposed"`) is PURE backlog
 *      housekeeping (its merge diff touches exactly two `backlog/*.md` files — reopening #3443's card and
 *      filing this very item) yet is credited via the ref-lead-segment rule anyway. A PR whose ENTIRE
 *      changed-file set is `.md` can never BE a real implementation, however its title/ref reads, so it is
 *      excluded up front before any other rule runs. Intentionally conservative in the SAFE direction per this
 *      docblock's own asymmetry above (a false negative re-strands the item, recoverable by a human; a false
 *      positive silently corrupts an unrelated item on main) — a genuine future doc-only single-PR delivery
 *      item would need manual resolution instead of auto-credit, which is the correct trade.
 *   8. (added during this item's own post-fix verification, 2026-09-04) "no code changes" BLANKET BODY
 *      DISCLAIMER — PR #1599 (`lane/reconcile-3147-3096-3239`, credited toward `#3096`) is a real false
 *      positive guard 7 CANNOT catch: its true merge-commit diff is 4 files, all markdown, but `gh`'s own
 *      `files` field for this long-lived branch is stale/inflated (reports 17 files, 3 of them real `.mjs`
 *      changes that landed on `main` independently while the branch sat open — verified via `git show
 *      90fe066f6 --stat` vs. the branch's real merge-base diff) — so guard 7's changed-file check, fed by that
 *      same stale `gh` data, cannot exclude it either. Its own body, like PR #1613's ("No code changes — two
 *      backlog files."), opens with a blanket claim rather than a per-id one: "No code behaviour changes —
 *      this is a backlog reconciliation plus one in-code comment repoint." A PR body matching
 *      `/\bno\s+code\s+(behaviou?r\s+)?changes?\b/i` is excluded ENTIRELY (all ids, not just one) — unlike
 *      guard 6 above, this disclaimer names no specific id to scope to, so it reads as "nothing in this PR was
 *      implemented," period. Checked alongside guard 7, before any other computation.
 * Guards 6-8 are additive and fully backward compatible: the 3rd argument defaults to `{ body: '',
 * changedFiles: null }`, under which none of them can ever fire, so every existing call site (and every
 * pre-#3473 test) gets IDENTICAL output to before this change.
 * #2779-incident (PR #2785, `lane/2779-session-token-fresh`, 03:14Z) — a NINTH guard, found the hard way: this
 * extractor's lead-segment/trailing-segment RULES (3/4 above) read "the id-bearing position is a grammar", but
 * that grammar assumes the human/agent who named the branch used the CARD's number. A worker instead named
 * their branch after PR #2779 (an unrelated, still-open, unmerged bg-isolation fix) — `segs[0] === '2779'`
 * satisfied the exact same lead-match rule #3441 round 3 documented as safe, with NO manifest, NO title
 * corroboration, and NO diff evidence, yet the caller auto-committed `drain: resolve #2779 on land`, which (a)
 * wrongly flipped backlog card #2779 (an unrelated card nothing here built) to `resolved`, and (b) — because
 * "resolve #2779" is a GitHub closing keyword — CLOSED the real, unmerged PR #2779 as a side effect of the
 * commit landing. A branch's bare leading/trailing number is NEVER sufficient evidence on its own when that
 * same number ALSO names a PR that is (or, at land time, still was) open: an open PR number and a backlog card
 * number share the same numbering, so a leading digit run is fundamentally ambiguous between "the card this PR
 * builds" and "the PR the worker copied into their own branch name". `openPrNums` — the OTHER currently-open
 * PR numbers in this repo (never including this PR's own number) — lets the caller name that collision set;
 * any id this extractor would otherwise credit that also appears in `openPrNums` is dropped from the credited
 * set entirely (the safe direction per this docstring's own asymmetry: a false negative just re-strands the
 * item for a human/the stranded sweep to resolve with real evidence; a false positive wrongly resolves an
 * unrelated card AND, via the closing-keyword commit message, can close someone else's open PR).
 * @param {string} headRefName
 * @param {string} title
 * @param {{body?: string, changedFiles?: (Array<string|{path?: string}>|null), openPrNums?: Iterable<string|number>}} [o] - #3473: `body` is the
 *   PR's own description text (guards 6/8); `changedFiles` is the PR's changed-file list, either plain path
 *   strings or `{path}`-shaped rows as `gh pr view --json files` returns (guard 7). `openPrNums` is the
 *   #2779-incident guard above. All default to inert.
 * @returns {string[]} zero-padded item ids this PR's ref/title claims to DELIVER (not merely mention)
 */
export function deliveredItemNumsFromPr(headRefName = '', title = '', { body = '', changedFiles = null, openPrNums = null } = {}) {
  const ref = String(headRefName || '');
  if (isNonDeliveryPr(ref, title, { body, changedFiles })) return [];
  // Only a `lane/<slug>` ref is ever a delivery vehicle (matches itemNumsFromPr's own gate above) — a random
  // branch name with an embedded number (`release-2026`) must never be read as an id.
  const laneMatch = ref.match(/(?:^|\/)lane\/(.+)$/);
  const slug = laneMatch ? laneMatch[1] : '';
  const segs = slug.split(/[-_]/).filter(Boolean);
  // #3441 round 3 — the id-bearing position is a GRAMMAR, not "any digit-looking segment" (the lesson
  // `scripts/conveyor/lease-reaper.mjs`'s `laneRefItemNum` already anchors to): a real delivery ref only ever
  // carries its id as the segment RIGHT AFTER `lane/`, or — for a true batch chain — as the TRAILING segment.
  // Scanning every segment (round 2's shape) misread an ordinary tech-slug fragment ("…-80s-…", "…-10x-…",
  // "…-50k-…") as a second, unrelated delivered id. `isBatchRef` itself is anchored to segs[0] === 'batch' —
  // the real convention (`lane/batch-<date>-…`) — not "the word batch anywhere" (round 3: `lane/2415-batch-
  // job-scheduler` is an ordinary single-item ref, not a batch chain, and must still resolve #2415).
  const isBatchRef = segs[0] === 'batch';
  // A YYYY-MM-DD run ANYWHERE in the ref is a date, not an id (`lane/calibrate-2026-08-02` must not credit
  // item #2026, AND its trailing `02` must not credit item #2 either — round 4 caught the second half of
  // this after the trailing fallback below was added). Scan every consecutive triple, not just the lead.
  const dateSpanSegs = new Set();
  for (let i = 0; i + 2 < segs.length; i++) {
    const [y, m, d] = segs.slice(i, i + 3);
    if (/^(19|20)\d{2}$/.test(y) && /^(0[1-9]|1[0-2])$/.test(m) && /^(0[1-9]|[12]\d|3[01])$/.test(d)) {
      dateSpanSegs.add(y); dateSpanSegs.add(m); dateSpanSegs.add(d);
    }
  }
  // #3441 round 4/5 — verb-led, id-LAST refs are a REAL convention this repo's own maintenance tooling
  // mints (`lane/build-3067`, `lane/resolve-2712`, `lane/heal-stranded-2319`, `lane/fix-stranded-backlog-id-
  // 3392`), but "id-last" is NOT the only verb-led shape in use — `scripts/pr-land.mjs`'s own docstring cites
  // a real merged PR at `lane/fix-2165-ci-fui-checkout` (id right after the verb, MORE words after it). Both
  // start with "fix"; position alone cannot tell them apart, and guessing wrong means crediting a
  // coincidental trailing number (a slug word that happens to end in digits) as a real id — a false POSITIVE,
  // exactly the class every round exists to prevent. So this is a CLOSED allowlist of the exact verb phrases
  // actually verified as real id-last conventions, not an open "any verb, trailing segment" heuristic — a
  // verb-led shape outside this list is a false NEGATIVE (safe: re-strands the item) rather than a guess.
  const ID_LAST_VERB_PHRASES = new Set(['build', 'resolve', 'heal-stranded', 'number-stranded', 'fix-stranded-backlog-id', 'reconcile']);
  const nums = new Set();
  if (isBatchRef) {
    const trailingBatch = segs[segs.length - 1] || '';
    // Same date-span exclusion as the non-batch trailing fallback below (round 5 — this branch was missed
    // when round 4 added it there, leaving a date-only batch ref, e.g. `lane/batch-2026-08-02`, able to
    // credit its day-of-month).
    if (!dateSpanSegs.has(trailingBatch)) {
      // A retry ref carries one trailing letter after the number (`lane/3441b-…`, #3110) — still names item 3441.
      const m = /^(\d{2,5})[a-z]?$/i.exec(trailingBatch);
      if (m) nums.add(m[1]);
    }
  } else {
    const lead = segs[0];
    const leadMatch = lead && !dateSpanSegs.has(lead) ? /^(\d{2,5})[a-z]?$/i.exec(lead) : null;
    // #3441 round 6/7 — a lead-digit segment and the verb-id-last shape can COLLIDE: `lane/3383-resolve-3412`
    // is real (this very item's own parent epic's git history), and reads as EITHER "item 3383" (the lead)
    // OR "item 3412, via a 'resolve' lane grouped under 3383" — two different, equally plausible targets,
    // with no way to prefer one from the ref alone. Round 6 first caught this but matched only the EXACT
    // 3-segment shape (`<id>-<verb>-<id>`, nothing else) — round 7 found that one extra word ANYWHERE
    // (`lane/3383-resolve-3412-cleanup`, `-please-resolve-3412`, `-resolve-cleanup-3412`, even a retry letter
    // on the trailing id) defeated the exact match and silently restored the pre-round-6 bug. Detect the
    // SHAPE instead of an exact segment count: does an allowlisted verb phrase occur ANYWHERE after the lead
    // (as a contiguous word run, wherever it starts), with ANY id-shaped token anywhere after THAT? If so,
    // ambiguous — emit NEITHER id (this extractor's asymmetry: a false negative re-strands the item for the
    // stranded sweep; a false positive silently corrupts an unrelated item on main).
    let leadVerbCollision = false;
    if (leadMatch) {
      for (const phrase of ID_LAST_VERB_PHRASES) {
        const words = phrase.split('-');
        for (let i = 1; i + words.length <= segs.length && !leadVerbCollision; i++) {
          if (words.every((w, j) => segs[i + j].toLowerCase() === w)) {
            const after = segs.slice(i + words.length);
            if (after.some((s) => !dateSpanSegs.has(s) && /^\d{2,5}[a-z]?$/i.test(s))) leadVerbCollision = true;
          }
        }
        if (leadVerbCollision) break;
      }
    }
    const trailing = segs[segs.length - 1];
    const trailingIsCleanId = segs.length > 1 && !dateSpanSegs.has(trailing) && /^\d{2,5}$/.test(trailing);
    if (leadMatch && !leadVerbCollision) {
      nums.add(leadMatch[1]);
    } else if (!leadMatch && trailingIsCleanId) {
      // #3441 review round 1 (human) — a real, merged multi-id verb-led ref (`lane/reconcile-3147-3096-3239`,
      // PR #1599) chains several sibling ids ahead of the one this PR actually delivers, the same shape
      // `isBatchRef` already credits only-the-trailing-segment for. So the verb phrase need not consume EVERY
      // segment before the trailing id — zero or more plain (non-date) numeric segments may sit between the
      // verb and the trailing id and are treated as batch-chain siblings, not a second delivered id.
      for (const phrase of ID_LAST_VERB_PHRASES) {
        const words = phrase.split('-');
        if (words.length >= segs.length) continue;
        if (!words.every((w, j) => segs[j].toLowerCase() === w)) continue;
        const middle = segs.slice(words.length, -1);
        if (middle.every((s) => !dateSpanSegs.has(s) && /^\d{2,5}$/.test(s))) {
          nums.add(trailing);
          break;
        }
      }
    }
  }
  const t = String(title || '');
  // #3441 review round 1 (human) — anchored to the SUBJECT position (start of title, optional "WE "
  // prefix), not "any whitespace-preceded digits-colon": the prior unanchored form credited an
  // unrelated mid-title "NNN:" (an HTTP code, a port, a rate limit — "cap at 500: avoid OOM") as a
  // second delivered id, feeding the auto-committed resolve on main.
  const leadTitleMatch = /^\s*(?:WE\s+)?#?(\d{2,5})\s*:/.exec(t);
  if (leadTitleMatch) nums.add(leadTitleMatch[1]);
  // #3441 round 4 — "resolve: #NNN — subject" (colon right after "resolve", not before "#NNN") is a real,
  // repeated commit-title convention in this repo's history; the optional `:?` covers it alongside the
  // colon-less "resolve #NNN" shape already handled.
  for (const m of t.matchAll(/\bresolve[sd]?:?\s+#(\d{2,5})\b/gi)) nums.add(m[1]);
  // #3473 guard 6 — an explicit "does not resolve #NNN" disclaimer in the PR's own body excludes exactly that
  // id from the credited set (PR #1866's shape) — a final filter, not an early return, so it never suppresses
  // an unrelated id the same title/ref legitimately delivers.
  const disclaimed = new Set();
  for (const m of String(body || '').matchAll(/\bdoes\s+not\s+resolve\s+#?(\d{2,5})\b/gi)) disclaimed.add(m[1].padStart(3, '0'));
  // #2779-incident guard (see docstring) — never credit an id that is itself another currently-open PR's
  // number: that is exactly the ambiguity a bare branch-name digit run cannot resolve on its own.
  const openSet = new Set([...(openPrNums || [])].map((n) => String(n).replace(/^0+/, '') || '0'));
  const isOpenPrNum = (n) => openSet.has(n.replace(/^0+/, '') || '0');
  return [...nums].map((n) => n.padStart(3, '0')).filter((n) => !disclaimed.has(n) && !isOpenPrNum(n));
}

// #3916 review round 1 — a citation cue word; paired with a `#NNN` item reference it marks a quoted span as
// someone else's words being cited, not this PR's own voice.
const CITATION_CUE = /\b(?:precedent|cf\.?|citing|cited|quoting|quoted|characteri[sz]ation)\b/i;
const CITATION_WINDOW = 120;

/**
 * Remove every quoted span (straight `"…"` or curly `“…”`) that reads as an ATTRIBUTED citation: the text around
 * it (outside the quote, same line, within `CITATION_WINDOW` chars either side) carries BOTH a citation cue word
 * AND a `#NNN` item reference — the live #2594 shape, `"already landed, no code change" precedent in #3443's own
 * Progress log`. Any other quoted span is kept verbatim, so a PR quoting its own disclaimer still trips guard 8.
 * Requiring both signals keeps a self-quote followed by an unrelated `see #NNN` or `as cited above` inside the
 * guard. The `#NNN` must name ANOTHER item — a ref to one of `ownIds` (the ids this PR's own ref/title carry)
 * never counts, so `Closes #4200. "No code changes" as cited in the card.` on #4200's PR still trips guard 8.
 * Residual (accepted): a self-quote beside a cue AND another item's ref (`"No code changes" (cf. #1613)`) is
 * indistinguishable by pattern from the live citation shape. Pure.
 */
function stripCitedQuotes(text, ownIds = new Set()) {
  return text.replace(/"[^"\n]*"|“[^”\n]*”/g, (m, off, s) => {
    const lineStart = s.lastIndexOf('\n', off - 1) + 1;
    const nl = s.indexOf('\n', off + m.length);
    const lineEnd = nl === -1 ? s.length : nl;
    const ctx = `${s.slice(Math.max(lineStart, off - CITATION_WINDOW), off)} ${s.slice(off + m.length, Math.min(lineEnd, off + m.length + CITATION_WINDOW))}`;
    const citesOther = [...ctx.matchAll(/#(\d{2,5})\b/g)].some((r) => !ownIds.has(r[1].replace(/^0+/, '')));
    return CITATION_CUE.test(ctx) && citesOther ? '' : m;
  });
}

/** Every 2–5 digit id token in a PR's own ref/title, leading zeros dropped — the ids a citation must NOT be. */
function ownIdsOf(ref, title) {
  return new Set([...`${ref} ${title}`.matchAll(/(?<!\d)(\d{2,5})(?!\d)/g)].map((m) => m[1].replace(/^0+/, '')));
}

/**
 * The whole-PR exclusions every delivery extractor applies before reading ids (#3473 guards 7/8 + the #3441
 * annotation guard). Pure; inert under the default `{ body: '', changedFiles: null }`.
 */
function isNonDeliveryPr(ref, title, { body = '', changedFiles = null } = {}) {
  // #3473 guard 7 — an all-.md changed-file set is pure backlog/doc housekeeping and can never be a real
  // delivery, whatever the ref/title reads as.
  if (Array.isArray(changedFiles) && changedFiles.length > 0 && changedFiles.every((f) => /\.md$/i.test(String(f?.path ?? f)))) return true;
  // #3473 guard 8 — a blanket "no code changes" disclaimer in the PR's own body excludes it entirely,
  // independent of (and a backstop for) guard 7's changed-file check, which a stale `gh` files list can defeat.
  // #3916 — PR #2594 (a real, large multi-`.mjs`-file graduation port) was silently dropped from
  // `landedThisPass` — and so never even entered resolve-on-land's totality report (#2899 J2/J3), the exact
  // silent-skip class that report was built to catch — because its body CITES another item's own characterization
  // of a DIFFERENT, narrower deviation: `"already landed, no code change" precedent in #3443's own Progress
  // log`. That is a quoted reference to someone else's disclaimer, not this PR's own claim about itself — PR
  // #1599's `No code behaviour changes — …` and #1613's `No code changes — …` (this guard's real, intended
  // catches) both state the disclaimer unquoted, in the PR's own voice. Strip a quoted span before testing
  // ONLY when it reads as an attributed citation (see `stripCitedQuotes`) — never any quoted text, or a PR
  // that quotes its OWN disclaimer (`"No code changes here"`) would evade the guard (#3916 review round 1).
  if (/\bno\s+code\s+(behaviou?r\s+)?changes?\b/i.test(stripCitedQuotes(String(body || ''), ownIdsOf(ref, title)))) return true;
  return isAnnotationPr({ headRefName: ref, title }); // scope-authoring / prepare-decision — not a build
}

/**
 * #3914 — the hash-born item a lane PR DELIVERS, when the lane was cut for a card it filed in the SAME PR.
 * A `--session` scaffold is born active under a provisional hash (`backlog/x<6>-….md`, #2288) and its lane ref
 * leads with that hash (`lane/xaa7r2n-…`). `deliveredItemNumsFromPr` deliberately matches digits only, so these
 * PRs contributed nothing to resolve-on-land and the drain JIT-numbered the card and left it `active` forever
 * (#3459/#3492/#3638). Only the LEAD ref segment counts (the id the lane was cut for, same grammar as the
 * numeric lead) — a hash the PR merely filed in passing (a spin-off) is never in that position, so it is never
 * credited. When the changed-file list is known it must include the card itself (`backlog/<hash>-…`), i.e. the
 * PR filed it; the caller's hash→NNN re-key (`planResolveOnLand`) then only flips a card numbered THIS land.
 * Same whole-PR guards as `deliveredItemNumsFromPr`. Pure.
 *
 * #xqpqyr2 — the scaffold-refile check above is necessary when the hash has NO OTHER proof, but wrongly
 * requires a re-file when the card was ALREADY numbered on `main` — by a JIT-numbering pass that ran BEFORE
 * this PR's own diff was computed — since the merged PR's diff then never touches the renamed file at all
 * (real, live: PR #2668's ref led `xn6n5gp`, but its merge diff touched `backlog/4127-…md`, never
 * `backlog/xn6n5gp-…md`, because a numbering commit had already renamed it). `landedNumberFor` (injected;
 * defaults to a no-op so every pre-existing call site/test is unaffected) reads the SAME durable
 * `bornAs:<hash>` frontmatter record on `origin/main` already used for the identical stackParent/blockedBy
 * proof — strictly STRONGER evidence than the changed-file heuristic, since it is the actual birth record,
 * not a guess from file paths. Tried FIRST; when it resolves, the caller (`landedIdsForCandidate`) treats the
 * returned NNN exactly like a hash literal (both pass through `asItemId`), so this never needs a second code
 * path downstream.
 *
 * #4477 — when the ref has no lead hash, also read the title's lead `WE #<hash>:` marker (PR #2924's
 * descriptive lane ref), mirroring the numeric title-lead convention. A ref-lead hash still wins;
 * whole-PR guards and the landed-number lookup apply unchanged.
 * @param {{body?:string, changedFiles?:(Array|null), landedNumberFor?:function}} [o] `landedNumberFor(hash)` →
 *   the item's current NNN (as a string) if a `bornAs: <hash>` record already exists on `origin/main`, else
 *   `null`/falsy. Defaults to `() => null` (inert — identical to pre-#xqpqyr2 behaviour).
 * @returns {string|null} the provisional hash, the already-landed NNN, or null
 */
export function deliveredHashFromPr(headRefName = '', title = '', { body = '', changedFiles = null, landedNumberFor = () => null } = {}) {
  const ref = String(headRefName || '');
  const lane = ref.match(/(?:^|\/)lane\/(.+)$/);
  const refLead = lane ? lane[1].split(/[-_]/).filter(Boolean)[0] : '';
  const refIsHash = /^x[0-9a-z]{6}$/.test(refLead || '');
  // #4477 — a descriptive lane ref can name its card's hash in the title's lead position instead.
  // Mirror deliveredItemNumsFromPr's numeric title-lead convention; a ref-lead hash always wins.
  // (round-1 simplicity nit: no need to re-test the hash shape below — `refLead` is already known-hash
  // via `refIsHash`, and the title regex's own capture group can only ever match the hash shape.)
  const titleLeadMatch = refIsHash ? null : /^\s*(?:WE\s+)?#(x[0-9a-z]{6})\s*:/i.exec(String(title || ''));
  const lead = refIsHash ? refLead : (titleLeadMatch ? titleLeadMatch[1].toLowerCase() : '');
  if (!lead) return null;
  if (isNonDeliveryPr(ref, title, { body, changedFiles })) return null;
  const landed = typeof landedNumberFor === 'function' ? landedNumberFor(lead) : null;
  if (landed != null) return String(landed);
  if (Array.isArray(changedFiles) && changedFiles.length > 0
    && !changedFiles.some((f) => String(f?.path ?? f).startsWith(`backlog/${lead}-`))) return null;
  return lead;
}

/**
 * #xqpqyr2 — ride-along cards a PR declares (and, for signal 3, PROVES) it resolves BESIDES its own single
 * ref-led id. `deliveredItemNumsFromPr`/`deliveredHashFromPr` structurally credit AT MOST one id per PR (the
 * one its ref/title names as the PR's OWN lane); a coordinated multi-card PR — several small cards landed
 * together because they touch the same files or are explicitly sequenced — declares its OTHER cards only in
 * its own text or diff, never in its ref, so those cards' `active` status survives the land forever. Real,
 * live cases this closes: PR #2668 (ref-led `xn6n5gp` → #4127) also delivered `xuqk1vp` → #4134 and `xb94mt5`
 * → #4121, named only in its title/body; PR #2689 (ref-led `x0zg44l` → #4169) also delivered `xg6m4i5` → #4172,
 * named only in a body heading and a bold `**Rule (xg6m4i5):**` line.
 *
 * THREE conservative signals, each independently gated so a bare mention in prose never counts — the exact
 * "looks delivered" false-positive class this must avoid (per this module's own docstring above):
 *   1. An explicit "resolves #N" / "Resolves: #N, #M" LINE marker in the body — anchored to the START of a
 *      line (optional leading list marker / bold decoration), never a mid-sentence citation — AND corroborated
 *      by the PR's own diff moving that card's frontmatter status to `active`/`resolved` (the text alone never
 *      resolves a card; a touched-but-unclaimed or deferred `open` card never counts). This is the
 *      `Resolves #N` / `Refs #N` backstop `docs/agent/platform-decisions.md`'s
 *      `#drain-multi-slice-card-interim-hold` note already anticipated as "a later, additive backstop."
 *   2. A structured bornAs-HASH card marker: a `x[0-9a-z]{6}` token that appears either (a) in a parenthesized
 *      group of the PR's own TITLE holding only hashes (`(xuqk1vp)`, `(xuqk1vp, xb94mt5)`), or (b) INSIDE a
 *      body line's leading markdown BOLD span, or on a HEADING line — never a bare hash mention in ordinary
 *      prose elsewhere, including the prose that follows a leading bold span on the same line. Corroborated
 *      exactly like signal 1 (under the card's hash or its number). A hash with a REAL `bornAs` record on
 *      `origin/main` (`landedNumberFor`) credits its NNN; one not numbered yet credits the bare hash only when
 *      the PR filed/claimed that hash-named card itself.
 *   3. A backlog file the PR's OWN diff flips TO `status: resolved` (`resolvedStatusIdsFromDiff` below) —
 *      ground truth from the merge itself, independent of any text heuristic.
 * All three sit behind the same whole-PR `isNonDeliveryPr` guards (no-code-changes / all-.md / annotation) a
 * housekeeping-only or scope-authoring PR never ride-along-credits either. Pure.
 * @param {{body?:string, changedFiles?:(Array|null), diff?:string, landedNumberFor?:function}} [o]
 * @returns {string[]} zero-padded item ids, deduplicated (order not significant — caller unions into a Set)
 */
export function declaredResolvedIdsFromPr(headRefName = '', title = '', { body = '', changedFiles = null, diff = '', landedNumberFor = () => null } = {}) {
  const ref = String(headRefName || '');
  if (isNonDeliveryPr(ref, title, { body, changedFiles })) return [];
  const ids = new Set();
  // Signals 1/2 name a card; that is only a CLAIM (PR #2724 review, two rounds). The evidence is the PR's own
  // diff moving that card's FRONTMATTER status to `active` (the PR claimed it — the delivery-agent convention,
  // as real ride-along PRs #2668/#2689 did) or `resolved`, never from `resolved` (a re-open). A card merely
  // touched (a typo, a scope edit), filed `open` (a deferred follow-up) or absent from the diff credits
  // nothing; an unknown diff fails closed.
  const transitions = backlogStatusTransitionsFromDiff(diff);
  const delivered = (key) => {
    const t = transitions.get(key);
    return !!t && (t.to === 'active' || t.to === 'resolved') && t.from !== 'resolved';
  };
  // Signal 1 — explicit resolves/Resolves marker LINES (never mid-sentence): "Resolves #4121", "resolves:
  // #4121, #4134", "Resolves #4121 and #4134." — optional leading `-`/`*` bullet, bold decoration and one
  // trailing `.`/`;`.
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = /^(?:[-*]\s+)?\*{0,2}resolve[sd]?:?\*{0,2}\s+((?:#\d{2,5}\b[\s,&]*(?:and\s+)?)+)[.;]?$/i.exec(line);
    if (!m) continue;
    for (const n of m[1].matchAll(/#(\d{2,5})/g)) {
      const id = n[1].padStart(3, '0');
      if (delivered(id)) ids.add(id);
    }
  }
  // Signal 2 — structured bornAs-hash card markers (title parens holding only hashes; body leading bold span /
  // heading line). On a bold-led line only the text INSIDE the leading bold span counts — prose after it
  // (`**Note:** unlike xg6m4i5, …`) is a citation.
  const hashCandidates = new Set();
  for (const g of String(title || '').matchAll(/\(([^()]*)\)/g)) {
    if (!/^\s*x[0-9a-z]{6}(?:\s*(?:,|\+|&|\band\b)\s*x[0-9a-z]{6})*\s*$/i.test(g[1])) continue;
    for (const m of g[1].matchAll(/x[0-9a-z]{6}/gi)) hashCandidates.add(m[0].toLowerCase());
  }
  for (const rawLine of String(body || '').split(/\r?\n/)) {
    const bold = /^\s*(?:[-*+]\s+)?\*\*([^*\n]*)\*\*/.exec(rawLine);
    const markerText = bold ? bold[1] : (/^\s{0,3}#{1,6}\s/.test(rawLine) ? rawLine : null);
    if (markerText == null) continue;
    for (const m of markerText.matchAll(/\b(x[0-9a-z]{6})\b/gi)) hashCandidates.add(m[1].toLowerCase());
  }
  // A hash already numbered on `origin/main` (a REAL bornAs record) credits its NNN; one the PR filed under its
  // hash and is not numbered yet (numbering runs in this same land) credits the bare hash, which
  // `planResolveOnLand` re-keys to the NNN minted this land. Either way the diff must show the delivery move.
  for (const hash of hashCandidates) {
    const landed = typeof landedNumberFor === 'function' ? landedNumberFor(hash) : null;
    if (landed != null) {
      const id = String(landed).padStart(3, '0');
      if (delivered(id) || delivered(hash)) ids.add(id);
    } else if (delivered(hash)) {
      ids.add(hash);
    }
  }
  // Signal 3 — a backlog file the PR's OWN diff flips TO status: resolved (ground truth, not a heuristic).
  for (const n of resolvedStatusIdsFromDiff(diff)) ids.add(n);
  return [...ids];
}

/**
 * #xqpqyr2 — each backlog card's frontmatter `status:` transition in a unified diff (PR #2724 review round 2).
 * Only a FRONTMATTER status line counts: a status line on a side stops counting once that side shows the
 * closing `---` delimiter, a blank line or any non-YAML line before it (a fenced example, body prose). A
 * modified card must REMOVE its prior status for a transition to exist (an added status line alone is not
 * one); a new file (`--- /dev/null`) transitions from `null`. Pure.
 * @param {string} diffText
 * @returns {Map<string, {from:(string|null), to:(string|null)}>} keyed by zero-padded NNN or lowercase hash —
 *   both the old and new name of a renamed card
 */
const FRONTMATTER_MAX_LINE = 30;

export function backlogStatusTransitionsFromDiff(diffText = '') {
  const out = new Map();
  const text = String(diffText || '');
  if (!text) return out;
  const cardKey = (p) => {
    const k = /(?:^|\/)backlog\/(\d{2,5}|x[0-9a-z]{6})-[^/]+\.md$/i.exec(p || '')?.[1];
    return !k ? null : /^\d/.test(k) ? k.padStart(3, '0') : k.toLowerCase();
  };
  const yamlish = (c) => /^[A-Za-z_][\w-]*:(?:\s|$)/.test(c) || /^\s+\S/.test(c) || /^-\s/.test(c);
  for (const block of text.split(/^diff --git /m).slice(1)) {
    const lines = block.split(/\r?\n/);
    const header = /a\/(\S+)\s+b\/(\S+)/.exec(lines[0] || '');
    const keys = header ? [...new Set([cardKey(header[1]), cardKey(header[2])].filter(Boolean))] : [];
    if (!keys.length) continue;
    const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
    const isNew = lines.slice(0, firstHunk < 0 ? lines.length : firstHunk).includes('--- /dev/null');
    // Per side: `ln` the next line number, `body` true once that side is provably past the frontmatter,
    // `opened` true once the opening `---` at line 1 was seen. A hunk that never shows line 1 cannot see where
    // the frontmatter ends, so there a status line counts only within the first FRONTMATTER_MAX_LINE lines
    // (real cards put `status:` by line 19) — a body `status:` line deep in the file is prose.
    const side = { old: { ln: 0, body: false, opened: false }, new: { ln: 0, body: false, opened: false } };
    let inHunk = false;
    let from = null;
    let to = null;
    const visit = (s, c) => {
      const n = s.ln++;
      if (s.body) return false;
      if (n === 1) { if (c === '---') s.opened = true; else s.body = true; return false; }
      if (c === '---' || !yamlish(c)) { s.body = true; return false; }
      return s.opened || n <= FRONTMATTER_MAX_LINE; // a frontmatter line
    };
    for (const line of lines.slice(1)) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { inHunk = true; side.old.ln = Number(h[1]); side.new.ln = Number(h[2]); continue; }
      if (!inHunk || line.startsWith('\\')) continue;
      const mark = line[0];
      const content = line.slice(1);
      // Unquote (`status: "active"`) and drop a trailing `# comment`, so a quoted `'resolved'` still reads as a
      // re-open rather than slipping past the `from !== 'resolved'` guard.
      const status = /^status:\s*(["']?)([\w-]+)\1\s*(?:#.*)?$/.exec(content.trimEnd())?.[2] ?? null;
      if (mark === ' ') { visit(side.old, content); visit(side.new, content); }
      else if (mark === '-') { if (visit(side.old, content) && status) from = status; }
      else if (mark === '+') { if (visit(side.new, content) && status) to = status; }
    }
    if (to == null || to === from || (from == null && !isNew)) continue;
    for (const k of keys) out.set(k, { from, to });
  }
  return out;
}

/**
 * #xqpqyr2 — the ground-truth half of `declaredResolvedIdsFromPr` (signal 3): which numbered backlog files
 * does a unified diff itself flip FROM some other status TO `status: resolved`? A file already `resolved`
 * before this PR (a `-status: resolved` line paired with the `+status: resolved` addition — i.e. no real
 * transition) is excluded; this only credits a PR that PERFORMED the flip — in the card's FRONTMATTER, per
 * `backlogStatusTransitionsFromDiff` (a body example is not a flip). Pure — takes a diff string (`git
 * diff` / `gh pr diff` output), never fetches one itself.
 * @param {string} diffText
 * @returns {string[]} zero-padded item ids
 */
export function resolvedStatusIdsFromDiff(diffText = '') {
  const ids = [];
  for (const [key, t] of backlogStatusTransitionsFromDiff(diffText)) {
    if (/^\d/.test(key) && t.to === 'resolved') ids.push(key);
  }
  return ids;
}

export function extractItemNums(prs) {
  const out = new Set();
  for (const pr of prs || []) for (const n of itemNumsFromPr(pr.headRefName, pr.title)) out.add(n);
  return [...out];
}

/**
 * List OPEN PRs in EVERY constellation repo via `gh` and map them to the backlog item numbers they land, KEEPING
 * each PR's identity (`{repo, number, title, url, headRefName}`) under its item number. An item whose
 * implementation half is open in frontierui / plateau-app is just as in-flight as one open in WE (backlog item
 * numbers are WE ids, and a couple's impl PR lives in the sibling repo), so a WE-only read would re-offer it.
 * Fail-soft: the WE read failing → `unavailable` (as before); a SIBLING repo failing keeps the numbers already
 * read and names the repo under `partial`, never silently dropping it. ONE `gh pr list` per repo serves both the
 * exclusion (`nums`) and the Decision Docket's "In review" rows (`byItem`) — the docket adds no second call.
 * @param {{run?:typeof ghRun, repos?:string[]}} o  `repos` = gh `owner/repo` slugs (default: the constellation table).
 * @returns {{nums:string[], byItem:Record<string, Array<{repo:string, number:number|null, title:string, url:string|null, headRefName:string}>>, partial?:Array<{repo:string, reason:string}>}
 *   |{nums:string[], byItem:{}, unavailable:true, reason:string}}
 */
export function openPrsByItem({ run = ghRun, repos = Object.values(CONSTELLATION_REPOS).map((r) => r.slug) } = {}) {
  const byItem = {};
  const partial = [];
  for (const [i, repo] of repos.entries()) {
    const r = run(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'headRefName,title,number,url']);
    let prs = null;
    let reason = null;
    if (r.status !== 0) reason = (r.stderr || 'gh unavailable').trim().split('\n')[0];
    else {
      try { prs = JSON.parse(r.stdout || '[]'); } catch { reason = 'unparseable gh output'; }
    }
    if (reason !== null) {
      if (i === 0) return { nums: [], byItem: {}, unavailable: true, reason }; // the primary repo is the source of truth
      partial.push({ repo, reason });
      continue;
    }
    for (const pr of prs) {
      const detail = { repo, number: Number.isInteger(pr.number) ? pr.number : null, title: String(pr.title ?? ''), url: typeof pr.url === 'string' ? pr.url : null, headRefName: String(pr.headRefName ?? '') };
      for (const n of itemNumsFromPr(pr.headRefName, pr.title)) (byItem[n] ??= []).push(detail);
    }
  }
  const nums = Object.keys(byItem);
  return partial.length ? { nums, byItem, partial } : { nums, byItem };
}

/** The number-only view of `openPrsByItem` (the readiness exclusion + suggest-next callers). Same fail-soft contract. */
export function openPrItemNums(opts = {}) {
  const { byItem, ...rest } = openPrsByItem(opts);
  return rest;
}
