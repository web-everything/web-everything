/**
 * check-standards-rules.mjs — pure, individually-testable rule bodies for the validator.
 *
 * `check-standards.mjs` is a top-to-bottom live script (it loads the real registries and
 * `process.exit`s), which makes a new rule's correctness — false-positive safety especially — a
 * manual, un-regressed check. This module factors the highest-value, context-pure rules out of that
 * script so they can be unit-tested with synthetic fixtures (see `scripts/__tests__/`). The script
 * stays the single source of live behavior: it *imports and composes* these, so the test exercises
 * the exact code the production gate runs (backlog #251).
 *
 * Each rule takes already-loaded data + an item and returns `{ errors, warnings }`, where every entry
 * is `{ message, descriptor? }` — identical to what `check-standards.mjs` pushes — so the descriptor
 * feed (#095/#196/#197) and the human output are unchanged.
 */

import { validateFidelityContract } from './lib/fidelity-contract.mjs';
import { coversFile, isSubtreeEntry } from './readiness/scope-lease.mjs';
import { scrubPublish } from './lib/secret-scrub.mjs';
// #3637 — the POC-branch registry's own `deliveryTarget:` predicate, so the gate and the scoped per-item
// lint validate that field with the ONE function the dispatcher also uses (never a second copy of the rule).
import { validateDeliveryTarget } from './lib/poc-branches.mjs';

/** #2866: literal invisible characters are forbidden even in Markdown prose and fixtures.
 * Use visible Unicode escapes to document/test them. Offsets use zero-based UTF-16 code units.
 * Callers supply repository-relative, normalized paths; binary assets are not source text.
 */
