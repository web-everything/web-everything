/**
 * @file scripts/readiness/lane-manifest.mjs
 * @description Durable lane manifest — the per-item source of truth for #2138's deferred merge queue
 *   (Fork 2, ruled: option a). A standalone `.lane-manifest.json` written as a NEW file in the WE lane
 *   commit, carrying each queued item's cross-repo shape so the drain can land it in a LATER session.
 *
 * WHY (#2138 Fork 2): today an item's cross-repo shape — which repos' `lane/*` refs form it, the
 * impl-first/WE-last merge order, and `blockedBy` edges BETWEEN queued items — lives ONLY in the
 * orchestrator's in-run memory (`pushedRefs` on the item result, plus `INTEGRATION_ORDER`) and evaporates
 * when the producing session ends. A deferred drain runs in a DIFFERENT session, so it needs that shape
 * persisted. This manifest is a SUPERSET of the in-run `pushedRefs` array: it also carries cross-ITEM /
 * cross-SESSION `blockedBy` (do-not-drain-until #PRED lands) and the `mergeRiskFiles` list Fork 3's
 * whitelisted-additive check reads — data the run-scoped array never held.
 *
 * WHY A STANDALONE FILE (not a fenced block in `backlog/NNN.md`): a NEW file is a one-sided ADD, which
 * preserves the #1869 conflict-free WE-lane merge and keeps the manifest out of the resolve diff a human
 * reviews. The drain DELETES it at landing (co-located with the `lane/*` ref deletion) so `main` carries
 * no post-drain cruft.
 *
 * WHO WRITES/DELETES IT: the lane agent writes it into the WE lane commit at push; the drain reads every
 * queued item's manifest to order the merges and deletes each at landing. Those call-sites live in the
 * relocated push+land flow owned by the drain/monitor command (#2162) — THIS item ships the primitive
 * (build / validate / parse / serialize / order) + the reader the drain consumes. Pairs with the
 * ready-to-merge token (#2161): the token says WHICH items are queued, the manifest says HOW to land each.
 *
 * This module is PURE — no fs, no process, no `Date` reads. The CLI / drain owns the fs at its boundary.
 */
import { isHash } from '../backlog/id.mjs';

/** An item/edge id is a numeric NNN (landed) or an `xNNNNNN` hash (provisional, #2288) — keep a hash as a
 * string, coerce a number to Number (backward compat with pre-#2288 numeric manifests).
 * Exported (#2388) — `merge-ai-prs.mjs`'s plan-label-drain cascade needs the SAME hash-aware coercion the
 * manifest builder uses. A bare `Number(v)` on a hash id (e.g. `"x5lail9"`) yields `NaN`, and a `Set` uses
 * SameValueZero equality where `NaN === NaN` — so EVERY hash-keyed item collapses into one indistinguishable
 * "open" bucket and every hash `blockedBy` edge spuriously matches every other hash item. `asItemId` keeps a
 * hash as its own distinct string so `Set.has`/`===` compare correctly. */
export const asItemId = (v) => (isHash(String(v)) ? String(v) : Number(v));
/**
 * True ONLY for a real item id: a POSITIVE integer NNN, a positive-integer digit string, or an `xNNNNNN` hash.
 *
 * #xc7p3q9 (B4) — the old `isHash(String(v)) || Number.isFinite(Number(v))` returned TRUE for `null`, `''`,
 * `' '`, `0`, `[]`, `false` (all coerce via `Number(...)` to a finite `0`) — so it could NOT tell a nameable
 * carrier apart from an unnameable one. A missing manifest `item` becomes `NaN` (`asItemId(undefined)`), which
 * `JSON.stringify` prints as `"item": null`, which re-normalizes to `0` on read — and the old predicate read
 * that `0` as nameable, so a carrier with no positively-named backlog item read healthy and its coupled impl
 * landed. This predicate is a fail-closed SECURITY oracle for the couple gate, so it must reject every value
 * that is not a positively-identified item (`null/undefined/''/' '/0/[]/{}/false/NaN/Infinity` → false). Keep
 * it in lock-step with the expression that COMPUTES the item (`asItemId`) so the two can never disagree.
 */