export function scanInvisibleCharacters(docs) {
  const names = { '\u200b': 'U+200B (zero-width space)', '\ufeff': 'U+FEFF (BOM / zero-width no-break space)',
    '\u00a0': 'U+00A0 (non-breaking space)' };
  return docs.flatMap(({ file, content }) => {
    if (!/^(scripts|docs)\//.test(file)) return [];
    return [...content.matchAll(/[\u200b\ufeff\u00a0]/g)].map((hit) => ({
      message: `${file}: forbidden ${names[hit[0]]} at offset ${hit.index} (zero-based UTF-16); ` +
        'remove it, use an ordinary space, or write a visible Unicode escape (#2866).',
      descriptor: { kind: 'invisible-character', fix: 'model', file, offset: hit.index,
        line: content.slice(0, hit.index).split('\n').length },
    }));
  });
}

/**
 * #3960 (multi-repo slice 4) — conveyor briefs that `cd` INTO an acquired lane clone and then invoke a WE tool
 * by a RELATIVE `node scripts/...` path are wrong the moment that lane's checkout is not WE's own: there is no
 * `scripts/` directory to find at that relative location, because the agent's cwd is the TARGET repo, not WE
 * (`we:reports/2026-09-23-conveyor-multi-repo-gap-map.md`, root cause 2 — "the tools' repo is the target repo").
 * The fix is to qualify every such call with an absolute WE root (`{{WE_ROOT}}` in the templates this repo
 * ships); this scan is what keeps that qualification from silently rotting back to a relative path.
 *
 * WHY THIS IS NOT EVERY `skills-src/conveyor/*.md`. `delivery-agent-brief.md` (and its v2, plus the
 * investigation/prepare-scope/prepare-decision briefs) also `cd "$LANE"` and then call WE tools by relative
 * path — but THEIR `$LANE` is acquired with no `--repo=` at all (`lane-pool.mjs acquire --lane=… --item=…`, no
 * repo flag), so it is always a WE lane by construction; a cross-locus build's SECOND, impl-repo lane is a
 * DIFFERENT variable acquired separately and never `cd`-relied-on for a WE tool call. `fix-agent-brief.md` /
 * `fix-agent-ci-brief.md` are different: `{{LANE_REF}}` is an EXISTING PR's head ref, which under multi-repo
 * fix/ci-heal dispatch (slice 5, not turned on by this item) can belong to any constellation repo — so THEIR
 * lane is the one that can silently stop being WE's own. {@link WE_ONLY_LANE_CONVEYOR_BRIEFS} names the briefs
 * exempt for that reason; anything NOT listed is checked by default, so a new conveyor brief earns the same
 * bug-closed default the rest of this file uses rather than needing to remember to opt in.
 */
export const WE_ONLY_LANE_CONVEYOR_BRIEFS = new Set([
  'skills-src/conveyor/delivery-agent-brief.md',
  'skills-src/conveyor/delivery-agent-brief-v2.md',
  'skills-src/conveyor/investigation-agent-brief.md',
  'skills-src/conveyor/prepare-decision-agent-brief.md',
  'skills-src/conveyor/prepare-scope-agent-brief.md',
]);

/**
 * Find every RELATIVE `node scripts/...` invocation that appears AFTER a `cd "$LANE"` / `cd "{{SOME_TOKEN}}"`
 * line, in any `skills-src/conveyor/*.md` brief not in {@link WE_ONLY_LANE_CONVEYOR_BRIEFS}. Pure; takes the
 * same `{file, content}[]` shape every other rule here does (the recursive `skills-src` markdown walk
 * `check-standards.mjs` already builds for the #3224/#3253 scans).
 *
 * "AFTER", once tripped, stays tripped for the REST OF THE FILE — not just the same fenced code block. A brief
 * `cd`s into its lane once (near the top) and then references WE tools across many separate steps/headers for
 * the rest of the document; the bug is exactly as real in step 7 as it would be immediately after the `cd`.
 *
 * A qualified call — `node "{{WE_ROOT}}/scripts/..."` or `node "/abs/path/scripts/..."` — never matches: the
 * regex requires `scripts/` to follow `node` (plus optional whitespace/quote) immediately, and an interposed
 * `{{WE_ROOT}}`/absolute segment breaks that adjacency.
 * @param {Array<{file: string, content: string}>} docs
 * @returns {{errors: Array<{message: string, descriptor: object}>, warnings: []}}
 */
export function findRelativeNodeScriptsAfterLaneCd(docs) {
  const CD_LANE_RE = /\bcd\s+"(?:\$LANE|\{\{[A-Za-z0-9_]+\}\})"/;
  const RELATIVE_NODE_SCRIPTS_RE = /\bnode\s+"?scripts\//;
  const errors = docs.flatMap(({ file, content }) => {
    if (!/^skills-src\/conveyor\/.*\.md$/.test(file) || WE_ONLY_LANE_CONVEYOR_BRIEFS.has(file)) return [];
    const lines = String(content ?? '').split('\n');
    let afterCd = false;
    const found = [];
    lines.forEach((line, i) => {
      if (!afterCd) {
        if (CD_LANE_RE.test(line)) afterCd = true;
        return;
      }
      if (RELATIVE_NODE_SCRIPTS_RE.test(line)) {
        found.push({
          message: `${file}:${i + 1}: a relative \`node scripts/...\` call after \`cd "$LANE"\`/\`cd "{{…}}"\` — `
            + 'that lane may not be a WE checkout, so there is no `scripts/` directory at this relative path. '
            + 'Qualify the tool with an absolute WE root (e.g. `node "{{WE_ROOT}}/scripts/..."`) (#3960).',
          descriptor: { kind: 'conveyor-brief-relative-node-after-lane-cd', fix: 'model', file, line: i + 1 },
        });
      }
    });
    return found;
  });
  return { errors, warnings: [] };
}

// ── Definition-of-green THRESHOLD registry (#2786) ─────────────────────────────────────────────
// check-standards.conformance.test.mjs proves no definition-of-green knob escapes
// check-standards.contract.json. The suite's two knob classes use two different discovery
// strategies, because they differ in kind:
//   • ENFORCEMENT flags are homogeneous (every one is a boolean), so the suite auto-discovers them
//     by `typeof export === 'boolean'` — a future flag is caught regardless of its name, closing
//     the #2786 gap where a `_ENFORCED`-suffix name heuristic would miss a flag named anything else.
//   • THRESHOLDS are heterogeneous (numbers, Sets, arrays, strings, a bound regex) — no runtime
//     predicate distinguishes a definition-of-green tuning knob from an unrelated exported constant
//     (this module exports many constants that are reference data, not a pass/fail boundary). So this
//     list is maintained BY HAND: every symbol here names a value a check compares a finding against
//     to decide a pass/fail (or error/warning) boundary — almost always a HARD-ERROR allowed-set/bound
//     with no accompanying warn-first flag (BACKLOG_KINDS-style, or the allowed-set companion of an
//     already-declared enforcement flag, e.g. MANDATE_FENCE_ALLOWED_PARAMS alongside
//     UNFENCED_MANDATE_ENFORCED). DIGEST_MAX_WORDS, LOCK_POINT_CODE_LINES_THRESHOLD,
//     LOCK_POINT_COLLISIONS_THRESHOLD and SCOPE_BASENAME_MAX_SUGGESTIONS are the warn-only exceptions
//     (an independent review caught the first attempt at this registry naming DIGEST_MAX_WORDS as "the
//     one" exception, which was itself false — these three are permanently-warn numeric budgets in
//     exactly the same shape, #2678/#3337), kept here because widening any of them still loosens a real
//     budget the contract governs, even though nothing downgrades an error to a warning for them.
//     Adding a new such knob to the engine means adding its symbol HERE *and* its value to the
//     contract's `thresholds` — two independent declarations that must agree (checked by the
//     conformance suite), so a silent widening of either turns the suite red.
// RESIDUAL GAP (accepted, not closed by either strategy): a boolean or bound INLINED at its call site
// — never a named export — is invisible to both discovery strategies. Only a named export can be
// governed this way; that is the boundary of what a coverage guard over `import * as rules` can see.
export const THRESHOLD_KNOBS = new Set([
  'FIB',
  'DIGEST_MAX_WORDS',
  'MANDATE_FENCE_ALLOWED_PARAMS',
  'BACKLOG_KINDS',
  'BACKLOG_STATUSES',
  'PARKED_REASONS',
  'STANDARD_ENTITY_KINDS',
  'LIFECYCLE',
  'PROJECT_TIERS',
  'CAP_POLYFILL',
  'REFERENCE_RUNTIME_FORMS',
  'LOCUS_NAMES',
  'TIER_STATES',
  'LIBRARY_TIER_STATES',
  'MATURITY_TRIGGER_RE',
  'PILOT_EVIDENCE_NUMS',
  'POLYGLOT_WIDENING_TAG',
  'POLYGLOT_CARVEOUT_TAGS',
  'STRANDED_HASH_GRACE_SECONDS',
  'PLUG_SHARED_CORE_FILES',
  'WEBEVERYTHING_PUBLISHED_SCOPE',
  'MODULE_RESOLUTION_LOCKED_SCOPE',
  'DERIVED_ARTIFACT_DIRS',
  'PLAYWRIGHT_CONTAINER_PIN_REQUIRED_FILES',
  'GITHOOK_ALL_ALLOW',
  'GRADUATED_REF',
  'SURFACE_ZONE_PREFIXES',
  'LOCK_POINT_CODE_LINES_THRESHOLD',
  'LOCK_POINT_COLLISIONS_THRESHOLD',
  'SCOPE_BASENAME_MAX_SUGGESTIONS',
]);
// NOT in this registry, by necessity rather than oversight:
//   • SITE_SURFACE_MATCHERS / STANDARD_SURFACE_MATCHERS (check-standards-rules.mjs) gate the SAME hard
//     error `classifySurfacePaths` feeds (via SURFACE_ZONE_PREFIXES, above) the same unconditional way,
//     but each is an array of ARROW-FUNCTION predicates — not JSON-representable, so neither this
//     registry's string-symbol list nor the contract's JSON `value` field can hold them.
//   • COMPOSE_DENY_LIST is the allowed-set companion of the already-declared COMPOSE_TRAITS_ENFORCED
//     flag (same shape as MANDATE_FENCE_ALLOWED_PARAMS/UNFENCED_MANDATE_ENFORCED above) but each rule
//     embeds a `signature` array of REGEXES inside an object — also not representable as one JSON
//     `value` the conformance suite's `sameValue` can compare, so pinning it here would either need a
//     new comparison shape or silently pass without actually checking the signatures.
// A silent narrowing of any of these is a real gate weakening this mechanism cannot see; closing that
// gap would need a different representation (e.g. named, individually-declared predicates/signatures)
// than this #2786 registry provides. Documented here so each reads as a known boundary, not a missed
// entry.
//
// ALSO NOT in this registry, but for a different reason — out of the check:standards GATE entirely
// today: HTML_ELEMENTS (findRawHtmlInMarkdown), FORK_HEADING_TERMS (findBuriedForkSections) and
// NON_BATCHABLE_MARKERS (findNonBatchableMarkers) are pure, unit-tested rule functions with no caller
// anywhere in check-standards.mjs — verified by a repo-wide grep for each function name. A knob that
// gates nothing the gate actually runs is out of scope for "the check:standards gate's definition of
// green" by the contract's own stated boundary (see check-standards.contract.json's `summary`); wiring
// any of the three into the gate is a separate, first-class change that would earn its own THRESHOLD_KNOBS
// entry at that point, not before.

// Backlog operational axis (not the implementation lifecycle) + agile sizing — see
// docs/agent/backlog-workflow.md. Exported so the script and the tests share one definition.
// `preparing` (#375) — a decision being researched by /prepare: non-open + in-flight (drops from
// selection like `active`) but distinct on the board from a story mid-build.
export const BACKLOG_STATUSES = new Set(['open', 'active', 'preparing', 'parked', 'resolved']);
// Valid `parkedReason` values (#1392) — the machine-readable WHY a non-epic item is parked, mirror of an
// epic's childlessReason. Vocab + pill colours live in backlogMeta.js `parkedReasonMeta`.
// Tightened 2026-06-22 (parked-item sweep): parking is NOT a prioritisation escape. A park must reduce to a
// real structural reason — a `blockedBy` edge, a `humanGate` (human-only action), or being a `kind: decision`
// (decisions live in the decision lane, not parked). The soft `deferred`/`superseded`/`external-infra`
// reasons are retired; the ONLY standalone `parkedReason` left is `platform-gated` (held on a web-platform
// capability shipping in browsers — not a backlog item or a human action).
// #1620 added `maturityGated` — held because building NOW would yield a worse artifact (guess the shape,
// tune against no integration, automate the unproven). It REQUIRES a typed, externally-verifiable
// `maturityTrigger` (see MATURITY_TRIGGER_RE) — the gate errors on a maturityGated item without one, which
// is exactly what keeps it from being a soft `deferred` 2.0 escape.
export const PARKED_REASONS = new Set(['platform-gated', 'maturityGated']);
// A `maturityGated` park's `maturityTrigger` must name a COUNTER or an external artifact's EXISTENCE — never
// a date or bare "later". One of: `externalConsumers>=N` · `realRuns>=N` · `adoptionSignal:<named milestone>`.
export const MATURITY_TRIGGER_RE = /^(externalConsumers>=\d+|realRuns>=\d+|adoptionSignal:\s*\S.+)$/;
// One `kind` axis (#466/#487) — the merged nature+hierarchy field that replaced the former two
// correlated axes (`type ∈ idea|issue|decision` + `workItem ∈ story|epic|task`). `story|epic|task` keep
// the sizing/hierarchy semantics; `decision` keeps Tier-B + fork validation. `size` stays a separate
// orthogonal field; fix-vs-feature, if ever wanted, is an optional `tags: [fix]` (never a field).
// `feature` (#2691, ratified 2026-08-08) is the grouping tier ABOVE epic — a root, flat, non-buildable
// grouping node (epic-parity: never Tier-A, never sized as buildable work). See
// docs/agent/backlog-workflow.md#feature-tier for the full ruling; #2998 is the plumbing tax it names.
// `investigation` (#3567) is a THIRD non-build lifecycle beside `decision` — investigate -> synthesize ->
// report, optionally filing children, never a build/PR of its own work. Like `decision` it carries no
// `scope:` and is held (`needs-investigation`) before the scope gate — see
// `we:scripts/readiness/dispatch-plan.mjs`'s `item.kind === 'investigation'` branch — but it is NOT a
// `decision` (no fork to ratify) and NOT a grouping kind (it has no children of its own by definition).
export const BACKLOG_KINDS = new Set(['story', 'epic', 'task', 'decision', 'feature', 'investigation']);
// The repo's single "build kind" rule: every kind except `decision` ships work (story/task build leaves,
// epic is the umbrella). This is the canonical form of proposer.mjs's `isBuildable` and the backlog-health
// audit's G2/G3 exec gate — keeping it here, beside the kind set, means a future kind rename surfaces it.
// Defined as `!== 'decision'` (not a positive list) on purpose: a NEW build kind is auto-covered, and the
// only silent-death vector is `decision` itself being renamed — pinned by the kinds test (#1473).
// `investigation` (#3567) IS exec-kind here too, even though it never reaches `spawnBuilds`: this axis means
// "ships SOME resolution work" (a decision ships nothing but a ratified fork), not "builds code" — an
// investigation ships its own report/filed-items resolution, which is exactly `isExecKind`'s A1
// done-when-proof gate's intent (an open investigation still owes a provable "done when"). The actual
// build-vs-not routing lives in `we:scripts/readiness/dispatch-plan.mjs`'s per-kind branches, not here.
export const isExecKind = (kind) => kind !== 'decision';
// GROUPING kinds (#2998) — the container kinds that are never directly buildable: they hold no `scope:`,
// never carry burndown `size` as buildable work, and are never dispatched to build — their work lives in
// their children (an epic's stories/tasks, a feature's epics), so the readiness/dispatch layer must HOLD
// them (needs-slice) rather than let them reach the build path, exactly like `deriveSliceable` in
// src/_data/backlog.js treats them as one pool. `feature` (#2691) is epic-parity BY DESIGN — the grouping
// tier ABOVE epic — so a future grouping kind only needs adding here once, not at every scattered
// `kind === 'epic'` call site (scripts/readiness/dispatch-plan.mjs, scripts/readiness/conveyor-state.mjs).
export const isGroupingKind = (kind) => kind === 'epic' || kind === 'feature';
// G3 subject scope (#1498) — the backlog-health "ungoverned-arch" gate fires only when a build graduated
// to a new named STANDARD ENTITY (a governable architectural noun), not a routine file-path / locus-prefixed
// graduation (`we:`/`fui:`/`plateau:scripts/...`) or a `demo:`. The principle: a governance gate's subject is
// governable architecture, not impl — a file landing in an existing subsystem is settled arch and needs no
// fresh decision. The `:` anchor discriminates: entity kinds always carry `<kind>:<name>`; locus paths use a
// repo prefix; free-text graduations have no clean prefix. Pinned by exec-kind.test.mjs so a future
// `graduatedTo` grammar change can't silently re-broaden (back to ~350) or re-kill (to 0) G3.
export const STANDARD_ENTITY_KINDS = new Set(['block', 'intent', 'protocol', 'project', 'plug', 'capability', 'adapter']);
export const isEntityGraduation = (graduatedTo) => {
  if (typeof graduatedTo !== 'string') return false;
  const m = graduatedTo.match(/^([a-z]+):/);
  return !!m && STANDARD_ENTITY_KINDS.has(m[1]);
};
// Repo-LOCUS (backlog-workflow.md → "Repo-locus") — the declarative per-locus gate registry (#498/#500).
// An item's `locus` is its **gate home**: which repo's gate can honestly CLOSE it. A cross-locus `/batch`
// is locus-agnostic — it packs items of any locus and gates **each in its own locus** using this record:
//   `repoPath`     — dir (relative to the WE root) to run the gate in; `.` = this repo.
//   `gateCommand`  — the close-out gate that must be green before resolving an item of this locus.
//   `devServerProbe` — the canonical dev port to DETECT-or-skip for a render check (never spin/kill one).
//   `commitTarget` — the repo the per-item commit lands in (commits are per-repo, never `git add -A` across).
//   `closeoutDiscipline?` — an extra, non-skippable close-out rule beyond the gate (exercise-app only).
// `webeverything` is the default. The inferred values in src/_data/backlog.js `inferLocus`
// (frontierui / plateau-app / exercise-app) must stay a subset of these keys.
export const LOCI = {
  webeverything: { repoPath: '.', gateCommand: 'npm run check:standards', devServerProbe: 3000, commitTarget: 'webeverything' },
  frontierui: { repoPath: '../frontierui', gateCommand: 'npm run check:standards', devServerProbe: 6000, commitTarget: 'frontierui' },
  'plateau-app': { repoPath: '../plateau-app', gateCommand: 'npm test', devServerProbe: 4000, commitTarget: 'plateau-app' },
  'exercise-app': {
    repoPath: '.',
    gateCommand: 'npm run check:standards && npm run check:app-conformance',
    devServerProbe: 3000,
    commitTarget: 'webeverything',
    closeoutDiscipline: 'platform-first build; if you must bypass a standard, tag a GAP — a required, non-skippable close-out step (see /exercise-app)',
  },
};
// The hard-error boundary LOCI actually gates (`validateReadinessTargets` / item.locus) is just the
// KEY set — the per-locus gateCommand/devServerProbe/commitTarget are operational routing, never
// compared against a finding. Declared separately so the #2786 threshold registry governs exactly
// the allowed-set that can loosen the gate, not LOCI's full operational config.
export const LOCUS_NAMES = new Set(Object.keys(LOCI));
export const FIB = new Set([1, 2, 3, 5, 8, 13]);
// The digest is each item's lead paragraph (the loader's derived `summary`), surfaced for one-glance
// selection. Presence is a required-field error; length is a soft nudge — a runaway opener defeats the
// "scan, don't read the body" purpose. Accuracy (does it still describe the item?) is a review-time
// concern, not mechanical. See docs/agent/backlog-workflow.md → "The digest".
export const DIGEST_MAX_WORDS = 100;

// ── Failure descriptors (#095 → fed to the auto-fix agent #196) ────────────────
// A required field declared in the spec but absent — the model fixer supplies a value.
export const dMissingField = (entity, id, file, field) =>
  ({ kind: 'missing-required-field', fix: 'model', entity, id, file, field });
// A cross-reference whose value doesn't resolve in its target registry — model judgment (typo vs.
// genuinely-missing entity), so `model`. `refRegistry` names the registry the value should resolve in.
// `global: true` — a cross-registry JOIN: in an isolated `--local` worktree the referent may live in a
// sibling lane or a not-yet-regenerated registry, so this defers to the integrator's per-merge gate (#1159).
export const dUnresolvedRef = (entity, id, file, field, value, refRegistry) =>
  ({ kind: 'unresolved-ref', fix: 'model', entity, id, file, field, value, refRegistry, global: true });

// graduatedTo compact ref shape (#247): a single lowercase kind, a colon, and a kebab/underscore slug
// — no spaces, slashes, or dots, so prose / paths / URLs / the `none` sentinel never match and stay
// free-form (the sanctioned alternative, left untouched).
export const GRADUATED_REF = /^([a-z][a-z]*):([A-Za-z0-9_-]+)$/;

// #614 — graduatedTo canonical form. The field must lead with a resolvable entity reference so the
// audit's G3 lineage walk and entity-graph joins can read it: `none`, a resolving `<kind>:<id>`, a repo
// path, or a bare id resolvable in a registry (which `normalize-graduated.mjs` upgrades to `<kind>:<id>`).
// A trailing annotation after that leading token is tolerated; pure prose where the entity is buried mid-
// sentence (or absent) is NOT canonical — it belongs in the body. Returns true for the object (crossRef)
// form, which is a different legacy shape this rule doesn't police.
const GRAD_REPO_PATH_LEAD = /^[A-Za-z0-9_.@-]+\/[A-Za-z0-9_.@{}-]+/;   // leading token carries a path separator
export function isCanonicalGraduated(value, graduatedKinds) {
  if (typeof value !== 'string') return true;
  const v = value.replace(/\s+#\s.*$/, '').trim();                     // strip a YAML end-of-line comment
  if (v === '' || v === 'none') return true;
  const lead = v.split(/\s+/)[0].replace(/[.,;]+$/, '');
  const typed = /^([a-z]+):([A-Za-z0-9_-]+)$/.exec(lead);
  if (typed) { const reg = graduatedKinds[typed[1]]; return !!reg && reg.ids.has(typed[2]); }
  if (GRAD_REPO_PATH_LEAD.test(lead)) return true;
  return Object.values(graduatedKinds).some((r) => r.ids.has(lead));   // bare id resolvable in some registry
}

/**
 * Build the graduatedTo `kind → { ids, file }` resolution table from the loaded registries. A
 * graduatedTo written in the compact `kind:slug` form is resolved against the matching registry, so a
 * typo'd kind or a stale slug is caught instead of silently silencing the nudge. Adapters are assembled
 * from the per-adapter specs (src/_data/adapters/<id>.json, #1938) into the nested `items[]` groups; the
 * `adapters.json#<id>` graduatedTo anchor stays virtual (the monolith file is gone).
 */
export function buildGraduatedKinds({ blocks = [], intents = [], protocols = [], projects = [], plugs = [], capabilityIds = new Set(), adapters = [], demos = [] }) {
  return {
    block: { ids: new Set(blocks.map((b) => b.id)), file: 'blocks.json' },
    intent: { ids: new Set(intents.map((i) => i.id)), file: 'intents.json' },
    protocol: { ids: new Set(protocols.map((p) => p.id)), file: 'protocols.json' },
    project: { ids: new Set(projects.map((p) => p.id)), file: 'projects.json' },
    plug: { ids: new Set(plugs.map((p) => p.id)), file: 'plugs.json' },
    capability: { ids: capabilityIds instanceof Set ? capabilityIds : new Set(capabilityIds), file: 'capabilities.json' },
    adapter: { ids: new Set(adapters.flatMap((a) => (a.items || []).map((i) => i.id))), file: 'adapters.json' },
    demo: { ids: new Set(demos.map((d) => d.id)), file: 'demos.json' },
  };
}

/**
 * Validate a single backlog item's fields and outward references.
 *
 * Pure: all I/O is injected via `ctx`, so the rule is exercisable with synthetic items.
 * @param item  one backlog entry (frontmatter fields, incl. derived `num`).
 * @param ctx   { projectById: Map, graduatedKinds: object (buildGraduatedKinds output),
 *                knownNums: Set<string> (every item's `num`, for parent resolution),
 *                reportExists: (relPath: string) => boolean (relatedReport file probe) }
 * @returns { errors: Array<{message, descriptor?}>, warnings: Array<{message, descriptor?}> }
 */
export function validateBacklogItem(item, ctx) {
  const { projectById, graduatedKinds, knownNums, reportExists } = ctx;
  const errors = [];
  const warnings = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  const warn = (m, descriptor) => warnings.push({ message: m, descriptor });

  const backlogFile = item.id ? `backlog/${item.id}.md` : undefined;
  for (const f of ['id', 'title', 'kind', 'status', 'summary', 'dateOpened']) {
    if (item[f] === undefined || item[f] === null || item[f] === '')
      err(`Backlog item "${item.id || '<no id>'}" missing required field "${f}"`,
        dMissingField('Backlog', item.id, backlogFile, f));
  }
  // Digest length nudge — the lead paragraph is surfaced for one-glance selection; keep it scannable.
  if (typeof item.summary === 'string') {
    const words = item.summary.split(/\s+/).filter(Boolean).length;
    if (words > DIGEST_MAX_WORDS)
      warn(`Backlog item "${item.id}" digest (lead paragraph) is ${words} words — keep it under ${DIGEST_MAX_WORDS} for one-glance selection`);
  }
  if (item.kind && !BACKLOG_KINDS.has(item.kind))
    err(`Backlog item "${item.id}" has invalid kind "${item.kind}" (expected ${[...BACKLOG_KINDS].join(' / ')})`);
  if (item.status && !BACKLOG_STATUSES.has(item.status))
    err(`Backlog item "${item.id}" has invalid status "${item.status}" (expected ${[...BACKLOG_STATUSES].join(' / ')})`);
  // Parked items must carry a machine-readable reason (#1392) — parking is a deliberate hold and the WHY
  // must be first-class + surfaced as a pill, never buried in prose. A reason is derivable from a real
  // `blockedBy` edge (pills "blocked by #N"), a `humanGate`, a `parkedReason`, or — for an epic — a
  // `childlessReason`. None of those → hard error.
  if (item.status === 'parked') {
    if (item.parkedReason && !PARKED_REASONS.has(item.parkedReason))
      err(`Backlog item "${item.id}" has invalid parkedReason "${item.parkedReason}" (expected ${[...PARKED_REASONS].join(' / ')})`);
    // A `maturityGated` park MUST carry a typed, externally-verifiable `maturityTrigger` (#1620) — the
    // guard that keeps it from being a soft `deferred` 2.0 escape. Missing/untyped/date-only → hard error.
    if (item.parkedReason === 'maturityGated' &&
        (typeof item.maturityTrigger !== 'string' || !MATURITY_TRIGGER_RE.test(item.maturityTrigger.trim())))
      err(`Backlog item "${item.id}" is \`parkedReason: maturityGated\` but lacks a typed \`maturityTrigger\` ` +
        `— it must name a counter or an external artifact's existence: \`externalConsumers>=N\` · ` +
        `\`realRuns>=N\` · \`adoptionSignal:<named milestone>\` (never a date or bare "later"). That typed ` +
        `trigger is what makes maturityGated a real hold, not a soft "deferred" escape (#1620).`);
    const hasEdge = Array.isArray(item.blockedBy) && item.blockedBy.length > 0;
    if (!hasEdge && !item.humanGate && !item.parkedReason && !item.childlessReason)
      err(`Backlog item "${item.id}" is \`status: parked\` but carries no machine-readable reason — parking is ` +
        `NOT a prioritisation escape. Reduce it to a real structural state: a \`blockedBy\` edge (file the ` +
        `prereq as its own card if missing), a \`humanGate\` (human-only action), \`kind: decision\` + ` +
        `\`status: open\` (let the decision lane rank it), or \`parkedReason: platform-gated\` (held on a ` +
        `browser-platform capability). Soft "deferred" holds are retired (#1392, tightened 2026-06-22). ` +
        `See docs/agent/backlog-workflow.md → Parking.`);
  }
  // Repo-locus: an AUTHORED `locus:` must be a known registry key (a typo'd locus → the batch runs the
  // wrong/nonexistent gate at close-out → hard error). An item whose tags INFERRED a cross-repo locus but
  // never declared it gets a nudge (warning) to make the gate home explicit — so which repo's gate closes
  // it rests on an author choice, not a tag heuristic. (Loader-derived item.locus/locusAuthored; absent on raw fixtures.)
  if (item.locusAuthored && !Object.hasOwn(LOCI, item.locus))
    err(`Backlog item "${item.id}" has invalid locus "${item.locus}" (expected ${Object.keys(LOCI).join(' / ')})`);
  else if (!item.locusAuthored && item.locus && item.locus !== 'webeverything' && item.batchable)
    warn(`Backlog item "${item.id}" reads as locus "${item.locus}" (inferred from its tags/parent) but has no explicit \`locus:\` — a cross-locus /batch will gate it with ${item.locus}'s gate; set \`locus: ${item.locus}\` to confirm, or \`locus: webeverything\` if it's actually built and gated here`);
  if (item.relatedProject && !projectById.has(item.relatedProject))
    err(`Backlog item "${item.id}" relatedProject "${item.relatedProject}" does not resolve in projects.json`,
      dUnresolvedRef('Backlog', item.id, backlogFile, 'relatedProject', item.relatedProject, 'projects.json'));
  if (item.relatedReport && !reportExists(item.relatedReport))
    err(`Backlog item "${item.id}" relatedReport does not exist: ${item.relatedReport}`,
      dUnresolvedRef('Backlog', item.id, backlogFile, 'relatedReport', item.relatedReport, 'reports/'));
  if (item.crossRef && (!item.crossRef.url || !item.crossRef.label))
    err(`Backlog item "${item.id}" crossRef must have both "url" and "label"`);
  // graduatedTo records the entity a resolved item became. It doesn't apply to outcomes that aren't a
  // new entity: a `task` (bounded sub-work / a fix that rolls up) or a `decision` (a ruling). A resolved
  // `story`/`epic` that produced no entity sets the sentinel `graduatedTo: none`; any present value
  // silences this nudge. (Pre-#487 this exempted `issue`; issues are now `story`/`task` by kind, so the
  // fix-class exemption maps to `task`.)
  if (item.status === 'resolved' && !item.graduatedTo && !['task', 'decision'].includes(item.kind))
    warn(`Backlog item "${item.id}" is resolved but has no graduatedTo — record what it became`);
  // #247 — resolve the value, not just its presence. A compact `kind:slug` ref must have a known kind
  // and a resolving slug; the `none` sentinel and every free-form value don't match GRADUATED_REF and
  // are left untouched.
  if (typeof item.graduatedTo === 'string') {
    const gm = GRADUATED_REF.exec(item.graduatedTo.trim());
    if (gm) {
      const [, kind, slug] = gm;
      const reg = graduatedKinds[kind];
      if (!reg)
        err(`Backlog item "${item.id}" graduatedTo "${item.graduatedTo}" uses unknown kind "${kind}" — expected one of ${Object.keys(graduatedKinds).join(' / ')}, the sentinel "none", or a free-form description of what it became`);
      else if (!reg.ids.has(slug))
        err(`Backlog item "${item.id}" graduatedTo "${kind}:${slug}" does not resolve to a known ${kind} in ${reg.file}`,
          dUnresolvedRef('Backlog', item.id, backlogFile, 'graduatedTo', `${kind}:${slug}`, reg.file));
    }
  }

  // ── Agile sizing — drives the /backlog/ burndown (keyed on the merged `kind` axis, #487) ──
  // `kind` presence + enum are checked above; here only the size-by-kind constraints. A `story` requires
  // Fibonacci points; a `task` is never sized (rolls up to a parent); an `epic` is sized only while
  // unsliced (the sized-epic-with-children double-count is caught in check-standards.mjs); a `decision`
  // carries an optional size (its analysis effort) — no constraint.
  if (item.size !== undefined && !FIB.has(item.size))
    err(`Backlog item "${item.id}" has non-Fibonacci size "${item.size}" (expected one of ${[...FIB].join(', ')})`);
  if (item.kind === 'story' && item.size === undefined)
    err(`Backlog item "${item.id}" is a story but has no size — every story must carry Fibonacci points`);
  if (item.kind === 'task' && item.size !== undefined)
    err(`Backlog item "${item.id}" is a task but has a size — tasks are never sized (they roll up under a story/epic)`);
  // `estimatedLoc` (#3839, Fork 4 field of #3801) is the task-only dispatch estimate — estimated changed
  // lines, distinct from `size` points, that the burndown never sums (docs/agent/backlog-workflow.md#agile-sizing).
  if (item.estimatedLoc !== undefined && item.kind !== 'task')
    err(`Backlog item "${item.id}" declares estimatedLoc but is not a task — estimatedLoc is task-only (a story/epic/decision/feature carries size instead)`);
  if (item.estimatedLoc !== undefined && !(Number.isInteger(item.estimatedLoc) && item.estimatedLoc > 0))
    err(`Backlog item "${item.id}" has a non-numeric or non-positive estimatedLoc "${item.estimatedLoc}" (expected a positive integer of estimated changed lines)`);
  if (item.parent !== undefined && !knownNums.has(String(item.parent)))
    err(`Backlog item "${item.id}" parent "#${item.parent}" does not resolve to an existing item`,
      dUnresolvedRef('Backlog', item.id, backlogFile, 'parent', String(item.parent), 'backlog/'));

  // ── Feature-tier invariants (#2691, docs/agent/backlog-workflow.md#feature-tier; plumbing #2998) ──
  // `feature` is the grouping tier ABOVE epic: a ROOT (carries no `parent` at all — the hole-free form of
  // "the feature tier is structurally the top"; a `{story,epic,task}` parent-kind blacklist leaks via
  // `feature → decision → epic` and drifts as kinds are added) and FLAT (no `kind: feature` ancestor —
  // feature → feature nesting is a non-breaking future extension, not built yet). Promoting an existing
  // epic to a feature is therefore a RE-PARENT (drop the `parent` edge), never a bare kind-flip.
  if (item.kind === 'feature') {
    if (item.parent !== undefined)
      err(`Backlog item "${item.id}" is \`kind: feature\` but carries a \`parent\` ("#${item.parent}") — a feature is a ROOT: the tier above epic carries no \`parent\` at all. Promoting an epic to a feature is a re-parent (drop the \`parent\` edge), not a bare kind-flip.`);
    // The ancestor walk needs the cross-item num→kind / num→parent maps (absent from a bare per-item ctx,
    // e.g. a minimal synthetic fixture exercising only the ROOT half above) — cycle-guarded via `seen`.
    if (ctx.kindByNum && ctx.parentByNum) {
      const seen = new Set([String(item.num)]);
      let cur = item.parent !== undefined ? String(item.parent) : undefined;
      while (cur !== undefined && !seen.has(cur)) {
        if (ctx.kindByNum.get(cur) === 'feature') {
          err(`Backlog item "${item.id}" is \`kind: feature\` with a \`kind: feature\` ancestor (#${cur}) — features are FLAT (no feature → feature nesting; a non-breaking future extension, not built now).`);
          break;
        }
        seen.add(cur);
        cur = ctx.parentByNum.get(cur);
      }
    }
  }
  // Resolution date is what the burndown plots — required once resolved.
  if (item.status === 'resolved' && !item.dateResolved)
    err(`Backlog item "${item.id}" is resolved but has no dateResolved — the burndown needs the resolution date`);

  // UI-fidelity contract shape (#2805, epic #2804) — a UI item is born carrying a `fidelity:` block naming
  // its real assembled route, host shell, frozen webcase required-set, data seeds (empty+overflow
  // mandatory), themes, registry-anchored target, and baseline template. WE validates the SHAPE only
  // (never boots the product — MEMORY #6); the real route table + render live in the product repo. Any
  // item that authors the block gets it gated here.
  if (item.fidelity !== undefined) {
    const fc = validateFidelityContract(item.fidelity, { id: item.id });
    for (const e of fc.errors) err(e.message, e.descriptor);
    for (const w of fc.warnings) warn(w.message, w.descriptor);
  }

  return { errors, warnings };
}

// ── Classification-axis loud-fail (#1247) ─────────────────────────────────────
// The Prioritisation board buckets every open item onto the merged `kind` axis (#487): a `task`/small
// `story` → `batchable`, a `decision` → Tier B, an open `epic` → `sliceable`. Each of those three pools
// keys off `item.kind`. So if the kind axis is ever UNPOPULATED for the whole collection — the #487
// near-miss, where consumers were switched to `item.kind` ahead of the producer, leaving `kind`
// undefined everywhere — all three pools collapse to zero AT ONCE while the board still renders (a
// silent empty Prioritisation tab: "0 batchable / 0 decision / 0 program"), because `deriveTier` still
// hands an undefined-kind item Tier A. A per-item "missing kind" error catches the field being absent;
// this aggregate canary additionally catches a *bucketing-logic* break that leaves `kind` present but
// every classified pool empty. Both failure modes share one observable signature: open items exist but
// {batchable, tierB, sliceable} are all zero. That is the loud-fail — never a quiet zero board.
//
// Pure over the loaded + enriched collection (items carry `.status`, `.kind`, `.tier`, `.batchable`,
// `.sliceable`); returns null when healthy, else a diagnosis object the script turns into one error.
export function detectClassificationCollapse(items) {
  const open = (items || []).filter((it) => it && it.status === 'open');
  if (open.length === 0) return null; // an all-resolved backlog legitimately classifies nothing
  const batchable = open.filter((it) => it.batchable === true).length;
  const tierB = open.filter((it) => it.tier === 'B').length;
  const sliceable = open.filter((it) => it.sliceable === true).length;
  if (batchable + tierB + sliceable > 0) return null;
  const kindlessOpen = open.filter((it) => !BACKLOG_KINDS.has(it.kind)).length;
  return { openCount: open.length, batchable, tierB, sliceable, kindlessOpen };
}

// ── Front-A native-first conformance metric (#1267) ───────────────────────────
// The platform-standards watch (#1257) front A: every WE standard with a SHIPPED native equivalent should
// defer to it (native-first, #031). This turns that from a one-time assertion into a living, QUANTITATIVE
// check — the metric the next watch run reads. Pure over the `nativeFirstWatch.json` ledger (one row per
// tracked native equivalent, each carrying a `registered` flag the watch flips when the standard repoints).
// Returns the totals + the still-unregistered rows; the script surfaces them as a nudge (not an error —
// the registrations are tracked open work, so red-gating would just block the batch fixing them).
export function computeNativeFirstConformance(watch) {
  const entries = (watch && Array.isArray(watch.entries)) ? watch.entries : [];
  const pending = entries.filter((e) => e && e.registered !== true);
  return {
    total: entries.length,
    registered: entries.length - pending.length,
    pending: pending.length,
    pendingList: pending.map((e) => `${e.id}${e.trackingItem ? ` (#${e.trackingItem})` : ''}`),
  };
}

// ── Front-A design-knowledge conformance metric (#1586) ───────────────────────
// The design-knowledge intake program (#1585) front A: every ADMITTED authoritative source should
// eventually be distilled into the codified #1034 design-critique rubric (its priors carried per axis as
// provenance, #1587). This turns that from an aspiration into a living, QUANTITATIVE check — the metric
// the next watch run reads. Pure over the `designKnowledgeWatch.json` ledger (one row per admitted source,
// each carrying a `distilledInto` field the watch fills when the source lands in the rubric). A row counts
// as distilled when `distilledInto` is a non-empty value (a rubric axis/version ref). Mirrors
// computeNativeFirstConformance (#1267). Returns the totals + the still-undistilled rows; the script
// surfaces them as a nudge (not an error — distillation is tracked open work, so red-gating would just
// block the batch doing it).
export function computeDesignKnowledgeConformance(watch) {
  const entries = (watch && Array.isArray(watch.entries)) ? watch.entries : [];
  const isDistilled = (e) => e && e.distilledInto != null &&
    (Array.isArray(e.distilledInto) ? e.distilledInto.length > 0 : String(e.distilledInto).trim() !== '');
  const pending = entries.filter((e) => !isDistilled(e));
  return {
    total: entries.length,
    distilled: entries.length - pending.length,
    pending: pending.length,
    pendingList: pending.map((e) => `${e.id}${e.trackingItem ? ` (#${e.trackingItem})` : ''}`),
  };
}

// ── Raw-HTML-in-backlog-body lint (#290) ──────────────────────────────────────
// An un-backticked HTML tag in a backlog markdown body is passed through verbatim by 11ty and parsed
// by the browser as a live element. A void/unclosed interactive one (`<select>`, `<dialog>`,
// `<textarea>`) then swallows the rest of the page body, rendering the item visibly empty — the #020
// bug, which shipped silently because check:standards didn't look. This lint flags tag-like `<…>`
// sequences outside code spans/fences so the author wraps them (cheap fix: backticks).
//
// Severity is WARNING, not error: balanced raw HTML (e.g. #028's deliberate `<h3>/<p>/<ul>` block)
// renders fine, so banning all body HTML would red-gate a working item. The warning surfaces every
// raw tag — including the dangerous unclosed ones — without failing on legitimate rich-HTML prose.
//
// Match is restricted to RECOGNISED HTML element names. Backlog/doc prose is dense with `<NNN>`,
// `<date>`, `<slug>` placeholders that are valid tag-name syntax but are NOT elements (the browser
// treats them as inert unknown tags); matching every `<…>` would bury the real hits under placeholder
// noise. Every content-swallowing element is a standard one, so the recognised-element set IS the
// danger zone — custom elements (hyphenated, inert) are intentionally excluded.
export const HTML_ELEMENTS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
  'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend',
  'li', 'link', 'main', 'map', 'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol',
  'optgroup', 'option', 'output', 'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's',
  'samp', 'script', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time',
  'title', 'tr', 'track', 'u', 'ul', 'var', 'video', 'wbr',
]);

/**
 * Find un-backticked HTML element tags in a markdown body. Fenced code blocks (``` / ~~~) and inline
 * code spans (`…`) are stripped first, so a `<select>` shown as an example inside backticks is ignored
 * and only prose-level raw HTML remains. Only tags whose name resolves in HTML_ELEMENTS are reported.
 *
 * Pure: takes the raw body string (the script reads the file) and returns `{ line, tag, name }` per
 * hit, line-numbered against the original body for an actionable message.
 */
export function findRawHtmlInMarkdown(body) {
  const findings = [];
  if (typeof body !== 'string' || body === '') return findings;
  let fenceChar = null;   // the char of the open fence (` or ~), or null when outside a fence
  let fenceLen = 0;       // its run length — a fence closes on the same char, run length ≥ this
  body.split('\n').forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) { fenceChar = null; fenceLen = 0; }
      return; // inside a fence — drop the line
    }
    if (fm) { fenceChar = fm[1][0]; fenceLen = fm[1].length; return; }
    // Strip inline code spans (a backtick run, lazily, to a matching-length run) before scanning.
    const prose = line.replace(/(`+)[\s\S]*?\1/g, ' ');
    for (const m of prose.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g)) {
      const name = m[1].toLowerCase();
      if (HTML_ELEMENTS.has(name)) findings.push({ line: i + 1, tag: m[0], name });
    }
  });
  return findings;
}

// ── Buried-fork lint: a fork section in a non-decision body (#441 carve rule) ──
// A fork belongs in a `type: decision` item, never inline in an idea/epic/story body. The tell is a
// fork-shaped SECTION HEADING ("## Open design points", "## Open decisions", "## Design tensions") in
// a non-decision item — exactly the #192 / #315 / #087 pattern. This lint flags those so the author
// carves the fork to a decision item that `blocks` the original (docs/agent/backlog-workflow.md → the
// carve rule). Severity is WARNING: the heading is a strong signal but not proof (a section may list
// forks already deferred elsewhere), so it nudges rather than red-gates.
//
// Suppressed when the section is already SETTLED — it names a decision item (`#NNN`) alongside
// carve/delegate/resolve/block language — so a correctly-carved item (#192's "→ #441", #134's "carved
// to #450", #315's "resolved by the child stories … #346") does NOT warn. The script applies it only
// to non-`decision`, non-`resolved` items; a decision item legitimately *is* the fork, and a resolved
// item's open-questions are historical.
// The fork tells are "Open …", "… tension", and "… to settle" — headings that announce an UNSETTLED
// choice. A bare "Design decisions" (esp. "(recommended)") is the opposite — a settled section — so it
// is intentionally NOT a term (it produced false positives on resolved-inline sections).
export const FORK_HEADING_TERMS = [
  'open design', 'open decision', 'open question', 'open fork', 'open sub-decision',
  'design tension', 'forks to settle', 'decisions to settle', 'tensions to settle',
];
// A section is "settled" (→ already carved/resolved, suppress) when it cites an item number next to
// carve/delegate/resolve/settle/blockedBy/decision language. NB: match `blockedby`/`blocked by`, NOT
// bare "block" — a live fork can be *about* whether to build a block (#369), which must still warn.
const FORK_SETTLED_RX = /(carv|deleg|resolv|settl|blocked\s?by|decision)/i;
const ITEM_REF_RX = /#(?:\d{1,5}|x[0-9a-z]{6})\b/; // two-form id (#2288): a prose ref to a landed NNN or a provisional hash

/**
 * Find fork-shaped section headings in a backlog markdown body that are NOT already settled (carved to
 * a decision). A "section" runs from its heading to the next markdown heading (any level). A heading
 * matches when its text contains a FORK_HEADING_TERMS phrase; it is reported only when its section body
 * lacks a decision pointer (an `#NNN` ref alongside carve/resolve/block language).
 *
 * Pure: takes the raw body string (frontmatter already stripped by the caller) and returns
 * `{ line, heading }` per unsettled fork section, line-numbered against the body for an actionable
 * message. The caller restricts this to non-decision, non-resolved items.
 */
export function findBuriedForkSections(body) {
  const findings = [];
  if (typeof body !== 'string' || body === '') return findings;
  const lines = body.split('\n');
  // Index every heading line first, so a section's end is the next heading (or EOF).
  const headings = [];
  lines.forEach((line, i) => {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) headings.push({ i, text: m[2] });
  });
  for (let h = 0; h < headings.length; h++) {
    const { i, text } = headings[h];
    const low = text.toLowerCase();
    if (!FORK_HEADING_TERMS.some((t) => low.includes(t))) continue;
    const end = h + 1 < headings.length ? headings[h + 1].i : lines.length;
    const section = lines.slice(i, end).join('\n');
    // Settled (already carved/resolved) → suppress.
    if (ITEM_REF_RX.test(section) && FORK_SETTLED_RX.test(section)) continue;
    findings.push({ line: i + 1, heading: text });
  }
  return findings;
}

// ── Polyglot-widening start-gate: an item that widens the forward-generation surface must cite ──────
// external-adopter evidence (#2089 Fork 2(a), codified at
// docs/agent/platform-decisions.md#forward-target-start-gate). The ratified rule: "every new
// polyglot-widening item — an item that adds a new generation target or emit form — may not start
// until it carries a `blockedBy` edge to the current pilot-evidence item (bootstrap #2129), or an
// explicit carve-out." #2089 filed this rule as the enforcement follow-up (#2131) precisely because the
// obligation to ADD the edge at scaffold time was statute-enforced judgment, not script-enforced — this
// turns the last mile from reviewer recall into a deterministic gate, per the hookable-vs-judgment rule.
//
// Predicate is TAG-KEYED and DECLARED, not auto-derived (declared-over-auto-derived): the author opts an
// item into the gate with the `polyglot-widening` tag. A blanket match on the broad `polyglot` tag would
// false-positive on the ~38 polyglot-tagged decisions/maintenance/consume items — the whole point of the
// predicate (#2089: "by predicate, not item list") is that it names *new target/form* work only, which
// the author asserts by tagging.
//
// PILOT_EVIDENCE_NUMS is the set of items that satisfy the edge (the bootstrap + any later
// pilot-evidence item; "later targets cite evidence current at their filing"). A `blockedBy` edge to any
// of them clears the gate.
export const PILOT_EVIDENCE_NUMS = new Set(['2129']);
// Carve-outs by the same predicate (#2089 / #forward-target-start-gate): work that consumes existing
// emit forms and adds no new target/form. `maintenance` = bugfix/upkeep of shipped artifacts;
// `workbench-consume` = the workbench live-test family (serve/mount already-generated wrappers).
export const POLYGLOT_WIDENING_TAG = 'polyglot-widening';
export const POLYGLOT_CARVEOUT_TAGS = new Set(['maintenance', 'workbench-consume']);

/**
 * Gate a polyglot-widening item on the evidence edge. Pure, frontmatter-only (no body read):
 *   • fires only on an item tagged `polyglot-widening` (the declared predicate);
 *   • PROSPECTIVE — a `resolved` item is skipped (the gate governs the next widening, never retracts a
 *     shipped increment: #2089 "prospective — never retracts shipped increments");
 *   • cleared by a `blockedBy` edge to a pilot-evidence item (PILOT_EVIDENCE_NUMS), OR a carve-out tag
 *     (POLYGLOT_CARVEOUT_TAGS), OR its own ratified empirical trigger — an item carrying a
 *     `maturityTrigger` is governed by that trigger (the #1735 / #forward-emit-dedicated-ir exemption,
 *     captured structurally by the field, not by a hardcoded item number).
 * Returns `{ errors, warnings }` with plain-string messages (caller-formatted). ERROR: the statute makes
 * the edge a hard `blockedBy`, and a missing edge is exactly the drift the gate exists to catch.
 */
export function validatePolyglotWideningGate(item) {
  const errors = [];
  const warnings = [];
  const tags = Array.isArray(item.tags) ? item.tags : [];
  if (!tags.includes(POLYGLOT_WIDENING_TAG)) return { errors, warnings };
  if (item.status === 'resolved') return { errors, warnings }; // prospective gate
  // Exempt: an item under its own ratified empirical trigger (#1735 / #forward-emit-dedicated-ir).
  if (typeof item.maturityTrigger === 'string' && item.maturityTrigger.trim()) return { errors, warnings };
  // Carve-out: consumes existing forms, adds no new target/form.
  if (tags.some((t) => POLYGLOT_CARVEOUT_TAGS.has(t))) return { errors, warnings };
  // Cleared: a blockedBy edge to a current pilot-evidence item.
  const edges = Array.isArray(item.blockedBy) ? item.blockedBy.map(String) : [];
  if (edges.some((e) => PILOT_EVIDENCE_NUMS.has(e))) return { errors, warnings };
  errors.push(
    `Backlog item "${item.id}" is tagged \`${POLYGLOT_WIDENING_TAG}\` (adds a new generation target / emit ` +
    `form) but carries no external-adopter evidence edge. The ratified new-target start-gate ` +
    `(docs/agent/platform-decisions.md#forward-target-start-gate, #2089 Fork 2(a)) requires it to either ` +
    `\`blockedBy\` the current pilot-evidence item (bootstrap #${[...PILOT_EVIDENCE_NUMS].join('/#')}) or ` +
    `carry an explicit carve-out — a \`${[...POLYGLOT_CARVEOUT_TAGS].join('\`/\`')}\` tag (it only consumes ` +
    `existing emit forms), or its own ratified \`maturityTrigger\` (the #1735 / #forward-emit-dedicated-ir ` +
    `exemption). Add \`blockedBy: ["${[...PILOT_EVIDENCE_NUMS][0]}"]\`, or the carve-out, or drop the tag ` +
    `if it doesn't widen the forward-generation surface.`,
  );
  return { errors, warnings };
}

// ── Mis-flagged-batchable lint: a batchable item whose body asserts non-batchability ──────────────
// The `--select` loader derives `batchable` from STRUCTURED fields only (Tier A + size ≤ 8 + all
// `blockedBy` resolved). The disqualifier that actually makes an item un-workable often lives only in
// PROSE — a buried fork, an author "not batchable as one; re-slice" note, an "external infra" / "agent
// cannot provision" deliverable, a "blocked-in-fact" / "open question" caveat. When that prose is
// present but the flags still compute `batchable`, the loader over-reports agent-readiness and every
// batch pre-flight re-rejects the item by hand instead of fixing the data (the recurring slip this
// lint kills — see memory `feedback_misflagged_batchable_fix_real_state`).
//
// The caller restricts this to `item.batchable === true`, so the lint SELF-CLEARS the moment the real
// state is encoded: retyping to `decision`, bumping `size` to ≥13, parking, or adding the real
// `blockedBy` edge all drop the item out of `batchable`, and the warning vanishes with no further
// edit. The only items it fires on are exactly those still computed-batchable while their body says
// otherwise. WARNING, not error: prose heuristics aren't proof, and the fix is a deliberate re-flag.
//
// Each entry is [label, regex]. Kept high-signal to limit false positives (a passing mention like
// "this is NOT external infra" can trip it — the message says "encode the real state or reword").
export const NON_BATCHABLE_MARKERS = [
  ['not batchable', /\bnot\s+batchable\b/i],
  ['re-slice', /\bre-?slice\b/i],
  ['blocked-in-fact', /\bblocked[-\s]in[-\s]fact\b/i],
  ['external infra', /\bexternal\s+infra(structure)?\b/i],
  ['human-in-the-loop', /\bhuman[-\s]in[-\s]the[-\s]loop\b/i],
  ['needs prep/decision', /\bneeds\s+(a\s+)?[`/]*(prep|prepare|decision)\b/i],
  ['agent cannot provision', /\b(agent\s+cannot|cannot\s+(stand\s+up|provision|be\s+(built|done|stood)))\b/i],
  ['unverified prerequisite', /\b(verify|unverified|unconfirmed)\b[^.\n]{0,60}\bbefore\s+(claim|build)/i],
];

/**
 * Scan a backlog markdown body for non-batchability MARKERS (frontmatter already stripped by the
 * caller). Skips fenced + inline code (mirrors findRawHtmlInMarkdown) so a sample/path doesn't trip it.
 * Returns `{ line, marker }` per hit; the caller restricts this to `item.batchable === true` items and
 * groups the distinct markers per item. Pure.
 */
export function findNonBatchableMarkers(body) {
  const findings = [];
  if (typeof body !== 'string' || body === '') return findings;
  let fenceChar = null, fenceLen = 0;
  body.split('\n').forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) { fenceChar = null; fenceLen = 0; }
      return;
    }
    if (fm) { fenceChar = fm[1][0]; fenceLen = fm[1].length; return; }
    // Scan the raw line (fenced blocks already skipped). Unlike the raw-HTML lint we do NOT strip
    // inline code spans: these markers are natural-language phrases and authors routinely backtick the
    // slash-commands inside them (e.g. "needs a `/decision`"), which must still match.
    for (const [label, rx] of NON_BATCHABLE_MARKERS) {
      if (rx.test(line)) findings.push({ line: i + 1, marker: label });
    }
  });
  return findings;
}

// ── Bad-body-link lint: leaked authoring syntax in a backlog body ──────────────
// A backlog body is rendered at `/backlog/<id>/` on the 11ty site, so a link that only resolves in the
// repo/editor (or not at all) renders as dead text or a 404 for a reader. Three recurring leaks:
//   • `[[wiki-link]]` — MEMORY-files-only syntax (`[[feedback_*]]`/`[[project_*]]`); markdown renders it
//     literally and the slug has no page anywhere. ERROR — there is no valid use in a backlog body.
//   • `localhost` / absolute-`/Users/` / `file://` links — dead for any reader. WARN.
//   • a link to ANOTHER backlog item's `.md` file (`](…/backlog/NNN-x.md)`) — 404s on the live site;
//     the correct form is the rendered URL `/backlog/NNN-slug/`. WARN. (Links to reports/ or docs/agent/
//     `.md`, which are deliberately NOT on the site, are the sanctioned agent-facing ref and NOT flagged.)
// Skips fenced + inline code (an array literal `[[1,2]]` or a sample path in a code span is legitimate),
// mirroring findRawHtmlInMarkdown. Returns `{ line, kind, text }`; the caller groups per item + severity.
export function findBadBodyLinks(body) {
  const findings = [];
  if (typeof body !== 'string' || body === '') return findings;
  let fenceChar = null, fenceLen = 0;
  body.split('\n').forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) { fenceChar = null; fenceLen = 0; }
      return; // inside a fence
    }
    if (fm) { fenceChar = fm[1][0]; fenceLen = fm[1].length; return; }
    const prose = line.replace(/(`+)[\s\S]*?\1/g, ' '); // strip inline code spans
    const ln = i + 1;
    for (const m of prose.matchAll(/\[\[[^\]]*\]\]/g)) findings.push({ line: ln, kind: 'wikilink', text: m[0] });
    for (const m of prose.matchAll(/\]\(([^)\s]+)/g)) {
      const tgt = m[1];
      if (/^(https?:\/\/)?localhost\b/i.test(tgt)) findings.push({ line: ln, kind: 'localhost', text: tgt });
      else if (/^(\/Users\/|file:\/\/)/i.test(tgt)) findings.push({ line: ln, kind: 'absfile', text: tgt });
      // A link to another backlog item — bare sibling `NNN-slug.md`, or `./`, `../backlog/`, `/backlog/`,
      // `backlog/` prefixed. ALL render as a dead href from `/backlog/<id>/` (bare `NNN-slug.md` resolves to
      // `/backlog/<id>/NNN-slug.md` → 404); the live route is `/backlog/NNN-slug/`. The `\d{3}-` prefix +
      // absence of any non-`backlog/` dir keeps sanctioned `reports/…md` / `docs/…md` refs out of scope.
      else if (/^(?:\.{0,2}\/)?(?:backlog\/)?\d{3}-[a-z0-9-]+\.md(?:#.*)?$/.test(tgt)) findings.push({ line: ln, kind: 'backlog-md', text: tgt });
    }
  });
  return findings;
}

// ── Duplicate-key merge gate for keyed JSON manifests (#2149 Fork 1) ───────────
// we:package.json rides the OPTIMISTIC merge floor (it is NOT a merge-risk/blacklist file): order is
// irrelevant to npm and distinct-key adds merge clean AND correct, so its ONLY clean-but-wrong class is
// two lanes adding the SAME key at different offsets — which git line-merges CLEAN into a duplicate-key
// object that JSON.parse silently last-wins. That class is fully enumerable and machine-checkable, so per
// the hookable-vs-judgment rule it gets a HOOK (this gate → gate-red → serial-replay), not a serialization
// entry. JSON.parse cannot see a duplicate key, so scan the RAW text: a tiny tokenizer tracking key names
// per object scope (one Set per `{}` frame; a string is a KEY only when it sits in the key position of its
// object — right after `{` or a `,`). Nested objects/arrays each get their own scope, so `{"a":{"a":1}}`
// is NOT a duplicate. Runs per merge via check:standards on the merged tree ([gate-on-merged-tree]).
export function findDuplicateKeysPerScope(raw) {
  const dupes = [];
  if (typeof raw !== 'string') return dupes;
  const frames = []; // one per open object/array; objects carry {seen:Set, expectKey:bool}
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw[i];
    if (c === '"') {
      // read a JSON string, honoring backslash escapes; s is the decoded-enough key/value text
      let j = i + 1, s = '';
      while (j < n) {
        if (raw[j] === '\\') { s += raw[j + 1] ?? ''; j += 2; continue; }
        if (raw[j] === '"') break;
        s += raw[j]; j++;
      }
      i = j + 1;
      const top = frames[frames.length - 1];
      if (top && top.isObject && top.expectKey) {
        if (top.seen.has(s)) dupes.push(s); else top.seen.add(s);
        top.expectKey = false; // consumed the key; the value follows
      }
      continue;
    }
    if (c === '{') { frames.push({ isObject: true, seen: new Set(), expectKey: true }); i++; continue; }
    if (c === '[') { frames.push({ isObject: false }); i++; continue; }
    if (c === '}' || c === ']') { frames.pop(); i++; continue; }
    if (c === ',') { const top = frames[frames.length - 1]; if (top && top.isObject) top.expectKey = true; i++; continue; }
    i++; // ':' , whitespace, and value literals are irrelevant to key tracking
  }
  return dupes;
}

// One finding per duplicate key. `source` labels the offending manifest (e.g. its repo-relative path).
export function validateNoDuplicateManifestKeys(raw, source = 'package.json') {
  return findDuplicateKeysPerScope(raw).map((k) => ({
    message: `${source}: duplicate key "${k}" — two merged additions collided (JSON parse is last-wins-silent); rebase one side onto the other.`,
  }));
}

// ── Unquoted-colon scalar lint for backlog frontmatter (#453) ──────────────────
// The loader (#430) skips a malformed-YAML item and only warns, so a frontmatter typo slips past the
// gate unseen. The recurring trigger is an UNQUOTED plain scalar whose value embeds a `: ` (colon +
// space) or a trailing `:` — e.g. `graduatedTo: a/b.json: foo` — which YAML reads as a nested mapping
// ("mapping values are not allowed here") and the parse dies. This pure helper scans the raw
// frontmatter block (NOT the loader output — that's already dropped the broken items) and returns one
// finding per offending line, so check:standards prompts the quote-fix at author time, in CI, before
// the loader has to skip it. Takes the full file content; reports ABSOLUTE 1-based line numbers.
//
// Deliberately conservative — only a top-level `key: value` plain scalar is examined, and a value is
// EXEMPT (skipped) when it is already quoted (`"`/`'`), a flow collection (`{`/`[` — inner colons are
// legal there, e.g. `crossRef: { url: /x, label: Foo }`), a block scalar (`|`/`>`), a comment, or a
// YAML anchor/alias (`&`/`*`). A bare colon WITHOUT a following space (a URL like `https://x`) is fine
// in plain YAML and is NOT flagged — only `: ` or a trailing `:` breaks the parse.
export function findUnquotedColonScalars(content) {
  const findings = [];
  if (typeof content !== 'string' || !content.startsWith('---\n')) return findings;
  const lines = content.split('\n');
  // The frontmatter block is lines[1 .. closing fence). Find the next bare `---`.
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '---\r') { close = i; break; }
  }
  if (close === -1) return findings; // no closing fence — not our concern here
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    const m = line.match(/^([A-Za-z_][\w-]*):(\s+)(.*)$/);
    if (!m) continue;                       // not a top-level `key: value` line
    const value = m[3].trim();
    if (value === '') continue;             // an empty value (a nested block follows) — fine
    const first = value[0];
    if (first === '"' || first === "'" || first === '{' || first === '[' ||
        first === '|' || first === '>' || first === '#' || first === '&' || first === '*') continue;
    // Strip a trailing inline comment (` # …`) before testing the scalar itself.
    const scalar = value.replace(/\s+#.*$/, '');
    if (/:\s/.test(scalar) || /:$/.test(scalar)) {
      findings.push({ line: i + 1, key: m[1], value });
    }
  }
  return findings;
}

// ── Per-item backlog RENDERING lint (#845) ────────────────────────────────────
// The structural/rendering checks that operate on ONE backlog item in isolation — no registry/cross-item
// context needed, so they're cheap enough to run on every edit (a scoped `check:standards --item NNN`
// validator, or a PostToolUse hook on backlog/*.md). Composes the pure detectors above with the SAME
// canonical messages the whole-repo gate (`check-standards.mjs`) emits, so the two never diverge — the
// gate calls this for its per-item rendering passes and the scoped script calls it standalone.
//
// Inputs: `body` = the item body with frontmatter stripped (for the markdown scans); `item` = the
// loader-shaped record (id/type/status/batchable — drives the conditional checks). Returns
// `{ errors, warnings }` of message strings. The frontmatter unquoted-colon scan is NOT here — it must
// run file-driven (a malformed-YAML item is skipped by the loader, so it isn't in the item array at all),
// so each caller runs `findUnquotedColonScalars(content)` over the raw file itself. Also excludes the
// digest-length nudge (validateBacklogItem owns it) and the blockedBy cycle walk (a graph-level check).
export function lintBacklogItemRendering({ item, body, pocRegistry = null }) {
  const errors = [];
  const warnings = [];
  const id = item.id;

  // Body links — a backlog body renders at /backlog/<id>/, so leaked authoring syntax reads as dead text.
  const linkHits = findBadBodyLinks(body);
  if (linkHits.length) {
    const byKind = (k) => linkHits.filter((h) => h.kind === k);
    const lines = (k) => [...new Set(byKind(k).map((h) => h.line))].join(', ');
    if (byKind('wikilink').length) {
      errors.push(`Backlog item "${id}" uses [[wiki-link]] syntax at body line(s) ${lines('wikilink')} — ` +
        `that is MEMORY-files-only; markdown renders it literally and the slug has no page. In a backlog ` +
        `body, link another item as /backlog/NNN-slug/ or drop to plain prose.`);
    }
    if (byKind('backlog-md').length) {
      errors.push(`Backlog item "${id}" links to another item with a dead .md path @ line(s) ${lines('backlog-md')} ` +
        `— a bare/relative \`NNN-slug.md\` renders as a 404 from /backlog/${id}/. ` +
        `Use the rendered URL \`/backlog/NNN-slug/\` instead.`);
    }
    const warnKinds = ['localhost', 'absfile'].filter((k) => byKind(k).length);
    if (warnKinds.length) {
      const detail = warnKinds.map((k) => `${k === 'absfile' ? 'absolute /Users//file:// link' :
        'localhost link'} @ line(s) ${lines(k)}`).join('; ');
      warnings.push(`Backlog item "${id}" has a body link that is dead on the live site — ${detail}. ` +
        `Use the rendered /backlog/NNN-slug/ URL (or a site-relative path); editor-only refs to ` +
        `reports/ and docs/agent/ are fine.`);
    }
  }

  // Raw HTML — an un-backticked recognised element is parsed live by the browser; a void/unclosed one
  // swallows the rest of the page (the #020 bug). WARN (balanced rich-HTML bodies render fine).
  const htmlHits = findRawHtmlInMarkdown(body);
  if (htmlHits.length) {
    const tags = [...new Set(htmlHits.map((h) => h.name))].map((n) => `<${n}>`).join(', ');
    const hl = [...new Set(htmlHits.map((h) => h.line))].join(', ');
    warnings.push(`Backlog item "${id}" has raw HTML (${tags}) at body line(s) ${hl} outside code — ` +
      `11ty passes it through and the browser parses it as a live element; a void/unclosed interactive ` +
      `tag (e.g. <select>/<script>) swallows the rest of the page. Wrap them in backticks.`);
  }

  // Buried fork — a fork-shaped section in a non-decision, non-resolved body should be carved to a decision.
  if (item.kind !== 'decision' && item.status !== 'resolved') {
    const forkHits = findBuriedForkSections(body);
    if (forkHits.length) {
      const where = forkHits.map((h) => `"${h.heading}" (line ${h.line})`).join(', ');
      warnings.push(`Backlog item "${id}" (${item.kind}) has a fork-shaped section ${where} in a non-decision ` +
        `body — if it's a live design fork, carve it to a type:decision item that blocks this one; if it's ` +
        `already resolved or deferred elsewhere, reframe the heading or cite the decision (#NNN). ` +
        `See docs/agent/backlog-workflow.md → the carve rule.`);
    }
  }

  // Mis-flagged batchable — body asserts non-batchability but the structured flags compute batchable.
  if (item.batchable === true) {
    const markerHits = findNonBatchableMarkers(body);
    if (markerHits.length) {
      const markers = [...new Set(markerHits.map((h) => h.marker))].join('", "');
      const ml = [...new Set(markerHits.map((h) => h.line))].join(', ');
      warnings.push(`Backlog item "${id}" computes \`batchable\` but its body asserts non-batchability ("${markers}" ` +
        `@ line(s) ${ml}) — the loader only sees tier+size+blockedBy, so this over-reports agent-readiness. ` +
        `Encode the real state so it drops from the pool: retype \`type: decision\`, bump \`size\` to ≥13, ` +
        `\`status: parked\`, or add the real \`blockedBy\` edge (file the prereq/decision if missing). ` +
        `If the marker is a passing mention, reword it. See docs/agent/backlog-workflow.md → batching.`);
    }
  }

  // Premature-epic-closure guard (the #777 lesson). The cross-item guard in check-standards.mjs only
  // catches a resolved epic with an open CHILD; #777 resolved with its one child done while four
  // migration slices lived only as prose ("Not carved yet (gated on #765)"), so it slipped through —
  // an umbrella closed over uncarved scope. Two body-level tells of that, scanned only on a RESOLVED
  // epic, skipping fenced code:
  //   1. an unchecked GFM task box `- [ ]` — a literal "not done" marker. Closing over it is always a
  //      contradiction (check the box once the scope ships, or don't resolve) → ERROR.
  //   2. forward-looking uncarved-slice language ("not carved", "carve once/after/later") — softer,
  //      because a deliberate deferral that cites its tracking item (#666 → #665) is legitimate → WARN.
  if (item.status === 'resolved' && item.kind === 'epic') {
    const uncheckedBoxes = [];
    const uncarvedTells = [];
    let inFence = false;
    body.split('\n').forEach((raw, i) => {
      const l = raw.trim();
      if (/^```/.test(l)) { inFence = !inFence; return; }
      if (inFence) return;
      if (/^[-*]\s*\[ \]/.test(l)) uncheckedBoxes.push(i + 1);
      if (/\b(not (yet )?carved|left uncarved|uncarved|carve (once|after|later))\b/i.test(l)) uncarvedTells.push(i + 1);
    });
    if (uncheckedBoxes.length)
      errors.push(`Backlog item "${id}" is a RESOLVED epic with ${uncheckedBoxes.length} unchecked scope box(es) ` +
        `(\`- [ ]\` @ line(s) ${uncheckedBoxes.join(', ')}) — an umbrella closed over work it still marks as not done ` +
        `(the #777 footgun). If the scope shipped, check the box and cite the child that delivered it; if it didn't, ` +
        `reopen the epic (status: open) and carve the remaining slice(s). See docs/agent/backlog-workflow.md → "Closing out".`);
    if (uncarvedTells.length)
      warnings.push(`Backlog item "${id}" is a RESOLVED epic whose body still uses uncarved-slice language @ line(s) ` +
        `${uncarvedTells.join(', ')} — verify that scope actually shipped or is a deliberate deferral that cites its ` +
        `tracking item (#NNN). If it was simply never sliced, reopen and carve it rather than closing the umbrella over it.`);
  }

  // Dangling-residue guard (#1935). A `kind: decision` that is either RESOLVED or carries a truthful
  // `preparedDate` (prepared, awaiting ratification) must not leave a live choice as PROSE outside a
  // `## Fork N` — an "open residue / decide-at-ratification / TBD" aside is an un-prepared fork in disguise,
  // and the structural reason `prepare` and the decision turn diverge (the decider can only ratify the
  // item's default, so a deferred sub-choice forces a cold call). The fork-shape walks scan headings, so a
  // prose residue slips past them — catch it here. Scoped to resolved|prepared (an OPEN, un-prepared
  // decision is mid-research, where deferral language is legitimate; ACTIVE is the discussion phase, where a
  // staged `AWAITING RATIFICATION` block may transiently hold such phrasing). WARN: heuristic, the real
  // enforcement is the prep close-out judgment in docs/agent/backlog-workflow.md.
  if (item.kind === 'decision' && (item.status === 'resolved' || item.preparedDate)) {
    const DEFERRED_CHOICE_RE = /\b(open residue|residue for the ratification|(?:at|for|in) the ratification turn|to be decided|decide(?:d)? (?:this |it )?later|decide at ratification|\bTBD\b)/i;
    const residueTells = [];
    let inFence = false;
    body.split('\n').forEach((raw, i) => {
      const l = raw.trim();
      if (/^```/.test(l)) { inFence = !inFence; return; }
      if (inFence) return;
      if (DEFERRED_CHOICE_RE.test(l)) residueTells.push(i + 1);
    });
    if (residueTells.length)
      warnings.push(`Backlog item "${id}" is a ${item.status === 'resolved' ? 'RESOLVED' : 'prepared'} decision whose body ` +
        `still defers a choice in prose @ line(s) ${residueTells.join(', ')} ("open residue" / "decide at ratification" / ` +
        `"TBD"-style) — a live choice left OUTSIDE a \`## Fork N\` is an un-prepared fork in disguise (#1935). Promote it to ` +
        `its own \`## Fork N\` with a bold default (research it now), fold it into an existing fork's default, or drop it as ` +
        `not-actually-a-choice. See docs/agent/backlog-workflow.md → "no live choice may sit outside a Fork N".`);
  }

  // Stale-ratified/verified-done status guard (#3383) — see the header comment above findStaleRatifiedClaims.
  if ((item.status === 'open' || item.status === 'active') && item.kind !== 'epic') {
    const staleHits = findStaleRatifiedClaims(body);
    if (staleHits.length) {
      const where = staleHits.map((h) => `"${h.match}" (${h.label}, line ${h.line})`).join('; ');
      warnings.push(`Backlog item "${id}" is \`status: ${item.status}\` but its body reads as already ` +
        `ratified or built — ${where}. If the work is genuinely done, flip the status (\`resolved\`, with a ` +
        `\`graduatedTo\`) or file/link the follow-through that finishes it; if this only cites another ` +
        `item's ratification in passing, reword it so it doesn't read as a claim about THIS card (#3383).`);
    }
  }

  // #3637 Fork 3 — `deliveryTarget:` must name a DECLARED POC branch (or be absent / `main`).
  //
  // WHY IT IS CHECKED HERE, in the shared rule module, rather than only in the dispatcher: an unknown branch
  // caught at FILING time is a one-line fix by the person who typed it; the same mistake caught at dispatch
  // time is a refused launch hours later, with a lane already assigned. The card's own words: "validated
  // against the registry at filing time (an unknown branch is a filing refusal, not a runtime surprise)".
  // `pocRegistry` is injected by the caller (both the whole-repo gate and the scoped per-item lint read the
  // real one) so this stays a pure function of its inputs; omitted ⇒ the check is SKIPPED rather than
  // failing every item, because "the caller did not supply a registry" must never read as "no branch is
  // registered".
  if (item.deliveryTarget != null && pocRegistry) {
    const verdict = validateDeliveryTarget(pocRegistry, item.deliveryTarget);
    if (!verdict.ok) errors.push(`Backlog item "${id}" ${verdict.error}`);
  }

  return { errors, warnings };
}

// ── Implementation-lifecycle vocabulary + descriptor plumbing (#256) ───────────
// Shared by the script (blocks/plugs status) AND the entity validators below, so the lifecycle
// vocabulary and the descriptor `file` pointers have a single definition. Ordered concept → draft →
// experimental → active. Deprecated synonyms map to their canonical target (flagged so drift can't
// return). Research topics use a separate axis (RESEARCH_STATUSES, kept in the script).
export const LIFECYCLE = new Set(['concept', 'draft', 'experimental', 'active']);
export const STATUS_SYNONYMS = { implemented: 'active', stable: 'active', done: 'active', planned: 'concept', wip: 'draft' };

// Spec data files, keyed by entity for descriptor `file` pointers (the row/file a fixer edits).
// Block is NOT here: blocks are split one-file-per-block (#882), so a Block fixer's target is
// per-id — resolve it through `fileFor`/`blockSpecFile`, never a single registry path.
export const FILE = {
  Plug: 'src/_data/plugs.json', Protocol: 'src/_data/protocols.json',
  Intent: 'src/_data/intents.json', Capability: 'src/_data/capabilities.json',
  CapabilityAdapter: 'src/_data/capabilityMatrix.json', Project: 'src/_data/projects.json',
  Research: 'src/_data/researchTopics.json',
  Preset: 'src/_data/assemblerPresets.json',
  DesignSystem: 'src/_data/designSystems.json',
};

// Entities split one-file-per-id: the descriptor `file` must point at the per-entry spec, not the (now
// virtual) monolith — so the autofix write-target is real AND the #1144 --scope/--local lane attribution
// matches the file a lane actually dirties. Block #882, Intent + Research #1145.
const PER_ID_SPEC_DIR = {
  Block: 'blocks', Intent: 'intents', Research: 'researchTopics',
  Protocol: 'protocols', Demo: 'demos', Preset: 'assemblerPresets', // #1146
  Plug: 'plugs', Capability: 'capabilities', Project: 'projects', DesignSystem: 'designSystems', // #1157
};

/** The per-block spec file a Block fixer edits (#882 — replaces the former single blocks.json row). */
export const blockSpecFile = (id) => `src/_data/blocks/${id}.json`;

/** Resolve the descriptor `file` write-target for an entity kind: per-id for split entities, the registry otherwise. */
export const fileFor = (kind, id) => (PER_ID_SPEC_DIR[kind] ? `src/_data/${PER_ID_SPEC_DIR[kind]}/${id}.json` : FILE[kind]);

// A spec entity with no matching description .njk — the model writes the prose; `file` is the path to create.
export const dMissingDescription = (entity, id, file) =>
  ({ kind: 'missing-description', fix: 'model', entity, id, file });

/**
 * Status enum check — returns an array of `{ message, descriptor? }` error entries (status rules
 * never warn). A deprecated synonym is `reference`-fixable (canonical target known); an
 * otherwise-invalid value is `model`-fixable (intended status isn't derivable). Pure: the caller
 * pushes the entries onto its own error list, so the script and the entity validators share one body.
 */
export function checkStatus(kind, id, status) {
  const out = [];
  if (!status) return out;
  // The descriptor `file` is where a fixer WRITES the corrected status. Blocks are split one-file-per
  // block (#882), so a Block fix must target its own src/_data/blocks/<id>.json, not a single registry.
  const file = fileFor(kind, id);
  if (STATUS_SYNONYMS[status]) {
    const to = STATUS_SYNONYMS[status];
    out.push({
      message: `${kind} "${id}" uses deprecated status "${status}" — use canonical "${to}"`,
      descriptor: file ? { kind: 'deprecated-status', fix: 'reference', entity: kind, id, file, field: 'status', from: status, to } : undefined,
    });
  } else if (!LIFECYCLE.has(status)) {
    out.push({
      message: `${kind} "${id}" has invalid status "${status}" (expected ${[...LIFECYCLE].join(' / ')})`,
      descriptor: file ? { kind: 'invalid-status', fix: 'model', entity: kind, id, file, field: 'status', from: status, allowed: [...LIFECYCLE] } : undefined,
    });
  }
  return out;
}

// ── Portfolio project tier — the importance axis, orthogonal to `status` (#2088 → #2132) ──────
// Ratified at docs/agent/platform-decisions.md#portfolio-project-tiering. Every project carries an
// explicit, enum-validated `tier` (the named-consumer evidence bar); every non-exploratory project
// (core | contextual) additionally carries a non-empty `tierEvidence` one-liner NAMING its consumer —
// the falsifiability hook. Deliberately NOT derived from data (fork 3-b rejected on merit: a judgment
// over heterogeneous evidence no dataset holds), so the stamp is validated, never computed.
export const PROJECT_TIERS = new Set(['core', 'contextual', 'exploratory']);

/**
 * Validate a single project's tier stamp — returns `{ message, descriptor? }` error entries (never
 * warns: the tier is a required, enum-validated field from day one, unlike the deliberately-loose
 * project `status`). Pure, mirroring `checkStatus`: the caller pushes onto its own error list.
 *   • missing/invalid `tier` (∉ {core, contextual, exploratory}) → model-fixable (intended tier is a
 *     judgment, not derivable);
 *   • tier ∈ {core, contextual} with an empty/whitespace `tierEvidence` → model-fixable (the one-liner
 *     is the falsifiability hook — a non-exploratory stamp MUST name its consumer).
 */
export function validateProjectTier(id, tier, tierEvidence) {
  const out = [];
  const file = fileFor('Project', id); // src/_data/projects/<id>.json
  if (!tier || !PROJECT_TIERS.has(tier)) {
    out.push({
      message: `Project "${id}" has missing/invalid tier "${tier ?? ''}" (expected ${[...PROJECT_TIERS].join(' / ')}) — the #portfolio-project-tiering enum is required from day one`,
      descriptor: { kind: 'invalid-tier', fix: 'model', entity: 'Project', id, file, field: 'tier', from: tier, allowed: [...PROJECT_TIERS] },
    });
    return out; // no point checking evidence against an invalid tier
  }
  const needsEvidence = tier === 'core' || tier === 'contextual';
  if (needsEvidence && !(typeof tierEvidence === 'string' && tierEvidence.trim())) {
    out.push({
      message: `Project "${id}" is tier "${tier}" but has no non-empty tierEvidence — every non-exploratory tier must NAME its consumer (the #portfolio-project-tiering falsifiability hook)`,
      descriptor: { kind: 'missing-tier-evidence', fix: 'model', entity: 'Project', id, file, field: 'tierEvidence' },
    });
  }
  return out;
}

// ── Derived advisory tier cross-check — the domain→project evidence join (#2135, #2088 Fork 3) ──
// A WARN-ONLY cross-check demoted from #2088 Fork 3 (c): flag an `exploratory` project whose DOMAIN
// shows benchmark demand — a signal its tier may be understated. It is *advisory only*: it NEVER owns
// or computes the `tier` value (that stays the stamped, named-consumer judgment of Fork 3 (a),
// validateProjectTier above) — a divergence is a nudge to a human, not a gate failure.
//
// Why a DECLARED join, not a derived one: #2088 Fork 3 rejected deriving the tier because "no domain→
// project join exists at all — projects carry no intents/blocks lists, intents/blocks carry no project
// field, only protocols have ownedByProject; the association is prose-only." The one structured edge
// (protocol.ownedByProject → protocol.realizesIntent → intent.requiresCapabilities) does NOT reach the
// benchmark-demand signal: requiresCapabilities is keyed by web-platform PRIMITIVE ids (`popover`,
// `contenteditable`), while benchmark demand is keyed by component-CAPABILITY ids (`combobox`, `tabs`)
// — a different namespace. So the domain→demand edge is genuinely absent from the data and cannot be
// auto-derived soundly. This builds it as an EXPLICIT DECLARED mapping instead (declared > fragile
// auto-derivation): `benchmarkCoverage.projectDomainDemand[]` — each row NAMES the project, the benchmark
// capability whose demand its domain covers, and a one-line evidence cite. The check joins that declared
// edge to the live `tier` stamp and warns only on the (project=exploratory ∧ declared-demand) cross.
//
// On today's real data this warns ZERO: benchmark demand is all component-level UI surface, while every
// `exploratory` project is an infra/protocol domain (webinjectors, webregistries, webrealtime, …) with
// no benchmark-capability demand to declare — so `projectDomainDemand` is legitimately empty of firing
// rows. The mechanism (the join + the advisory) exists and is unit-exercised with synthetic rows; it
// stays quiet until a future sweep declares a real domain→demand edge for an exploratory project.

/**
 * Derived advisory tier cross-check (#2135). Pure: takes the declared domain→demand join rows plus the
 * live project tier index, returns WARNINGS only (never errors — advisory, never owns the value).
 *
 *   • a `projectDomainDemand` row whose `project` doesn't resolve → a warning (the declared join drifted);
 *   • a resolving row for an `exploratory` project → the advisory nudge (domain shows benchmark demand,
 *     consider whether the tier is understated) — surfaced with the row's `evidence` cite;
 *   • a row for a `core`/`contextual` project → silent (the demand is already reflected in the tier).
 *
 * @param rows  Array<{ project, capability, evidence }> — benchmarkCoverage.projectDomainDemand (declared)
 * @param projectTierById  Map<projectId, tier>  — the live stamped tier per project
 * @returns { errors: [], warnings: Array<{message, descriptor?}> }
 */
export function advisoryTierCrossCheck(rows, projectTierById) {
  const warnings = [];
  const warn = (m, descriptor) => warnings.push({ message: m, descriptor });
  for (const row of Array.isArray(rows) ? rows : []) {
    const { project, capability, evidence } = row || {};
    if (!project) continue;
    if (!projectTierById.has(project)) {
      warn(`benchmarkCoverage.projectDomainDemand names project "${project}" which does not resolve in projects.json — the declared domain→project evidence join has drifted (#2135)`,
        dUnresolvedRef('Project', project, fileFor('Project', project), 'projectDomainDemand', project, 'projects.json'));
      continue;
    }
    const tier = projectTierById.get(project);
    if (tier === 'exploratory') {
      warn(`Advisory (#2135): project "${project}" is tier "exploratory" but its domain shows benchmark demand for "${capability}" — consider whether the tier is understated. ADVISORY ONLY: the stamped tier still owns the value (#2088 Fork 3). Evidence: ${evidence || '(none cited)'}`,
        { kind: 'advisory-tier-cross-check', fix: 'model', entity: 'Project', id: project, field: 'tier', capability });
    }
  }
  return { errors: [], warnings };
}

/**
 * Validate a single protocol (§6b) — required fields, ownedByProject / realizesIntent resolution,
 * and the project-partial anchor probe.
 *
 * Pure: the anchor probe's file read is injected via `readProjectPartial(projectId) => string|null`
 * (null = the partial file is absent), so the rule is exercisable with synthetic projects.
 * @param ctx { projectById: Map, intentById: Map, readProjectPartial: (projectId) => string|null }
 */
export function validateProtocol(proto, ctx) {
  const { projectById, intentById, readProjectPartial } = ctx;
  const errors = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  const file = fileFor('Protocol', proto.id); // per-protocol spec path (#1146) for descriptor attribution
  for (const f of ['id', 'name', 'summary', 'status', 'ownedByProject', 'anchor']) {
    if (!proto[f]) err(`Protocol "${proto.id || '<no id>'}" missing required field "${f}"`,
      dMissingField('Protocol', proto.id, file, f));
  }
  for (const e of checkStatus('Protocol', proto.id, proto.status)) err(e.message, e.descriptor);
  if (proto.ownedByProject && !projectById.has(proto.ownedByProject))
    err(`Protocol "${proto.id}" ownedByProject "${proto.ownedByProject}" does not resolve in projects.json`,
      dUnresolvedRef('Protocol', proto.id, file, 'ownedByProject', proto.ownedByProject, 'projects.json'));
  if (proto.realizesIntent && !intentById.has(proto.realizesIntent))
    err(`Protocol "${proto.id}" realizesIntent "${proto.realizesIntent}" does not resolve in intents.json`,
      dUnresolvedRef('Protocol', proto.id, file, 'realizesIntent', proto.realizesIntent, 'intents.json'));
  if (proto.ownedByProject && proto.anchor) {
    const body = readProjectPartial(proto.ownedByProject);
    if (body === null || body === undefined)
      err(`Protocol "${proto.id}" expects project partial src/_includes/project-${proto.ownedByProject}.njk`);
    else if (!body.includes(`id="${proto.anchor}"`))
      err(`Protocol "${proto.id}" anchor "${proto.anchor}" not found in project-${proto.ownedByProject}.njk`);
  }
  return { errors, warnings: [] };
}

/**
 * Validate a single assembler preset (#646/#667) — a shadcn-shaped registry-item. Required fields,
 * status, `ownedByProject` resolution, every `composesBlocks`/`composesIntents` id resolves, and each
 * `files[]` entry carries a `path` + non-empty `content` (the ejectable recipe IS the standard, so an
 * empty file is a broken preset). The recipe is plain markup — it is NOT re-validated as a block.
 * @param ctx { projectById: Map, blockIds: Set, intentById: Map }
 */
export function validatePreset(preset, ctx) {
  const { projectById, blockIds, intentById } = ctx;
  const errors = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  const file = fileFor('Preset', preset.name); // per-preset spec path (#1146) for descriptor attribution
  for (const f of ['name', 'type', 'title', 'description', 'status', 'ownedByProject', 'files']) {
    if (preset[f] === undefined || preset[f] === null || preset[f] === '')
      err(`Preset "${preset.name || '<no name>'}" missing required field "${f}"`,
        dMissingField('Preset', preset.name, file, f));
  }
  for (const e of checkStatus('Preset', preset.name, preset.status)) err(e.message, e.descriptor);
  if (preset.ownedByProject && !projectById.has(preset.ownedByProject))
    err(`Preset "${preset.name}" ownedByProject "${preset.ownedByProject}" does not resolve in projects.json`,
      dUnresolvedRef('Preset', preset.name, file, 'ownedByProject', preset.ownedByProject, 'projects.json'));
  for (const b of preset.composesBlocks || []) {
    if (!blockIds.has(b))
      err(`Preset "${preset.name}" composesBlocks "${b}" does not resolve in the blocks registry (src/_data/blocks/)`,
        dUnresolvedRef('Preset', preset.name, file, 'composesBlocks', b, 'blocks registry'));
  }
  for (const i of preset.composesIntents || []) {
    if (!intentById.has(i))
      err(`Preset "${preset.name}" composesIntents "${i}" does not resolve in intents.json`,
        dUnresolvedRef('Preset', preset.name, file, 'composesIntents', i, 'intents.json'));
  }
  // Optional CEM descriptor (#668) — coexists with the recipe, describing the composed-API surface. Rides
  // the #653 CEM protocol; when present it must be a minimal CEM declaration (kind + name).
  if (preset.cem !== undefined) {
    if (!preset.cem || typeof preset.cem !== 'object')
      err(`Preset "${preset.name}" cem must be a CEM declaration object`,
        dMissingField('Preset', preset.name, file, 'cem'));
    else {
      if (!preset.cem.kind)
        err(`Preset "${preset.name}" cem missing "kind" (e.g. "class")`,
          dMissingField('Preset', preset.name, file, 'cem.kind'));
      if (!preset.cem.name)
        err(`Preset "${preset.name}" cem missing "name"`,
          dMissingField('Preset', preset.name, file, 'cem.name'));
    }
  }
  if (Array.isArray(preset.files)) {
    if (preset.files.length === 0)
      err(`Preset "${preset.name}" has an empty files[] — a preset must ship at least one recipe file`,
        dMissingField('Preset', preset.name, file, 'files'));
    preset.files.forEach((file, idx) => {
      if (!file || !file.path)
        err(`Preset "${preset.name}" files[${idx}] missing "path"`,
          dMissingField('Preset', preset.name, file, `files[${idx}].path`));
      if (!file || !file.content)
        err(`Preset "${preset.name}" file "${file && file.path ? file.path : idx}" has empty content`,
          dMissingField('Preset', preset.name, file, `files[${idx}].content`));
    });
  }
  return { errors, warnings: [] };
}

/**
 * Validate a single design-system bundle (#747 Fork-3-A, #871) — a thin registry entry that points at
 * a manifest of shape `{ extends, themeTokens (DTCG ref), intentDefaults?, traitDefaults? }`. Two layers
 * are checked: the rendering index (id/name/summary/status/ownedByProject + a `manifest` pointer that
 * resolves) and the manifest it points at (per #747: `themeTokens` is the only required field, it must
 * resolve as a file, `extends` must resolve to the platform default or another design system, and every
 * other field is optional). `intentDefaults` keys, when present, must resolve to known intents (the
 * bundle sets intent defaults — Fork 2-A); `traitDefaults` stays free-form (Fork 4-A's forward-compatible
 * presentational slot — the behavioral traits in traits.json are deliberately NOT a valid target here).
 *
 * Pure: manifest reads are injected — `readManifest(relPath) => object|null` (null = absent/unparseable)
 * and `tokenRefResolves(manifestRelPath, tokenRef) => boolean` (resolves the DTCG ref relative to the
 * manifest's own directory) — so the rule is exercisable with synthetic manifests.
 * @param ctx { projectById: Map, intentById: Map, designSystemIds: Set, readManifest, tokenRefResolves }
 */
export function validateDesignSystem(ds, ctx) {
  const { projectById, intentById, designSystemIds, readManifest, tokenRefResolves } = ctx;
  const errors = [];
  const warnings = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  const warn = (m, descriptor) => warnings.push({ message: m, descriptor });
  const id = ds.id || '<no id>';
  for (const f of ['id', 'name', 'summary', 'status', 'ownedByProject', 'manifest']) {
    if (!ds[f]) err(`Design system "${id}" missing required field "${f}"`,
      dMissingField('DesignSystem', ds.id, FILE.DesignSystem, f));
  }
  for (const e of checkStatus('DesignSystem', ds.id, ds.status)) err(e.message, e.descriptor);
  if (ds.ownedByProject && !projectById.has(ds.ownedByProject))
    err(`Design system "${id}" ownedByProject "${ds.ownedByProject}" does not resolve in projects.json`,
      dUnresolvedRef('DesignSystem', ds.id, FILE.DesignSystem, 'ownedByProject', ds.ownedByProject, 'projects.json'));
  if (!ds.manifest) return { errors, warnings };

  const manifest = readManifest(ds.manifest);
  if (!manifest) {
    err(`Design system "${id}" manifest "${ds.manifest}" does not resolve (missing or not valid JSON)`,
      dUnresolvedRef('DesignSystem', ds.id, FILE.DesignSystem, 'manifest', ds.manifest, ds.manifest));
    return { errors, warnings };
  }
  // themeTokens — the only required manifest field; it must resolve as a DTCG file.
  if (!manifest.themeTokens)
    err(`Design system "${id}" manifest missing required field "themeTokens" (a DTCG token ref)`,
      dMissingField('DesignSystem', ds.id, ds.manifest, 'themeTokens'));
  else if (!tokenRefResolves(ds.manifest, manifest.themeTokens))
    err(`Design system "${id}" themeTokens "${manifest.themeTokens}" does not resolve relative to ${ds.manifest}`,
      dUnresolvedRef('DesignSystem', ds.id, ds.manifest, 'themeTokens', manifest.themeTokens, ds.manifest));
  // extends — must resolve to the platform default sentinel or another registered design system.
  if (manifest.extends !== undefined) {
    const ok = manifest.extends === '@webtheme/default' || designSystemIds.has(manifest.extends);
    if (!ok)
      err(`Design system "${id}" extends "${manifest.extends}" does not resolve (expected "@webtheme/default" or another design-system id)`,
        dUnresolvedRef('DesignSystem', ds.id, ds.manifest, 'extends', manifest.extends, FILE.DesignSystem));
  }
  // intentDefaults — optional; when present every key must resolve to a known intent (Fork 2-A).
  if (manifest.intentDefaults !== undefined) {
    if (typeof manifest.intentDefaults !== 'object' || Array.isArray(manifest.intentDefaults))
      err(`Design system "${id}" intentDefaults must be an object of { intentId: value }`,
        dMissingField('DesignSystem', ds.id, ds.manifest, 'intentDefaults'));
    else for (const intentId of Object.keys(manifest.intentDefaults))
      if (!intentById.has(intentId))
        err(`Design system "${id}" intentDefaults "${intentId}" does not resolve in intents.json`,
          dUnresolvedRef('DesignSystem', ds.id, ds.manifest, 'intentDefaults', intentId, 'intents.json'));
  }
  // traitDefaults — optional, presentational only (Fork 4-A). Kept free-form: today's behavioral traits
  // (traits.json) are deliberately not a valid target, so we only type-check the slot's shape.
  if (manifest.traitDefaults !== undefined &&
      (typeof manifest.traitDefaults !== 'object' || Array.isArray(manifest.traitDefaults)))
    err(`Design system "${id}" traitDefaults must be an object of presentational { trait: value }`,
      dMissingField('DesignSystem', ds.id, ds.manifest, 'traitDefaults'));
  return { errors, warnings };
}

/**
 * Validate a single intent (§6c) — required fields, status, `dimensions` presence (warn), and
 * `requiresCapabilities` resolution (every declared id must resolve in capabilities.json).
 *
 * Custom-intent meta-schema (#1929, ruling #1913 `custom-intents-namespace-by-ownership`): a product-minted
 * intent is namespaced **`owner:intent`** (single colon, lowercase kebab); standard intents stay bare, so
 * promotion = drop the prefix (alias, never rename — RFC 6648: namespace by ownership, not status). The
 * optional meta-schema fields are `extends` (a standard intent id), `mustUnderstand` (boolean fail-fast
 * opt-in), and `provenance` (ownership anchor). `extends` is **additive**:
 *  - new dimensions a custom intent introduces must be **`owner:`-namespaced** keys;
 *  - it may add **`owner:value`-namespaced** values to an **open** inherited dimension (every value listed
 *    under an inherited key is treated as an addition and must carry the `owner:` prefix);
 *  - it may **never** widen a `closed: true` inherited dimension (#1337, untouchable by anyone) and never
 *    add a bare (unnamespaced) value — both are rejected at validate-time.
 * A dimension is **open** unless it declares `closed: true`. Standard (bare-id) intents are unaffected.
 * @param ctx { capabilityIds: Set, intentById?: Map }
 */
export function validateIntent(intent, ctx) {
  const { capabilityIds, intentById } = ctx;
  const errors = [];
  const warnings = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  const warn = (m, descriptor) => warnings.push({ message: m, descriptor });
  for (const f of ['id', 'name', 'summary', 'status', 'dimensions']) {
    if (intent[f] === undefined || intent[f] === null || intent[f] === '')
      err(`Intent "${intent.id || '<no id>'}" missing required field "${f}"`,
        dMissingField('Intent', intent.id, fileFor('Intent', intent.id), f));
  }
  for (const e of checkStatus('Intent', intent.id, intent.status)) err(e.message, e.descriptor);
  const dimCount = intent.dimensions && typeof intent.dimensions === 'object'
    ? Object.keys(intent.dimensions).length
    : 0;
  if (!dimCount) warn(`Intent "${intent.id}" has no dimensions — /intents/ catalog needs at least one axis`);
  // Intent → required-capabilities mapping (data-driven, D3′): every declared id must resolve.
  if (intent.requiresCapabilities !== undefined) {
    if (!Array.isArray(intent.requiresCapabilities)) {
      err(`Intent "${intent.id}" requiresCapabilities must be an array of capability ids`);
    } else {
      for (const capId of intent.requiresCapabilities)
        if (!capabilityIds.has(capId))
          err(`Intent "${intent.id}" requires unknown capability "${capId}" — not in capabilities.json`,
            dUnresolvedRef('Intent', intent.id, fileFor('Intent', intent.id), 'requiresCapabilities', capId, 'capabilities.json'));
    }
  }

  // ── Custom-intent meta-schema (#1929, ruling #1913) ──────────────────────────────────────────────
  // Only a namespaced (colon) id is a product-minted custom intent; bare standard intents skip this block.
  const id = String(intent.id ?? '');
  if (id.includes(':')) {
    if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(id))
      err(`Custom intent "${id}" must be namespaced \`owner:intent\` (lowercase kebab, a single colon) — RFC 6648: namespace by ownership, never status (#1913)`);
    const owner = id.split(':')[0];
    if (intent.mustUnderstand !== undefined && typeof intent.mustUnderstand !== 'boolean')
      err(`Custom intent "${id}" \`mustUnderstand\` must be a boolean (the per-intent fail-fast opt-in)`);
    if (intent.extends !== undefined) {
      const base = intentById && intentById.get(intent.extends);
      if (!base)
        err(`Custom intent "${id}" \`extends\` "${intent.extends}" does not resolve to a known intent`,
          dUnresolvedRef('Intent', id, fileFor('Intent', id), 'extends', intent.extends, 'intents.json'));
      else {
        const inherited = base.dimensions && typeof base.dimensions === 'object' ? base.dimensions : {};
        const own = intent.dimensions && typeof intent.dimensions === 'object' ? intent.dimensions : {};
        for (const [dimKey, dimDef] of Object.entries(own)) {
          const inheritedDim = inherited[dimKey];
          if (inheritedDim) {
            // Re-listing an inherited dimension key = a value-addition (never a redefinition/override).
            if (inheritedDim.closed === true)
              err(`Custom intent "${id}" cannot widen inherited dimension "${dimKey}" — it is a closed enum (#1337, untouchable by anyone)`);
            for (const v of (Array.isArray(dimDef && dimDef.values) ? dimDef.values : []))
              if (!String(v).startsWith(`${owner}:`))
                err(`Custom intent "${id}" adds bare value "${v}" to inherited dimension "${dimKey}" — cross-author additions must be \`${owner}:value\`-namespaced (#1913 Fork 3d)`);
          } else if (!dimKey.startsWith(`${owner}:`)) {
            // A brand-new dimension a custom intent introduces must itself be owner-namespaced.
            err(`Custom intent "${id}" adds non-namespaced dimension "${dimKey}" — new custom dimensions must be \`${owner}:dimension\`-namespaced (#1913 Fork 3)`);
          }
        }
      }
    }
  }
  return { errors, warnings };
}

// Capability + build-matrix vocabularies (§6c-bis, #204). Exported so the script and tests share one
// definition of the three tier states and the polyfill classes.
export const TIER_STATES = new Set(['native-ok', 'polyfill-ok', 'capability-hard']);
// Library impls (#1450/#1487) score on a coverage axis, not the platform-relative substrate axis — a JS
// library does not sit on native-ok/polyfill-ok/capability-hard. A `kind: library` row tiers each capability
// supported/partial/unsupported instead. `kind` defaults to `native` (the existing substrate rows).
export const LIBRARY_TIER_STATES = new Set(['supported', 'partial', 'unsupported']);
export const CAP_POLYFILL = new Set(['polyfillable', 'partial', 'capability']);

/**
 * Validate a single capability (§6c-bis) — required fields, the `baseline` year-string-or-false
 * shape, and the polyfill class vocabulary.
 */
export function validateCapability(cap) {
  const errors = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  for (const f of ['id', 'label', 'webFeaturesKey', 'baseline', 'polyfill', 'summary']) {
    if (cap[f] === undefined || cap[f] === null || cap[f] === '')
      err(`Capability "${cap.id || '<no id>'}" missing required field "${f}"`,
        dMissingField('Capability', cap.id, FILE.Capability, f));
  }
  if (cap.baseline !== undefined && cap.baseline !== false && typeof cap.baseline !== 'string')
    err(`Capability "${cap.id}" baseline must be a year string or false (not-yet-Baseline)`);
  if (cap.polyfill && !CAP_POLYFILL.has(cap.polyfill))
    err(`Capability "${cap.id}" has invalid polyfill class "${cap.polyfill}" (expected ${[...CAP_POLYFILL].join(' / ')})`);
  return { errors, warnings: [] };
}

/**
 * Validate the registered capability-adapter table + static build-matrix invariants (§6c-bis,
 * #204/#206/#216). The `impls[]` array IS the registered adapter table — one row per impl — and the
 * matrix's row source. This guards: a non-empty table, unique ids, per-row required fields, a boolean
 * `native` marker, a tier map whose values are all valid states keying only known capabilities, the
 * *completeness* of the grid (every row tiers every capability), a detail-page partial per row, and
 * the single-native-substrate invariant.
 *
 * Pure: `capabilityIds` (the known-capability id set) and `hasAdapterDesc(id) => bool` (the partial
 * probe) are injected, so the gnarly completeness/native-count logic is fixture-testable.
 * @param ctx { capabilityIds: Set, hasAdapterDesc: (id) => boolean }
 */
export function validateCapabilityMatrix(matrixImpls, ctx) {
  const { capabilityIds, hasAdapterDesc } = ctx;
  const errors = [];
  const warnings = [];
  const err = (m, descriptor) => errors.push({ message: m, descriptor });
  const warn = (m, descriptor) => warnings.push({ message: m, descriptor });
  const impls = Array.isArray(matrixImpls) ? matrixImpls : [];
  if (!impls.length) err('capabilityMatrix.json has no registered capability adapters — the default provider needs at least one impl row');
  // Unique adapter ids (dup rows would silently double-tier a capability).
  const seenIds = new Set();
  for (const impl of impls) {
    if (!impl.id) continue;
    if (seenIds.has(impl.id)) err(`Duplicate id "${impl.id}" in capabilityMatrix.json adapter table (impls)`);
    seenIds.add(impl.id);
  }
  let nativeImplCount = 0;
  for (const impl of impls) {
    for (const f of ['id', 'label', 'summary', 'tiers']) {
      if (impl[f] === undefined || impl[f] === null || impl[f] === '')
        err(`Registered capability adapter "${impl.id || '<no id>'}" missing required field "${f}"`,
          dMissingField('CapabilityAdapter', impl.id, FILE.CapabilityAdapter, f));
    }
    // `native` (the native-first tiebreak marker, #205) is optional but, when present, a boolean.
    if (impl.native !== undefined && typeof impl.native !== 'boolean')
      err(`Capability adapter "${impl.id}" native must be a boolean (the native-first substrate marker)`);
    if (impl.native === true) nativeImplCount++;
    // `kind` selects the tier vocabulary: `native` (default) → substrate states; `library` → coverage states.
    const kind = impl.kind ?? 'native';
    if (kind !== 'native' && kind !== 'library')
      err(`Capability adapter "${impl.id}" kind must be "native" or "library" (got "${impl.kind}")`);
    const validStates = kind === 'library' ? LIBRARY_TIER_STATES : TIER_STATES;
    const tiers = impl.tiers && typeof impl.tiers === 'object' ? impl.tiers : {};
    // Every tier value must be one of the kind's states, and key a known capability id (no stray rows).
    for (const [capId, tier] of Object.entries(tiers)) {
      if (!capabilityIds.has(capId))
        err(`Capability adapter "${impl.id}" tiers unknown capability "${capId}" — not in capabilities.json`,
          dUnresolvedRef('CapabilityAdapter', impl.id, FILE.CapabilityAdapter, 'tiers', capId, 'capabilities.json'));
      if (!validStates.has(tier))
        err(`Capability adapter "${impl.id}" (kind ${kind}) capability "${capId}" has invalid tier "${tier}" (expected ${[...validStates].join(' / ')})`);
    }
    // The build-matrix is a complete grid: tier() must be total, so every row tiers every capability.
    for (const capId of capabilityIds)
      if (!(capId in tiers))
        err(`Capability adapter "${impl.id}" is missing a tier for capability "${capId}" — the registered row must tier every capability (the matrix is a complete impl × capability grid)`);
    // Each registered adapter gets a detail page (capability-adapter-pages.njk) backed by a prose
    // partial — the column-detail discovery surface (#216), mirroring adapter-descriptions/{id}.njk.
    if (impl.id && !hasAdapterDesc(impl.id))
      err(`Capability adapter "${impl.id}" has no src/_includes/capability-adapter-descriptions/${impl.id}.njk`,
        dMissingDescription('CapabilityAdapter', impl.id, `src/_includes/capability-adapter-descriptions/${impl.id}.njk`));
  }
  // The native-first tiebreak needs an unambiguous substrate: at most one impl may be marked native.
  if (nativeImplCount > 1)
    err(`capabilityMatrix.json registers ${nativeImplCount} native adapters — the native-first tiebreak needs a single native substrate`);
  // Zero native is legal but means native-first can never win a lightness tie on the bundled table.
  if (impls.length && nativeImplCount === 0)
    warn('capabilityMatrix.json registers no native adapter — native-first has no substrate to prefer on a tie');
  return { errors, warnings };
}

// Strip the leading `YYYY-MM-DD-` date and the `.md` suffix from a report filename to get its slug
// (the id a /research/ topic would carry). Exported for the reports-not-hidden test fixtures.
export const deDateReport = (f) => f.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '');

/**
 * Reports-not-hidden (§6e): reports/ is NOT in the 11ty build, so a report is reachable only when a
 * /research/ topic (id = its de-dated slug) or a backlog item (relatedReport) references it. A report
 * that is neither is invisible — fail.
 *
 * Pure: the fs walk stays in the script; the file list + the two reference sets are injected.
 * @param ctx { researchIds: Set, backlogReportRefs: Set } — refs are filenames with the `reports/`
 *              prefix stripped (matching how the script normalises relatedReport).
 */
export function validateReportsNotHidden(reportFiles, ctx) {
  const { researchIds, backlogReportRefs } = ctx;
  const errors = [];
  for (const f of reportFiles) {
    const slug = deDateReport(f);
    if (!researchIds.has(slug) && !backlogReportRefs.has(f))
      errors.push({ message:
        `Report "reports/${f}" is hidden — no /research/ topic (id "${slug}") and no /backlog/ item ` +
        `references it (relatedReport). Promote it to a research topic or add a backlog item.` });
  }
  return { errors, warnings: [] };
}

/**
 * Compiled-artifact shadow (§8): a `.js`/`.d.ts` emitted next to its `.ts`/`.tsx` source silently
 * shadows it in vitest (extensionless imports resolve `.js` BEFORE `.tsx`). Fail on any such pair.
 *
 * Pure: takes a flat list of file paths (the fs walk stays in the script) and returns one error per
 * shadowing artifact. `rel(path)` formats the display path (default: identity).
 */
export function findCompiledShadows(fileList, rel = (f) => f) {
  const errors = [];
  const fileSet = new Set(fileList);
  for (const f of fileList) {
    const base = f.endsWith('.d.ts') ? f.slice(0, -5) : f.endsWith('.js') ? f.slice(0, -3) : null;
    if (!base) continue;
    if (fileSet.has(`${base}.ts`) || fileSet.has(`${base}.tsx`))
      errors.push({ message:
        `Compiled artifact "${rel(f)}" shadows its TS source — delete it. ` +
        `Stale .js/.d.ts next to .ts/.tsx silently override the source in vitest (.js resolves first).` });
  }
  return { errors, warnings: [] };
}

// Escape a string for literal use inside a RegExp (the proxy-coverage probe builds a regex per segment).
export const escapeRegExp = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

/**
 * Is a top-level catalog segment covered by the Vite proxy allowlist? (§9, #210.) A segment is
 * "covered" when it appears in the proxy-key blob bounded by a path/alternation delimiter — so `js`
 * matches `|js)` but the `js` inside `project-lifecycle` does not. This bounded-match regex is the
 * gnarly bit a silent false-positive/negative most likely hides in, so it's factored for fixtures.
 */
export function isSegmentCovered(seg, proxyKeys) {
  return new RegExp(`(?:^|[\\/|(])${escapeRegExp(seg)}(?:[\\/|)\\\\$]|$)`).test(proxyKeys);
}

/**
 * Derive a catalog njk's top-level URL segment from its body — its `permalink:` front-matter, else
 * the 11ty default `/<name>/`. Returns null for the root or a fully-templated first segment (neither
 * maps to a fixed proxy route).
 */
export function permalinkSegment(njkBody, filename) {
  const m = njkBody.match(/^\s*permalink:\s*["']?([^"'\n]+)/m);
  const permalink = m ? m[1].trim() : `/${filename.replace(/\.njk$/, '')}/`;
  const seg = permalink.replace(/^\//, '').split('/')[0];
  if (!seg || seg.includes('{')) return null;
  return seg;
}

/**
 * Vite dev-proxy allowlist coverage (§9): every catalog route that renders on 11ty :8080 must be
 * forwarded by the Vite proxy, or it 404s on :3000. Pure: takes the parsed `{ seg, file }` segments
 * (via permalinkSegment) + the proxy-key blob and reports each uncovered segment.
 */
export function validateViteProxyCoverage(segments, proxyKeys) {
  const errors = [];
  for (const { seg, file } of segments)
    if (!isSegmentCovered(seg, proxyKeys))
      errors.push({ message:
        `Vite proxy is missing catalog route "/${seg}/" (from src/${file}) — it renders on 11ty :8080 ` +
        `but 404s on the Vite dev server :3000. Add "${seg}" to the proxy allowlist alternation in vite.config.mts.` });
  return { errors, warnings: [] };
}

// ── Module-resolution exports-lock (#274, materialising #271) ──────────────────────────────────────
// The module-resolution axis lets a project resolve a bare specifier however its toolchain does
// (node_modules+exports, importmap, CDN URL, dev alias) — but with ONE lock: an `@frontierui/*` entry
// in any of those native manifests must terminate at the PACKAGE's `exports`, never at WE/foreign
// source or a raw in-repo path. "protocol is the only lock." This is the lint half of #274's three
// deliverables (the model + reference page are the other two); the resolution itself is native, no
// runtime code.

/** The published-impl scope whose entries are locked to package-exports resolution (#239/#271). */
export const MODULE_RESOLUTION_LOCKED_SCOPE = '@frontierui/';

/**
 * Is an importmap/alias `target` a legitimate package-exports terminus (vs a raw source path)? OK:
 * an http(s) URL (CDN/served), a `node_modules` path, or a bare specifier (no leading `/`, `.` — node
 * resolves it via `exports`). NOT OK: a raw in-repo/foreign source path — a leading `/` that is not a
 * URL (e.g. `/plugs/...`), a relative `./`/`../` path, or any path reaching into a `/src/` tree.
 */
export function isExportsSafeTarget(target) {
  if (typeof target !== 'string' || target.trim() === '') return false;
  if (/^https?:\/\//.test(target)) return true; // URL override
  if (/(^|\/)node_modules\//.test(target)) return true; // resolved package path
  if (target.startsWith('/') || target.startsWith('./') || target.startsWith('../')) return false; // raw path
  if (target.includes('/src/')) return false; // foreign/WE source tree
  return true; // bare specifier → node-resolution via exports
}

/**
 * Module-resolution exports-lock: every locked-scope (`@frontierui/*`) importmap/alias entry must
 * resolve to the package's exports (URL, node_modules, or bare specifier), never a raw WE/foreign
 * source path. Pure: takes the gathered `{ specifier, target, source }` entries and reports each
 * violation. Vacuously passes when no locked entry exists (the common case until a project repoints).
 */
export function validateModuleResolutionLock(entries) {
  const errors = [];
  for (const { specifier, target, source } of entries) {
    if (!specifier.startsWith(MODULE_RESOLUTION_LOCKED_SCOPE)) continue;
    if (!isExportsSafeTarget(target))
      errors.push({ message:
        `Module-resolution lock: "${specifier}" → "${target}"${source ? ` (in ${source})` : ''} resolves to a ` +
        `raw source path, not the package exports. An ${MODULE_RESOLUTION_LOCKED_SCOPE}* entry must terminate at ` +
        `the published package (a bare specifier, a node_modules path, or an http(s) URL) — never WE/foreign ` +
        `source. See the module-resolution reference (#271/#274).` });
  }
  return { errors, warnings: [] };
}

// ── Codegen-placement invariants (#964, hardening #956's ruling) ─────────────
// #956 ratified: the `serve()` form-generators stay in the WE repo as reference runtime (#791), but
// `@webeverything` publishes only the contract + conformance vectors — never the lowering code (#855).
// Both load-bearing invariants were true-by-absence; #964 makes them enforced.

export const RENDERERS_PUBLISH_ENFORCED = true; // #964: renderers never enter a published @webeverything exports map
/** The published WE scope (`npm scope mirrors layer`, #239): standard artifacts only — never impl/renderers. */
export const WEBEVERYTHING_PUBLISHED_SCOPE = '@webeverything/';

/** Flatten an `exports` map (string | nested conditions/subpaths) to its leaf target strings. */
export function flattenExportsTargets(exports) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(exports);
  return out;
}

/**
 * Invariant 1 (#956/#855): no `@webeverything/*` published package may re-export the reference-runtime
 * renderers. The form-generators (`blocks/renderers/*`) are repo-internal reference runtime (#791); a
 * published `exports` target that reaches into `blocks/renderers/` would ship the lowering code as a de
 * facto standard — exactly what #855 forbids. Pure: takes the gathered `{ name, exports, source }`
 * manifests; vacuously passes when no `@webeverything/*` manifest exists (true today — root pkg is the
 * unscoped `web-everything` with no exports map).
 */
export function validateRenderersNotPublished(manifests) {
  if (!RENDERERS_PUBLISH_ENFORCED) return { errors: [], warnings: [] };
  const errors = [];
  for (const { name, exports, source } of manifests) {
    if (typeof name !== 'string' || !name.startsWith(WEBEVERYTHING_PUBLISHED_SCOPE)) continue;
    for (const target of flattenExportsTargets(exports)) {
      if (/(^|\/)blocks\/renderers\//.test(String(target).replace(/^\.\//, '')))
        errors.push({ message:
          `Published-renderer leak: ${name} (${source}) has an exports target "${target}" reaching ` +
          `blocks/renderers/. The form-generators are WE-repo reference runtime (#791) — @webeverything ` +
          `publishes only the contract + conformance vectors, never the lowering code (#855/#956). ` +
          `Drop the renderer from the published exports map.` });
    }
  }
  return { errors, warnings: [] };
}

export const REFERENCE_RUNTIME_FORMS_ENFORCED = true; // #964: WE-side serve() form catalog is frozen to the ratified reference-runtime set
/**
 * The form ids WE's reference runtime emits in-repo (#956's principled refinement). These five are the
 * forms a `<component>` definition is *already* lowered to by WE-side code — they stay WE (#791). A
 * genuinely-new framework target (Vue/Svelte/Angular SFC, …) has NO WE reference runtime, so its
 * generator must follow the #855/genWrapper pattern (contract+vectors in WE, generator in FUI) and must
 * NOT be slipped into the WE-side `serve()` switch — the catalog's openness lives in the *adapter* layer
 * (#663), not the reference runtime.
 */
export const REFERENCE_RUNTIME_FORMS = new Set(['declarative', 'wc-class', 'html', 'jsx', 'functional']);

/**
 * Invariant 2 (#956 per-form refinement → gate): the WE-side `serve()` form catalog (the `FORMS` ids /
 * `ServeForm` union in `module-service/moduleService.ts`) must be a subset of the ratified
 * reference-runtime set. A new id beyond it manufactures a WE-side codegen path for a framework target
 * that should go through FUI — closing the "a demo ships a consumer to keep codegen in WE" escape #956's
 * skeptic flagged. Pure: takes the gathered form ids; the fs parse lives in the gate.
 */
export function validateReferenceRuntimeForms(formIds) {
  if (!REFERENCE_RUNTIME_FORMS_ENFORCED) return { errors: [], warnings: [] };
  const errors = [];
  for (const id of formIds) {
    if (!REFERENCE_RUNTIME_FORMS.has(id))
      errors.push({ message:
        `New WE-side serve() form "${id}": the reference-runtime form catalog is frozen to ` +
        `{${[...REFERENCE_RUNTIME_FORMS].join(', ')}} (#956). A genuinely-new framework target has no WE ` +
        `reference runtime — its generator must follow the #855/genWrapper pattern (contract+vectors in ` +
        `WE, generator in FUI), not a WE-side serve() case. The form catalog's openness lives in the ` +
        `adapter layer (#663), never the WE renderer.` });
  }
  return { errors, warnings: [] };
}

// ── Research freshness derivation (#441 Fork 4 / #477) ───────────────────────
// The derivation lives in a CommonJS module (scripts/lib/research-freshness.cjs) so the sync-only
// Eleventy 2.x config can `require` it for the reader freshness badge; here we re-export its named
// bindings so the warn-only check:standards rule shares the *exact* same logic — one source of
// truth, two module systems.
export { RESEARCH_REVIEW_HORIZON_DEFAULT, addIsoDuration, deriveResearchFreshness } from './lib/research-freshness.cjs';

// ── Benchmark capability-presence join table (#352) ──────────────────────────
/**
 * Validate the capability×source presence join table (`benchmarkCapabilityPresence.json`, #352): every
 * row must reference a known capability id and a known corpus source id, `present` must be a boolean,
 * and `provenance` one of the declared kinds. A `verified` row without a `url` warns (the deep doc link
 * is the point of verifying); a `notable-inference` row legitimately has none yet. Pure: takes the rows
 * + the id sets the script gathers from the sibling registries.
 */
export function validateCapabilityPresence(presence, { capabilityIds, sourceIds, provenanceKinds }) {
  const errors = [];
  const warnings = [];
  const rows = Array.isArray(presence?.rows) ? presence.rows : [];
  const kinds = new Set(provenanceKinds ?? ['notable-inference', 'verified']);
  const seen = new Set();
  for (const r of rows) {
    const key = `${r.capabilityId}${r.sourceId}`;
    if (seen.has(key)) errors.push({ message: `capability-presence: duplicate row for (${r.capabilityId}, ${r.sourceId})` });
    seen.add(key);
    if (!capabilityIds.has(r.capabilityId))
      errors.push({ message: `capability-presence: row references unknown capability "${r.capabilityId}" (not in benchmarkCapabilities)` });
    if (!sourceIds.has(r.sourceId))
      errors.push({ message: `capability-presence: row references unknown corpus source "${r.sourceId}" (not in benchmarkCorpus)` });
    if (typeof r.present !== 'boolean')
      errors.push({ message: `capability-presence: row (${r.capabilityId}, ${r.sourceId}) "present" must be a boolean` });
    if (!kinds.has(r.provenance))
      errors.push({ message: `capability-presence: row (${r.capabilityId}, ${r.sourceId}) has unknown provenance "${r.provenance}"` });
    if (r.provenance === 'verified' && !r.url)
      warnings.push({ message: `capability-presence: verified row (${r.capabilityId}, ${r.sourceId}) has no deep doc url — the URL is the point of verifying (#352)` });
  }
  return { errors, warnings };
}

// ── General reference-retirement convention (#584) ───────────────────────────
const RETIREMENT_ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Shared validator for the general reference-retirement convention (#584 ruling): ONE uniform
 * field-set applied to every structured reference home (corpus sources, `references.json` links,
 * `designSystemResearch` refs, capability-presence rows) — the homes differ in container, not in the
 * retirement concept, so the shape reads identically everywhere. Two orthogonal, independently-optional
 * markers (Fork 3-A — death and supersession are distinct facts a single enum can't both hold):
 *   • the #546 death triplet — `retired:true` + `retiredDate` (ISO) + `retiredReason` (keep-not-delete);
 *   • the #192 supersession pointer — `supersededBy` ("a newer canonical replaces this").
 * Pure: takes one entry object + a `label` and an optional `resolveSupersededBy(target)` predicate
 * (supplied only by homes with an id space, e.g. the corpus, where the pointer is a sibling id).
 * Vacuously passes when an entry carries no retirement markers — the common, most-permissive case
 * (the metadata is always opt-in, never required). See docs/agent/reference-retirement.md.
 */
export function validateRetirementShape(entry, { label = 'entry', resolveSupersededBy } = {}) {
  const errors = [];
  const warnings = [];
  if (!entry || typeof entry !== 'object') return { errors, warnings };
  const present = (k) => entry[k] != null && entry[k] !== '';
  // Death triplet — all-or-nothing: retired:true requires a reason + ISO date; neither field stands alone.
  if ('retired' in entry && typeof entry.retired !== 'boolean')
    errors.push({ message: `${label}: "retired" must be a boolean (#584)` });
  if (entry.retired === true) {
    if (!present('retiredReason'))
      errors.push({ message: `${label}: retired:true requires a retiredReason — keep-not-delete: record why it left (#584)` });
    if (!present('retiredDate'))
      errors.push({ message: `${label}: retired:true requires a retiredDate (#584)` });
    else if (!RETIREMENT_ISO_DATE.test(entry.retiredDate))
      errors.push({ message: `${label}: retiredDate must be an ISO date (YYYY-MM-DD), got "${entry.retiredDate}" (#584)` });
  } else if (present('retiredDate') || present('retiredReason')) {
    errors.push({ message: `${label}: retiredDate/retiredReason present without retired:true — the death triplet is all-or-nothing (#584)` });
  }
  // Supersession pointer — orthogonal to death; resolved only where the home has an id space.
  if (present('supersededBy') && typeof resolveSupersededBy === 'function') {
    const targets = Array.isArray(entry.supersededBy) ? entry.supersededBy : [entry.supersededBy];
    for (const t of targets)
      if (!resolveSupersededBy(t))
        errors.push({ message: `${label}: supersededBy "${t}" does not resolve to a known entry (#584)` });
  }
  return { errors, warnings };
}

// ── Plug dual-mode conformance (#636, enforcing the #606 invariants) ───────────
// #606 ruled: every plug ships passing automated tests for BOTH the unplugged
// (non-invasive) and plugged modes, and NO plug may require plugged mode — the
// unplugged form is mandatory and is the real-app surface; plugged is POC/demo.
// A passing *unplugged-mode* test is the automated proof a plug doesn't require
// plugged mode, so the dual-mode test coverage IS the enforcement mechanism.
//
// This rule is pure: `domains` is the pre-collected metadata (the fs walk lives in
// check-standards.mjs). Each domain = { name, hasSource, hasPluggedTest, hasUnpluggedTest }.
//
// Staging (per #636, "defines the test shape the backfill fills"): the #635 audit
// found all 10 domains have an unplugged FORM but only webbehaviors has an
// unplugged-mode TEST. The #649 backfill fills the rest. So the unplugged-mode
// requirement is a WARN until that backfill lands, then it promotes to ERROR
// (flip PLUG_UNPLUGGED_TEST_ENFORCED to true) so "missing either mode's tests"
// fully fails the gate. The plugged-mode + no-untested-plug invariants are ERROR now.
export const PLUG_UNPLUGGED_TEST_ENFORCED = true;

export function validatePlugDualMode(domains) {
  const errors = [];
  const warnings = [];
  for (const d of domains) {
    if (!d.hasSource) continue; // not a plug domain (no implementation files)
    // ERROR — a plug with no plugged-mode test (the global-patched / real-DOM path).
    if (!d.hasPluggedTest)
      errors.push({
        message: `Plug domain "${d.name}" ships no plugged-mode test — every plug needs passing tests for BOTH modes (#606/#636).`,
      });
    // The unplugged-mode test is the proof the plug does not REQUIRE plugged mode.
    if (!d.hasUnpluggedTest) {
      const msg = `Plug domain "${d.name}" ships no unplugged-mode (non-invasive) test — a plug may not require plugged mode; the unplugged form is mandatory (#606). #649 backfill target.`;
      if (PLUG_UNPLUGGED_TEST_ENFORCED) errors.push({ message: msg });
      else warnings.push({ message: msg });
    }
  }
  return { errors, warnings };
}

// ── Repo-locus prefix detection (#884, enforces the #883 convention; #880 slice B) ──
// Every code-path reference in backlog/*.md + reports/*.md must carry a `<repo>:` locus marker
// (`we:`/`fui:`/`plateau:` or the full name) so its constellation repo is unambiguous in chat / raw
// markdown (the convention codified in conventions.md by #883). This scans for path-like tokens that
// LACK a marker. Carve-outs (per #880): fenced code blocks, markdown-link targets (the link *text*
// carries the locus — `[we:path](path)`), `@scope/pkg` npm specifiers, URLs, and the WE-relative
// frontmatter fields (`relatedReport`/`graduatedTo`/`crossRef`). WARN-level until the #885 corpus
// migration, then it flips to ERROR (flip REPO_LOCUS_PREFIX_ENFORCED). Pure: docs read by the caller.
export const REPO_LOCUS_PREFIX_ENFORCED = true;

// Longer/prefix-conflicting extensions first + a no-trailing-letter guard so `blocks.json` matches
// `json` (not `js` + leftover `on`).
const PATHLIKE_RE = /[\w./-]+\.(?:tsx|ts|json|mjs|cjs|js|md|njk|css|html|yaml|yml)(?![a-z])(?::\d+(?:-\d+)?)?/g;
const LOCUS_MARKER_RE = /(?:we|fui|plateau|webeverything|frontierui|plateau-app):$/;
const EXEMPT_FIELD_RE = /^\s*(?:relatedReport|graduatedTo|crossRef|codifiedIn)\s*:/;
// #885 false-positive carve-outs (these are NOT repo code-path references): JS-ecosystem product
// names (`Node.js`/`Next.js`/`Three.js` — a single Capitalized word + `.js`) and bare type-suffix
// fragments (`.d.ts`/`.spec.ts` — an extension chain with no name segment). Glob masks (`*.test.ts`)
// are caught separately by a `*` immediately before the token.
const PRODUCT_JS_RE = /^[A-Z][a-z]+\.js$/;
const TYPE_FRAGMENT_RE = /^\.(?:d|test|spec|stories|sw\.spec)\.[a-z]+$/;

/**
 * PURE CORE, single document. Every unmarked pathlike token in `content`, IN ORDER, WITH duplicates —
 * exactly what {@link scanRepoLocusPrefixes} has always counted. Extracted (#3383 mechanical-dispatcher
 * fix, live #3565 trial) so a caller that needs the ACTUAL matched substrings — not just a count + first
 * sample — reads from this identical scan rather than a second, driftable copy of the same five exemption
 * checks. See {@link findUnmarkedLocusRefs}, its caller.
 */
function scanUnmarkedLocusRefs(content) {
  const noFenced = String(content ?? '').replace(/```[\s\S]*?```/g, '');
  const unmarked = [];
  for (const line of noFenced.split('\n')) {
    if (EXEMPT_FIELD_RE.test(line)) continue;
    for (const m of line.matchAll(PATHLIKE_RE)) {
      const before = line.slice(0, m.index);
      if (LOCUS_MARKER_RE.test(before)) continue;        // already marked (we:/fui:/… or full name)
      if (/\]\($/.test(before)) continue;                // markdown link target — text carries the locus
      if (/@$/.test(before)) continue;                   // @scope/pkg npm specifier (scope sits in the token)
      if (/https?:\/*$/.test(before)) continue;          // URL (the `//…` is consumed into the token)
      if (/\*$/.test(before)) continue;                  // glob mask (`*.test.ts`) — a file-type pattern, not a path
      if (PRODUCT_JS_RE.test(m[0])) continue;            // JS-ecosystem product name (`Node.js`), not a repo file
      if (TYPE_FRAGMENT_RE.test(m[0])) continue;         // bare type-suffix fragment (`.d.ts`), not a path
      unmarked.push(m[0]);
    }
  }
  return unmarked;
}

/**
 * Scan docs (`[{ file, content }]`) for code-path tokens lacking a `<repo>:` locus marker. Returns
 * per-file findings `[{ file, count, sample }]` (pure). Strips fenced code blocks first; applies the
 * #880 carve-outs per token. Inline backtick code is NOT exempt — a path in backticks still needs the
 * prefix (`` `we:scripts/x.ts` ``).
 */
export function scanRepoLocusPrefixes(docs) {
  const findings = [];
  for (const { file, content } of docs) {
    const unmarked = scanUnmarkedLocusRefs(content);
    if (unmarked.length) findings.push({ file, count: unmarked.length, sample: unmarked[0] });
  }
  return findings;
}

/**
 * #3383 mechanical-dispatcher fix — live #3565 trial (2026-09-13). Every DISTINCT unmarked pathlike token
 * {@link scanRepoLocusPrefixes} would flag in ONE document's content, deduped — the shape an auto-fixer
 * needs (which exact substrings to prefix) rather than a count + first sample. Reuses
 * `scanUnmarkedLocusRefs`'s identical scan (the SAME `PATHLIKE_RE`/`LOCUS_MARKER_RE`/exemption checks the
 * gate itself runs), so a fixer built on this can never drift from what the gate actually flags.
 *
 * WHY THIS EXISTS: `we:scripts/operations/deliver-item-wrapper.mjs#sanitizeOwnLocusMentions` (added by
 * #3565's wrapper-owned-commit redesign) used to prefix bare mentions of ONLY the delivery's own touched
 * paths, on the assumption that a delivery agent's backlog prose only ever quotes files IT just touched.
 * A live #3565 dispatch trial disproved that: the pre-commit `lint:locus` hook still rejected the
 * wrapper's own commit (`locus-prefix: 2 bare code-path ref(s) ...`) because the agent's own `## Progress`
 * note also cited an UNTOUCHED existing file bare (`queue-store.mjs`, mentioned for context, never itself
 * part of the diff) — a token the touched-paths-only fixer had no way to know needed prefixing, since it
 * was never in that list to begin with. Scanning the file's own FULL content with the real detector,
 * instead of a caller-supplied guess at which tokens might appear, closes that gap by construction: it
 * prefixes everything the gate would flag, whether or not it happens to be one of the delivery's own
 * touched files.
 */
export function findUnmarkedLocusRefs(content) {
  return [...new Set(scanUnmarkedLocusRefs(content))];
}

/**
 * Scan docs (`[{ file, content }]`) for content that must never sit in a COMMITTED artifact — the #3015
 * publish-seam sweep. Returns per-file findings `[{ file, reasons }]` (pure; the fs walk lives in
 * check-standards.mjs, mirroring `scanRepoLocusPrefixes` directly above).
 *
 * THE BACKSTOP, NOT THE GATE. The two write-time gates (`writeBacklogMd` for the CLI funnel, the `--pre`
 * hooks for `Edit`/`Write`) deny BEFORE the write. This sweep re-reads the corpus afterwards, so it catches
 * only a write that used neither — a later catch, not a same-turn deny. It shares the ONE detector
 * (`scrubPublish`, we:scripts/lib/secret-scrub.mjs) with both gates rather than re-stating the patterns; an
 * unreachable second copy of a rule is drift waiting to happen.
 */
export function scanPublishSecrets(docs) {
  const findings = [];
  for (const { file, content } of docs) {
    const reasons = scrubPublish(content);
    if (reasons.length) findings.push({ file, reasons });
  }
  return findings;
}

// ── Harness-scaffolding leak sweep (#3448) ────────────────────────────────────────────────────────
// PR #1803 committed a literal <system-reminder> block into a backlog item — copy-pasted from the
// authoring agent's own context, not an external attack, undetected until human review. A real leak
// always lands as its OWN block: the tag opens a fresh line, and a `Claude-Session:` header likewise
// starts its own line — so those two markers are anchored at line-start (optional leading
// whitespace, or a `>` blockquote prefix — a leak pasted into review discussion is often quoted) rather
// than matched anywhere in the line. That is what lets this rule pass on backlog/report content that
// merely *describes* the incident in prose (e.g. this very item's body mentions "<system-reminder>" and
// "SendUserFile" mid-sentence, never at a line's start) while still catching a genuinely pasted block.
// SCOPE NOTE: this is a "leaked BLOCK" detector, not a "leaked marker anywhere" detector — a marker
// smashed into the middle of a sentence (not opening its own line) is intentionally out of scope, the
// same tradeoff #1803's own shape (a genuine multi-line paste) makes safe. `SendUserFile`'s tell is
// different — the harness phrases it as a natural-language instruction ("… send it with SendUserFile")
// rather than a line-opening tag, so its marker matches that phrase anywhere in the line.
const HARNESS_SCAFFOLDING_MARKERS = [
  { label: '<system-reminder> tag', re: /^[\s>]*<\/?system-reminder\b[^>]*>/i },
  { label: '<system> tag', re: /^[\s>]*<\/?system(?!-reminder)\b[^>]*>/i },
  { label: 'Claude-Session: header', re: /^[\s>]*Claude-Session:/i },
  { label: 'SendUserFile tool-invocation instruction', re: /\bwith\s+SendUserFile\b/i },
];

/**
 * Find harness-scaffolding leak markers in a markdown body, outside fenced code blocks (mirrors the
 * fence-toggle scan in findRawHtmlInMarkdown above — a marker fenced in a code block is a documented
 * example of the pattern, not a leak). Returns `[{ line, label, match }]`.
 */
export function findHarnessScaffoldingMarkers(body) {
  const findings = [];
  if (typeof body !== 'string' || body === '') return findings;
  let fenceChar = null;
  let fenceLen = 0;
  body.split('\n').forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) { fenceChar = null; fenceLen = 0; }
      return; // inside a fence — a documented example, not a leak
    }
    if (fm) { fenceChar = fm[1][0]; fenceLen = fm[1].length; return; }
    for (const { label, re } of HARNESS_SCAFFOLDING_MARKERS) {
      const m = line.match(re);
      if (m) findings.push({ line: i + 1, label, match: m[0].trim() });
    }
  });
  return findings;
}

/**
 * Scan docs (`[{ file, content }]`) for harness-scaffolding leaks — the fs walk lives in
 * check-standards.mjs, mirroring scanRepoLocusPrefixes / scanPublishSecrets directly above.
 */
export function scanHarnessScaffolding(docs) {
  const findings = [];
  for (const { file, content } of docs) {
    const hits = findHarnessScaffoldingMarkers(content);
    if (hits.length) findings.push({ file, hits });
  }
  return findings;
}

// ── Stale-ratified/verified-done status guard (#3383 session lesson) ─────────────────────────────
// This session found the same defect at least 11 times on the `lane/mechanical-dispatcher` prototype
// branch (#3838–#3849, #3801): frontmatter said `status: open` while the body already recorded the work
// as ratified or built — a decision ratified inline per-fork ("ratified at operator review, <date>") with
// no status flip, or a build story carrying a "Verified done, <date>" blockquote (the convention this
// session introduced while fixing #3838–#3849) whose status was never resolved. A batch pass re-selected
// several of these as "ready to build" though they were already done — real wasted effort, and it
// depended on a human/agent noticing by luck. This is the standing mechanical check for it.
//
// WARN, never ERROR: this is a heuristic over prose, and a body may legitimately DISCUSS "ratified"
// without asserting that THIS card is done — most commonly by citing ANOTHER item's ratified anchor
// ("Ruled in #3801 Fork 2", "ratified #2089 Fork 1(b)"). Calibrated against the real corpus: a bare
// "ratified"/"Ratified" match is FAR too broad (1000+ backlog files mention it, almost all citing some
// other anchor), so the markers below require a DATED, EMPHASIZED (bold/italic) assertion or the specific
// blockquote convention — and even then, a matched span naming a `#NNNN` reference is treated as citing
// that OTHER item's ratification and dropped (this alone cleared 3 of 7 raw hits found calibrating against
// the current corpus — #1137, #2821, #3374 — each citing a different item's ratification date, not its
// own).
//
// Scoped to `open`/`active` — a `resolved` item is definitionally not stale in this sense (#3383's own
// framing) — and skips `kind: epic`: an epic's own "## Ratified …" heading routinely documents a ratified
// DESIGN for its children's build, not completion of the umbrella itself (verified against two real open
// epics with exactly that shape, #2612 and #2804 — both carry a dated "## Ratified …" heading for how their
// children should be built, while the epic itself correctly stays open pending those children). A `kind:
// decision` whose forks are ratified inline is the readiest true-positive case (#3801) but is still only a
// WARN, never auto-resolved — a decision can rule some forks and leave others open, so a human/skill must
// read the body and decide whether the CARD is done, only a follow-through item is missing, or the mention
// is legitimately partial.
const STALE_RATIFIED_MARKERS = [
  { label: '"Verified done" blockquote', re: /^>\s*\*\*[^*\n]*\bVerified done\b[^*\n]*\*\*/i },
  { label: '"## Ratified" heading', re: /^#{1,4}\s*Ratified\b/i },
  { label: 'dated "ratified" assertion', re: /\*{1,2}[^*\n]{0,80}\bratified\b[^*\n]{0,60}\d{4}-\d{2}-\d{2}[^*\n]{0,40}\*{1,2}/i },
];

/**
 * Find dated completion/ratification assertions in a markdown body, outside fenced code blocks (mirrors
 * findHarnessScaffoldingMarkers's fence-toggle scan). A match naming a `#NNNN` reference is dropped — that
 * shape reads as citing ANOTHER item's ratification (`ratified #2089 Fork 1(b)`, `RATIFIED … (#2607)`),
 * not asserting this card's own. Returns `[{ line, label, match }]`.
 */
export function findStaleRatifiedClaims(body) {
  const findings = [];
  if (typeof body !== 'string' || body === '') return findings;
  let fenceChar = null;
  let fenceLen = 0;
  body.split('\n').forEach((line, i) => {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceChar) {
      if (fm && fm[1][0] === fenceChar && fm[1].length >= fenceLen) { fenceChar = null; fenceLen = 0; }
      return; // inside a fence — a documented example, not an assertion
    }
    if (fm) { fenceChar = fm[1][0]; fenceLen = fm[1].length; return; }
    for (const { label, re } of STALE_RATIFIED_MARKERS) {
      const m = line.match(re);
      if (m && !/#\d/.test(m[0])) findings.push({ line: i + 1, label, match: m[0].trim() });
    }
  });
  return findings;
}

// ── Block contract↔impl drift conformance (#659 — the #606/#641 plugs analogue for blocks) ──
// #641 ruled WE blocks are pure *protocols*; the impl lives in FUI (`implementedBy:
// @frontierui/blocks/…`). Unlike the plug runtime, WE holds NO block-impl copy post-#641
// (`sourcePath` is gone), so the #170 drift hazard for blocks is not byte-divergence but a
// *contract pointing at an impl that has moved or does not exist*. This gate is cross-repo and
// detect-or-skip (the `devServerProbe` pattern, mirroring 8b's "skip when plugs/ isn't checked
// out"): when FUI is present every `implementedBy` must resolve to a real impl path; when FUI is
// absent (CI without the sibling repo) the content arm is SKIPPED, never failed.
//
// Staging (mirroring the #636 warn→enforce shape): a contract may legitimately point *ahead* of an
// impl FUI hasn't built yet, so a missing impl is a WARN until the FUI block-impl backfill closes
// the gaps (#659 found 10 such gaps at authoring time), then it promotes to ERROR (flip
// BLOCK_IMPL_DRIFT_ENFORCED) so a moved/deleted impl hard-fails. The fs walk lives in
// check-standards.mjs; this rule is pure.
//
// `blocks` = [{ id, implementedBy, implPresent }] — implPresent is true/false when FUI was walked,
// or null when FUI is absent (→ skip that block). Returns { errors, warnings, skipped, checked }.
export const BLOCK_IMPL_DRIFT_ENFORCED = true; // #926: all 10 FUI block impls (#916–#925) landed (batch-2026-06-18); a moved/deleted impl now hard-fails

export function validateBlockImplConformance(blocks) {
  const errors = [];
  const warnings = [];
  let skipped = 0;
  let checked = 0;
  for (const b of blocks) {
    if (!b.implementedBy) continue; // no impl pointer — form is gated elsewhere (#641)
    if (b.implPresent === null || b.implPresent === undefined) {
      skipped++; // FUI absent — the cross-repo content arm can't run here
      continue;
    }
    checked++;
    if (b.implPresent === false) {
      const msg = `Block "${b.id}" implementedBy points at an impl that does not resolve in ../frontierui — ${b.implementedBy} (block contract↔impl drift, #170/#659). Build the FUI impl or correct the reference.`;
      if (BLOCK_IMPL_DRIFT_ENFORCED) errors.push({ message: msg });
      else warnings.push({ message: msg });
    }
  }
  return { errors, warnings, skipped, checked };
}

// ── validatePlugWeFuiDrift — plug contract↔impl drift conformance (#1309, the §8c/#659 plugs analogue) ──
// WE owns the plug platform layer; FUI ports each plug domain UP to the WE contract (the #1250 reconcile
// epic + its per-domain slices #1297–#1308/#1350/#1354). This is the regression guard so a reconciled
// domain can't silently re-drift — the plugs edition of #170/#659. Two arms, both cross-repo and
// detect-or-skip when ../frontierui is absent (mirrors validateBlockImplConformance's null→skip):
//   (1) DOMAIN PRESENCE — every we:plugs/<domain> must have a matching fui:plugs/<domain> impl dir;
//   (2) SHARED-CORE BYTE PARITY — the plug-core contract files declared byte-identical across both repos
//       (PLUG_SHARED_CORE_FILES, per #1304/#1350) must match FUI byte-for-byte.
// Enforced from landing: #1309 lands AFTER the reconciliation slices, so both arms are green.
//
// `domains` = [{ domain, implPresent }] — implPresent true/false when FUI was walked, null when FUI is
// absent (→ skip). `parityFiles` = [{ file, identical }] — identical true/false when both copies were
// read, null when FUI is absent or the file is WE-only (→ skip). Returns { errors, warnings, skipped, checked }.
export const PLUG_DRIFT_ENFORCED = true; // #1309: lands after the #1250 reconciliation slices, so green; a re-drift now hard-fails

// The plug-core files contractually required to be byte-identical across WE and FUI (#1304/#1350). NOT
// the whole core/ — `plugs/core/CustomRegistry.ts` carries the #1350-governed lifecycle divergence, and
// `plugs/index.ts` / `plugs/bootstrap.ts` are per-repo domain-registration wiring; all three legitimately
// differ, so gating them would false-positive. This curated list is exactly the shared contract substrate.
export const PLUG_SHARED_CORE_FILES = [
  'plugs/core/Plug.ts',
  'plugs/core/HTMLRegistry.ts',
  'plugs/unplugged.ts',
];

export function validatePlugWeFuiDrift({ domains = [], parityFiles = [] } = {}) {
  const errors = [];
  const warnings = [];
  let skipped = 0;
  let checked = 0;
  for (const d of domains) {
    if (d.implPresent === null || d.implPresent === undefined) { skipped++; continue; }
    checked++;
    if (d.implPresent === false) {
      const msg = `WE plug domain "we:plugs/${d.domain}" has no matching fui:plugs/${d.domain} impl in ../frontierui (plug contract↔impl drift, #170/#1309). Port the domain to FUI or retire the WE contract.`;
      (PLUG_DRIFT_ENFORCED ? errors : warnings).push({ message: msg });
    }
  }
  for (const p of parityFiles) {
    if (p.identical === null || p.identical === undefined) { skipped++; continue; }
    checked++;
    if (p.identical === false) {
      const msg = `Shared plug-core contract file "${p.file}" has drifted between WE and FUI — it must be byte-identical (#1304/#1350; plug contract↔impl drift, #170/#1309). Re-converge the two copies.`;
      (PLUG_DRIFT_ENFORCED ? errors : warnings).push({ message: msg });
    }
  }
  return { errors, warnings, skipped, checked };
}

// ── validateBlockComposesTraits — compose-don't-hand-roll deny-list (#937, Fork 1 of #933) ──
// Sibling of validateBlockImplConformance (same cross-repo, source-null→skip precedent). Where the
// #936 §3b resolution arm asserts a block's *declared* `composesBehaviors` resolve, THIS arm catches
// the inverse: a block that hand-rolls behaviour it should have COMPOSED. It is a *curated* deny-list,
// NOT an open `addEventListener` sniff (that framing was rejected on #933): each rule names the block
// ids it applies to, so it can never false-positive on an unrelated block (e.g. the behaviour's own
// provider impl, which hand-rolls the choreography by design). A block silences a rule the intended
// way — by actually composing the named behaviour (declaring it in `composesBehaviors`), which is the
// migration #944/#934 perform. Warn-first until the list is curated + false-positive-free, then flip
// COMPOSE_TRAITS_ENFORCED (the #840/#844/#477 warn→ERROR precedent). Static (source regex), not
// rendered/axe — it reads the impl source, never the computed DOM.
export const COMPOSE_TRAITS_ENFORCED = false; // #937: warn-first; flip once the deny-list is curated + false-positive-free

// Seed rules. `signature` = every regex must match the block's concatenated impl source for the rule to
// fire (an AND, to keep the match specific). `appliesTo` = the curated block-id allow-list it scans.
export const COMPOSE_DENY_LIST = [
  {
    id: 'disclosure-aria-expanded',
    requires: 'nav:section',
    appliesTo: ['disclosure-nav', 'sectioned-nav'],
    signature: [/aria-expanded/, /addEventListener\(\s*['"`](?:click|keydown)['"`]/],
    why: 'hand-wires click/keydown on an aria-expanded head — that disclosure choreography is exactly what the nav:section behavior provides',
  },
  {
    id: 'roving-tabindex',
    requires: 'nav:list',
    appliesTo: [], // seeded rule; no curated target yet — adding one is a one-line edit
    signature: [/tabindex/i, /Arrow(?:Up|Down|Left|Right)/],
    why: 'hand-wires roving tabindex + arrow-key movement — that is what the nav:list behavior provides',
  },
];

// `blocks` = [{ id, composesBehaviors, source }] — `source` is the block's concatenated FUI impl source,
// or null/undefined when ../frontierui isn't checked out (→ skip, mirrors validateBlockImplConformance).
// Returns { errors, warnings, skipped, checked }.
export function validateBlockComposesTraits(blocks) {
  const errors = [];
  const warnings = [];
  let skipped = 0;
  let checked = 0;
  const rulesByBlock = new Map();
  for (const r of COMPOSE_DENY_LIST)
    for (const id of r.appliesTo) {
      if (!rulesByBlock.has(id)) rulesByBlock.set(id, []);
      rulesByBlock.get(id).push(r);
    }
  for (const b of blocks) {
    const rules = rulesByBlock.get(b.id);
    if (!rules) continue; // not a curated target — never sniffed
    if (b.source === null || b.source === undefined) { skipped++; continue; } // FUI absent
    checked++;
    const composed = new Set((b.composesBehaviors || []).map((e) => (typeof e === 'string' ? e : e && e.name)));
    for (const r of rules) {
      if (composed.has(r.requires)) continue; // already composes it — migrated, no finding
      if (r.signature.every((re) => re.test(b.source))) {
        const msg = `Block "${b.id}" ${r.why}, but does not compose "${r.requires}" (compose-don't-hand-roll, #933/#937). Declare composesBehaviors: ["${r.requires}"] and delegate to the behavior.`;
        if (COMPOSE_TRAITS_ENFORCED) errors.push({ message: msg, descriptor: dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'composesBehaviors', r.id, r.requires) });
        else warnings.push({ message: msg, descriptor: dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'composesBehaviors', r.id, r.requires) });
      }
    }
  }
  return { errors, warnings, skipped, checked };
}

// ── Block export-shape drift conformance (#927, the deeper #170 arm #659 deferred) ──
// #659 shipped impl-EXISTENCE only (validateBlockImplConformance: does the implementedBy path resolve?).
// This second arm goes deeper: does the impl actually EXPORT the surface the contract DECLARES? It compares
// each barrel block's declared `exports` (`we:src/_data/blocks/<id>.json`) against the RESOLVED actual
// exports of its FUI barrel — gathered by a real TS program (not regex) so `export type *` and
// `@webeverything/contracts/…` package re-exports are followed (a regex can't; that's why resource-loader /
// type-ahead, which re-export contract types, would false-fail a textual scan).
//
// Warn-first (EXPORT_SHAPE_ENFORCED=false), mirroring the #840/#937/BLOCK_IMPL_DRIFT warn→flip precedent:
// the two embedded forks are carved to #1164 (renderer coverage) / #1165 (resolve the genuine drifts), and
// the flip waits on them. Scope is the 7 barrel blocks (implementedBy `…/index.ts` + a declared `exports`);
// renderer/file-pointer blocks have no enumerable barrel and are skipped (logged un-coverable, #1164).
// A declared export ABSENT from the resolved barrel is the drift (the impl can export MORE — extras are
// fine). Cross-repo detect-or-skip: `actualExports === null` (FUI absent / barrel unresolved) → skip.
export const EXPORT_SHAPE_ENFORCED = true; // #927: ENFORCED (#1206) — #1164 renderer coverage (#1203/#1204) + #1165/#1205 drifts landed; contract↔barrel drift is now a hard gate error

// `blocks` = [{ id, implementedBy, declaredExports: string[], actualExports: string[] | null }].
// Returns { errors, warnings, skipped, checked }.
export function validateBlockExportShape(blocks) {
  const errors = [];
  const warnings = [];
  let skipped = 0;
  let checked = 0;
  for (const b of blocks) {
    if (b.actualExports === null || b.actualExports === undefined) {
      skipped++; // FUI absent, or no enumerable barrel (#1164) — the export-shape arm can't run
      continue;
    }
    checked++;
    const actual = new Set(b.actualExports);
    const missing = (b.declaredExports || []).filter((name) => !actual.has(name));
    if (missing.length) {
      const msg = `Block "${b.id}" declares export(s) [${missing.join(', ')}] that the resolved FUI barrel (${b.implementedBy}) does not export — CEM surface ↔ impl export drift (#170/#927). Correct the contract \`exports\` or build the missing FUI surface (#1165).`;
      const d = dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'exports', missing[0], 'export-shape');
      if (EXPORT_SHAPE_ENFORCED) errors.push({ message: msg, descriptor: d });
      else warnings.push({ message: msg, descriptor: d });
    }
  }
  return { errors, warnings, skipped, checked };
}

// ── Static template a11y lint (#772, ratified #763 supported-not-decided) ──────
// The structural a11y rules a headless axe run (the #770/#771 rendered-DOM gate) CANNOT observe from the
// computed page — they live in the .njk SOURCE and must be caught at authoring time, before render. Scoped
// to the site-chrome layouts (`src/_layouts/*`) — the #762 regression locus and the only hand-authored page
// shell — so spec-content navs (block-descriptions) and in-page breadcrumbs never false-positive.
//
// Two rule classes (mirroring the #636 dual-mode warn→enforce shape):
//   • page-shell landmarks — a full-page layout (one emitting `<html`) MUST carry a `lang` attribute, a
//     `<title>`, and a `<main>` landmark. ERROR: these are structural invariants both layouts satisfy today,
//     so a regression hard-fails (the value the rendered gate can give only post-render).
//   • nav active-state wiring (the #762 class) — a `<nav>` holding a hardcoded `<a href=` link list MUST
//     wire `aria-current` so the current page is distinguishable. ENFORCED (#795): the only offending file
//     was the dead/legacy base.html (7 links, no aria-current), removed in #795; the live base.njk wires
//     aria-current, so the lane is green and this regression class now hard-fails going forward.
export const NAV_ACTIVE_STATE_ENFORCED = true;

/**
 * Static a11y lint over the site-chrome layouts. `layouts` = [{ path, content }] (the `src/_layouts/*`
 * files the script reads). Pure: returns { errors, warnings }. A nav whose links are macro-driven with a
 * conditional `aria-current` passes (the token is present in source); a hardcoded link list with none fails.
 */
export function validateTemplateA11y(layouts) {
  const errors = [];
  const warnings = [];
  for (const { path, content } of layouts) {
    const isFullPage = /<html[\s>]/i.test(content);
    if (isFullPage) {
      if (!/<html[^>]*\slang=/i.test(content))
        errors.push({ message: `Layout "${path}" emits <html> without a lang attribute (WCAG 3.1.1 html-has-lang) — set <html lang="…">.` });
      if (!/<title[\s>]/i.test(content))
        errors.push({ message: `Layout "${path}" emits <html> but has no <title> (WCAG 2.4.2 document-title) — add a <title> in <head>.` });
      if (!/<main[\s>]/i.test(content))
        errors.push({ message: `Layout "${path}" has no <main> landmark (WCAG 1.3.1 region) — wrap the page body in <main>.` });
    }
    // Nav active-state wiring (#762): only fires on a hardcoded <a href=…> list inside a <nav>.
    const hasNav = /<nav[\s>]/i.test(content);
    const hasHardcodedNavLink = /<a\s[^>]*href=/i.test(content);
    if (hasNav && hasHardcodedNavLink && !/aria-current/i.test(content)) {
      const msg = `Layout "${path}" has a <nav> with a hardcoded link list but no aria-current wiring — the current page is indistinguishable from siblings (#762, WCAG 2.4.8). Mark the active link with aria-current="page".`;
      if (NAV_ACTIVE_STATE_ENFORCED) errors.push({ message: msg });
      else warnings.push({ message: msg });
    }
  }
  return { errors, warnings };
}

// ── Standard-vs-site surface classifier (#2052, interim per #2006 Fork 2(b)) ───────
// The WE repo intermingles two surfaces (#2006): WE-the-standard (the zero-impl authority — the
// intent/block/plug/protocol/semantic defs, meta-schemas, conformance gate, backlog) and the WE-website
// render (an artifact-producing 11ty+Vite product, mis-homed here, end-state extraction gated on #872).
// #2006 Fork 2(b) ratified a *directory boundary* whose interim carrier is this fail-closed classifier:
// every path in the RENDER-TREE ZONE (`src/**` — where the two surfaces interleave, plus the build
// configs that only exist to render the site) must classify as EXACTLY ONE of {standard, site}. A path
// in that zone matching NEITHER prefix set is a HARD ERROR, so new site code can never masquerade as
// standard (nor a new standard def hide among the loaders).
//
// Scope is deliberately the render-tree zone, NOT literally every tracked path: node_modules/, backlog/,
// tools/, tests/, the impl trees, etc. are neither standard nor site — classifying them would be noise
// and would red-gate the whole repo. The zone is exactly the interleave surface #2006 names, where a new
// file's classification is load-bearing for the eventual `site/**` lift (Fork 1a). Everything outside the
// zone is `neutral` (unclassified-and-that-is-correct) and is not policed here.
//
// site-surface  = the render/product: page templates, layouts, render partials (incl *-descriptions/),
//                 assets, css, render fixtures, AND the src/_data/*.{js,ts} Eleventy loaders.
// standard-surface = the definitions the standard owns: the src/_data/*/  per-entity .json registries and
//                 the src/_data/*.json top-level data files (the assembler-loader seam scripts/lib/*-loader.cjs
//                 that BOTH the gate and the site loaders consume stays WE with the gate — it is standard).
// A path under the zone that is neither (e.g. a new `src/foo.tsx` or a `src/_data/newLoader.mjs`) errors —
// the author must place it on the correct side of the seam (a .njk/.js render file is site; a .json def is
// standard) so the boundary stays machine-legible ahead of the physical `site/**` lift.

// The render-tree zone: prefixes whose contents are all either standard or site (the #2006 interleave).
export const SURFACE_ZONE_PREFIXES = ['src/'];

// Within the zone, SITE wins if the path matches any of these (checked first — the loaders live under
// src/_data/ alongside the standard .json, so the extension/glob discriminates them).
export const SITE_SURFACE_MATCHERS = [
  (p) => /^src\/[^/]+\.(njk|md|html)$/.test(p),          // top-level page templates
  (p) => p.startsWith('src/_layouts/'),                  // page layouts (render chrome)
  (p) => p.startsWith('src/_includes/'),                 // render partials incl *-descriptions/
  (p) => p.startsWith('src/assets/'),                    // static assets served by the site
  (p) => p.startsWith('src/css/'),                       // site styles
  (p) => p.startsWith('src/patterns/'),                  // render pattern fixtures
  (p) => p.startsWith('src/plateau/'),                   // legacy render fixtures
  (p) => p.startsWith('src/cases/'),                     // render case fixtures
  // Eleventy data loaders — src/_data/*.{js,ts,cjs,mjs} (the .json siblings are STANDARD, below).
  (p) => /^src\/_data\/[^/]+\.(js|ts|cjs|mjs)$/.test(p),
];

// Within the zone, STANDARD wins for the definition data (checked after site, so a .js loader in
// src/_data never mis-classifies as standard just because it sits beside the .json registries).
export const STANDARD_SURFACE_MATCHERS = [
  (p) => /^src\/_data\/[^/]+\.json$/.test(p),            // top-level standard data files
  (p) => /^src\/_data\/[^/]+\/.*\.json$/.test(p),        // per-entity registries (blocks/, intents/, …)
  (p) => p.startsWith('src/_data/__tests__/'),           // loader tests — standard-side tooling
];

/**
 * Classify every render-tree-zone path as exactly one of {site, standard}; an in-zone path matching
 * neither is `unclassified` (a hard error the caller emits). Pure — takes repo-relative tracked paths,
 * returns { site, standard, unclassified } path arrays. Paths outside SURFACE_ZONE_PREFIXES are `neutral`
 * and simply omitted (correctly unclassified — not the standard/site interleave).
 */
export function classifySurfacePaths(paths) {
  const site = [];
  const standard = [];
  const unclassified = [];
  for (const p of paths) {
    if (!SURFACE_ZONE_PREFIXES.some((pre) => p.startsWith(pre))) continue; // neutral — outside the zone
    if (SITE_SURFACE_MATCHERS.some((m) => m(p))) { site.push(p); continue; }
    if (STANDARD_SURFACE_MATCHERS.some((m) => m(p))) { standard.push(p); continue; }
    unclassified.push(p);
  }
  return { site, standard, unclassified };
}

/**
 * Untracked derived-artifact guard (#2180) — surfaces local-vs-CI divergence BEFORE push.
 *
 * `check:standards` reads the working tree, so local untracked files (reports, research-topic specs,
 * research-description partials) inflate existence/inventory checks to green locally while a fresh CI
 * clone (which only has tracked files) sees fewer artifacts and goes red. This check detects that gap
 * early: if ANY untracked file lands in a derived-artifact directory, the developer needs to commit it
 * (or delete it) before pushing.
 *
 * Pure: takes the output of `git ls-files -o --exclude-standard` (one repo-relative path per element)
 * and returns one error per directory that has untracked files in it. The fs walk / git invocation
 * stays in check-standards.mjs (the orchestrator).
 *
 * Derived dirs (the set that inflated the gate on 2026-07-02, see #2160 and #2180):
 *   reports/                          — research reports referenced by relatedReport
 *   src/_data/researchTopics/         — per-topic spec files loaded by loadResearch()
 *   src/_includes/research-descriptions/ — per-topic partials paired 1:1 with research topic specs
 *
 * Each error is keyed to the directory (not the individual file) so `--scope` / `--local` can
 * attribute it: the check is local to the developer who left files untracked, not a cross-lane concern.
 */
/**
 * #2248 (tripwire under #2289/#2291) — backlog NNN collision detector. Two `backlog/NNN-*.md` files sharing an
 * NNN silently DROP one item from the loader's last-wins `byNum` Map (`src/_data/backlog.js`), so this must
 * ERROR at the gate: two lanes each adding the same NNN then fail the SECOND PR's required `test` check instead
 * of colliding on `main` (the #2316 double-land, 2026-07-06). Pure + unit-tested (the #256 pattern), replacing
 * the previously-inline loop. Framing (#2291): once numbers are assigned just-in-time (#2288) a duplicate NNN
 * is UNREPRESENTABLE, so a fire here signals an ALLOCATION BUG to alert on — not a routine heal trigger.
 * @param {Array<{num?:string,id?:string}>} items  loaded backlog items
 * @returns {string[]} one error message per colliding NNN (empty when all unique). Items with no `num` are
 *   skipped here — the missing-prefix error is a separate check.
 */
export function duplicateBacklogNums(items = []) {
  const seen = new Map();
  const errors = [];
  for (const item of items) {
    if (!item || !item.num) continue;
    if (seen.has(item.num)) {
      errors.push(`Backlog id #${item.num} is used by both "${seen.get(item.num)}" and "${item.id}" — ids must be unique (a duplicate NNN silently drops one item from the loader; #2248 tripwire — under JIT numbering #2288 this is unrepresentable, so a fire signals an allocation bug, not a routine heal)`);
    } else {
      seen.set(item.num, item.id);
    }
  }
  return errors;
}

/**
 * TWO NUMBERED CARDS CLAIMING THE SAME BIRTH. Under JIT numbering (#2288) an item is born with a hash and the
 * drain mints its NNN at land, recording the hash as `bornAs`. That hash is the item's IDENTITY across the
 * rename, so two cards carrying the same one are the same item minted twice.
 *
 * WHY EVERY EXISTING CHECK MISSES IT, which is why this is its own rule rather than a branch of one:
 *   · `duplicateBacklogNums` compares `num`. The twins have DIFFERENT numbers — that is what makes them twins
 *     rather than a collision — so it sees nothing.
 *   · `strandedHashesOnMain` looks for a hash still in the FILENAME. Both twins are properly numbered; the
 *     duplication lives in the frontmatter, which that rule never reads.
 * The one state nothing looked for is the one that actually happened.
 *
 * HOW IT HAPPENS, from the live case this was written for. A stale hash-named copy of an already-landed card
 * sat in a lane's working tree; a `git add -A` swept it into an unrelated commit; the drain, doing its job,
 * minted it a fresh NNN. Result: `#3201` resolved and `#3244` OPEN, same `bornAs`, byte-identical bodies — a
 * card describing finished work back in the ready pool, where selection would hand it to someone to redo.
 * PR #1506's juror caught that exact file one commit before it minted and said it "would have minted a
 * duplicate bornAs". It later did.
 *
 * ERRORS ONLY WHEN A TWIN IS UNRESOLVED, because that is the case with a live cost. Two RESOLVED twins are an
 * audit-trail smudge and warn instead — this tree carries such a pair (#3111/#3112) predating the rule, and
 * erroring on it would redden main over a defect with no consequence, which is how a gate gets ignored.
 *
 * @param {Array<{num: string, id: string, bornAs?: string, status?: string}>} items
 * @returns {{errors: string[], warnings: string[]}}
 */
export function duplicateBornAs(items = []) {
  const byHash = new Map();
  for (const item of items) {
    const hash = typeof item?.bornAs === 'string' ? item.bornAs.trim() : '';
    if (!hash) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(item);
  }
  const errors = []; const warnings = [];
  for (const [hash, twins] of byHash) {
    if (twins.length < 2) continue;
    const names = twins.map((t) => `#${t.num}${t.status ? ` (${t.status})` : ''}`).join(' and ');
    const live = twins.filter((t) => t.status !== 'resolved');
    const msg =
      `Backlog hash \`${hash}\` is the \`bornAs\` of ${twins.length} cards — ${names}. Under JIT numbering `
      + "(#2288) the hash is the item's identity across its rename, so this is ONE item minted twice — "
      + 'typically a stale hash-named copy swept in by a `git add -A` and then numbered by the drain. '
      + (live.length
        ? 'At least one twin is UNRESOLVED, so a card describing work already done is sitting in the ready '
          + 'pool. Resolve the later twin, naming the original it duplicates.'
        : 'Both are resolved, so nothing selects them — an audit-trail smudge rather than live work.');
    (live.length ? errors : warnings).push(msg);
  }
  return { errors, warnings };
}

/**
 * #2319 — hash-on-main invariant. Under JIT numbering (#2288) a new item is born with a provisional hash id
 * (`xNNNNNN`) and the drain mints its real NNN AT LAND (`numberPendingHashes`). So a `backlog/<id>-*.md` on
 * `origin/main` whose leading id is NON-numeric means a land route bypassed numbering (e.g. `pr-land
 * --fallback-git`'s local-merge degrade, per #2322) and stranded a hash. This is DISTINCT from the duplicate-NNN
 * detector (`duplicateBacklogNums`, #2248/#2291): a LONE unique hash is not a collision, so that check misses it
 * entirely. Pure + unit-tested — takes the `backlog/*.md` paths present ON MAIN (a git ls-tree, so in-lane
 * pre-land hashes that live only on a `lane/*` branch never false-trip). Fix a fire with
 * `node scripts/backlog.mjs number-stranded`.
 *
 * #2956 — the drain's OWN in-flight numbering window is not a strand. `pr-land` pushes the merge commit,
 * then the drain pushes the JIT-numbering commit SEPARATELY, 7-73s later (measured across real lands — see
 * the card). A checkout fast-forwarded onto the merge commit inside that window legitimately sees a
 * hash-led file that the drain is already about to fix, and the OLD hard error's remedy
 * (`number-stranded`) is an out-of-lane mutation that races the drain's own numbering if run there.
 * Detection: for each candidate file, look at the epoch of the LAST commit that touched it on
 * `origin/main` (`commitTimeFor`, supplied by the caller via `git log -1 --first-parent --format=%ct` — the
 * `--first-parent` is load-bearing: without it, pathspec history simplification walks past a `--no-ff`
 * merge into the lane's own commit and returns ITS timestamp, not the merge's, #2956 r1). A file touched
 * within `graceWindowSeconds` of now is presumed in-flight — downgraded to a WARNING that does not name
 * `number-stranded` (running it here would race the drain) — rather than a hard error. A file older than
 * the grace window is a genuine strand: the drain's window has long since closed, so the fix is safe to
 * run, and it still hard-errors with the remedy intact. The grace window (`STRANDED_HASH_GRACE_SECONDS`,
 * default 180s) is set comfortably above the measured 7-73s trailing gap so the false-positive window is
 * covered without materially delaying detection of a real strand (a re-run minutes later still catches
 * one). When `commitTimeFor` can't produce a timestamp for a path (unknown git error), the file is treated
 * as NOT in-flight — i.e. it still errors — so a signal failure fails toward the old, safe-but-noisy
 * behaviour rather than silently swallowing a real strand.
 * @param {string[]} mainBacklogPaths  `backlog/<id>-slug.md` paths tracked on origin/main
 * @param {object} [opts]
 * @param {(path: string) => number|null} [opts.commitTimeFor]  epoch seconds of the last commit that
 *   touched `path` on origin/main, or `null` if unknown. Defaults to "unknown" for every path (so callers
 *   that don't pass it keep the old always-error behaviour).
 * @param {() => number} [opts.now]  epoch seconds "now" — injectable for deterministic tests.
 * @param {number} [opts.graceWindowSeconds]  in-flight window, default `STRANDED_HASH_GRACE_SECONDS`.
 * @param {boolean} [opts.inLane]  true when the checkout running the check is a LANE clone. A genuine strand is
 *   then a WARNING, not an error: the lane neither caused it nor can repair it (`number-stranded` refuses to run
 *   in a lane), and an error wedged every lane's `verify-lane` until someone numbered it in a primary. Default
 *   false — a primary checkout keeps the hard error.
 * @returns {{errors: string[], warnings: string[]}} one message per stranded hash, routed by recency.
 */
export const STRANDED_HASH_GRACE_SECONDS = 180; // ~2.5x the measured 7-73s drain numbering-commit lag

export function strandedHashesOnMain(mainBacklogPaths = [], {
  commitTimeFor = () => null,
  now = () => Date.now() / 1000,
  graceWindowSeconds = STRANDED_HASH_GRACE_SECONDS,
  inLane = false,
} = {}) {
  const errors = [];
  const warnings = [];
  for (const p of mainBacklogPaths) {
    const m = String(p).match(/(?:^|\/)backlog\/([^/]+?)-[^/]*\.md$/);
    if (!m) continue;
    const lead = m[1];
    if (/^\d+$/.test(lead)) continue;
    const committedAt = commitTimeFor(p);
    const ageSeconds = typeof committedAt === 'number' && Number.isFinite(committedAt) ? now() - committedAt : null;
    const inFlight = ageSeconds !== null && ageSeconds >= 0 && ageSeconds < graceWindowSeconds;
    if (inFlight) {
      warnings.push(`Backlog file "${p}" is on main with a NON-NUMERIC leading id "${lead}", committed ${Math.round(ageSeconds)}s ago — within the drain's own JIT-numbering window (#2288/#2956, <${graceWindowSeconds}s grace). This looks like the drain's separate numbering commit hasn't landed yet, not a strand. No action needed here — re-run \`check:standards\` after a fresh fetch to confirm it cleared.`);
    } else if (inLane) {
      // A lane clone can neither cause this (the strand is already on main) nor repair it: `number-stranded`
      // refuses to run in a lane, because the NNN it mints is only valid against serialized main. Erroring here
      // wedged `verify-lane` for EVERY lane while CI (which has no origin/main to read) stayed green, so it is
      // a warning in a lane; the primary checkout and the drain's own assert still hard-error.
      warnings.push(`Backlog file "${p}" is on main with a NON-NUMERIC leading id "${lead}" — a land route bypassed JIT numbering (#2288) and stranded a hash (#2319). Not caused by this lane and not fixable from it (\`number-stranded\` refuses to run in a lane): run \`node scripts/backlog.mjs number-stranded\` in a PRIMARY checkout, or let the drain number it at its next land.`);
    } else {
      errors.push(`Backlog file "${p}" is on main with a NON-NUMERIC leading id "${lead}" — a land route bypassed JIT numbering (#2288) and stranded a hash (#2319). Number it: \`node scripts/backlog.mjs number-stranded\` (distinct from a duplicate NNN — a lone hash isn't a collision).`);
    }
  }
  return { errors, warnings };
}

/**
 * #2548 — hand-numbered-new-item gate, the MIRROR of `strandedHashesOnMain` above. Under JIT numbering
 * (#2288) a new item is born with a provisional hash id (`xNNNNNN`) and the drain mints its real NNN AT
 * LAND. So a working-tree backlog item whose `num` is a plain numeric NNN token that is NOT present in the
 * on-`origin/main` id-token set was hand-picked rather than assigned by the drain — the #558 incident (a
 * hand-numbered batch collided with a concurrent session and triggered the collision-heal that blanked
 * files).
 *
 * Match by ID TOKEN ONLY, never the full filename: `docs/agent/backlog-workflow.md` documents that a
 * landed item's slug may be legitimately reworded without changing its NNN — an ordinary edit that changes
 * the filename while the item stays genuinely landed. Matching on the full path would false-positive on
 * that edit; matching on the token alone is immune to it, because the same NNN is still present on main
 * under SOME filename.
 *
 * @param {Array<{id?:string, num?:string}>} items       loaded backlog items (working tree)
 * @param {string[]} mainBacklogPaths  `backlog/<id>-slug.md` paths tracked on origin/main
 * @returns {string[]} one error per hand-numbered new item (empty when every new NNN is already on main)
 */
export function handNumberedNewItems(items = [], mainBacklogPaths = []) {
  const mainNums = new Set();
  for (const p of mainBacklogPaths) {
    const m = String(p).match(/(?:^|\/)backlog\/([^/]+?)-[^/]*\.md$/);
    if (!m) continue;
    if (/^\d+$/.test(m[1])) mainNums.add(m[1]);
  }
  const errors = [];
  for (const item of items) {
    if (!item || !item.num) continue;
    if (!/^\d+$/.test(item.num)) continue; // hash-keyed new item — the correct path, never fires
    if (mainNums.has(item.num)) continue; // number is on origin/main — a landed item, possibly reworded
    errors.push(`Backlog item "${item.id}" carries a hand-picked NNN id (#${item.num}) that is not on origin/main — new items must be hash-keyed (xNNNNNN); the drain assigns the real number at land (#2288). Rename it with a hash id, or set WE_SKIP_HAND_NUMBERED_GATE=1 if this is the sanctioned collision-heal renumbering path (#2548).`);
  }
  return errors;
}

export const DERIVED_ARTIFACT_DIRS = [
  'reports/',
  'src/_data/researchTopics/',
  'src/_includes/research-descriptions/',
];

export function validateUntrackedDerivedArtifacts(untrackedPaths, { derivedDirs = DERIVED_ARTIFACT_DIRS } = {}) {
  // Group untracked paths by which derived dir they belong to.
  const byDir = new Map();
  for (const p of untrackedPaths) {
    for (const dir of derivedDirs) {
      if (p.startsWith(dir)) {
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(p);
        break;
      }
    }
  }
  const errors = [];
  for (const [dir, files] of byDir) {
    const sample = files.slice(0, 3).join(', ') + (files.length > 3 ? `, … (+${files.length - 3} more)` : '');
    errors.push({
      message:
        `${files.length} untracked file(s) in "${dir}" will cause check:standards to pass locally ` +
        `but fail on CI (fresh clone has no untracked files) — commit or delete them before pushing. ` +
        `Sample: ${sample}. ` +
        `See #2180 and the [[local-gate-green-ci-red-untracked-artifacts]] memory note.`,
      descriptor: { kind: 'untracked-derived', file: dir.replace(/\/$/, ''), global: false },
    });
  }
  return { errors, warnings: [] };
}

// ── Playwright container-image pin lockstep (#2234) ────────────────────────────
// The visual-regression CI jobs (ci.yml's `visual` job + update-visual-baselines.yml) render inside a
// version-locked `mcr.microsoft.com/playwright:vX.Y.Z-jammy` container so rendered pixels stay
// byte-reproducible across machines/CI — that's the whole point of the pin (#2234, decision #2233's
// substrate). The image tag is hand-written in workflow YAML and can silently drift from the
// `@playwright/test` version actually installed (a `package.json` bump updates one, not the other); a
// drifted container ships a *different* bundled browser build than the test runner expects, quietly
// re-introducing the exact byte-reproducibility gap this pin exists to close. Fail loud instead.

/** Workflow files required to carry an in-lockstep container pin (the render + the refresh flow). */
export const PLAYWRIGHT_CONTAINER_PIN_REQUIRED_FILES = [
  '.github/workflows/ci.yml',
  '.github/workflows/update-visual-baselines.yml',
];

/** Extract every `vX.Y.Z-jammy` Playwright container image tag referenced in a workflow file's text. */
export function extractPlaywrightContainerTags(text) {
  return [...text.matchAll(/mcr\.microsoft\.com\/playwright:(v[0-9.]+-jammy)/g)].map((m) => m[1]);
}

/**
 * Playwright container-pin lockstep: every workflow in `filesReferences` must carry at least one
 * `mcr.microsoft.com/playwright:vX.Y.Z-jammy` reference, and every tag found must equal
 * `v${installedVersion}-jammy` — no drift between the container's bundled browser build and the
 * npm-installed `@playwright/test` version. Pure: takes the resolved installed version + each file's
 * extracted tags (via extractPlaywrightContainerTags); the fs/lockfile reads stay in check-standards.mjs.
 */
export function validatePlaywrightContainerPin({ installedVersion, filesReferences }) {
  const errors = [];
  if (!installedVersion) {
    errors.push({ message:
      `Playwright container pin: could not resolve the installed @playwright/test version from ` +
      `package-lock.json — cannot verify the container image tag is in lockstep (#2234).` });
    return { errors, warnings: [] };
  }
  const expectedTag = `v${installedVersion}-jammy`;
  for (const { file, tags } of filesReferences) {
    if (tags.length === 0) {
      errors.push({ message:
        `Playwright container pin: ${file} has no "mcr.microsoft.com/playwright:${expectedTag}" container ` +
        `image reference — the visual-regression job(s) must render inside the version-locked Playwright ` +
        `container so pixels stay byte-reproducible across machines/CI (#2234).` });
      continue;
    }
    for (const tag of tags) {
      if (tag !== expectedTag)
        errors.push({ message:
          `Playwright container pin drift: ${file} pins "mcr.microsoft.com/playwright:${tag}" but the ` +
          `installed @playwright/test version is ${installedVersion} (expects "${expectedTag}"). Bump the ` +
          `image tag alongside every @playwright/test version bump (#2234) — a mismatched container build ` +
          `re-introduces the byte-reproducibility drift this pin exists to close.` });
    }
  }
  return { errors, warnings: [] };
}

// ── DECLARED MODULE CONTRACT vs. actual imports (PR #1064 review, cosmetic 1) ──────────────────────────────────
// A few `scripts/lib/*.mjs` modules declare, in their header prose, the CONTRACT they depend on:
//
//     from we:scripts/lib/jury-core.mjs   — `deriveVerdict` (…), `derivePanelVerdict` (…), `VERDICTS`.
//
// The block exists so a maintainer greping declared contracts before changing a shared export SEES every
// consumer, and so a semantic change to a shared export has a named tripwire. It is worthless the moment it
// drifts from the real import list — and the first one shipped ALREADY drifted (`normalizeFindings` imported,
// called, undeclared), which is precisely the false negative it was written to prevent.
//
// "Does the declared list cover every specifier the module actually imports from that module?" is fully
// script-decidable, so per #51 it belongs in a deterministic gate rather than in a reviewer's attention.
// DELIBERATELY ONE-DIRECTIONAL: an UNDECLARED import is an error (the block under-reports a real dependency);
// a declared name that is not imported is NOT (a header may legitimately name a contract member it depends on
// the MEANING of without importing the symbol).

/** The header block-comment of a module — the only place a declared contract lives. */
function headerComment(src) {
  const m = /^\s*\/\*\*([\s\S]*?)\*\//.exec(src);
  return m ? m[1] : '';
}

/**
 * Bound the LAST `from we:… —` declaration in a header by where ITS OWN backtick-list grammar
 * actually ends, rather than by searching for a blank comment line (#2976 review r2). Searching for a
 * blank line only closed the false negative when a blank `*` line happens to separate the declaration
 * from whatever prose follows — trailing prose that immediately follows on the very next comment line
 * (no blank-line separator) fell back to `header.length` again, folding that prose's backticked names
 * into the "declared" set and reproducing the exact false negative #2976 exists to catch.
 *
 * The grammar itself is the real boundary: `name` (aside)?, `name` (aside)?, …, — a run of backticked
 * names and optional parenthetical asides (which may contain arbitrary prose, including words, and may
 * themselves span multiple comment lines), joined by commas/`+`/whitespace/dashes. The first character
 * that sits OUTSIDE both a backtick pair and a paren and is a bare letter is prose, not a continuation
 * of the list — whether or not a blank line separates it from the declaration. `scanFrom` must be the
 * offset right after the declaration's own `from we:<path> —` text (never inside it — the path itself
 * is full of letters).
 */
function lastDeclarationEnd(header, scanFrom) {
  let parenDepth = 0;
  let inBacktick = false;
  for (let i = scanFrom; i < header.length; i += 1) {
    const ch = header[i];
    if (ch === '`') { inBacktick = !inBacktick; continue; }
    if (inBacktick) continue;
    if (ch === '(') { parenDepth += 1; continue; }
    if (ch === ')') { parenDepth = Math.max(0, parenDepth - 1); continue; }
    if (parenDepth === 0 && /[A-Za-z]/.test(ch)) return header.lastIndexOf('\n', i) + 1;
  }
  return header.length;
}

/**
 * Diff each module's DECLARED contract block against its actual import specifiers. Pure.
 * @param {Array<{file: string, content: string}>} modules
 * @returns {{errors: Array<{message: string, descriptor?: object}>, warnings: Array<object>}}
 */
export function validateDeclaredModuleContract(modules = []) {
  const errors = [];
  for (const { file, content } of modules) {
    const header = headerComment(content);
    if (!header) continue;
    // Every `from we:<path> — …` declaration in the header, each running to the next one (or the block's end).
    const decls = [...header.matchAll(/from\s+we:(\S+\.mjs)\s*[—-]/g)];
    if (!decls.length) continue;
    for (let i = 0; i < decls.length; i += 1) {
      const target = decls[i][1];                                   // e.g. scripts/lib/jury-core.mjs
      // Bound each declaration's own text. A middle declaration runs to the next one's start (exact —
      // that next `from we:` match IS the boundary). The LAST declaration has no such anchor, and must
      // NOT run to header.length — that folded every backticked name in the header's trailing prose
      // (e.g. a paragraph explaining the rule itself) into the "declared" set, silently accepting an
      // undeclared import under the last declaration (#2976). Bound it by its own backtick-list
      // grammar instead (lastDeclarationEnd) — not by searching for a blank line, which only closes
      // the false negative when a blank line happens to separate the declaration from what follows.
      let end = header.length;
      if (i + 1 < decls.length) {
        end = decls[i + 1].index;
      } else {
        end = lastDeclarationEnd(header, decls[i].index + decls[i][0].length);
      }
      const body = header.slice(decls[i].index, end);
      const declared = new Set([...body.matchAll(/`([A-Za-z0-9_$]+)`/g)].map((m) => m[1]));
      // The matching real import. Modules import each other by relative specifier, so match on basename.
      const base = target.split('/').pop();
      const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*'[^']*${base.replace(/\./g, '\\.')}'`, 's');
      const im = importRe.exec(content);
      if (!im) continue;                                            // declared a contract it does not import from
      const imported = im[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const undeclared = imported.filter((n) => !declared.has(n));
      if (undeclared.length) {
        errors.push({
          message:
            `declared-contract drift: ${file} imports ${undeclared.map((n) => `\`${n}\``).join(', ')} from ` +
            `we:${target} but its header's declared contract block does not name ${undeclared.length > 1 ? 'them' : 'it'}. ` +
            `The block is the tripwire a maintainer greps before changing a shared export — an undeclared ` +
            `consumer is exactly the false negative it exists to prevent (PR #1064). Add the name(s) to the ` +
            `\`from we:${target} —\` line, or drop the import.`,
          descriptor: { kind: 'declared-contract-drift', file, target, undeclared },
        });
      }
    }
  }
  return { errors, warnings: [] };
}

// ── 15. Small-file preference: size+collision composite soft-warn (#2678 ruling, #2782) ─────────
// #2678 Fork 1 ratified (b): a NON-blocking warn (never an error, never a deny) on a file that is BOTH
// oversized AND scope-collision-heavy — the real conveyor serialization cost (a file named in many queued
// items' `scope:` is a single lock point that holds those items apart even with zero real overlap). The
// signal is the size+collision COMPOSITE, never raw line count (a large-but-cohesive, uncontended file
// stays quiet). A `// @cohesive: <reason>` escape hatch IN THE FILE HEADER silences the warn for a
// genuinely-cohesive file. Codified at docs/agent/platform-decisions.md#small-file-preference.

/** Ratified illustrative defaults (#2678's own code sample) — override via `findLockPointFiles`'s `opts`
 * for tests; the live wiring in check-standards.mjs uses these. */
export const LOCK_POINT_CODE_LINES_THRESHOLD = 800;
export const LOCK_POINT_COLLISIONS_THRESHOLD = 5;

/** Count "code lines" in a file body — total lines minus blank lines and single-line `//` comment lines.
 * Deliberately a simple proxy, NOT a tokenizer/parser (block comments are not stripped): #2678's own point
 * is that this composite need only be truer than raw line count, not exact — it is a warn-only gate. */
export function countCodeLines(text) {
  if (typeof text !== 'string' || text === '') return 0;
  return text.split('\n').filter((line) => {
    const t = line.trim();
    return t !== '' && !t.startsWith('//');
  }).length;
}

/** Does the file's HEADER carry the `// @cohesive: <reason>` escape hatch (#2678)? A bare marker with no
 * reason text does NOT suppress the warn — the author must actually state why the file is cohesive.
 *
 * POSITIONAL, not lexical (#2782 review r2). The marker only counts as a directive when it sits in the
 * file header: the run of shebang / blank / `//` lines (and any leading `/* … *\/` block) before the first
 * line of real content. Two earlier cuts answered "is this a directive?" by pattern alone and both were
 * forgeable as DATA:
 *   r0 matched `// @cohesive:` anywhere in the body, so every file that merely DOCUMENTS the hatch
 *     exempted itself — including all three files this rule ships in.
 *   r1 anchored to line-start, which still matched the marker inside a template literal, inside a
 *     `/* … *\/` block, or inside a fenced ` ```js ` example in a `.md` file — any incidental line
 *     permanently silencing the gate for a whole file.
 * A header line cannot be smuggled in as content: a template literal, a fenced block and mid-file code all
 * sit past the first real line, and block-comment interiors are skipped even in the header. #2678's own
 * sample scanned the file head for exactly this reason; restoring that constraint makes the marker an
 * author's deliberate declaration again rather than any string the file happens to contain. */
export function hasCohesiveEscapeHatch(text) {
  if (typeof text !== 'string' || text === '') return false;
  const lines = text.split('\n');
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (inBlockComment) {
      const end = t.indexOf('*/');
      if (end === -1) continue; // block-comment interior — never a directive
      inBlockComment = false;
      if (t.slice(end + 2).trim() !== '') return false; // real content trails the block: header is over
      continue;
    }
    if (t === '') continue;
    if (i === 0 && t.startsWith('#!')) continue;
    if (t.startsWith('//')) {
      if (/^\/\/[ \t]*@cohesive:[ \t]*\S/.test(t)) return true;
      continue;
    }
    if (t.startsWith('/*')) {
      const end = t.indexOf('*/', 2);
      if (end === -1) { inBlockComment = true; continue; }
      if (t.slice(end + 2).trim() !== '') return false;
      continue;
    }
    return false; // first line of real content — the header region ends here
  }
  return false;
}

/** Count how many backlog items' `scope:` entries NAME this file — the real serialization cost (#2678):
 * each queued item whose predicted scope covers the file holds a lane apart from every other. Uses the
 * same coverage matcher the scope-lease engine runs (`coversFile`, #2679), so a directory/glob scope entry
 * that happens to cover the file counts too, not only an exact-path entry.
 * @param file repo-qualified path (e.g. "we:scripts/merge-ai-prs.mjs").
 * @param backlogScopes array of each (already status-filtered) item's `scope:` array.
 */
export function countScopeCollisions(file, backlogScopes) {
  let n = 0;
  for (const scopes of backlogScopes || []) {
    if (Array.isArray(scopes) && scopes.some((s) => typeof s === 'string' && coversFile(s, file))) n++;
  }
  return n;
}

/** The candidate universe for the lock-point scan: every FILE-shaped (not directory/glob), `we:`-qualified
 * scope entry named by ANY item in `backlogScopes`, deduped. Only a file some item explicitly names can
 * ever cross the collision threshold, so this is both correct and far cheaper than walking every tracked
 * file. Pure (no fs) and exported so the live wiring in check-standards.mjs and the real-repo calibration
 * guard (#2782) select the SAME population — a drift here would silently un-guard the thresholds.
 * @returns `string[]` of repo-qualified paths. */
export function lockPointCandidatePaths(backlogScopes) {
  const out = new Set();
  for (const scopes of backlogScopes || [])
    for (const s of scopes || [])
      if (typeof s === 'string' && s.startsWith('we:') && !isSubtreeEntry(s)) out.add(s);
  return [...out];
}

/**
 * Find lock-point files: BOTH oversized (code lines over threshold) AND scope-collision-heavy (named by
 * at least `collisionsThreshold` items' scopes), skipping any file whose HEADER carries the `@cohesive:`
 * escape hatch.
 * #2678 Fork 1 (b) — warn-only; the caller decides how to surface the result (never an error/deny).
 *
 * @param files array of `{ path, text }` — path repo-qualified, text the file body. Pass only FILE-shaped
 *   candidates (e.g. filter with `!isSubtreeEntry(path)`) — a directory has no single "size" to measure.
 * @param backlogScopes array of each queued item's `scope:` array — the collision universe. Callers
 *   typically pass only non-resolved items (a resolved item no longer holds a live lane).
 * @param opts.codeLinesThreshold / opts.collisionsThreshold override the ratified defaults (test seam).
 * @returns `[{ path, codeLines, collisions }]`
 */
export function findLockPointFiles({ files, backlogScopes }, opts = {}) {
  const codeLinesThreshold = opts.codeLinesThreshold ?? LOCK_POINT_CODE_LINES_THRESHOLD;
  const collisionsThreshold = opts.collisionsThreshold ?? LOCK_POINT_COLLISIONS_THRESHOLD;
  const out = [];
  for (const f of files || []) {
    if (!f || typeof f.path !== 'string' || isSubtreeEntry(f.path)) continue;
    if (hasCohesiveEscapeHatch(f.text)) continue;
    const codeLines = countCodeLines(f.text);
    if (codeLines <= codeLinesThreshold) continue;
    const collisions = countScopeCollisions(f.path, backlogScopes);
    if (collisions < collisionsThreshold) continue;
    out.push({ path: f.path, codeLines, collisions });
  }
  return out;
}

// ── 18/19. The two rules the PR #1064 review named but that needed whole-repo design first (#2967) ───────────
// The review named three script-decidable rules. The third — declared-contract-vs-imports — was cheap and
// shipped with the #1064 fix (`validateDeclaredModuleContract`, above). These are the other two. Both are
// SOURCE-TEXT scans (regex + a small hand scanner), never a JS parser: they are hygiene gates over a repo whose
// own style they only have to be truer than, and each documents the shapes it cannot see.

/** Split `text` on the commas that sit at bracket depth 0 and outside any quote/template. A small hand
 * scanner, NOT a JS parser — enough for a destructuring parameter list (`a = [], b = {}, c = FOO`). */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0; let quote = null; let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** The index just past the bracket matching the opener at `open` (`(`/`{`/`[`), or -1. Quote-aware. */
function matchBracket(text, open) {
  const closers = { '(': ')', '{': '}', '[': ']' };
  const closer = closers[text[open]];
  if (!closer) return -1;
  let depth = 0; let quote = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === text[open]) depth += 1;
    else if (c === closer) { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

// ── (a) TEST-ONLY EXPORTS — "extracted, tested, never wired" (#2967) ─────────────────────────────────────────
// `reduceLensJury` was exported from scripts/lib/converge-core.mjs, unit-tested with three cases, and called by
// NOTHING — so multi-juror lenses collapsed last-writer-wins inside `reducePanelRound` and the SAME two jurors
// produced `land` or `edit` depending on array order. "No non-test module in this repo imports this export" is
// fully script-decidable, and it catches that whole class in one rule.
//
// WARN-FIRST (`TEST_ONLY_EXPORT_ENFORCED = false`), on the `COMPOSE_TRAITS_ENFORCED` precedent: a broad
// structural scan with a real but boundable false-positive surface ships advisory until its carve-outs are
// curated false-positive-free, then flips. Four carve-out classes are known and handled:
//   • USED INSIDE ITS OWN MODULE — a pure helper a file's own CLI shell calls, exported only as a test seam, is
//     WIRED: its behaviour is live and a change to it breaks something real. The class this rule is for is the
//     one `reduceLensJury` was in — called by NOTHING, so the tests were the only thing holding it up. A raw
//     "no importer" scan conflates the two and buries the real finding under ~800 non-findings (measured).
//   • STAR-IMPORT re-export — a module namespace-imported (`import * as rules from …`) has every export "used"
//     only through the namespace object. Structural: precomputed by the caller's fs walk.
//   • CLI-SHELLED harness body — `scripts/review-core-cli.mjs`'s exports are imported only by its own test file,
//     but its real consumer is `node scripts/review-core-cli.mjs …` inside a workflow harness PROMPT STRING (and
//     package.json scripts). The consumer is the OS, invisible to any import graph. Structural, same walk.
//   • JUDGMENT carve-outs (a conformance suite that IS the intended consumer; a sibling-repo public API this
//     checkout cannot see) — a per-export `@test-only-export-ok: <reason>` marker in the export's OWN leading
//     comment. Deliberately NOT a curated list in this file: this file is already a #2678 lock point named by
//     9 queued items' scopes, and a third giant list here compounds exactly the serialization cost that gate
//     exists to flag. The marker is POSITIONALLY anchored for the reason `hasCohesiveEscapeHatch` is (its own
//     r0/r1 history): an un-anchored marker is forgeable by anything that merely documents the hatch.
export const TEST_ONLY_EXPORT_ENFORCED = false; // #2967, warn-first — mirrors COMPOSE_TRAITS_ENFORCED (#937)

/** Every name a module exports by DECLARATION (`export function|const|let|class …`), with the index the
 * declaration starts at. `export { … }` lists and `export default` are deliberately not collected: a
 * re-export list has no leading comment to anchor a marker to, and a default export has no name to wire.
 * @returns {Array<{name: string, index: number}>} */
export function extractExportedNames(content) {
  const out = [];
  const re = /^export\s+(?:async\s+)?(?:function\s*\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of String(content ?? '').matchAll(re)) out.push({ name: m[1], index: m.index });
  return out;
}

/** Does the export declared at `index` carry the `@test-only-export-ok: <reason>` marker in its OWN leading
 * comment? POSITIONAL, not lexical — the same constraint `hasCohesiveEscapeHatch` learned the hard way (r0
 * matched the marker anywhere in the file, so every file that merely DOCUMENTED the hatch exempted itself).
 * Only the unbroken run of comment lines directly above the declaration counts: a blank line, a line of real
 * code, or any backtick (a template literal's interior can look exactly like a comment line to a text scan)
 * ends the walk. A bare marker with no reason text does NOT count — the author must state why. */
export function hasTestOnlyExportOkMarker(content, index) {
  const lines = String(content ?? '').slice(0, index).split('\n');
  lines.pop();                                    // the (empty) head of the line the export starts on
  const collected = [];
  let inBlock = false;                            // walking UPWARD, we meet a block comment's `*/` first
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t.includes('`')) break;                   // unlexable: a template literal's body reads like a comment
    if (inBlock) {
      collected.push(t);
      if (t.startsWith('/*')) inBlock = false;    // reached the block's opener — keep walking upward
      continue;
    }
    if (t.endsWith('*/') && !t.startsWith('//')) { collected.push(t); inBlock = !t.includes('/*'); continue; }
    if (t.startsWith('//')) { collected.push(t); continue; }
    break;                                        // blank line or real code — the leading comment ends here
  }
  return /@test-only-export-ok:[ \t]*\S/.test(collected.join('\n'));
}

/**
 * Flag every export that no non-test module imports AND that its own module never references again — the
 * "extracted, tested, never wired" class (#2967a). Pure.
 *
 * Import matching is by SPECIFIER BASENAME, the same conservative match `validateDeclaredModuleContract` uses:
 * two modules sharing a basename merge, which can only ever HIDE a finding, never invent one — the right
 * direction for a scan whose whole design problem is false positives. The internal-reference test is the same
 * shape of conservative: any second mention of the name in the file (including one in a JSDoc) counts as use.
 *
 * @param {Array<{file: string, content: string}>} modules - every candidate .mjs (scripts/**, skills-src/**,
 *   excluding __tests__/dist/node_modules). Test files are excluded by the caller, which is why a finding says
 *   "no NON-TEST module imports it" rather than naming the test that does.
 * @param {{starImportedSpecifiers?: Set<string>, subprocessReferencedFiles?: Set<string>}} structural -
 *   precomputed by the caller's fs walk; both are sets of FILE BASENAMES (e.g. `review-core-cli.mjs`).
 * @returns {{errors: Array<{message: string, descriptor: object}>, warnings: Array<{message: string, descriptor: object}>}}
 */
export function findTestOnlyExports(modules = [], structural = {}) {
  const starImported = structural?.starImportedSpecifiers instanceof Set ? structural.starImportedSpecifiers : new Set();
  const shelled = structural?.subprocessReferencedFiles instanceof Set ? structural.subprocessReferencedFiles : new Set();
  // basename → every name some module imports (or re-exports) from a specifier with that basename.
  const importedByBasename = new Map();
  const add = (spec, names) => {
    const base = String(spec).split('/').pop();
    let set = importedByBasename.get(base);
    if (!set) { set = new Set(); importedByBasename.set(base, set); }
    for (const raw of names.split(',')) {
      const name = raw.trim().split(/\s+as\s+/)[0].trim();
      if (name) set.add(name);
    }
  };
  for (const { content } of modules || []) {
    const src = String(content ?? '');
    // `[^'"{}]*` absorbs a default import (`import x, { y } from …`) without ever crossing a string boundary.
    for (const m of src.matchAll(/import[^'"{}]*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) add(m[2], m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) add(m[2], m[1]);
  }
  const errors = []; const warnings = [];
  for (const { file, content } of modules || []) {
    const base = String(file).split('/').pop();
    if (starImported.has(base) || shelled.has(base)) continue;
    const imported = importedByBasename.get(base) || new Set();
    const src = String(content ?? '');
    for (const { name, index } of extractExportedNames(content)) {
      if (imported.has(name)) continue;
      // Referenced again anywhere in its OWN module (a file's CLI shell calling its own pure core) ⇒ wired.
      if ((src.match(new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\b`, 'g')) || []).length > 1) continue;
      if (hasTestOnlyExportOkMarker(content, index)) continue;
      const finding = {
        // Deliberately SHORT: this fires ~50 times on today's tree, and a paragraph repeated 50 times is a
        // wall, not a signal. The rationale (and `reduceLensJury`'s story) lives in the block comment above.
        message:
          `test-only export (#2967): \`${name}\` in ${file} — no non-test module imports it and nothing in ` +
          `${file} references it either, so only its own test exercises it. Wire it, drop the export, or put ` +
          `\`@test-only-export-ok: <reason>\` in its own leading comment if the consumer is one this scan ` +
          `structurally cannot see (a sibling repo, a conformance suite that IS the intended consumer).`,
        descriptor: { kind: 'test-only-export', file, export: name },
      };
      (TEST_ONLY_EXPORT_ENFORCED ? errors : warnings).push(finding);
    }
  }
  return { errors, warnings };
}

// ── (b) UNFENCED MANDATE PARAMS — a mandate builder with no fence on its untrusted input (#2967b) ────────────
// This repo ships `fenceUntrusted` + `FENCED_DATA_RULE` (#2438) so untrusted prose travels as LABELLED DATA
// rather than sitting in instruction position. That fix was left local to the plan handshake, so the next
// author composing a mandate followed the older, unfenced example — `scripts/converge-cli.mjs:210`'s own header
// comment says so nearly verbatim.
//
// WHAT THIS RULE ESTABLISHES, EXACTLY — and no more. It proves a builder has NO fenced path for a parameter it
// splices into instruction text. That is a hygiene fact about the source, not evidence of an exploit: nobody
// has tested whether crafted caller text actually changes an agent's verdict, and the degree of influence is
// UNMEASURED. Do not read (or write) a wider claim than "caller-supplied text reaches the mandate unfenced".
//
// CODE ONLY, NEVER PROSE (PR #1235 review, blocker 1). Everything below reads the builder body through
// `maskNonCode` — comments, string/template TEXT and regex bodies are blanked before anything is matched. The
// unmasked r0 scanned raw source, so `// TODO: fenceUntrusted('goal', goal) later` next to a raw `${goal}`
// SILENCED the error (the fence "call" was a comment), and, in the other direction, a docblock that merely
// SHOWS `${goal}` in an example flagged a builder that never splices it. A gate a comment can switch off is
// not a gate; a gate this repo's commenting style reddens is not one either.
//
// TWO LIMITS, both deliberate and both worth knowing before trusting a green run:
//   1. It is a DEFINITION-level scan. `fenced` is opt-in on some builders (`buildEditorMandate`), so a builder
//      that merely OFFERS a fenced path passes — the rule does not verify that each CALL SITE opts in. Call-site
//      verification is a different scan over a different file set; this one does not do it.
//   2. It sees only a parameter interpolated DIRECTLY (`${goal}`, `${String(goal).trim()}`), and counts it
//      fenced only when the param name appears in `fenceUntrusted`'s SECOND argument — the data expression. The
//      TAG (first argument) is masked with the rest of the string literals on purpose: `fenceUntrusted('goal',
//      somethingElse)` must not exempt a raw `${goal}` elsewhere in the body. So a param first copied into a
//      local (`const g = goal;`) is invisible when spliced (no taint tracking, by design) and reads as UNfenced
//      when only the local is passed to the fence. In the other direction it is deliberately blunt: a param
//      merely MENTIONED inside an interpolated expression (`${goal ? a : b}`, where only its truthiness is
//      read) counts as interpolated. Over-flagging costs one allow-list line; under-flagging costs the finding,
//      so both bluntnesses point the safe way.
export const UNFENCED_MANDATE_ENFORCED = true; // #2967 RULED: error from day one; both live sites fixed with it

/** Parameters exempt from the fence: CLOSED vocabularies, never caller free text. `lens` is validated against
 * `PANEL_LENSES` (an unknown lens throws); `round`/`roundCap` are numbers; `contextIsolation` is an isolation
 * mode; `subjectNoun`/`findingAnchor` are the structural nouns a subject ADAPTER supplies ("diff", "region"),
 * not anything a caller passes through. Fencing these would be noise inside the mandate's own grammar.
 *
 * ONE OF THOSE RATIONALES IS WEAKER THAN THE OTHERS, stated rather than glossed (PR #1235 review, finding 7):
 * `contextIsolation` is called a closed vocabulary here, but no code closes it — `buildMandate` interpolates
 * whatever string it is handed straight into instruction position. Every live caller passes the default or
 * nothing, so the allow-list entry is not covering a live splice today; it is an unenforced claim, and closing
 * it means validating the value at the builder, not editing this list. */
export const MANDATE_FENCE_ALLOWED_PARAMS = new Set([
  'lens', 'round', 'roundCap', 'contextIsolation', 'subjectNoun', 'findingAnchor', 'fenced',
]);

/**
 * Blank every non-code region of a JS source — line and block comments, string literals (delimiters included),
 * the TEXT of template literals, and regex bodies — while preserving length, newlines, and every `${…}`
 * substitution's *expression* (PR #1235 review, blockers 1 and 2). Length preservation is what lets the
 * bracket walkers below keep working on offsets taken from the masked copy.
 *
 * WHY THE WHOLE FILE AND NOT JUST THE BODY: the same masking is what keeps a commented-out
 * `// export function buildOldMandate({ goal })` from being scanned as a live builder.
 *
 * The one heuristic here is regex-vs-division: a `/` is read as a regex literal only when the previous
 * significant character cannot end an expression (or the previous word is `return`/`typeof`/`case`/…), and only
 * when a closing `/` follows on the SAME line — a regex literal cannot span one, so anything else stays code.
 */
function maskNonCode(source) {
  const src = String(source ?? '');
  const out = src.split('');
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  // Openers and operators only: `)`, `]` and `}` are deliberately ABSENT — they can end an expression, so
  // `arr[i] / 2` is division, and reading it as a regex would blank real code up to the next slash.
  const REGEX_PREV = /[(,;:=!&|?+\-*%~^<>[{]/;
  const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'new', 'delete', 'void']);
  // Frames: the innermost is what we are lexing. A `template` frame blanks text and hands `${` back to code.
  const frames = [{ kind: 'code', braces: 0 }];
  let i = 0;
  const prevSignificant = () => {
    let k = i - 1;
    while (k >= 0 && /\s/.test(out[k])) k -= 1;
    if (k < 0) return { char: '', word: '' };
    if (!/[\w$]/.test(out[k])) return { char: out[k], word: '' };
    let end = k;
    while (k >= 0 && /[\w$]/.test(out[k])) k -= 1;
    return { char: out[end], word: out.slice(k + 1, end + 1).join('') };
  };
  while (i < src.length) {
    const top = frames[frames.length - 1];
    const c = src[i]; const d = src[i + 1];
    if (top.kind === 'template') {
      if (c === '\\') { blank(i); blank(i + 1); i += 2; continue; }
      if (c === '$' && d === '{') { frames.push({ kind: 'code', braces: 0 }); i += 2; continue; } // keep `${`
      if (c === '`') { blank(i); frames.pop(); i += 1; continue; }
      blank(i); i += 1; continue;
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { blank(i); i += 1; } continue; }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let k = i; k < stop; k += 1) blank(k);
      i = stop; continue;
    }
    if (c === "'" || c === '"') {
      blank(i); i += 1;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { blank(i); i += 1; }
        blank(i); i += 1;
      }
      if (i < src.length && src[i] === c) { blank(i); i += 1; }
      continue;
    }
    if (c === '`') { blank(i); frames.push({ kind: 'template', braces: 0 }); i += 1; continue; }
    if (c === '/') {
      const prev = prevSignificant();
      if (prev.char === '' || (prev.word ? REGEX_PREV_WORDS.has(prev.word) : REGEX_PREV.test(prev.char))) {
        let k = i + 1; let inClass = false; let closed = -1;
        while (k < src.length && src[k] !== '\n') {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '[') inClass = true;
          else if (src[k] === ']') inClass = false;
          else if (src[k] === '/' && !inClass) { closed = k; break; }
          k += 1;
        }
        if (closed > 0) {
          let end = closed + 1;
          while (end < src.length && /[a-z]/.test(src[end])) end += 1; // flags
          for (let b = i; b < end; b += 1) blank(b);
          i = end; continue;
        }
      }
      i += 1; continue;
    }
    if (c === '{') { top.braces += 1; i += 1; continue; }
    if (c === '}') {
      if (top.braces === 0 && frames.length > 1) { frames.pop(); i += 1; continue; } // closes a `${…}` — keep it
      top.braces -= 1; i += 1; continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Every `export function build…Mandate(…)` in a module, with its destructured parameter names and body text.
 * The body runs to the first `}` in column 0 — this repo's top-level functions all close that way. Reads the
 * MASKED source (see `maskNonCode`): every consumer below matches identifiers, never prose. */
function extractMandateBuilders(content) {
  const src = maskNonCode(content);
  const out = [];
  for (const m of src.matchAll(/export\s+function\s+(build[A-Za-z0-9_$]*Mandate)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const sigEnd = matchBracket(src, open);
    if (sigEnd < 0) continue;
    const sig = src.slice(open + 1, sigEnd - 1);
    const bodyOpen = src.indexOf('{', sigEnd - 1);
    if (bodyOpen < 0) continue;
    const close = src.slice(bodyOpen).search(/\n\}/);
    const body = src.slice(bodyOpen, close < 0 ? src.length : bodyOpen + close);
    const params = [];
    const brace = sig.indexOf('{');
    const inner = brace >= 0 ? sig.slice(brace + 1, matchBracket(sig, brace) - 1) : sig;
    for (const part of splitTopLevelCommas(inner)) {
      const pm = /^\s*([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(part);
      if (pm) params.push(pm[2] || pm[1]);
    }
    out.push({ name: m[1], params, body });
  }
  return out;
}

/** Every `${…}` expression in `text`, and every `fenceUntrusted(…)` call's DATA argument — everything after the
 * first top-level comma, i.e. the expression actually being fenced. The tag argument is deliberately excluded
 * (it is a masked string literal by the time this runs anyway): a fence whose TAG happens to spell a param name
 * must not exempt that param from a raw splice elsewhere. `text` must already be masked. */
function interpolationsAndFences(text) {
  const interpolations = []; const fenced = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '$' && text[i + 1] === '{') {
      const end = matchBracket(text, i + 1);
      if (end > 0) { interpolations.push(text.slice(i + 2, end - 1)); i = end - 1; }
    }
  }
  for (const m of text.matchAll(/\bfenceUntrusted\s*\(/g)) {
    const end = matchBracket(text, m.index + m[0].length - 1);
    if (end < 0) continue;
    const args = splitTopLevelCommas(text.slice(m.index + m[0].length, end - 1));
    if (args.length > 1) fenced.push(args.slice(1).join(','));
  }
  return { interpolations, fenced };
}

/** True when the builder hands its own `fenced` flag on to ANOTHER `build…Mandate(…)` — the delegate shape
 * (`buildMandate` / `buildPanelMandate` forward `fenced` to `buildSubjectMandate`, which owns the wording and
 * emits `FENCED_DATA_RULE`). A delegating builder therefore satisfies the data-rule requirement without naming
 * the constant itself (PR #1235 review, blocker-adjacent 2). `body` must already be masked.
 *
 * THE LIMIT, stated rather than glossed: this traces ONE hop, syntactically. It proves the flag is forwarded to
 * something named `build…Mandate`, not that the callee really emits the rule — a delegate chain two hops long,
 * or a callee that ignores the flag, is out of reach of a definition-level scan. */
function delegatesFenceRule(body) {
  for (const m of body.matchAll(/\bbuild[A-Za-z0-9_$]*Mandate\s*\(/g)) {
    const end = matchBracket(body, m.index + m[0].length - 1);
    if (end > 0 && /\bfenced\b/.test(body.slice(m.index + m[0].length, end - 1))) return true;
  }
  return false;
}

/**
 * Flag every `build…Mandate` parameter spliced into the mandate's instruction text with no `fenceUntrusted`
 * path (#2967b). Pure. Read the two limits and the scope of the claim in the block comment above — the rule
 * establishes that caller-supplied text reaches the mandate unfenced, and nothing about how much influence
 * that buys, which is UNMEASURED.
 *
 * @param {Array<{file: string, content: string}>} modules - scripts/lib/*.mjs content.
 * @returns {{errors: Array<{message: string, descriptor: object}>, warnings: Array<{message: string, descriptor: object}>}}
 */
export function findUnfencedMandateParams(modules = []) {
  const errors = []; const warnings = [];
  const emit = (finding) => (UNFENCED_MANDATE_ENFORCED ? errors : warnings).push(finding);
  for (const { file, content } of modules || []) {
    for (const { name, params, body } of extractMandateBuilders(content)) {
      const { interpolations, fenced } = interpolationsAndFences(body);
      let anyFenced = false;
      for (const param of params) {
        const ref = new RegExp(`\\b${param}\\b`);
        const isFenced = fenced.some((a) => ref.test(a));
        if (isFenced) anyFenced = true;
        if (!interpolations.some((e) => ref.test(e))) continue;
        if (isFenced || MANDATE_FENCE_ALLOWED_PARAMS.has(param)) continue;
        emit({
          message:
            `unfenced mandate param: \`${param}\` is interpolated into the mandate text ${name}() returns ` +
            `(${file}) without ever passing through \`fenceUntrusted\`. Caller-supplied text then reaches the ` +
            `mandate in instruction position rather than as labelled data — that is all this rule establishes; ` +
            `whether such text can actually steer an agent's verdict is UNMEASURED here. Route it through ` +
            `\`fenceUntrusted('<tag>', …)\` and include \`FENCED_DATA_RULE\` in the returned text (#2438), or ` +
            `add it to \`MANDATE_FENCE_ALLOWED_PARAMS\` if it is a closed vocabulary rather than free text.`,
          descriptor: { kind: 'unfenced-mandate-param', file, builder: name, param },
        });
      }
      if (anyFenced && !body.includes('FENCED_DATA_RULE') && !delegatesFenceRule(body)) {
        emit({
          message:
            `fenced mandate without its data rule: ${name}() (${file}) wraps a parameter in \`fenceUntrusted\` ` +
            `but the text it returns never states \`FENCED_DATA_RULE\` — and it does not forward its \`fenced\` ` +
            `flag to another \`build…Mandate\` that would. A fence with no rule sentence is decorative — the ` +
            `tags are just characters unless the mandate tells the agent that fenced blocks are data to judge ` +
            `and never instructions to follow (#2438).`,
          descriptor: { kind: 'unfenced-mandate-param', file, builder: name, param: null },
        });
      }
    }
  }
  return { errors, warnings };
}

// ── scope defaults to FILE-LEVEL — dir-level scope finding (#2739/#2751) ──────────────────────
// Extracted from the inline §6d-sexies WARN in check-standards.mjs so the rule has ONE shipped definition:
// the gate imports and calls this, and the test file imports the SAME function instead of hand-mirroring it
// (a hand-mirrored copy can drift from the rule it claims to pin — #2751). Pure: reads only the fields named.
const SCOPE_REPO_PREFIX_RE = /^(?:we|fui|plateau|webeverything|frontierui|plateau-app):/;

/**
 * @param {{scope?: unknown, status?: string, scopeRationale?: string}} item - RAW (pre-loader) frontmatter.
 * @returns {string[]} the repo-qualified, "/"-terminated scope entries to flag; [] when item.scope isn't an
 *   array, item.status === 'resolved', or a non-empty (trimmed) item.scopeRationale justifies the span.
 */
export function dirLevelScopeFinding(item) {
  const scope = item?.scope;
  if (!Array.isArray(scope)) return [];
  if (item?.status === 'resolved') return [];
  const rationale = typeof item?.scopeRationale === 'string' ? item.scopeRationale.trim() : '';
  if (rationale) return [];
  return scope.filter((p) => typeof p === 'string' && SCOPE_REPO_PREFIX_RE.test(p) && p.endsWith('/'));
}

// ── scope entry names a path that does not resolve, but its BASENAME does (#3337) ─────────────
// `scope:` is machine-read: `scripts/readiness/dispatch-plan.mjs` matches it by EXACT path through
// `coversFile`, so an entry naming a path that does not exist covers nothing — the file the work really
// touches goes undeclared, and two items that are really the same-file collision look disjoint to the
// dispatcher. That is the failure this catches: `we:scripts/lib/__tests__/lane-verify.test.mjs` when the
// tracked file is `we:scripts/__tests__/lane-verify.test.mjs` (#3321), or `we:scripts/lib/foo.mjs` when the
// module lives at `we:scripts/foo.mjs`. 8 of the `scripts/lib/*.mjs` modules keep their test at the
// top-level `scripts/__tests__/` rather than a sibling `scripts/lib/__tests__/`, so the wrong directory is
// the natural guess for any of them.
//
// WARNING, NEVER AN ERROR — the greenfield case is legitimate. A scope may name a file the item is about to
// CREATE (#3307's `we:scripts/lib/claim-sweep.mjs` was correct as written), and static state cannot tell a
// to-be-created file from a typo. What CAN be told apart is the SHAPE: a basename that matches nothing
// anywhere is a genuine new file (silent); a basename that already exists at a different path is the shape
// that is provably a typo far more often than not. Erroring would redden exactly the greenfield case.
//
// FALSE POSITIVES ARE THE FAILURE MODE (the gate already emits ~1400 warnings — noise makes the whole pile
// less read, not more), so the rule is deliberately narrow on four axes:
//   1. LOCAL REPO ONLY. Only `we:` entries are checked. `fui:`/`plateau:` paths live in sibling repos this
//      gate cannot see, and "not found" there would mean "not checkable", not "wrong".
//   2. FILE ENTRIES ONLY. A subtree entry (glob / trailing slash / extensionless — `isSubtreeEntry`) leases a
//      tree, never an exact path, so "does it resolve" is not even the right question for it. The dir-level
//      shape is already the separate #2739 finding.
//   3. BEST-TAIL SUGGESTION, NOT EVERY BASENAME MATCH. Candidates are ranked by how many TRAILING path
//      segments they share with the entry, and only the top tier is offered. This is what makes a generic
//      basename safe: `.claude/skills/review/SKILL.md` has 27 `SKILL.md` matches, but exactly one shares the
//      `review/SKILL.md` tail — so the warning names one probable path instead of a useless list of 27.
//   4. A WIDE TOP TIER IS SILENCE. When even the best tier is bigger than SCOPE_BASENAME_MAX_SUGGESTIONS the
//      basename is generic AND undiscriminating; there is no path to suggest, the evidence is weak, and an
//      unactionable "this looks wrong" is exactly the warning that trains people to skip the output.
// Resolved items are skipped and a non-empty `scopeRationale:` clears the finding — the same two escapes the
// dir-level rule above uses, so an author whose odd-looking entry is deliberate has one place to say so.

/** Only the local repo's tree is visible to this gate, so only its entries can be resolution-checked. */
const SCOPE_LOCAL_REPO_PREFIX = 'we:';

/** Widest top tier still worth suggesting. Past this the basename discriminates nothing (see axis 4). */
export const SCOPE_BASENAME_MAX_SUGGESTIONS = 3;

/** Count the path segments `a` and `b` share reading from the END (both share ≥1 iff same basename). */
function sharedTrailingSegments(a, b) {
  const A = a.split('/'), B = b.split('/');
  let n = 0;
  while (n < A.length && n < B.length && A[A.length - 1 - n] === B[B.length - 1 - n]) n++;
  return n;
}

/**
 * Index a tracked-path list once for {@link scopeBasenameMismatches} (which is called per backlog item).
 * @param {Iterable<string>} trackedPaths repo-relative tracked paths (`git ls-files`), no `<repo>:` prefix.
 * @returns {{paths: Set<string>, byBasename: Map<string, string[]>}}
 */
export function buildTrackedPathIndex(trackedPaths) {
  const paths = new Set();
  const byBasename = new Map();
  for (const raw of trackedPaths || []) {
    if (typeof raw !== 'string' || !raw) continue;
    paths.add(raw);
    const base = raw.slice(raw.lastIndexOf('/') + 1);
    const bucket = byBasename.get(base);
    if (bucket) bucket.push(raw); else byBasename.set(base, [raw]);
  }
  return { paths, byBasename };
}

/**
 * @param {{scope?: unknown, status?: string, scopeRationale?: string}} item RAW (pre-loader) frontmatter.
 * @param {{paths: Set<string>, byBasename: Map<string, string[]>}} index from {@link buildTrackedPathIndex}.
 * @returns {{entry: string, path: string, suggestions: string[]}[]} one finding per unresolved `we:` FILE
 *   entry whose basename matches tracked files at other paths, `suggestions` = the best-tail tier (never
 *   empty, never longer than SCOPE_BASENAME_MAX_SUGGESTIONS). `[]` for a resolved item, one carrying a
 *   non-empty scopeRationale, a non-array scope, or a missing/empty index.
 */
export function scopeBasenameMismatches(item, index) {
  const scope = item?.scope;
  if (!Array.isArray(scope)) return [];
  if (item?.status === 'resolved') return [];
  const rationale = typeof item?.scopeRationale === 'string' ? item.scopeRationale.trim() : '';
  if (rationale) return [];
  const paths = index?.paths, byBasename = index?.byBasename;
  // An empty index means "the tracked list could not be read", not "nothing resolves" — stay silent rather
  // than flag the entire corpus off a failed fs read.
  if (!(paths instanceof Set) || !(byBasename instanceof Map) || paths.size === 0) return [];

  const findings = [];
  for (const entry of scope) {
    if (typeof entry !== 'string' || !entry.startsWith(SCOPE_LOCAL_REPO_PREFIX)) continue; // axis 1
    if (isSubtreeEntry(entry)) continue;                                                   // axis 2
    const path = entry.slice(SCOPE_LOCAL_REPO_PREFIX.length);
    if (!path || paths.has(path)) continue;                                       // resolves — nothing to say
    const candidates = byBasename.get(path.slice(path.lastIndexOf('/') + 1)) || [];
    if (!candidates.length) continue;                       // no basename match anywhere ⇒ a genuine new file
    let best = 0;                                                                            // axis 3
    for (const c of candidates) { const n = sharedTrailingSegments(path, c); if (n > best) best = n; }
    const suggestions = candidates.filter((c) => sharedTrailingSegments(path, c) === best).sort();
    if (suggestions.length > SCOPE_BASENAME_MAX_SUGGESTIONS) continue;                       // axis 4
    findings.push({ entry, path, suggestions });
  }
  return findings;
}

/**
 * The §6d-septies warning text for one {@link scopeBasenameMismatches} finding. Lives here (not at the call
 * site) so the message that names the probable intended path is itself unit-pinnable — a warning that says
 * only "this looks wrong" is not actionable, and the suggested path IS the actionable half.
 * @param {string} id backlog item id (the filename stem).
 * @param {{entry: string, suggestions: string[]}} finding
 * @returns {string}
 */
export function scopeBasenameMismatchMessage(id, finding) {
  const { entry, suggestions } = finding;
  const did = suggestions.length > 1
    ? `Did you mean one of ${suggestions.map((s) => `"${SCOPE_LOCAL_REPO_PREFIX}${s}"`).join(', ')}?`
    : `Did you mean "${SCOPE_LOCAL_REPO_PREFIX}${suggestions[0]}"?`;
  return `Backlog item "${id}" scope entry "${entry}" names a path that is not tracked, but a file with the ` +
    `same NAME is tracked elsewhere — the shape of a typo or a stale path, not a new file (#3337). ${did} ` +
    `\`scope:\` is matched by EXACT path (readiness/scope-lease.mjs \`coversFile\`), so an entry that resolves ` +
    `to nothing covers nothing: the file this item really touches goes undeclared and the dispatcher can launch ` +
    `it alongside an item that writes the very same file. Fix the path — or, if this item genuinely CREATES the ` +
    `file at the path as written, leave it and add a short \`scopeRationale:\` note saying so, which clears ` +
    `this flag.`;
}

// ── `--all` inside a git hook (#3196) ──────────────────────────────────────────────────────────
// `we:.githooks/post-merge` shipped a commands sync carrying `--all`. On that CLI `--all` does NOT mean
// "deploy every command" — it means "CREATE the machine-global tree", on a machine that never opted in
// (`if (!all && !exists(destRoot)) return null`). So a routine `git pull` that merely touched a command file
// created `~/.claude/commands` and populated the operator's user-global config, live in every unrelated repo
// they open, without ever asking.
//
// WHY A HOOK IS THE PLACE TO GATE IT, and not "anywhere the flag appears": a hook runs on every merge, on
// every clone, unattended, with nobody reading its output. The same flag typed by hand is a choice; typed
// into a hook it is applied silently and repeatedly to whoever cloned the repo. It was caught by a reviewer,
// which is exactly the kind of catch that does not repeat.
//
// A PROMPT, NOT A WALL (`GITHOOK_ALL_ALLOW`). A hook that genuinely needs the flag says so on the line or the
// one above it. A rule you can only obey is a rule people suppress wholesale; one you can answer gets read.

/** The inline escape. Naming the reason is the point — the marker alone would just relocate the silence. */
export const GITHOOK_ALL_ALLOW = 'standards-allow --all:';

/**
 * SPLIT one shell line into its code half and its comment half, carrying the quote state IN and OUT. PURE.
 *
 * THE COMMENT HALF IS WHY THIS EXISTS AT ALL. `we:.githooks/post-merge` carries a long comment explaining that
 * it deliberately does NOT pass `--all` — the exact prose a naive substring scan would report as a violation,
 * which would make the rule fire hardest on the file that already got it right. Quote tracking is here for the
 * same reason in miniature: `echo "pass --all # not really"` has no comment in it.
 *
 * THE STATE CROSSES LINES, and that is #3204. The predecessor started every physical line with no quote open,
 * so a single-quoted string spanning two lines whose continuation begins with `#` read as a whole-line
 * comment — and a real invocation after the closing quote on that line was never tokenized at all. That is a
 * worse failure than the boundary misses this scan has had before: those were a boundary it could not SEE,
 * this one made it stop LOOKING, and a scan that stops looking cannot even degrade toward the escape hatch.
 *
 * Honest limit: this is a scanner, not a shell parser. Heredocs, `$(…)` nesting and `${x#y}` expansions are
 * not modelled. It is deliberately biased toward treating text as CODE — a false positive is a sentence in a
 * review; a false negative is the flag shipping again.
 *
 * @param {string} line
 * @param {string|null} openQuote - the quote character still open when this line began, or null.
 * @returns {{code: string, comment: string, openQuote: string|null}}
 */
export function scanShellLine(line, openQuote = null) {
  const s = String(line ?? '');
  let quote = openQuote ?? null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && quote !== "'") { i++; continue; }   // an escaped char is never a delimiter
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    // `#` opens a comment only at the start of a word — `${x#y}` and `a#b` are not comments. Unreachable
    // while a quote is open, which is the whole point: a `#` inside a string is not a comment opener.
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return { code: s.slice(0, i), comment: s.slice(i), openQuote: null };
  }
  return { code: s, comment: '', openQuote: quote };
}

/** The code half of ONE line read in isolation. Thin over {@link scanShellLine}. PURE. */
export function shellCodeOf(line) {
  return scanShellLine(line).code;
}


/**
 * What separates one shell word from the next: everything that is not a word CHARACTER.
 *
 * THE SET IS DEFINED POSITIVELY, AND THAT INVERSION IS THE FIX. Four review rounds each found another
 * character the enumerated-separator list did not contain — a trailing `;`, then a leading quote, then `,` and
 * a backtick, then `}` in an ordinary `${VAR:-node x --all}` default expansion. Enumerating separators means
 * being wrong until somebody finds the next one, and every wrong answer is a SILENT miss. Enumerating word
 * characters means being wrong only in the direction that REPORTS: an unlisted character splits, which can at
 * worst over-split a word into pieces that are not the flag either.
 *
 * What is in the set, and why each:
 *   · `A-Za-z0-9_` with `.` and `/` — ordinary identifier and path characters, so `x.mjs` stays one word.
 *   · `-` — the single omission from the separator side that keeps `--all-repos` and `--allow-dirty` out.
 *     They tokenize to themselves and simply are not `--all`.
 *   · `=` — so `--all=1` survives as one word for `isAllFlagWord`'s prefix arm. It costs `VAR=--all` reading
 *     as one word too, which is the variable-assembly case this scanner already declares out of scope.
 *   · `+` — harmless, and keeps `--std=c++17`-shaped arguments intact.
 */
const NOT_WORD_CHAR = /[^A-Za-z0-9_./=+-]+/;

/**
 * The shell WORDS one line of code passes. PURE.
 *
 * BOUNDARY MATCHING WAS THE WRONG SHAPE, and two review rounds proved it. This started as a regex that looked
 * for `--all` with the right characters either side, and each round found another shell-valid way of writing
 * the same argument that the boundaries did not recognise:
 *   · round 1 accepted only whitespace / `=` / end-of-line as a terminator, so `… --all;` was missed — in a
 *     file full of `if …; then`;
 *   · round 2 still required whitespace or start-of-line BEFORE the flag, so `"--all"`, `` `… --all` `` and
 *     `--all,foo` were missed too.
 * Both misses are the same defect and it is the worst shape this gate can have: silently not reporting the
 * real line, while a passing run reads as coverage. Widening the character classes a third time would be
 * betting that the next reviewer runs out of shell syntax before the syntax runs out.
 *
 * So the question is asked the way a shell asks it: SPLIT THE LINE INTO WORDS, then compare a whole word.
 * Quote characters are removed rather than treated as boundaries, because quoting is not part of the word —
 * `"--all"` passes exactly the argument `--all` does. `-` is NOT a separator, and that single omission is what
 * keeps `--all-repos` and `--allow-dirty` out: they tokenize to themselves and simply are not `--all`.
 *
 * Still a scanner, not a shell: `$IFS` games, heredocs and a flag assembled from variables are not modelled.
 * The bias stays toward treating text as code.
 */
export function shellWords(code) {
  return String(code ?? '')
    // A BACKTICK IS SUBSTITUTION, NOT QUOTING, so it BREAKS the word. `--all\`echo hi\`` expands to `--allhi`
    // in bash and is not the flag — but the same line with a substitution that yields NOTHING is exactly
    // `--all`. The expansion is unknowable here, so the word breaks and the case reports.
    .replace(/`/g, ' ')
    // Quoting and ESCAPING, by contrast, are REMOVED exactly as the shell removes them. `"--all"`, `\--all`,
    // `--al""l`, `-"-all"` and `-\-all` all pass the identical argument — bash was asked, not assumed. An
    // earlier cut replaced these with a SPACE on the theory that deleting could "weld two words into one";
    // that theory was wrong about the shell. Welding adjacent quoted fragments is precisely what the shell
    // DOES, so the space invented a split the shell never makes and missed every spliced form (review-pr
    // correctness juror on PR #1488).
    //
    // Removal is QUOTE-BLIND, and that over-reports in one known place: inside double quotes a backslash is
    // literal unless it precedes `$`, a backtick, `"` or itself, so `"\-\-all"` really passes `\-\-all` and we
    // call it a hit anyway. That is the declared direction — a false positive is a sentence in a review — and
    // modelling double-quote escape rules to remove it would buy nothing this gate needs.
    .replace(/["'\\]/g, '')
    .split(NOT_WORD_CHAR)
    .filter(Boolean);
}

/**
 * The COMMENT half of ONE line read in isolation. Thin over {@link scanShellLine}. PURE.
 *
 * The escape marker is read from here and not from the raw line: a raw-line substring match meant
 * `echo "standards-allow --all: fake" ; node x.mjs --all` suppressed a genuine invocation, because the phrase
 * appeared in a STRING on the same line. The marker is a comment by design, so that is the only place it
 * counts.
 */
export function shellCommentOf(line) {
  return scanShellLine(line).comment;
}


/** Is this word the flag? `--all=<value>` is the same flag; `--all-repos` is somebody else's. PURE. */
export function isAllFlagWord(word) {
  return word === '--all' || String(word).startsWith('--all=');
}

/**
 * Every line of a git hook that PASSES `--all` without saying why. PURE over the file's text.
 * @param {string} content
 * @returns {Array<{line: number, text: string}>}
 */
/**
 * Does this physical line continue onto the next? Only an ODD trailing backslash run does — and only outside a
 * SINGLE-quoted string, where a backslash is literal and continues nothing. PURE.
 *
 * THE STATE PASSED HERE IS THE ONE AT THE END OF THE LINE, not the one it began with, and the difference is a
 * real case: `A='foo\` opens the quote on the SAME line as its trailing backslash. Fed the incoming state
 * (null) the guard never fired, the two lines were spliced, and the invocation on the second was reported at
 * line 1 under fabricated text — it still reported, so nothing hid, but it pointed at the wrong line
 * (review-pr correctness juror on PR #1494). I had considered this case and judged it harmless on the grounds
 * that the resulting argv matched the shell; the argv did, the LOCATION did not.
 */
function continuesLine(code, openQuote = null) {
  if (openQuote === "'") return false;
  const run = String(code).match(/\\*$/);
  return ((run ? run[0].length : 0) % 2) === 1;
}

/**
 * The LOGICAL lines of a script: physical lines joined across `\`-newline continuations, each keeping the
 * number of the physical line it starts on. PURE.
 *
 * A continuation can split the flag itself — `node x.mjs --al\` then `l` is one word, `--all`, to bash — so a
 * per-physical-line scan cannot see it. Only a CODE-half backslash continues: a trailing `\` inside a comment
 * is just the last character of that comment, because a comment ends at its newline whatever precedes it.
 *
 * PARITY DECIDES, not presence. A trailing run of backslashes continues the line only when it is ODD — an even
 * run is escaped backslashes, and the line ends. Testing for "ends with a backslash" over-joined `echo foo\\`
 * onto the line below it, welding that line's head onto the tail of this one, so a bare `--all` invocation
 * immediately after such a line became `foo--all` and was MISSED (review-pr correctness juror on PR #1488).
 * Over-joining is the one direction where this preprocessing can hide a flag rather than expose one, which is
 * why the rule is parity rather than presence.
 */
export function logicalLines(content) {
  const physical = String(content ?? '').split('\n');
  const out = [];
  // The quote state crosses PHYSICAL lines, so it is carried here rather than restarted per line (#3204).
  let open = null;
  for (let i = 0; i < physical.length; i++) {
    const start = i;
    let text = physical[i];
    let scan = scanShellLine(text, open);
    while (i + 1 < physical.length && continuesLine(scan.code, scan.openQuote)) {
      text = `${text.slice(0, -1)}${physical[++i]}`;
      scan = scanShellLine(text, open);
    }
    out.push({ line: start + 1, text });
    open = scan.openQuote;
  }
  return out;
}


export function findGitHookAllFlags(content) {
  // ONE ordered pass, carrying the open quote from each logical line into the next (#3204). Scanning each
  // line from a clean state let a string that spans lines turn its continuation into a "comment", and the
  // invocation after the closing quote was then never tokenized at all.
  let open = null;
  const lines = logicalLines(content).map(({ line, text }) => {
    const scan = scanShellLine(text, open);
    open = scan.openQuote;
    return { line, text, code: scan.code, comment: scan.comment };
  });
  const out = [];
  lines.forEach(({ line, text, code }, i) => {
    if (!shellWords(code).some(isAllFlagWord)) return;
    // The escape is read from the COMMENT half of this line and of the one above — never from the code, where
    // the same phrase inside a string would silently suppress a real invocation.
    const escaped = (l) => String(l?.comment ?? '').includes(GITHOOK_ALL_ALLOW);
    if (escaped(lines[i]) || escaped(lines[i - 1])) return;
    out.push({ line, text: text.trim() });
  });
  return out;
}


/**
 * The finding as the gate reports it. Kept beside the detector so the message and the rule cannot drift, and
 * so it says what the flag DOES rather than only that it is disallowed — see the header on why.
 */
export function gitHookAllFlagError(file, hit) {
  return `${file}:${hit.line}: \`--all\` passed from a git hook — on these deploy CLIs it does not mean `
    + '"deploy everything", it means CREATE the machine-global tree (`~/.claude/commands`, `~/.claude/skills`) '
    + 'on a machine that never opted in. A hook runs unattended on every merge and every clone, so this is '
    + `applied silently and repeatedly to whoever cloned the repo. Drop the flag (the hook then only REFRESHES `
    + `a tree the operator already has), or write \`# ${GITHOOK_ALL_ALLOW} <why>\` on that line or the one above.`
    + `\n    ${hit.text}`;
}

// ── Leash pin (#2892 — enforces #2840 trigger 3, guards #2838's flip-edit safeguard) ───────────────
// The declarative-leash files — the review-policy contract (which owns `careJury.disposition.landMode`, the
// shadow→enforce switch), the roster, the invariant / conformance suites — are human-gated AS WHOLE FILES,
// permanently (`#human-is-principle-surface-not-path`, trigger 3): they ARE the encoded principle, so no edit to
// one is behaviour-preserving. #2838's whole safety story leans on that floor ("the flip edit is itself
// `review:human`"): if the contract could quietly leave the human gate, the single most oversight-reducing edit
// in the system would become agent-clearable. This rule is the standing assertion that it has not.
//
// TWO INDEPENDENT ANGLES, so a regression has to fool both:
//   1. CLASSIFICATION — every pinned basename is still in `POLICY_SPEC_BASENAMES` (the roster still calls it a
//      declarative-leash file). Catches a `leash: 'code'` reclassification or a dropped roster entry.
//   2. BEHAVIOUR — the REAL rubric (`scoreEscalation`, injected as `isHumanGated`) still returns
//      `humanRequired` for a diff that touches the file, whether the file's own hunks are a whitespace-only touch
//      (a hunk the STATUTE term would exempt, so only the path floor can hold it) or were NOT COMPUTED at all.
//      Catches the composition itself (`isPrincipleSurface` / the rubric's term) losing the unconditional path
//      floor while the roster still looks right — the case a roster-only check cannot see.
// A third, cheap check keeps the pin from going VACUOUS: a pinned entry whose registered `homes` no longer exist
// on disk is a renamed/deleted file the roster still "protects" — the pin then guards nothing.
//
// FAIL DIRECTION. All findings are hard ERRORS (there is no warn-first flag: on the current tree none fires, and
// each names a change that reduces human oversight). The one WARNING is growth: a leash file the roster gained
// that this snapshot does not yet name — its later removal would go unpinned.
//
// The snapshot is EVERY `POLICY_SPEC_BASENAMES` member as of this rule. It is a snapshot on purpose, not derived
// from the roster: a derived pin would shrink in lockstep with the thing it guards. Read it as a SECOND KEY, not a
// lock: this file is engine-tier (an edit escalates to the committee), so removing a name here is not by itself
// human-gated. What makes dropping a leash file a human decision is that it cannot be done WITHOUT a human-gated
// edit — the roster lives in `gate-config.mjs` (a declarative-leash file), the unconditional path floor in its
// `isPrincipleSurface` (marked), and the rubric's `humanRequired` derivation in `review-escalation.mjs` (marked).
// This rule is what turns a slip in any of them — a typo'd `leash:` value, a floor made conditional, a renamed
// file the roster still names — into a red gate instead of a silent under-gate.
export const LEASH_PIN_SNAPSHOT = Object.freeze([
  'review-policy.contract.json',
  'review-policy.conformance.test.mjs',
  'review-runner-core.mjs',
  'review-runner.mjs',
  'check-standards.contract.json',
  'check-standards.conformance.test.mjs',
  'review-independence.mjs',
  'gate-config.mjs',
  'gate-invariants.test.mjs',
]);

/** A REAL-shaped diff section for `path` whose only change is whitespace — exactly the hunk a content trigger
 *  exempts, so the human gate holding for it can only be the leash-path floor. Pure. */
function whitespaceTouchDiff(path) {
  return `diff --git a/${path} b/${path}\nindex 0000000..1111111 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n- x\n+ x \n`;
}

/**
 * Assert no pinned declarative-leash file has been dropped from the human gate. Pure — every input is injected so
 * a test drives it with synthetic rosters; `check-standards.mjs` wires the real ones.
 * @param {{pinned?:readonly string[], specBasenames:ReadonlySet<string>, roster:Array<{file:string,tier?:string,leash?:string,homes?:string[]}>,
 *          isHumanGated:(path:string, hunks:string|null)=>boolean, homeExists?:(rel:string)=>boolean}} o
 * @returns {{errors:Array<{message:string,descriptor?:object}>, warnings:Array<{message:string,descriptor?:object}>}}
 */
export function checkLeashPin({ pinned = LEASH_PIN_SNAPSHOT, specBasenames, roster = [], isHumanGated, homeExists = () => true } = {}) {
  const errors = [];
  const warnings = [];
  const descriptor = (file, extra = {}) => ({ kind: 'leash-pin', fix: 'model', file, global: true, ...extra });
  const GATE_FILE = 'scripts/lib/gate-config.mjs';
  for (const name of pinned) {
    if (!specBasenames || !specBasenames.has(name)) {
      errors.push({
        message: `leash pin (#2892): \`${name}\` is no longer in POLICY_SPEC_BASENAMES — a declarative-leash file was reclassified or dropped from the roster. `
          + 'These files are human-gated as whole files, permanently (#human-is-principle-surface-not-path trigger 3); dropping one lets an agent panel clear an edit to the encoded policy '
          + '(including #2838\'s shadow→enforce flip). Restore its `leash: \'spec\'` entry, or — only if a human ratified the removal — remove it from LEASH_PIN_SNAPSHOT in the same change.',
        descriptor: descriptor(GATE_FILE, { pinned: name, angle: 'classification' }),
      });
      continue; // the behavioural angle below would only repeat the finding
    }
    const entry = roster.find((e) => e && e.file === name);
    const homes = Array.isArray(entry?.homes) ? entry.homes : [];
    if (homes.length && !homes.some((h) => homeExists(h))) {
      errors.push({
        message: `leash pin (#2892): pinned leash file \`${name}\` has no registered home on disk (${homes.join(', ')}) — it was renamed or deleted while the roster still names it, so the pin now guards nothing. `
          + 'Re-register the renamed file (the roster matches by BASENAME, so a rename needs its `file` updated) and update LEASH_PIN_SNAPSHOT with it.',
        descriptor: descriptor(GATE_FILE, { pinned: name, angle: 'vacuous' }),
      });
    }
    const probe = homes[0] || name;
    for (const hunks of [whitespaceTouchDiff(probe), null]) {
      if (!isHumanGated(probe, hunks)) {
        errors.push({
          message: `leash pin (#2892): the rubric no longer requires a human for \`${probe}\` (diffHunks ${hunks === null ? 'not computed' : 'a whitespace-only touch of that file'}) although it is a pinned declarative-leash file. `
            + 'The leash-path floor of isPrincipleSurface must be UNCONDITIONAL — independent of the diff content — so no hunk shape (or a missing one) can route an edit to the encoded policy to the committee.',
          descriptor: descriptor('scripts/lib/review-escalation.mjs', { pinned: name, angle: 'behaviour', hunks: hunks === null ? 'null' : 'whitespace-only' }),
        });
      }
    }
  }
  const pinnedSet = new Set(pinned);
  for (const name of specBasenames || []) {
    if (!pinnedSet.has(name)) {
      warnings.push({
        message: `leash pin (#2892): \`${name}\` is a declarative-leash file the roster gained but LEASH_PIN_SNAPSHOT does not name — add it so a future removal is caught.`,
        descriptor: descriptor('scripts/check-standards-rules.mjs', { pinned: name, angle: 'unpinned-growth' }),
      });
    }
  }
  return { errors, warnings };
}