export const isItemId = (v) => {
  if (typeof v === 'number') return Number.isInteger(v) && v > 0;
  if (typeof v === 'string') {
    const s = v.trim();
    return isHash(s) || (/^\d+$/.test(s) && Number(s) > 0);
  }
  return false;
};

/** #2447 — a manifest `graduatedTo` → one trimmed line, or `null` for a non-string / empty / `none`. Pure. */
function normalizeManifestGraduatedTo(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\r\n]+/g, ' ').trim();
  return s && s.toLowerCase() !== 'none' ? s : null;
}

/** The manifest filename — a NEW file in the WE lane commit (one-sided add; drain deletes at landing). */
export const MANIFEST_FILENAME = '.lane-manifest.json';

/**
 * Merge order across the constellation (#96): impl repos first, WE last — WE carries the `active→resolved`
 * flip, so it lands only after every impl repo lands clean (a failed impl merge never leaves a false
 * `resolved`). Mirrors `INTEGRATION_ORDER` in the orchestrator; the drain (#2162) is the shared consumer.
 */
export const INTEGRATION_ORDER = ['frontierui', 'plateau-app', 'we'];

/** A repo's rank in {@link INTEGRATION_ORDER}; unknown repos sort AFTER known ones (stable, defensive). */
function orderRank(repo) {
  const i = INTEGRATION_ORDER.indexOf(repo);
  return i === -1 ? INTEGRATION_ORDER.length : i;
}

/**
 * Build a normalized manifest from an item's cross-repo shape. Repos are stored impl-first/WE-last so the
 * drain can merge them in order directly. `carriesResolve` marks the repo carrying the `active→resolved`
 * flip (always WE — the item + claims.json always live in WE); defaulted onto the `we` repo when omitted.
 * Pure — returns a plain object; run {@link validateManifest} for the invariants.
 *
 * `stackParents` (#2387 F3) — an `asItemId` list naming the frontier-tip item(s) this lane was cut from or
 * merged onto (overlap-stacked batching). A per-repo `base` (a commit SHA string) records the base each
 * repo's lane was reset to. Both are OPTIONAL and default to absent/empty — a manifest built without either
 * carries today's plain-sibling behavior unchanged (backward compatible). Neither is consumed by the drain
 * yet (that lands in the later `proof-gated-stacked-drain` slice); this is just the primitive + round-trip.
 *
 * `graduatedTo` (#2447) — the resolve's `graduatedTo` pointer (e.g. the SHA a dedup-resolve's deliverable already
 * landed in). OPTIONAL and presentation-only: review/label surfaces render it as the resolution-basis banner so a
 * backlog-only diff is not misread as a hollow resolve. It gates nothing. Omitted when absent or `none`.
 *
 * @param {{item:number|string, batchSlug?:string, repos:Array<{repo:string, ref:string, carriesResolve?:boolean, base?:string}>, stackParents?:Array<number|string>, blockedBy?:Array<number|string>, mergeRiskFiles?:string[], dismissedFindings?:number, graduatedTo?:string}} input
 */
export function buildManifest(input) {
  const item = asItemId(input.item); // NNN or provisional hash (#2288)
  const repos = (input.repos ?? [])
    .map((r) => ({
      repo: String(r.repo),
      ref: String(r.ref),
      // WE carries the resolve by default; honor an explicit flag otherwise.
      carriesResolve: r.carriesResolve != null ? !!r.carriesResolve : r.repo === 'we',
      // #2387 F3 — the commit SHA this repo's lane was based on (a predecessor lane tip when stacked, or
      // omitted for a plain sibling off origin/main). Optional; never written as an empty string. Carry a
      // non-string value RAW (un-coerced) rather than `String()`-flattening it: a `String()` here would turn
      // `base:123`→`'123'` and `base:{}`→`'[object Object]'`, both of which slip past validateManifest's
      // type guard as plausible strings. Passing it through raw keeps that guard REACHABLE so a malformed
      // base is actually rejected instead of silently coerced into a bad `git` argument.
      ...(r.base != null && r.base !== '' ? { base: r.base } : {}),
    }))
    .sort((a, b) => orderRank(a.repo) - orderRank(b.repo) || a.repo.localeCompare(b.repo));
  return {
    item,
    ...(input.batchSlug ? { batchSlug: String(input.batchSlug) } : {}),
    repos,
    // #2387 F3 — frontier-tip item(s) this lane was cut from / merged onto (overlap-stacking). Same
    // NNN-or-hash coercion as blockedBy; defaults to [] (a plain sibling lane, today's behavior).
    stackParents: (input.stackParents ?? []).map(asItemId).filter(isItemId),
    blockedBy: (input.blockedBy ?? []).map(asItemId).filter(isItemId),
    mergeRiskFiles: (input.mergeRiskFiles ?? []).map((f) => String(f)),
    // #2171 — the count of pre-PR review findings the lane DISMISSED (#2170). The drain's escalation rubric
    // reads it as its strongest signal (a lane judging its own reviewer's findings away → a second look). 0 default.
    dismissedFindings: Number.isFinite(Number(input.dismissedFindings)) ? Math.max(0, Number(input.dismissedFindings)) : 0,
    // #2447 — NORMALIZED here rather than validated: it is presentation-only, so a malformed value (a non-string, or
    // a body-edited `none`) is DROPPED instead of failing `validateManifest` and blocking the land over a banner.
    // Newlines collapse to one line; absent/empty/`none` is omitted so a plain manifest is byte-identical to before.
    ...(normalizeManifestGraduatedTo(input.graduatedTo) ? { graduatedTo: normalizeManifestGraduatedTo(input.graduatedTo) } : {}),
  };
}

/**
 * Validate a manifest's invariants. Returns `{ ok, errors }` (never throws) so the drain can surface a
 * malformed manifest as a skip-and-report rather than crashing the queue.
 *  - `item` is a finite number;
 *  - at least one repo, each with a `repo` + `ref`;
 *  - the WE repo is present (the item + claims.json + the resolve always live in WE);
 *  - EXACTLY ONE repo carries the resolve, and it is the WE repo (impl-first/WE-last atomicity).
 */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['manifest is not an object'] };
  if (!isItemId(m.item)) errors.push('item must be a numeric NNN or an xNNNNNN hash');
  const repos = Array.isArray(m.repos) ? m.repos : [];
  if (repos.length === 0) errors.push('repos must be a non-empty array');
  for (const r of repos) {
    if (!r || !r.repo) errors.push('a repo entry is missing `repo`');
    else if (!r.ref) errors.push(`repo "${r.repo}" is missing its lane \`ref\``);
    // #2387 F3 — `base` is optional, but when present it must be a git object hash: 7–64 hex chars. This
    // rejects (a) a non-string (bool/number/object — the reachable-guard case now that buildManifest no
    // longer String()-coerces it) and (b) any leading-dash / non-hex string. The stacked drain later
    // `git reset`s each repo to `base`; a value like `--upload-pack=…` would be an argument-injection
    // primitive, and this manifest rides the editable, un-reviewed PR body — so the shape check is a gate.
    else if (r.base != null && !(typeof r.base === 'string' && /^[0-9a-f]{7,64}$/i.test(r.base))) errors.push(`repo "${r.repo}" has an invalid \`base\` (must be a git object hash: 7–64 hex chars)`);
  }
  if (repos.length && !repos.some((r) => r.repo === 'we')) errors.push('the WE repo must be present (WE carries the resolve; the item + claims.json live in WE)');
  const carriers = repos.filter((r) => r.carriesResolve);
  if (repos.length && carriers.length !== 1) errors.push(`exactly one repo must carry the resolve (found ${carriers.length})`);
  else if (carriers.length === 1 && carriers[0].repo !== 'we') errors.push(`the resolve must be carried by WE, not "${carriers[0].repo}" (impl-first/WE-last)`);
  // #2387 F3 — stackParents, if present, must be an array of valid item ids (NNN or xNNNNNN hash).
  if (m.stackParents != null) {
    if (!Array.isArray(m.stackParents)) errors.push('stackParents must be an array');
    else if (!m.stackParents.every(isItemId)) errors.push('stackParents must contain only numeric NNN or xNNNNNN hash ids');
  }
  return { ok: errors.length === 0, errors };
}

/** Repos in merge order (impl-first, WE last) — the order the drain merges the item's `lane/*` refs. */
export function orderedRepos(m) {
  return [...(m?.repos ?? [])].sort((a, b) => orderRank(a.repo) - orderRank(b.repo) || a.repo.localeCompare(b.repo));
}

/**
 * #2390 — the manifest repo KEY (`we`/`frontierui`/`plateau-app`) for a git slug or short name. Pure. The
 * escalation scorers (the drain in `merge-ai-prs.mjs`, the producer in `pr-land.mjs`) hold a repo as an
 * `owner/name` slug or `null` (the cwd repo); the manifest keys it by the SHORT name, with `web-everything`
 * carried as `we` (its `INTEGRATION_ORDER` key). Maps a slug (`frontier-ui/frontierui` → `frontierui`), a bare
 * short name (`web-everything` → `we`), and passes an already-canonical key through. `null`/empty → `null`.
 *
 * A trailing `.git` is stripped BEFORE the short-name comparison — a raw `git remote get-url origin` value
 * (`git@github.com:web-everything/web-everything.git`) is a real live input to this function via
 * `scope-lease-collect.mjs`'s `repoKeyForLane`, not just a clean `owner/name` slug; without the strip, the
 * comparison never matches `'web-everything'`, and the WHOLE-URL-taken-as-slug case degrades to a raw
 * `web-everything.git` key instead of `we` (live incident, 2026-09-04) — silently mismatching every OTHER
 * repo-qualified path in the codebase, which all use the short `we:` form.
 * @param {string|null|undefined} slug
 * @returns {string|null}
 */
export function repoKeyFromSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const stripped = slug.replace(/\.git$/, '');
  const name = stripped.includes('/') ? stripped.split('/').pop() : stripped;
  return name === 'web-everything' ? 'we' : name;
}

/**
 * #2390 — the per-repo `base` SHA a lane was cut from, for a given manifest repo key, or `null` when the
 * manifest carries none for that repo (a plain sibling lane, or no manifest at all). Pure. Scoring a STACKED
 * lane's SIZE / blast-radius from THIS base (its predecessor's tip) instead of `origin/main` diffs it on its own
 * delta, killing cumulative-stack blast-radius inflation. A `null` return makes both scorers fall through to the
 * unchanged `origin/main` basis. NOTE (#2390-review-fix): this only de-inflates the SIZE basis — the gate-self /
 * `review:human` trigger always reads the cumulative `origin/main…head` set (see `computeNetDiffChangedFiles`'s
 * `humanBasisFiles`), so a self-declared/mis-set base here can never suppress a human review.
 * @param {{repos?:Array<{repo?:string, base?:string}>}|null|undefined} manifest
 * @param {string|null} repoKey
 * @returns {string|null}
 */
export function manifestBaseForRepo(manifest, repoKey) {
  if (!manifest || !Array.isArray(manifest.repos) || !repoKey) return null;
  const entry = manifest.repos.find((r) => r && r.repo === repoKey);
  return entry && typeof entry.base === 'string' && entry.base ? entry.base : null;
}

/** Tolerant parse of `.lane-manifest.json` text → a manifest object, or `null` on empty/invalid JSON. */
export function parseManifest(text) {
  if (!text || !text.trim()) return null;
  try {
    const raw = JSON.parse(text);
    return buildManifest(raw);
  } catch { return null; }
}

/**
 * PR-body carrier (xnsk54v) — the drain metadata belongs ON the PR, not committed into the tree. The lane
 * manifest rode `.lane-manifest.json` at the repo root, but every lane wrote the SAME path, so every open lane
 * PR conflicted with `main` there (#2198) — which forced the `rebase-drop-manifest` merge-fabrication step and
 * its per-pass merge-commit bloat. Since the producer already opens a ready-to-merge PR and the drain is the
 * ONLY consumer, the manifest lives in the PR body as a delimited fenced block instead: no tracked file, no
 * shared-path conflict, no rebase-drop. These helpers are the pure block writer/reader (the CLI/drain own gh).
 */
export const MANIFEST_BODY_BEGIN = '<!-- lane-manifest:begin -->';
export const MANIFEST_BODY_END = '<!-- lane-manifest:end -->';

/** The delimited PR-body block for a manifest — a human-visible fenced `json` payload between HTML-comment
 *  markers (the markers make extraction unambiguous even when a human edits the surrounding body). */
export function manifestBodyBlock(m) {
  const payload = JSON.stringify(m, null, 2);
  return `${MANIFEST_BODY_BEGIN}\n<details><summary>Lane manifest (drain metadata)</summary>\n\n\`\`\`json\n${payload}\n\`\`\`\n</details>\n${MANIFEST_BODY_END}`;
}

/** Embed (or REPLACE, idempotently) a manifest block in a PR body. A null/empty body yields just the block.
 *  Re-embedding on an already-carrying body swaps the block in place rather than appending a second one. */
export function embedManifestInBody(body, m) {
  const block = manifestBodyBlock(m);
  const base = body == null ? '' : String(body);
  const re = new RegExp(`${escapeRe(MANIFEST_BODY_BEGIN)}[\\s\\S]*?${escapeRe(MANIFEST_BODY_END)}`);
  // Use a function replacement so `$`-special sequences in the manifest JSON (`$&`, `$1`, `$$`) are
  // inserted literally rather than interpreted as String.prototype.replace substitution patterns.
  if (re.test(base)) return base.replace(re, () => block);
  return base.trim() ? `${base.replace(/\s*$/, '')}\n\n${block}\n` : `${block}\n`;
}

/** Extract a manifest from a PR body's delimited block → a parsed manifest, or null (no block / bad JSON). */
export function extractManifestFromBody(body) {
  if (!body) return null;
  const re = new RegExp(`${escapeRe(MANIFEST_BODY_BEGIN)}([\\s\\S]*?)${escapeRe(MANIFEST_BODY_END)}`);
  const m = String(body).match(re);
  if (!m) return null;
  const fenced = m[1].match(/```(?:json)?\s*([\s\S]*?)```/);
  return parseManifest(fenced ? fenced[1] : m[1]);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * Tamper-evidence audit line (xnsk54v follow-up) — a STABLE one-line record of the escalation-sensitive
 * manifest values the drain/merge automation ACTED ON when it made an escalation/land decision. Since the
 * manifest now rides the PR BODY (editable by anyone with write access, NOT part of the reviewed commit-set),
 * `dismissedFindings` (which feeds `scoreEscalation` — higher ⇒ MORE review scrutiny), `crossRepo`, and
 * `blockedBy` can be edited AFTER review to suppress the drain's re-score backstop with no commit trace. The
 * sibling commit-set-drift gate (#2409) does not catch a body-only edit (it doesn't advance HEAD). Recording
 * this line into a DURABLE, timestamped `gh pr comment` (separate from the body) makes such a post-review edit
 * DETECTABLE: diff the recorded acted-on values against the live body. Prevention is not the goal — evidence is.
 *
 * Pure and deterministic (stable key order, no `Date`/fs) so an unchanged decision yields byte-identical output
 * — that stability is what lets the reason-comment dedupe skip a re-post, and a CHANGED value post a fresh,
 * separately-timestamped comment (the tamper trail). Tolerant of missing/zero/empty inputs.
 *
 * Record FAITHFULLY — mirror what `scoreEscalation` actually acted on. The caller (merge-ai-prs.mjs ~line 891)
 * sets `v.dismissedFindings` with an `isFinite` guard ONLY, NOT a clamp — so a body edited to a finite negative
 * (e.g. `-4`, which scores LOWER = LESS scrutiny) is fed RAW to the escalation decision. Clamping it to 0 here
 * would make the record diverge from the acted-on value in EXACTLY the tamper scenario this fix targets,
 * silently defeating the record==acted-on invariant the whole fix rests on. So a finite value round-trips
 * verbatim (negatives included); coercion guards only NON-finite/undefined so the line can't crash or inject.
 *
 * OUTPUT CONTRACT — always a SINGLE line, no embedded newline and no HTML-comment marker, regardless of input.
 * The dedupe in `hasDrainReasonComment` relies on the line being one stable token (`body.includes(auditLine)`)
 * that can't be split by a smuggled newline nor spoof a marker into a `startsWith(marker)` scan. In the real
 * drain path `blockedBy` is `.map(Number)` upstream so entries are already numbers, but this exported helper is
 * called with raw values elsewhere — so each `blockedBy` entry is stringified and reduced to a safe allowlist:
 * only `[A-Za-z0-9_-]` survive. That is exactly the shape of a legitimate backlog id — numeric (`2151`) or slug
 * (`x7k2q9a`) — so real values round-trip verbatim, while every structural / injection character (CR/LF, the
 * line's own `, [ ]` delimiters, and the `< > !` a `<!-- … -->` marker needs) is dropped.
 *
 * #2390-review-fix — also records the per-repo stacked `base` the scorer de-inflated SIZE from (the same
 * value that rides the editable PR body), so the diff basis is part of the tamper-evident trail — a later body
 * edit of `base` becomes diff-detectable like the other acted-on values. Sanitized to a git object hash;
 * `none` when absent or malformed (mirrors what the scorer actually trusts).
 *
 * @param {{dismissedFindings?:number, crossRepo?:boolean, blockedBy?:Array<number|string>, base?:string}} [v]
 */
export function manifestAuditLine({ dismissedFindings, crossRepo, blockedBy, base } = {}) {
  const n = Number.isFinite(Number(dismissedFindings)) ? Number(dismissedFindings) : 0;
  const cross = !!crossRepo;
  const blocked = (Array.isArray(blockedBy) ? blockedBy : []).map((x) => String(x).replace(/[^A-Za-z0-9_-]/g, ''));
  const b = typeof base === 'string' && /^[0-9a-f]{7,64}$/i.test(base) ? base : 'none';
  return `manifest acted-on: dismissedFindings=${n} crossRepo=${cross} blockedBy=[${blocked.join(',')}] base=${b}`;
}

/** Serialize a manifest to `.lane-manifest.json` text (with a self-documenting `_doc` header). */
export function serializeManifest(m) {
  return JSON.stringify(
    {
      _doc:
        'Durable lane manifest for the #2138 deferred merge queue (Fork 2). A NEW file in the WE lane commit (one-sided add — preserves the #1869 conflict-free WE-lane merge, stays out of the resolve diff). Carries this queued item\'s cross-repo shape so a LATER drain session can land it: `repos` in impl-first/WE-last merge order (WE `carriesResolve`, lands last; each repo may carry an optional `base` commit-hash it was reset to for overlap-stacked batching, #2387 F3), cross-item `blockedBy` (do not drain until those land), `stackParents` (the frontier-tip item(s) this lane was cut from / merged onto, #2387 F3 — empty for a plain sibling), and `mergeRiskFiles` for Fork 3\'s whitelisted-additive check. The drain DELETES this file at landing (co-located with the lane/* ref deletion). Written/deleted by the drain command (#2162); built/validated by this module (#2163). Pairs with the ready-to-merge token (#2161).',
      ...m,
    },
    null,
    2,
  ) + '\n';
}
