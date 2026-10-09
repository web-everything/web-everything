#!/usr/bin/env node
import { relatedReportRefs } from './lib/related-report.cjs';
/**
 * check-standards.mjs — consistency & convention validator for Web Everything.
 *
 * Verifies the invariants that keep the spec (src/_data/*.json), the descriptions
 * (src/_includes/*-descriptions/*.njk), and the implementation in sync — so agents
 * (and humans) can't silently let documentation drift from code.
 *
 * Run: `npm run check:standards`  (exits 1 on any error; warnings don't fail)
 *
 * Flags (all leave the default no-flag whole-repo-strict run untouched — CI / close-out unchanged):
 *   --json                machine-readable failure feed (#095/#196)
 *   --scope=<session>     block only on THIS session's files vs its claim baseline (#952) — concurrent batching
 *   --local [--files=…]   per-lane gating for the parallel-batch orchestrator (#1144/#1147): `--files=<comma|space
 *                         list>` scopes the blocking set to findings on those files; `--local` additionally
 *                         demotes path-less GLOBAL/RELATIONAL findings (dup ids, the blockedBy cycle walk,
 *                         registry joins) to notes — a lane in its own worktree can't cause a cross-lane
 *                         invariant, so those are the MERGE gate's job, not the lane's. #4167: a section whose
 *                         findings `--local` would ALWAYS demote this way doesn't run at all under `--local` —
 *                         it checks `LOCAL_MODE` (declared right below, before any section runs) and skips its
 *                         own work instead of computing a finding this mode discards anyway. Same verdict, less
 *                         work; the default no-flag run is untouched (`LOCAL_MODE` is false). #70d: under
 *                         `--local --files=…`, a whole-repo section whose declared inputs
 *                         (we:scripts/lib/standards-sections.mjs) match no touched file is skipped and listed in
 *                         `summary.skippedSections` as `skipped (scoped: no input touched)`.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { isLaneLocus, resolveReal } from './guard-lane.mjs';
import { createRequire } from 'node:module';
import { renderInventory, spliceInventory } from './gen-inventory.mjs';
import { parseClaims, mineFiles, porcelainFiles, partitionFindings, partitionLocal, linkedFilesFor } from './readiness/claimScope.mjs';
import { checkDemos } from './check-demos.mjs';
import { buildReport, source as reportSource, finding as reportFinding, section as reportSection } from './lib/buildReport.mjs';
import { loadBlocks } from './lib/blocks-loader.cjs';
import { checkVerdictTotality, IMPACT_ENROLMENT } from './lib/verdict-totality.mjs';
import { checkReviewLabelSingleHome, GUARDED_DOC_PREFIXES, checkReviewLabelSingleHomeCode } from './lib/review-skill-guard.mjs';
import { VERDICTS, IMPACT_LEVELS } from './lib/jury-core.mjs';
import { loadIntents } from './lib/intents-loader.cjs';
import { loadResearch } from './lib/research-loader.cjs';
import { loadProtocols } from './lib/protocols-loader.cjs';
import { loadDemos } from './lib/demos-loader.cjs';
import { loadSemantics } from './lib/semantics-loader.cjs';
import { loadPresets } from './lib/presets-loader.cjs';
import { loadDataRegistry } from './lib/registry-loader.cjs';
import { loadAdapters } from './lib/adapters-loader.cjs';
import { localToday } from './lib/local-date.mjs';
import { findUtcDaySlices, utcDaySliceMessage } from './lib/utc-day-slice-scan.mjs';
import { scanInvisibleSourceTree } from './lib/invisible-source-scan.mjs';
import { scanFilesCached, gitGrepCached, cacheEnabled, fileKeys } from './lib/standards-cache.mjs';
import { scanStdoutFlush, stdoutFlushMessage } from './lib/stdout-flush-scan.mjs';
import { runWeScan } from './lib/rust-scan-bridge.mjs';
import { createSectionGate, SKIP_REASON } from './lib/standards-sections.mjs';
import {
  BACKLOG_STATUSES, BACKLOG_KINDS, FIB, FILE, blockSpecFile,
  dMissingField, dUnresolvedRef, dMissingDescription, buildGraduatedKinds, validateBacklogItem, validatePolyglotWideningGate, isCanonicalGraduated, detectClassificationCollapse, computeNativeFirstConformance, computeDesignKnowledgeConformance,
  checkStatus, validateProjectTier, advisoryTierCrossCheck, validateProtocol, validatePreset, validateDesignSystem, validateIntent, validateCapability, validateCapabilityMatrix,
  validateReportsNotHidden, findCompiledShadows, permalinkSegment, validateViteProxyCoverage,
  validateModuleResolutionLock,
  validateRenderersNotPublished, validateReferenceRuntimeForms,
  validateNoDuplicateManifestKeys,
  findUnquotedColonScalars, describeUnparseableFrontmatter, lintBacklogItemRendering,
  RESEARCH_REVIEW_HORIZON_DEFAULT, deriveResearchFreshness,
  validateCapabilityPresence, validateRetirementShape,
  validatePlugDualMode, validateTemplateA11y, validateBlockImplConformance,
  validateBlockComposesTraits, COMPOSE_DENY_LIST,
  validateBlockExportShape,
  validatePlugWeFuiDrift, PLUG_SHARED_CORE_FILES,
  scanRepoLocusPrefixes, REPO_LOCUS_PREFIX_ENFORCED,
  classifySurfacePaths,
  validateUntrackedDerivedArtifacts, DERIVED_ARTIFACT_DIRS,
  duplicateBacklogNums,
  duplicateBornAs,
  strandedHashesOnMain, isPullRequestCiRun,
  handNumberedNewItems,
  validatePlaywrightContainerPin, extractPlaywrightContainerTags, PLAYWRIGHT_CONTAINER_PIN_REQUIRED_FILES,
  validateDeclaredModuleContract,
  findLockPointFiles, lockPointCandidatePaths,
  findTestOnlyExports,
  scanPublishSecrets,
  scanHarnessScaffolding,
  findHandMaintainedRegistryIndex, REGISTRY_DISCOVERY_INDEX_FILES,
  findUnjournaledLaneMutations, LANE_MUTATION_FILES,
  findGitHookAllFlags,
  gitHookAllFlagError,
  buildTrackedPathIndex, scopeBasenameMismatches, scopeBasenameMismatchMessage,
  checkLeashPin,
  findRelativeNodeScriptsAfterLaneCd,
  scopeMissingTestFile, bodyDeliverablesMissingFromScope, deferredBlockedByFindings,
  dirLevelScopeFinding,
} from './check-standards-rules.mjs';
// #3637 — the declared POC branches, so a `deliveryTarget:` naming an UNregistered one is a gate error.
import { readRegistry as readPocRegistry } from './lib/poc-branches.mjs';
import { scanUnfencedMandateParams } from './lib/mandate-fence-scan.mjs';
// #3224 — the skill/operation wiring scan, and the map of what each operation declares over.
// #3253 adds the call-site scan beside it: same subject, one module.
import { findSkillsNamingUndelegatedHomes, findMalformedOperationCalls } from './lib/skill-operation-wiring.mjs';
import { scanOperationIoFidelity } from './lib/operation-io-fidelity.mjs';
import { DECLARED_HOMES } from './operations/declared-homes.mjs';
import { parseDeclaredHome } from './operations/registry.mjs';
// The operation table and the CLI's own control-flag list, IMPORTED not restated (#2644): a second copy of
// either is a second answer to "what may a call site pass", and the gate would drift from the CLI it judges.
import { OPERATIONS, resolveOperation } from './operations/run.mjs';
import { acceptedControlFlags } from './operations/cli-adapter.mjs';
import {
  buildAnchorOwners, findAnchorRulingMismatches, findDanglingLoci, findOutOfScopeHashSlugs,
  findDanglingMemoryHashSlugs,
  makeMemoizedLineCounter, CITATION_GATES_ENFORCED,
  findUnresolvedIdentifiers, buildIdentifierIndex, isIndexableSourcePath, PROVENANCE_ESCAPE_MARKERS,
  makeRepoResolver, findDanglingSymbolAnchors, findDanglingMarkdownLinks, findDanglingGraduatedTargets,
  HASH_PATH_CITE_SOURCE, findHashPathCitesInGrepLines, classifyHashPathCite,
  BACKLOG_GLOB_CITE_SOURCE, buildBacklogResolvableIds,
  findDanglingBacklogGlobCitesInGrepLines,
  findBlankLineLoci, makeMemoizedLineReader,
} from './lib/citation-check.mjs';
import { TRUST_CHAIN, POLICY_SPEC_BASENAMES } from './lib/gate-config.mjs';
// #2892 — the leash-pin rule asserts against the REAL rubric, not a copy of its predicate.
import { scoreEscalation } from './lib/review-escalation.mjs';
import { localChangedSet } from './lib/verify-lane-gate.mjs';
import { scanDiffBranchCoverage } from './lib/diff-branch-coverage.mjs';
import { isHash } from './backlog/id.mjs';

const require = createRequire(import.meta.url);
// #4166 — cheap outgoing-edge resolution for the scoped backlog load below (a changed item's OWN
// blockedBy/parent targets); reads frontmatter only, never the heavy markdown-render path.
const matter = require('gray-matter');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'src/_data');
const INC = join(ROOT, 'src/_includes');

// `--json` emits machine-readable failure descriptors (backlog #089 idea 1) so the
// conformance auto-fix agent (#095) can target failures structurally instead of
// scraping ANSI text. Human output is unchanged when the flag is absent.
const JSON_MODE = process.argv.includes('--json');

// #4167 — read BEFORE any section below runs, so a section whose findings `--local` would ALWAYS demote
// (a path-less GLOBAL/RELATIONAL finding — dup ids, the blockedBy cycle walk — or a `descriptor.global`-
// marked one like the AGENTS.md inventory / leash-pin checks) can skip its work entirely instead of
// computing it and then discarding it at the bottom (`partitionLocal`, scripts/readiness/claimScope.mjs).
// Each such section is guarded `if (!LOCAL_MODE)` at its own call site below — same verdict, less work.
// The scope-attribution mechanics themselves (the actual demotion of whatever DOES still run) stay at the
// bottom, unchanged, because they need the full `errors` array assembled first. The default no-flag run
// is untouched: LOCAL_MODE is false, so every section still runs exactly as before (CI / close-out).
const LOCAL_MODE = process.argv.includes('--local');

// #4163 profiling — CHECK_STANDARDS_PROFILE=1 prints ms spent in each section below to stderr, so a
// lane-gate shrink slice can target the sections that actually cost time instead of guessing. `mark()`
// is called once per section boundary (the `── … ──` comments below) in BOTH modes — same call sequence
// whether or not the flag is set — so profiling can never change what runs, only what prints. Zero cost
// when unset (`mark` short-circuits before touching `process.hrtime`).
const PROFILE = !!process.env.CHECK_STANDARDS_PROFILE;
const profileEntries = [];
let profileT = process.hrtime.bigint();
// #70b per-file result cache (see lib/standards-cache.mjs): ONLY per-file sections use it (6f, 6f-i-b); whole-repo
// rules never do. Off under CI or WE_STANDARDS_CACHE=0. Hit/miss counts go to the profile output.
const CACHE_ENTRIES = [fileURLToPath(import.meta.url), fileURLToPath(new URL('./check-standards-rules.mjs', import.meta.url))];
// #70c: git-grep sections also depend on the pattern constants + detectors in citation-check.mjs.
const GREP_CACHE_ENTRIES = [...CACHE_ENTRIES, fileURLToPath(new URL('./lib/citation-check.mjs', import.meta.url))];
let cacheKeysMemo = null;
const cacheKeys = () => (cacheKeysMemo ??= fileKeys(ROOT));
const cacheStatLines = [];
const mark = (label) => {
  if (!PROFILE) return;
  const now = process.hrtime.bigint();
  profileEntries.push([label, Number(now - profileT) / 1e6, process.memoryUsage().rss]);
  profileT = now;
};

// #4168 — `--files=` parsed HERE, before any section runs, so the per-file content scanners below (6f,
// 6f-i, 6f-i-b, 6f-ii, the 6f-ii-b anchor scan) can subset their own directory walk to just these files
// instead of the whole corpus. This is the SAME parse the bottom-of-file `--files` consumer already did
// (scripts/readiness/claimScope.mjs's `partitionLocal`) — hoisted, not duplicated: that block now reads
// `LOCAL_FILES_LIST` instead of re-deriving it, so the two can never drift on what `--files=` means.
//
// `SCOPE_TO_FILES` (the gate every scanner below actually checks) requires BOTH `--local` AND `--files`:
// `--files` alone (no `--local`) only narrows the BLOCKING set at the bottom while still classifying every
// OTHER file's findings as external notes (`partitionLocal(..., {local:false})`) — that needs the full
// scan to have run. `--local` alone (no `--files`) has no known file list to subset to. Only the combined
// `--local --files=<lane files>` this epic's replay proof (#4164) targets is safe to skip work under: in
// that mode EVERY finding on a file outside the list is demoted to a note regardless (`--local`'s own
// semantics, #4167's docblock above), so never computing it changes zero blocking outcomes — only less
// work to reach the same verdict. The default no-flag run, and CI's always-unscoped run, are untouched:
// `SCOPE_TO_FILES` is false whenever `--local` is absent, exactly like `LOCAL_MODE` itself.
const filesArgEarly = process.argv.find((a) => a.startsWith('--files='));
const LOCAL_FILES_LIST = filesArgEarly
  ? filesArgEarly.split('=').slice(1).join('=').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
  : null;
const LOCAL_FILES = LOCAL_FILES_LIST ? new Set(LOCAL_FILES_LIST) : null;
const SCOPE_TO_FILES = LOCAL_MODE && !!LOCAL_FILES;

// Drop-in replacement for `readdirSync(join(ROOT, dirRel)).filter(...)` at every per-file-content-scanner
// call site below: same result whenever `SCOPE_TO_FILES` is false (whole-repo/CI/default), but returns
// only the names that are BOTH in `dirRel` and in the caller's `--files` list when scoped. `dirRel` must
// carry its OWN trailing slash (`'backlog/'`, `'reports/'`, …) — the same convention every call site
// already uses to build its `file:` label (`\`${dirRel}${name}\``), so a set membership test against
// `LOCAL_FILES` (built from git-diff-style relative paths) never has to re-derive that convention.
const scopedReaddir = (dirRel, exts) => {
  const abs = join(ROOT, dirRel);
  if (!existsSync(abs)) return [];
  const names = readdirSync(abs).filter((n) => exts.some((e) => n.endsWith(e)));
  return SCOPE_TO_FILES ? names.filter((n) => EFFECTIVE_FILES.has(`${dirRel}${n}`)) : names;
};

// #4166 — LINKED FILES: the literal `--files=` list only names what the lane EDITED, but a reference/
// relational check (blockedBy, formerSlugs, citations) can be broken by that edit on a file the lane never
// itself touched (deleting/renaming an item another card still points at) — and today that finding is
// attributed to the OTHER file, outside `--files=`, so it is silently demoted to a note (a false green the
// unscoped merge-gate CI run still catches, never a merged regression, but a real gap at the lane gate).
// `linkedFilesFor` (moved to claimScope.mjs from the #4164 replay harness so both share ONE definition of
// "linked") finds files that REFERENCE a changed file's id via `git grep` — no maintained index, per the
// epic's own ratified direction; a shared per-origin/main cached index is only worth adding if `git grep`
// measures slow. It only reliably finds INCOMING references, though (a target doesn't necessarily mention
// the id that points AT it) — `outgoingBacklogTargets` closes that other direction for the one edge shape
// #4166 cares most about: a changed backlog item's own `blockedBy`/`parent` targets, resolved directly by
// filename convention (`<id>-<slug>.md`), no full frontmatter parse of the target needed. Computed only when
// `--files=` was passed at all; the site build, a bare `--local`, and the default no-flag run never touch
// git or backlog/ here.
// `--threads=1` (measured, #4166): git grep's default multi-threaded search pays a fixed ~2-2.5s SYS-time
// tax per invocation on this repo (thread spawn/teardown) for a real-time win of only a few tens of ms on a
// corpus this size — forcing single-threaded cuts a single call's sys time by ~10x with no real-time cost.
// A diff with several changed files issues several calls (one per id), so this is the difference between a
// barely-measurable overhead and one that dominates the whole scoped run (measured live: ~3.8s of a ~9.6s
// total on a 10-changed-file diff before this flag).
const gitGrep = (needle) => {
  try {
    return execFileSync('git', ['grep', '--threads=1', '-l', '-F', '-e', needle, '--', '.', ':!node_modules'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    }).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no match, or git is unavailable — never a gate failure
  }
};
const outgoingBacklogTargets = (changedFiles) => {
  const backlogDirAbs = join(ROOT, 'backlog');
  const backlogDirNames = existsSync(backlogDirAbs) ? readdirSync(backlogDirAbs) : [];
  const findFileForId = (id) => backlogDirNames.find((n) => n.startsWith(`${id}-`) || n === `${id}.md`);
  const targets = new Set();
  for (const relFile of changedFiles) {
    if (!relFile.startsWith('backlog/') || !relFile.endsWith('.md')) continue;
    const abs = join(ROOT, relFile);
    if (!existsSync(abs)) continue; // deleted/renamed — no own frontmatter left to resolve outgoing edges from
    let data;
    try { ({ data } = matter(readFileSync(abs, 'utf8'))); } catch { continue; }
    const ids = [];
    if (Array.isArray(data.blockedBy)) ids.push(...data.blockedBy.map(String));
    if (data.parent !== undefined && data.parent !== null) ids.push(String(data.parent));
    for (const id of ids) {
      const name = findFileForId(id);
      if (name) targets.add(`backlog/${name}`);
    }
  }
  return targets;
};
// #4166 — `git grep` measurably costs wall time per changed-file id (~0.3-1.3s each on this repo even at
// `--threads=1`; see `gitGrep`'s own doc). The false-green this linking closes is specifically a BACKLOG
// reference edge breaking on a file the lane didn't itself edit (blockedBy/formerSlugs/parent) — #4168
// already proved (0/50 missed) that the OTHER per-file content scanners are safe to scope to the literal
// `--files=` list alone, with NO linking at all. So only pay the git-grep cost when the diff actually
// touches a backlog/*.md file; a diff that touches none gets the full backlog-load saving with ZERO added
// overhead (`LINKED_FILES` stays `null`, `EFFECTIVE_FILES` falls back to plain `LOCAL_FILES` below).
const CHANGED_BACKLOG_FILES = LOCAL_FILES_LIST
  ? LOCAL_FILES_LIST.filter((f) => f.startsWith('backlog/') && f.endsWith('.md'))
  : [];
const LINKED_FILES = CHANGED_BACKLOG_FILES.length
  ? new Set([...linkedFilesFor(CHANGED_BACKLOG_FILES, { gitGrep }), ...outgoingBacklogTargets(CHANGED_BACKLOG_FILES)])
  : null;
// The widened scope every "is this file mine" test below should read instead of the literal `--files=` list
// (`scopedReaddir` above, the bottom-of-file classification) — monotonic (can only ADD files, never remove
// one), so it only ever promotes a demoted finding to blocking, never the reverse. Equal to `LOCAL_FILES`
// whenever no `--files=` was given at all (LINKED_FILES is then `null` too).
const EFFECTIVE_FILES = LOCAL_FILES ? new Set([...LOCAL_FILES, ...(LINKED_FILES || [])]) : null;
// #70d — under `--local --files=…` a whole-repo section whose declared inputs (we:scripts/lib/standards-sections.mjs)
// match no file in EFFECTIVE_FILES is skipped and recorded as `skipped (scoped: no input touched)`. Unscoped runs
// (CI, close-out, the default) never consult it: `shouldRun` is unconditionally true when SCOPE_TO_FILES is false.
const sectionGate = createSectionGate({ scoped: SCOPE_TO_FILES, touched: EFFECTIVE_FILES, root: ROOT });
// #70d — the two git-grep citation gates (6f-ii-c/d) attribute every finding to the CITING file, so under
// `--local --files=…` they grep only the lane's own existing files (a finding on any other file is demoted to a
// note anyway). Returns null when unscoped, so those gates keep their whole-tree (cached) grep unchanged.
const scopedGrepLines = (pattern, keep) => {
  if (!SCOPE_TO_FILES) return null;
  const targets = [...EFFECTIVE_FILES].filter((f) => keep(f) && existsSync(join(ROOT, f))).sort();
  if (!targets.length) return [];
  try {
    return execFileSync('git', ['grep', '--threads=1', '-nE', pattern, '--', ...targets.map((f) => `:(literal)${f}`)],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (e) {
    if (e?.status === 1) return []; // no match
    return null; // anything else → fall back to the unscoped path below, never a silent "clean"
  }
};
const skippedMark = (id) => { if (PROFILE) profileEntries.push([`  (${id} ${SKIP_REASON})`, 0, process.memoryUsage().rss]); };

// Each entry is { message, descriptor? }. The optional descriptor is the structured,
// agent-targetable form of the failure — populated for every class a fixer (deterministic
// or model) can act on. Calls with no descriptor are not yet agent-fixable.
const errors = [];
const warnings = [];
const err = (m, descriptor) => errors.push({ message: m, descriptor });
const warn = (m, descriptor) => warnings.push({ message: m, descriptor });

// #2876 — separate from the scoped-planes average; failures stay blocking.
const diffBranchCoverage = scanDiffBranchCoverage(ROOT);
for (const e of diffBranchCoverage.errors) err(e.message, e.descriptor);

mark("setup (imports + spec/backlog load)");
// ── Failure descriptors (#095 → fed to the auto-fix agent #196) ────────────────
// Every descriptor carries a `kind` (the failure class a fixer matches on) and `fix`: the routing
// call this item (#197) records for each class —
//   'reference' → mechanically fixable. The validator already knows the exact target value, so the
//                 deterministic reference fixer in scripts/autofix/engine.mjs derives the edit (no
//                 model, no key). Only `deprecated-status` qualifies today.
//   'model'     → content-generation. The intended value isn't mechanically derivable (a description
//                 to write, a missing field's value, the right entity for a broken ref), so it's
//                 deferred to the BYO-key model fixer (#196). Emitted now so that fixer gets a
//                 structured, targetable feed instead of scraping ANSI prose.
// `FILE` (spec data-file path per entity, for descriptor pointers), `dMissingField`, `dUnresolvedRef`
// and `dMissingDescription` are imported from ./check-standards-rules.mjs — the single definitions
// shared with the unit tests (#256). The status vocabularies + `checkStatus` live there too.

const readJson = (rel) => {
  const p = join(DATA, rel);
  if (!existsSync(p)) { err(`Missing data file: src/_data/${rel}`); return null; }
  try { return JSON.parse(readFileSync(p, 'utf8')); }
  catch (e) { err(`Invalid JSON in src/_data/${rel}: ${e.message}`); return null; }
};
const arr = (d) => (Array.isArray(d) ? d : []);

// The implementation lifecycle (`LIFECYCLE`/`STATUS_SYNONYMS`) and the `checkStatus` enum check live
// in ./check-standards-rules.mjs (shared with the entity validators + unit tests, #256). `checkStatus`
// is pure — it returns `{message, descriptor?}` entries — so compose it here for blocks/plugs:
const checkStatusInto = (kind, id, status) => {
  for (const e of checkStatus(kind, id, status)) err(e.message, e.descriptor);
};
// Research topics use a separate axis (open question vs answered), not the implementation lifecycle.
// `superseded` (#441 Fork 1) marks a topic whose canonical report was replaced by a newer dated one.
const RESEARCH_STATUSES = new Set(['open', 'resolved', 'draft', 'closed', 'superseded']);
// Global review-horizon fallback (#441 Fork 4): a topic without its own `reviewHorizon` is reviewed
// against this interval (ISO-8601 duration). Imported from the rules module — its single home, shared
// with the Eleventy freshness badge; staleness derivation is `deriveResearchFreshness` (#477, warn-only below).
const ISO_DURATION = /^P(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Backlog operational axis (BACKLOG_STATUSES) and the merged kind+sizing axis (BACKLOG_KINDS/FIB) are
// imported from ./check-standards-rules.mjs — the single definition shared with the backlog-rule unit
// tests (#251). See docs/agent/backlog-workflow.md → "Agile sizing".
const BLOCK_TYPES = new Set(['Store', 'Parser', 'Behavior', 'Directive', 'Component', 'Module']);

mark("Failure descriptors (#095 → fed to the auto-fix agent #196)");
// ── Load specs ───────────────────────────────────────────────────────────────
const blocks = arr(loadBlocks()); // per-block specs src/_data/blocks/<id>.json, assembled (#882)
const plugs = arr(loadDataRegistry('plugs')); // per-plug specs src/_data/plugs/<id>.json, assembled (#1157)
const semantics = arr(loadSemantics()); // per-term specs src/_data/semantics/<slug>.json, assembled (#1146)
const research = arr(loadResearch()); // per-topic specs src/_data/researchTopics/<id>.json, assembled (#1145)
const protocols = arr(loadProtocols()); // per-protocol specs src/_data/protocols/<id>.json, assembled (#1146)
const presets = arr(loadPresets()); // per-preset specs src/_data/assemblerPresets/<name>.json, assembled (#1146)
const designSystems = arr(loadDataRegistry('designSystems')); // per-entry src/_data/designSystems/<id>.json (#1157)
const projects = arr(loadDataRegistry('projects')); // per-project specs src/_data/projects/<id>.json (#1157)
const intents = arr(loadIntents()); // per-intent specs src/_data/intents/<id>.json, assembled (#1145)
const capabilities = arr(loadDataRegistry('capabilities')); // per-capability specs src/_data/capabilities/<id>.json (#1157)
const adapters = arr(loadAdapters()); // per-adapter specs src/_data/adapters/<id>.json + _groups.json, assembled (#1938)
const demos = arr(loadDemos()); // per-demo specs src/_data/demos/<id>.json, assembled (#1146)
const capabilityMatrix = readJson('capabilityMatrix.json') || {};
// Backlog feeds off backlog/*.md via the shared data-file loader (single source).
const loadBacklog = require(join(ROOT, 'src/_data/backlog.js'));
// #4166 — under `--local --files=`, load only the backlog cards this lane's diff can affect: its own
// changed backlog/*.md files, plus every file `EFFECTIVE_FILES` already resolved as linked (incoming
// references via git grep + a changed item's own outgoing blockedBy/parent targets). This is the "Load
// specs (backlog load)" cost this card targets — for the common diff that touches NO backlog file at all
// (and links to none), `backlogScopedFiles` is empty and the ~2.7s full parse of ~4.1k cards never runs.
// Every OTHER backlog-consuming section below (6d, ctaless, the dup/collapse aggregates, …) reads this SAME
// (possibly scoped) array — sound because their findings are either file-attributed (already demoted under
// `--local` whenever that file sits outside `EFFECTIVE_FILES`, exactly as before this change) or path-less/
// aggregate (already unconditionally demoted under `--local`, per `partitionLocal`'s own "path-less global
// → note iff --local"). Full soundness argument: src/_data/backlog.js's `loadBacklogScoped` docblock. The
// default no-flag run and a bare `--local` (no `--files=`) are untouched — `SCOPE_TO_FILES` is false.
const backlogScopedFiles = SCOPE_TO_FILES
  ? [...EFFECTIVE_FILES].filter((f) => f.startsWith('backlog/') && f.endsWith('.md')).map((f) => f.slice('backlog/'.length))
  : null;
const backlog = arr(
  SCOPE_TO_FILES
    ? loadBacklog.loadBacklogScoped(backlogScopedFiles)
    : (typeof loadBacklog === 'function' ? loadBacklog() : loadBacklog),
);

mark("Load specs");
// ── 1. Spec ↔ description coverage ────────────────────────────────────────────
const hasDesc = (folder, id) => existsSync(join(INC, folder, `${id}.njk`));
for (const b of blocks)
  if (b.id && !hasDesc('block-descriptions', b.id))
    err(`Block "${b.id}" has no src/_includes/block-descriptions/${b.id}.njk`,
      dMissingDescription('Block', b.id, `src/_includes/block-descriptions/${b.id}.njk`));
for (const p of plugs)
  if (p.id && !hasDesc('plug-descriptions', p.id))
    err(`Plug "${p.id}" has no src/_includes/plug-descriptions/${p.id}.njk`,
      dMissingDescription('Plug', p.id, `src/_includes/plug-descriptions/${p.id}.njk`));
for (const r of research)
  if (r.id && !hasDesc('research-descriptions', r.id))
    err(`Research topic "${r.id}" has no src/_includes/research-descriptions/${r.id}.njk`,
      dMissingDescription('Research', r.id, `src/_includes/research-descriptions/${r.id}.njk`));
// Adapters render via src/adapter-pages.njk, which `include`s adapter-descriptions/<id>.njk by id (NOT
// "ignore missing") — a new adapter without its partial crashes the WHOLE Eleventy build. The gate is
// otherwise blind to that njk render, so a missing partial would only surface as a build crash (#1388,
// hit by the #1374 graph plugs). Mirror the block/plug/research coverage so the failure shifts left to a
// gate error. The page paginates collections.flatAdapters = adapters.flatMap(c => c.items), so iterate
// the same flat item set (adapters is the assembled [ { id, items: [ { id, … } ] } ] nested-group array,
// per-adapter files src/_data/adapters/<id>.json since #1938).
for (const cat of adapters)
  for (const a of (Array.isArray(cat.items) ? cat.items : []))
    if (a.id && !hasDesc('adapter-descriptions', a.id))
      err(`Adapter "${a.id}" has no src/_includes/adapter-descriptions/${a.id}.njk (src/adapter-pages.njk includes it by id; a missing partial crashes the Eleventy build, #1388)`,
        dMissingDescription('Adapter', a.id, `src/_includes/adapter-descriptions/${a.id}.njk`));

mark("1. Spec ↔ description coverage");
// ── 2. Spec ↔ implementation ──────────────────────────────────────────────────
// Per #641 (block protocol/impl boundary, A/A/A): a WE block entry is a *protocol*,
// not impl. The impl lives in the canonical `@frontierui/blocks` package, named by
// `implementedBy` — NOT a WE-local file. So validate the *form* of the reference,
// not local existence (a contract may precede its impl — Fork 3-A, the 9 WE-only
// families migrate to FUI in #658). A red filesystem check here would re-encode the
// vendored-copy assumption #641 removed.
for (const b of blocks) {
  if (b.implementedBy && !/^@frontierui\/blocks\//.test(b.implementedBy))
    err(`Block "${b.id}" implementedBy must reference the canonical @frontierui/blocks impl: ${b.implementedBy}`,
      dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'implementedBy', b.implementedBy, 'contract-form'));
  if (b.status === 'active' && !b.implementedBy)
    warn(`Block "${b.id}" is status:active but has no implementedBy (@frontierui/blocks impl reference)`);
}

mark("2. Spec ↔ implementation");
// ── 3. Status / type enums ────────────────────────────────────────────────────
for (const b of blocks) {
  checkStatusInto('Block', b.id, b.status);
  if (b.type && !BLOCK_TYPES.has(b.type)) warn(`Block "${b.id}" has unusual type "${b.type}"`);
}
for (const p of plugs) checkStatusInto('Plug', p.id, p.status);

mark("3. Status / type enums");
// ── 3a. Portfolio project tier — the importance axis (#2088, codified #portfolio-project-tiering) ──
// Orthogonal to project `status` (which stays deliberately outside LIFECYCLE). Every project carries an
// enum-validated `tier` (core | contextual | exploratory) by the named-consumer evidence bar; every
// non-exploratory project additionally names its consumer via a non-empty `tierEvidence` one-liner.
for (const p of projects)
  for (const e of validateProjectTier(p.id, p.tier, p.tierEvidence)) err(e.message, e.descriptor);

// Derived advisory tier cross-check (#2135, demoted from #2088 Fork 3 (c)) — WARN-ONLY. Joins the
// DECLARED benchmarkCoverage.projectDomainDemand[] domain→project edge to the live stamped tier and
// nudges when an `exploratory` project's domain shows benchmark demand. Never owns the tier value.
{
  const projectTierById = new Map(projects.map((p) => [p.id, p.tier]));
  const coverage = readJson('benchmarkCoverage.json') || {};
  const { warnings: advWarnings } = advisoryTierCrossCheck(coverage.projectDomainDemand, projectTierById);
  for (const w of advWarnings) warn(w.message, w.descriptor);
}

mark("3a. Portfolio project tier — the importance axis (#2088, codified #portfolio-project-tiering)");
// ── 3b. composesBehaviors resolution (#936, Fork 2 of #933) ───────────────────
// A block's `traits[]` records the named behaviors it PROVIDES (`withSortableHeader`, …); the new
// `composesBehaviors[]` records the behaviors it CONSUMES. The de-facto behavior registry is the
// union of every provided `traits[].name` — each composesBehaviors entry must resolve to one, so a
// declared composition can't name a behavior that no block provides (the #933 "compose, don't
// hand-roll" signal). The legacy field name `composesTraits` is rejected — it collides with "The
// Map" (the trait-manifest concept, src/_data/traits.json) — authors must use `composesBehaviors`.
{
  const traitName = (t) => (typeof t === 'string' ? t : t && t.name);
  const providedBehaviors = new Set(
    blocks.flatMap((b) => (Array.isArray(b.traits) ? b.traits.map(traitName) : [])).filter(Boolean));
  for (const b of blocks) {
    if (b.composesTraits !== undefined)
      err(`Block "${b.id}" uses reserved field "composesTraits" — it collides with The Map (the trait manifest, src/_data/traits.json); use "composesBehaviors" (#936)`,
        dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'composesTraits', 'composesTraits', 'composesBehaviors'));
    if (b.composesBehaviors === undefined) continue;
    if (!Array.isArray(b.composesBehaviors)) {
      err(`Block "${b.id}" composesBehaviors must be an array of behavior names (or {name} objects)`,
        dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'composesBehaviors', String(b.composesBehaviors), 'array'));
      continue;
    }
    for (const entry of b.composesBehaviors) {
      const name = traitName(entry);
      if (!name)
        err(`Block "${b.id}" composesBehaviors entry has no name: ${JSON.stringify(entry).slice(0, 60)}`,
          dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'composesBehaviors', JSON.stringify(entry).slice(0, 40), 'trait manifest'));
      else if (!providedBehaviors.has(name))
        err(`Block "${b.id}" composesBehaviors "${name}" does not resolve to a provided trait (no block declares it in traits[]) — #936`,
          dUnresolvedRef('Block', b.id, blockSpecFile(b.id), 'composesBehaviors', name, 'trait manifest'));
    }
  }
}

for (const r of research)
  if (r.status && !RESEARCH_STATUSES.has(r.status)) warn(`Research topic "${r.id}" has unusual status "${r.status}"`);
// Research-freshness foundation schema (#441 / #476): validate the shape of the new freshness +
// revision-chain fields when present. Staleness derivation (#477) and the supersedes-as-new-report
// flow (#478) build on this — here we only enforce that the fields are well-formed and the
// supersedes/supersededBy pointers are bidirectional and resolve to known topic ids.
{
  const researchById = new Map(research.filter((r) => r.id).map((r) => [r.id, r]));
  const asIds = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  for (const r of research) {
    if (!r.id) continue;
    if (r.lastReviewed && !ISO_DATE.test(r.lastReviewed))
      err(`Research topic "${r.id}" lastReviewed must be an ISO date (YYYY-MM-DD), got "${r.lastReviewed}"`);
    if (r.reviewHorizon && !ISO_DURATION.test(r.reviewHorizon))
      err(`Research topic "${r.id}" reviewHorizon must be an ISO-8601 duration (e.g. ${RESEARCH_REVIEW_HORIZON_DEFAULT}), got "${r.reviewHorizon}"`);
    for (const target of asIds(r.supersedes)) {
      const t = researchById.get(target);
      if (!t) err(`Research topic "${r.id}" supersedes unknown topic "${target}"`);
      else if (!asIds(t.supersededBy).includes(r.id))
        warn(`Research topic "${r.id}" supersedes "${target}" but "${target}".supersededBy does not point back (bidirectional pointer expected, #441 Fork 1)`);
    }
    for (const target of asIds(r.supersededBy)) {
      const t = researchById.get(target);
      if (!t) err(`Research topic "${r.id}" supersededBy unknown topic "${target}"`);
      else if (!asIds(t.supersedes).includes(r.id))
        warn(`Research topic "${r.id}" supersededBy "${target}" but "${target}".supersedes does not point back (bidirectional pointer expected, #441 Fork 1)`);
    }
    if (asIds(r.supersededBy).length && r.status !== 'superseded')
      warn(`Research topic "${r.id}" has supersededBy but status is "${r.status}" (expected "superseded", #441 Fork 1)`);
    // Staleness derivation (#441 Fork 4 / #477): once past `lastReviewed + reviewHorizon` (or the
    // global P6M fallback) a topic is flagged for re-review. WARN-ONLY by ruling — never a CI error
    // (stale-while-shown: the topic stays published; this only nudges a maintainer to re-review).
    const fr = deriveResearchFreshness(r);
    if (fr.state === 'stale')
      warn(`Research topic "${r.id}" is stale — last reviewed ${fr.lastReviewed}, horizon ${fr.horizon} (due ${fr.dueDate}). Re-review and bump lastReviewed (warn-only, #477).`);
  }
}

mark("3b. composesBehaviors resolution (#936, Fork 2 of #933)");
// ── 4. Naming conventions (across all exports) ────────────────────────────────
const allExports = blocks.flatMap((b) => (Array.isArray(b.exports) ? b.exports.map((e) => [b.id, e]) : []));
for (const [id, name] of allExports) {
  if (/^use[A-Z]/.test(name))
    err(`Export "${name}" (block "${id}") uses reserved "use*" prefix — traits must be "with[Capability]"`);
  if (/Registry$/.test(name) && !/^Custom.+Registry$/.test(name))
    warn(`Export "${name}" (block "${id}") looks like a registry but isn't "Custom[Name]Registry"`);
}

mark("4. Naming conventions (across all exports)");
// ── 5. Semantics glossary hygiene ─────────────────────────────────────────────
const seenTerms = new Map();
for (const t of semantics) {
  if (!t.term || !t.definition) { err(`semantics.json entry missing term/definition: ${JSON.stringify(t).slice(0, 80)}`); continue; }
  const key = t.term.toLowerCase();
  if (seenTerms.has(key)) err(`Duplicate glossary term "${t.term}" in semantics.json`);
  seenTerms.set(key, true);
}

mark("5. Semantics glossary hygiene");
// ── 5a. Semantics glossary COVERAGE (#1371 slice B of #1327; scope ratified #1343) ───────────────
// The glossary is the project's ubiquitous vocabulary of CONCEPTS. The concept-bearing registries —
// intents + protocols + capabilities — should each have a matching glossary term; a block/plug earns
// a term only when it opts in via `isConcept: true` (the #1343 contested-name carve, consumed by the
// #1368 curation pass). WARN-only (matches the other coverage warnings) so partial coverage is a valid
// state and the gate stays green while A1 (#1369 intents) / A2 (#1370 protocols) backfill it.
{
  // Normalize a name/term to its concept key: drop a trailing standard-kind suffix word, lowercase.
  // Mirrors the #1327 audit join (term vs name, suffix-stripped) so "Action Intent" ↦ term "Action".
  const KIND_SUFFIX = /\s+(Intent|Protocol|Plug|Capability|Block)$/i;
  const conceptKey = (s) => String(s || '').replace(KIND_SUFFIX, '').trim().toLowerCase();
  const termSet = new Set(semantics.map((t) => conceptKey(t.term)).filter(Boolean));
  const hasTerm = (name) => { const k = conceptKey(name); return !!k && termSet.has(k); };

  // Wholesale-scope concept registries — every in-scope entry should carry a term.
  for (const [label, list, getName] of [
    ['intent', intents, (x) => x.name],
    ['protocol', protocols, (x) => x.name],
    ['capability', capabilities, (x) => x.label || x.name],
  ]) {
    for (const item of list) {
      const nm = getName(item);
      if (!nm) continue;
      if (!hasTerm(nm))
        warn(`Glossary coverage: ${label} "${item.id}" ("${nm}") has no matching semantics term — add src/_data/semantics/<slug>.json { term, definition, usage } (warn-level, #1327)`);
    }
  }

  // isConcept opt-in — a block/plug flagged `isConcept: true` MUST have a glossary term (#1343 / #1368).
  for (const [label, list] of [['block', blocks], ['plug', plugs]]) {
    for (const item of list) {
      if (item.isConcept !== true) continue;
      const nm = item.name || item.id;
      if (!hasTerm(nm))
        warn(`Glossary coverage: ${label} "${item.id}" ("${nm}") is flagged isConcept:true but has no matching semantics term — add one (#1343 isConcept opt-in)`);
    }
  }
}

mark("5a. Semantics glossary COVERAGE (#1371 slice B of #1327; scope ratified #1343)");
// ── 6. Unique ids per registry ────────────────────────────────────────────────
const dupCheck = (list, label) => {
  const seen = new Set();
  for (const x of list) {
    if (!x.id) continue;
    if (seen.has(x.id)) err(`Duplicate id "${x.id}" in ${label}`);
    seen.add(x.id);
  }
};
dupCheck(blocks, 'blocks.json');
dupCheck(plugs, 'plugs.json');
dupCheck(research, 'researchTopics.json');
dupCheck(protocols, 'protocols.json');

mark("6. Unique ids per registry");
// ── 6a-bis. Benchmark capability-presence join table (#352) ──────────────────
// Each row of benchmarkCapabilityPresence.json must reference a known capability + corpus source; a
// `verified` row should carry its deep doc URL. Pure rule, composed over the two sibling registries.
{
  const presence = readJson('benchmarkCapabilityPresence.json');
  if (presence) {
    const benchCaps = readJson('benchmarkCapabilities.json') || { capabilities: [] };
    const benchCorpus = readJson('benchmarkCorpus.json') || { sources: [] };
    const { errors: pe, warnings: pw } = validateCapabilityPresence(presence, {
      capabilityIds: new Set((benchCaps.capabilities || []).map((c) => c.id)),
      sourceIds: new Set((benchCorpus.sources || []).map((s) => s.id)),
      provenanceKinds: (presence.provenanceKinds || []).map((k) => k.id),
    });
    for (const e of pe) err(e.message);
    for (const w of pw) warn(w.message);
  }
}

mark("6a-bis. Benchmark capability-presence join table (#352)");
// ── 6a-ter. Reference-retirement convention (#584) ───────────────────────────
// One uniform retirement field-set — the #546 death triplet + the #192 supersededBy pointer — checked
// by a single shared helper across every structured reference home. The markers are opt-in
// (most-permissive), so a home with no retired/superseded entry passes vacuously. The supersededBy
// pointer resolves only where the home has an id space (the corpus). researchTopics.json keeps its own
// bidirectional supersedes/supersededBy rule above (§3) — its pointer space is topic ids, not refs.
// See docs/agent/reference-retirement.md.
{
  const benchCorpus = readJson('benchmarkCorpus.json') || { sources: [] };
  const corpusSourceIds = new Set((benchCorpus.sources || []).map((s) => s.id));
  const inCorpus = (t) => corpusSourceIds.has(t);
  const runShape = (entry, label, opts) => {
    const { errors: re, warnings: rw } = validateRetirementShape(entry, { label, ...opts });
    for (const e of re) err(e.message);
    for (const w of rw) warn(w.message);
  };
  // 1) Corpus sources — the seed home (#546); supersededBy resolves to a sibling source id.
  for (const s of benchCorpus.sources || [])
    runShape(s, `benchmarkCorpus source "${s.id}"`, { resolveSupersededBy: inCorpus });
  // 2) references links — per-entry specs src/_data/references/<slug>.json, assembled (#1157).
  for (const group of loadDataRegistry('references') || [])
    for (const link of group.links || [])
      runShape(link, `references.json link "${link.title || link.url}"`);
  // 3) designSystemResearch refs on blocks + intents.
  for (const [home, list] of [['block', blocks], ['intent', intents]])
    for (const item of list || [])
      for (const dsr of item.designSystemResearch || [])
        runShape(dsr, `${home} "${item.id}" designSystemResearch "${dsr.system || dsr.reference || ''}"`);
  // 4) capability-presence rows — supersededBy (a moved source) resolves to a corpus source id.
  const presenceRows = readJson('benchmarkCapabilityPresence.json');
  if (presenceRows)
    for (const row of presenceRows.rows || [])
      runShape(row, `capability-presence (${row.capabilityId}, ${row.sourceId})`, { resolveSupersededBy: inCorpus });
}

mark("6a-ter. Reference-retirement convention (#584)");
// ── 6b. Protocols (first-class entity, owned by a Project) ───────────────────
// Per-protocol field + reference rules (incl. the project-partial anchor probe) are the pure
// `validateProtocol` (unit-tested in scripts/__tests__, #256); the script composes it over the live
// registry. The anchor probe's file read is injected via `readProjectPartial`.
const projectById = new Map(projects.map((p) => [p.id, p]));
const intentById = new Map(intents.map((i) => [i.id, i]));
const readProjectPartial = (projectId) => {
  const partial = join(INC, `project-${projectId}.njk`);
  return existsSync(partial) ? readFileSync(partial, 'utf8') : null;
};
const protocolCtx = { projectById, intentById, readProjectPartial };
for (const proto of protocols) {
  const { errors: pe, warnings: pw } = validateProtocol(proto, protocolCtx);
  for (const e of pe) err(e.message, e.descriptor);
  for (const w of pw) warn(w.message, w.descriptor);
}

mark("6b. Protocols (first-class entity, owned by a Project)");
// ── 6b-bis. Assembler presets (#646/#667, registry-item recipes, surfaced via /presets/) ──
// Per-preset field/status/reference rules + the non-empty files[] recipe guard are the pure
// `validatePreset` (mirrors validateProtocol); the script composes it over the live registry.
const blockIds = new Set(blocks.map((b) => b.id));
const presetCtx = { projectById, blockIds, intentById };
for (const preset of presets) {
  const { errors: pe2, warnings: pw2 } = validatePreset(preset, presetCtx);
  for (const e of pe2) err(e.message, e.descriptor);
  for (const w of pw2) warn(w.message, w.descriptor);
}
dupCheck(presets.map((p) => ({ id: p.name })), 'assemblerPresets.json');

mark("6b-bis. Assembler presets (#646/#667, registry-item recipes, surfaced via /presets/)");
// ── 6b-ter. Design systems (#747 Fork-3-A / #871, theme+intents bundles, surfaced via /design-systems/) ──
// A thin `designSystems.json` rendering index pointing at manifests of shape
// `{ extends, themeTokens (DTCG ref), intentDefaults?, traitDefaults? }`. The per-entry field/status/
// reference rules + the manifest-shape checks (themeTokens resolves, extends resolves, optional fields)
// are the pure `validateDesignSystem`; the script injects the manifest reads (resolved from repo root,
// the DTCG ref resolved relative to its own manifest's dir).
const readManifest = (rel) => {
  const p = join(ROOT, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};
const tokenRefResolves = (manifestRel, tokenRef) =>
  existsSync(join(dirname(join(ROOT, manifestRel)), tokenRef));
const designSystemIds = new Set(designSystems.map((d) => d.id).filter(Boolean));
const designSystemCtx = { projectById, intentById, designSystemIds, readManifest, tokenRefResolves };
for (const ds of designSystems) {
  const { errors: de, warnings: dw } = validateDesignSystem(ds, designSystemCtx);
  for (const e of de) err(e.message, e.descriptor);
  for (const w of dw) warn(w.message, w.descriptor);
}
dupCheck(designSystems, 'designSystems.json');

dupCheck(intents, 'intents.json');

mark("6b-ter. Design systems (#747 Fork-3-A / #871, theme+intents bundles, surfaced via /design-systems/)");
// ── 6c. Intents (UX preference vocabulary, surfaced via /intents/ catalog) ───
// Per-intent field/status/dimensions rules + the requiresCapabilities → capabilities.json resolution
// are the pure `validateIntent` (#256). `capabilityIds` is built below (§6c-bis) before this runs.

mark("6c. Intents (UX preference vocabulary, surfaced via /intents/ catalog)");
// ── 6c-bis. Capability vocabulary + static build-matrix (#204, foundation of epic #203) ──
// Capability ids borrow Baseline / `web-features` keys (D3′); the matrix (the default provider impl,
// D4′) tiers each (impl × capability) at one of three states. Guard the vocabulary, the
// completeness of the grid, and that every cross-reference (matrix → vocab, intent → vocab) resolves
// — so the resolver (#205), the /capabilities/ catalog, and the edge URL key can never drift apart.
// The per-capability vocab rules, the registered-adapter table, and the complete impl × capability
// build-matrix invariants are the pure `validateCapability` / `validateCapabilityMatrix` (#256). The
// matrix's gnarliest logic — grid completeness + the single-native-substrate tiebreak — lives there
// with fixtures. `capabilityIds` (built here) is the shared known-capability id set the matrix and
// intent validators both resolve against.
dupCheck(capabilities, 'capabilities.json');
for (const cap of capabilities) {
  const { errors: ce } = validateCapability(cap);
  for (const e of ce) err(e.message, e.descriptor);
}
const capabilityIds = new Set(capabilities.map((c) => c.id).filter(Boolean));

const matrixImpls = arr(capabilityMatrix.impls);
{
  const { errors: me, warnings: mw } = validateCapabilityMatrix(matrixImpls, {
    capabilityIds,
    hasAdapterDesc: (id) => hasDesc('capability-adapter-descriptions', id),
  });
  for (const e of me) err(e.message, e.descriptor);
  for (const w of mw) warn(w.message, w.descriptor);
}

// Intents (§6c) compose `validateIntent` here, now that `capabilityIds` exists — it covers the field/
// status/dimensions rules AND the requiresCapabilities → capabilities.json resolution in one pass.
const intentCtx = { capabilityIds, intentById };
for (const intent of intents) {
  const { errors: ie, warnings: iw } = validateIntent(intent, intentCtx);
  for (const e of ie) err(e.message, e.descriptor);
  for (const w of iw) warn(w.message, w.descriptor);
}

dupCheck(backlog, 'backlog/');

// Backlog filenames are `NNN-slug.md`: NNN (item.num) is the stable unique id used in the URL.
// Enforce the prefix and that numbers don't collide, so authoring a new item can't silently reuse
// or drop an id. See docs/agent/backlog-workflow.md → "Authoring an item".
for (const item of backlog) {
  if (!item.num) err(`Backlog item "${item.id}" is missing the NNN- id prefix — rename to "<NNN>-${item.id}.md"`);
}
// #4167 — every finding in this block is path-less (dup ids / stranded hashes / hand-numbered items — no
// single owning file, RELATIONAL across the whole backlog set), so `--local` always demotes it to a note
// (`partitionLocal`). Skip the whole block — including the `git ls-tree`/`git log` calls below, real
// subprocess spawns — rather than compute it and throw it away; identical verdict under `--local`, less work.
if (!LOCAL_MODE) {
  // #2248 — the duplicate-NNN tripwire, now a pure unit-tested detector (was inline). A collision silently drops
  // one item from the loader's last-wins byNum Map, so it must ERROR (caught on the second colliding PR's CI).
  for (const msg of duplicateBacklogNums(backlog)) err(msg);
  // One item minted twice — same `bornAs`, two NNNs. Neither of the checks above can see it: the numbers
  // differ (so it is not a duplicate NNN) and both filenames are numeric (so no hash is stranded).
  {
    const born = duplicateBornAs(backlog);
    for (const msg of born.errors) err(msg);
    for (const msg of born.warnings) warn(msg);
  }
  // #2319 — hash-on-main invariant: a backlog file on origin/main with a non-numeric leading id means a land route
  // bypassed JIT numbering (#2288) and stranded a hash. Read the MAIN tree (not the working tree) so in-lane
  // pre-land hashes on a lane/* branch don't false-trip. Fail-SOFT: origin/main unresolvable (fresh/offline
  // clone) → skip, never wedge the gate on a git hiccup.
  try {
    const mainBacklog = execFileSync('git', ['ls-tree', '-r', '--name-only', 'origin/main', '--', 'backlog/'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
    // #2956 — a hash-led file touched within the drain's own JIT-numbering window (see strandedHashesOnMain's
    // doc comment) is downgraded to a warning rather than a hard error. `commitTimeFor` is a live, local-only
    // git call (no fetch) per candidate path — cheap, since there are normally zero or one of these.
    //
    // `--first-parent` is NOT optional (independent review, #2956 r1). The drain lands with a real `--no-ff`
    // merge (`pr-land.mjs`'s default `--method=merge`), and that merge commit's tree for a path added purely
    // in the lane is byte-identical to the lane parent's — a merge git log calls TREESAME. Without
    // `--first-parent`, git's pathspec history simplification walks PAST the merge and returns the LANE
    // commit's own timestamp (push → PR → CI → queue latency baked in — measured 947-4605s on this repo's
    // real history), not the merge's. `--first-parent` pins the walk to mainline, so the merge commit's own
    // time comes back — verified against this repo's real #2954 land: merge `269a4f1a` at 09:53:14 vs. the
    // lane commit's own 09:48:06 that a plain `git log` returns for the same path.
    const commitTimeFor = (path) => {
      try {
        const raw = execFileSync('git', ['log', '-1', '--first-parent', '--format=%ct', 'origin/main', '--', path], { cwd: ROOT, encoding: 'utf8' }).trim();
        const epoch = Number.parseInt(raw, 10);
        return Number.isFinite(epoch) ? epoch : null;
      } catch { return null; } // unknown → strandedHashesOnMain treats as NOT in-flight (fails toward erroring)
    };
    const stranded = strandedHashesOnMain(mainBacklog, { commitTimeFor, inLane: isLaneLocus(resolveReal(ROOT), sep) || isPullRequestCiRun() });
    for (const msg of stranded.errors) err(msg);
    for (const msg of stranded.warnings) warn(msg);
    // #2548 — hand-numbered-new-item gate: a working-tree item with a hand-picked NNN not yet on origin/main.
    // Guarded by WE_SKIP_HAND_NUMBERED_GATE (same family as WE_MERGE_BREAK_GLASS/STALE_LANE_OK/LANE_CLOBBER_OK)
    // because pr-land.mjs's runHeal() self-check runs on a locally-renumbered, not-yet-pushed tree that this
    // gate cannot distinguish from a real mistake — the heal IS the sanctioned numbering path.
    if (!process.env.WE_SKIP_HAND_NUMBERED_GATE) {
      for (const msg of handNumberedNewItems(backlog, mainBacklog)) err(msg);
    }
  } catch { /* origin/main not resolvable here — the drain's post-land assert still guards the land path */ }
}
// Every item's num — for `blockedBy`/parent resolution below (the dup check above owns collision reporting).
const seenNums = new Set(backlog.map((i) => i.num).filter(Boolean));

// graduatedTo value resolution (#247): the kind → {registry id-set, source file} table. A graduatedTo
// written in the compact `kind:slug` ref form is resolved against the matching registry, so a typo'd
// kind (`intnet:droplist`) or a stale slug is an ERROR — not silently accepted like a correct one.
// #614 tightened the rest: the field must LEAD with a resolvable entity reference (`none`, `kind:slug`,
// a repo path, or a bare registry id) so entity-graph joins + the G3 lineage walk can read it; pure prose
// where the entity is buried is non-canonical and surfaced as one aggregated nudge below (not per-item).
// Adapters live nested under the assembled `items[]` (per-adapter files since #1938; `adapters.json#<id>`
// stays a virtual graduatedTo anchor). (Table + rule body live in check-standards-rules.mjs
// so they're unit-tested with fixtures — #251.)
const graduatedKinds = buildGraduatedKinds({ blocks, intents, protocols, projects, plugs, capabilityIds, adapters, demos });

mark("6c-bis. Capability vocabulary + static build-matrix (#204, foundation of epic #203)");
// ── 6d. Backlog (single source of truth for ideas/issues/reviews/decisions) ──
// Feeds off backlog/*.md (frontmatter = fields, body = the per-item page). The per-item field +
// outward-reference rules are the pure `validateBacklogItem` (unit-tested in scripts/__tests__);
// the script composes it here over the live registry, then layers the cross-item graph checks
// (dup nums, blockedBy DAG, double-count) below.
const backlogCtx = {
  projectById,
  graduatedKinds,
  knownNums: new Set(backlog.map((i) => i.num).filter(Boolean)), // every item's num — for parent resolution
  reportExists: (rel) => existsSync(join(ROOT, rel)),
  // num→kind / num→parent maps (feature-tier FLAT invariant, #2691/#2998) — the same shape the
  // parent-deadlock guard + epic↔child coherence block below build separately; kept here too so
  // `validateBacklogItem` can walk a feature's ancestor chain purely from `ctx`.
  kindByNum: new Map(backlog.map((i) => [i.num, i.kind])),
  parentByNum: new Map(backlog.filter((i) => i.parent !== undefined).map((i) => [i.num, String(i.parent)])),
};
for (const item of backlog) {
  const { errors: itemErrors, warnings: itemWarnings } = validateBacklogItem(item, backlogCtx);
  for (const e of itemErrors) err(e.message, e.descriptor);
  for (const w of itemWarnings) warn(w.message, w.descriptor);
  // Polyglot-widening start-gate (#2089 Fork 2(a) / #forward-target-start-gate, enforcement #2131):
  // a `polyglot-widening`-tagged item must carry the evidence edge or a carve-out. Frontmatter-only.
  const { errors: pgErrors, warnings: pgWarnings } = validatePolyglotWideningGate(item);
  for (const m of pgErrors) err(m);
  for (const m of pgWarnings) warn(m);
}
// #1247 — classification-axis loud-fail. If the merged `kind` axis is unpopulated for the whole
// collection (the #487 near-miss: consumers ahead of the producer → `kind` undefined everywhere), all
// three Prioritisation pools collapse to zero at once while the board still renders a silent empty
// tab. Catch that observable signature (open items exist but {batchable, tierB, sliceable} all zero) as
// a hard error rather than a quiet zero board — the during-migration window #487's after-cutover
// leftover-field backstop does not cover.
const collapse = detectClassificationCollapse(backlog);
if (collapse)
  err(`Backlog classification axis is unpopulated — ${collapse.openCount} open item(s) but 0 batchable / 0 Tier-B decision / 0 sliceable epic (the Prioritisation board would render a silent all-zero tab). ${collapse.kindlessOpen} open item(s) have no resolvable \`kind\`. This is the #487-class collapse: a consumer reading \`item.kind\`/\`item.tier\`/\`item.batchable\` ahead of the loader populating it, or a break in the batchable/tier derivation. Fix the producer (src/_data/backlog.js) before the board ships empty.`);

// #614 — aggregated non-canonical graduatedTo nudge. Per-item would flood (≈90 resolved items still
// carry narrative); one summary line points at the normalizer + the tracking item instead.
const nonCanonGrad = backlog
  .filter((it) => it.status === 'resolved' && typeof it.graduatedTo === 'string' && !isCanonicalGraduated(it.graduatedTo, graduatedKinds))
  .map((it) => `#${it.num ?? it.id}`);
if (nonCanonGrad.length)
  warn(`${nonCanonGrad.length} resolved items have a non-canonical graduatedTo (prose/narrative instead of a leading entity ref) — run \`npm run normalize:graduated\` to auto-fix the safe ones; bulk narrative→body cleanup tracked in #619. Items: ${nonCanonGrad.slice(0, 10).join(', ')}${nonCanonGrad.length > 10 ? `, …+${nonCanonGrad.length - 10}` : ''}`);

// #608 — D3-readiness surfacing (forward conformance gate). The loader demotes an open build out of
// Tier A when its `relatedProject` is a `concept` project with no shipped surface ("the standard must
// exist first") — these items are NOT batchable even with a clean frontmatter. check:standards never
// gated on this (it gates mechanics); surface it as one aggregate nudge so the forward gate is visible
// in the standing /check, alongside the deterministic `npm run check:health` (decision-governance + ref
// drift) and the judgment pre-flight documented in backlog-workflow.md → "principle-conformance pre-flight".
const projectPending = backlog.filter((it) => it.projectPending).map((it) => `#${it.num ?? it.id} (${it.relatedProject})`);
if (projectPending.length)
  warn(`${projectPending.length} open build(s) held by D3-readiness — relatedProject is a \`concept\` project with no shipped surface, so the standard must exist first (loader demotes them out of Tier A; not a \`blockedBy\` edge). Either ship/graduate the project or re-home the item. Items: ${projectPending.join(', ')}`);

// #1137 — HUMAN-GATE shape + surfacing. A `humanGate` (a residual only a person can clear) demotes an
// open item out of Tier A like project-pending. Validate the shape (must be `{ kind, what }`, kind in the
// known set) so a typo doesn't silently mis-render, and surface the held set as one aggregate nudge — the
// human-action analogue of the D3 nudge above, so the standing /check shows what's parked on a person.
const { HUMAN_GATE_KINDS } = require(join(ROOT, 'src/_data/backlog.js'));
const humanGated = [];
for (const it of backlog) {
  if (!it.humanGate) continue;
  const ref = `#${it.num ?? it.id}`;
  const g = it.humanGate;
  if (typeof g !== 'object' || Array.isArray(g))
    err(`Backlog item "${it.id}" has a malformed \`humanGate\` — it must be a mapping \`{ kind, what }\` (kind ∈ ${[...HUMAN_GATE_KINDS].join('|')}; what = the one-line human action).`);
  else {
    if (!HUMAN_GATE_KINDS.has(g.kind))
      err(`Backlog item "${it.id}" has \`humanGate.kind: ${g.kind ?? '(missing)'}\` — must be one of ${[...HUMAN_GATE_KINDS].join('|')}.`);
    if (!g.what || typeof g.what !== 'string')
      err(`Backlog item "${it.id}" has a \`humanGate\` with no \`what\` — record the one-line human action (a runbook pointer / the feedback asked for) so the holder knows what to do.`);
  }
  // A human-gate only makes sense on an OPEN, otherwise-agent-ready item; on a resolved/active one it's stale.
  if (it.status !== 'open') warn(`Backlog item "${it.id}" carries a \`humanGate\` but status is \`${it.status}\` — clear the gate when the work is claimed/done (the gate holds an OPEN item out of Tier A).`);
  humanGated.push(`${ref} (${g && g.kind ? g.kind : '?'})`);
}
if (humanGated.length)
  warn(`${humanGated.length} open item(s) held by a HUMAN GATE — the only residual is a human-only action (credentialed deploy / agent-training feedback / setup / review), not a \`blockedBy\` edge, so the loader demotes them out of Tier A and the selector lists them under "Held — awaiting a human action". Do the action, then remove \`humanGate\`. Items: ${humanGated.join(', ')}`);

// #1267 — FRONT-A native-first conformance metric (platform-standards watch #1257). Count the tracked
// native equivalents that a WE standard has not yet repointed to (native-first, #031), so the next watch
// run is quantitative. A nudge, not an error: the registrations are tracked open work (#1261-#1265, #291).
try {
  const watch = JSON.parse(readFileSync(join(ROOT, 'src/_data/nativeFirstWatch.json'), 'utf8'));
  const m = computeNativeFirstConformance(watch);
  if (m.pending > 0)
    warn(`Front-A native-first conformance (platform-standards watch #1257): ${m.registered}/${m.total} tracked native equivalents are registered as their standard's resolver; ${m.pending} still pending — ${m.pendingList.join(', ')}. Each lands when its registration item flips \`registered: true\` in src/_data/nativeFirstWatch.json.`);
} catch { /* ledger missing/malformed → skip the metric (degrade, don't crash the gate) */ }

// #1586 — FRONT-A design-knowledge conformance metric (design-knowledge intake program #1585). Count the
// admitted authoritative sources not yet distilled into the codified #1034 design-critique rubric (#1587
// carries the provenance), so the next watch run is quantitative. A nudge, not an error: distillation is
// tracked open work (#1589, blockedBy the #1588 admission/credibility-weight decision).
try {
  const dkWatch = JSON.parse(readFileSync(join(ROOT, 'src/_data/designKnowledgeWatch.json'), 'utf8'));
  const dk = computeDesignKnowledgeConformance(dkWatch);
  if (dk.pending > 0)
    warn(`Front-A design-knowledge conformance (design-knowledge intake program #1585): ${dk.distilled}/${dk.total} admitted sources are distilled into the #1034 design-critique rubric; ${dk.pending} still pending — ${dk.pendingList.join(', ')}. Each lands when its distillation item fills \`distilledInto\` (the rubric axis/version) in src/_data/designKnowledgeWatch.json.`);
} catch { /* ledger missing/malformed → skip the metric (degrade, don't crash the gate) */ }

// #1275 — CTA INVARIANT (hard gate). Every OPEN item MUST carry a call-to-action: a pill on the
// Prioritisation table telling whoever picks it up what to do next, or a passive reason it's parked.
// The loader derives `hasCta` as the exact union of every renderable pill (tier badge / batch / slice /
// split / stop-the-world / human-gate / blocked-by / project-pending); if it's false the item would
// render a bare tier badge with no next step — the dead end #1004 surfaced (a project-pending epic whose
// only signal was "project pending", with no "slice me" cue). This makes that state IMPOSSIBLE to ship:
// every not-ready item must resolve to one of the known next-actions. To fix a flagged item, give it the
// state that earns a pill — a `blockedBy` edge (→ blocked), unsliced-epic shape (→ slice), `size > 8`
// story (→ split), a `relatedProject` to graduate (→ project-pending), or a `humanGate` (→ human action).
const ctaless = backlog
  .filter((it) => it.status === 'open' && !it.hasCta)
  .map((it) => `#${it.num ?? it.id} (${it.kind})`);
if (ctaless.length)
  err(`${ctaless.length} OPEN item(s) have NO call-to-action — they would render a bare tier badge with no next step (the #1004 dead-end class). Every not-ready item must resolve to a known next-action: build (Tier A) / ratify (decision) / slice (epic) / split (story>8) / unblock (blockedBy) / graduate the project (relatedProject) / clear a human gate. Fix each item's state so a pill renders. Items: ${ctaless.join(', ')}`);

mark("6d. Backlog (single source of truth for ideas/issues/reviews/decisions)");
// ── 6d-bis. Per-item RENDERING lints (#290 raw-HTML · #441 buried-fork · mis-flagged-batchable · #845 ──
// bad-body-links) — the structural/rendering checks that operate on ONE item's body, consolidated into the
// shared `lintBacklogItemRendering` (#845) so the whole-repo gate and the scoped `check:standards --item NNN`
// validator emit the SAME findings. One raw-body read per item feeds all four (was four separate passes).
// The frontmatter unquoted-colon scan stays its own file-driven loop below (a malformed-YAML item is
// dropped by the loader, so it isn't in `backlog` at all — it must be caught by scanning files directly).
// #3637 — read the POC-branch registry ONCE for the whole loop, not per item.
const pocRegistry = readPocRegistry();
const knownBacklogIds = buildBacklogResolvableIds(backlog);
for (const item of backlog) {
  if (!item.id) continue;
  const p = join(ROOT, 'backlog', `${item.id}.md`);
  if (!existsSync(p)) continue;
  const body = readFileSync(p, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
  const { errors: itemErr, warnings: itemWarn } = lintBacklogItemRendering({
    item, body, pocRegistry, knownBacklogIds, fileExists: (rel) => existsSync(join(ROOT, rel)),
  });
  for (const m of itemErr) err(m);
  for (const m of itemWarn) warn(m);
}

mark("6d-bis. Per-item RENDERING lints (#290 raw-HTML · #441 buried-fork · mis-flagged-batchable · #845");
// ── 6d-quinquies. Unquoted-colon scalar in frontmatter (#453) ──
// Scan the RAW backlog/*.md files, NOT the loader output — the loader (#430) already skips an item
// whose frontmatter is malformed YAML and only warns, so the broken item is absent from `backlog`
// here. An unquoted plain scalar embedding `: ` (e.g. `graduatedTo: a/b.json: foo`) is the recurring
// trigger; YAML reads it as a nested mapping and the parse dies, silently dropping the item from the
// board. Error (not warn): a vanished backlog item escapes every other check, so the gate must catch
// the typo at author time and prompt the quote-fix.
// #70d — per-file (judges one file's own frontmatter), so `scopedReaddir` narrows it to the lane's own files
// under `--local --files=…` exactly as #4168 did for 6f; unchanged (every file) otherwise.
for (const file of scopedReaddir('backlog/', ['.md'])) {
  const raw = readFileSync(join(ROOT, 'backlog', file), 'utf8');
  const { colonHits: hits, parseReason } = describeUnparseableFrontmatter(raw);
  // Non-colon parse failure (unclosed quote, tab indent, bad flow collection…) — the colon scan found nothing
  // to name, but the loader still SKIPS the item (#4451).
  if (!hits.length && parseReason) {
    err(`Backlog item "${file.replace(/\.md$/, '')}" has unparseable frontmatter — ${parseReason}. ` +
      `The loader silently SKIPS the whole item, so no other rule ever sees it. Fix the YAML.`);
  }
  for (const h of hits) {
    err(`Backlog item "${file.replace(/\.md$/, '')}" has an unquoted colon in frontmatter — ` +
      `\`${h.key}: ${h.value}\` (line ${h.line}). YAML reads the embedded \`: \` as a nested mapping ` +
      `and the loader silently SKIPS the whole item. Quote the value: \`${h.key}: "${h.value}"\`.`);
  }
}

mark("6d-quinquies. Unquoted-colon scalar in frontmatter (#453)");
// ── 6d-sexies. Optional `scope:` predicted touch-set (#x53zzf9) ──
// `scope: ["we:src/x/", "we:docs/y/"]` is the item's PREDICTED file-scope (REPO-QUALIFIED path prefixes) a
// probe agent writes once so the deterministic conveyor dispatcher (scripts/readiness/dispatch-plan.mjs) can
// hold overlapping items apart by script. Optional — but WHEN present it must be an array of strings (the shape
// the dispatcher's overlap check reads), and every entry must carry a `<repo>:` locus prefix. The loader
// NORMALIZES a wrong type to `undefined`, which would hide the author error, so this reads the RAW frontmatter
// (like the unquoted-colon scan above) to catch a bad type/shape at author time. Mirrors the blockedBy shape
// rule below.
//
// WHY repo-qualified (#883/#2613): a scope entry is matched against observed `<repo>:<path>` files by the
// scope-lease engine (readiness/scope-lease.mjs `splitRepo`/`coversFile`), which splits on the FIRST colon and
// requires the repo halves to be equal. A BARE entry (`src/…`, no `<repo>:`) splits to repo `null`, which never
// equals an observed `we:`-qualified file — so the lane's overlap is SILENTLY never detected and two
// overlapping lanes could both launch (the exact hazard the conveyor prevents). A bare ref is ALSO rejected by
// the write-time locus-prefix hook (#883). Hence a bare entry is an error here too.
{
  const matterFm = require('gray-matter');
  // Recognize a `<repo>:` locus prefix — the SAME key set as check-standards-rules.mjs `LOCUS_MARKER_RE`
  // (we/fui/plateau + full names) and the #883 locus-prefix convention, anchored to the START of the entry.
  const SCOPE_REPO_PREFIX_RE = /^(?:we|fui|plateau|webeverything|frontierui|plateau-app):/;
  // The tracked-path index behind the §6d-septies unresolved-path WARN below (#3337). Built ONCE for the
  // whole loop (the pure rule takes it as an argument — the fs read stays here, the logic stays in
  // check-standards-rules.mjs). A failed `git ls-files` yields an empty index, which the rule reads as
  // "not checkable" and stays silent on — never as "nothing resolves".
  let trackedIndex = buildTrackedPathIndex([]);
  try {
    trackedIndex = buildTrackedPathIndex(
      execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0').filter(Boolean));
  } catch { /* non-git environment — the scope-path WARN below is simply not emitted */ }
  // Use the lane gate's merge-base + staged/unstaged + untracked selection. Linked
  // cards are not edits: only the literal diff can promote legacy scope debt to errors.
  const scopeChanges = localChangedSet({ runGit: (args) => execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }) });
  if (!scopeChanges) throw new Error('Cannot enforce backlog scope guards: unable to read the diff against origin/main. Fetch the base history and retry.');
  const changedScopeCards = new Set(scopeChanges.changedFiles.filter((f) =>
    f.startsWith('backlog/') && f.endsWith('.md') && !scopeChanges.deletedFiles.includes(f)
    && (!LOCAL_FILES || LOCAL_FILES.has(f))));
  for (const file of readdirSync(join(ROOT, 'backlog')).filter((f) => f.endsWith('.md'))) {
    let raw, body = '';
    try { const fm = matterFm(readFileSync(join(ROOT, 'backlog', file), 'utf8')); raw = fm.data; body = fm.content; }
    catch { continue; } // a malformed-YAML item is already reported by the frontmatter-parse scan above
    const id = file.replace(/\.md$/, '');
    // #4448 guard 3 — validate the RAW field here (the loader drops unknown/wrong-typed fields and would hide it).
    const selfNum = (/^(\d+)-/.exec(id) || [])[1];
    for (const msg of deferredBlockedByFindings(raw, seenNums, selfNum)) err(`Backlog item "${id}" ${msg}`);
    const scope = raw?.scope;
    if (scope === undefined) continue;
    if (!Array.isArray(scope)) {
      err(`Backlog item "${id}" scope must be an array of repo-qualified path prefixes (e.g. ["we:src/backlog-view/", "we:docs/agent/"])`);
      continue;
    }
    // An EMPTY scope is meaningless and is the one value where the two halves could disagree — the loader
    // collapses [] → undefined (unscoped) while a naive shape check would pass it. Error at author time so [] can
    // never reach the loader OR the dispatcher: an unscoped item is NEVER launched to build — the dispatcher holds
    // it `unshaped-no-scope` and the /conveyor skill AUTO-PREPARES its scope (#2613), so to build it, omit the
    // field for now or list real prefixes.
    if (scope.length === 0) {
      err(`Backlog item "${id}" scope is empty — an empty scope is meaningless (the dispatcher reads absent-or-empty as unscoped: it never builds it, and auto-prepares the scope instead). Omit the field, or list real repo-relative path prefixes.`);
      continue;
    }
    if (scope.some((p) => typeof p !== 'string')) {
      err(`Backlog item "${id}" scope must contain only strings — every entry is a repo-qualified path prefix (e.g. "we:src/backlog-view/")`);
      continue;
    }
    // Every entry must be REPO-QUALIFIED (`we:…`/`fui:…`/`plateau:…`). A bare prefix is rejected by the #883
    // locus hook and, unqualified, the scope-lease engine reads its repo as `null` and it never matches an
    // observed `we:`-qualified file — silently breaking the overlap detection two lanes rely on to not both
    // launch. (See the WHY-repo-qualified note above.)
    const bare = scope.filter((p) => !SCOPE_REPO_PREFIX_RE.test(p));
    if (bare.length)
      err(`Backlog item "${id}" scope has non-repo-qualified entr${bare.length > 1 ? 'ies' : 'y'} ${JSON.stringify(bare)} — every scope entry must carry a <repo>: locus prefix (e.g. "we:src/backlog-view/", "fui:plugs/…", "plateau:…"), NOT a bare path. A bare path is rejected by the write-time locus-prefix hook (#883) and, unqualified, the scope-lease engine (readiness/scope-lease.mjs) reads its repo as null so it never matches an observed we:-qualified file — the lane's overlap is silently never detected and two overlapping lanes could both launch.`);

    // ── Scope defaults to FILE-LEVEL — flag a bare DIRECTORY scope unless justified (#2739) ──
    // The #2619/#2679 finer-lease principle: a lane's scope-lease should cover the SPECIFIC files it writes, not
    // a whole directory. A dir-level entry — a repo-qualified prefix ending in `/` with no filename (e.g.
    // "we:scripts/readiness/") — re-creates the coarse cross-item serialization finer leases removed: a whole
    // wave of file-disjoint items stalls behind one broad dir-scope (the rescope-wave2 pass had to hand-narrow
    // #2665/#2684/#2661 from whole dirs down to the files each build touches). So FLAG a dir-level scope at
    // authoring time and steer it to file-level — narrow to the specific files, OR record a short
    // `scopeRationale:` note (a genuinely dir-spanning / inherently cross-cutting item is the deliberate,
    // justified exception, not the silent default). Absent that note, dir-level is the finding.
    //
    // SOUNDNESS (never push toward UNDER-scope): this is a WARNING, never an error. A scope NARROWER than the
    // real write-set breaches the lease at build time — strictly worse than a coarse scope — so the remedy is
    // ALWAYS "narrow to the files you actually write, never fewer" OR "justify with a scopeRationale", never
    // "drop files to look file-level". Erroring here would also red the gate on the whole existing dir-scoped
    // corpus and pressure authors to under-scope; a warning surfaces the finer-lease debt without either hazard.
    // Resolved items are historical (no author will re-scope a shipped item), so they are skipped.
    const scopeRationale = typeof raw?.scopeRationale === 'string' ? raw.scopeRationale.trim() : '';
    if (raw?.status !== 'resolved' && !scopeRationale) {
      const dirs = dirLevelScopeFinding(raw);
      if (dirs.length)
        warn(`Backlog item "${id}" has directory-level scope entr${dirs.length > 1 ? 'ies' : 'y'} ${JSON.stringify(dirs)} (a repo-qualified prefix ending in "/") — scope defaults to FILE-LEVEL (#2739/#2679). A bare directory scope re-creates the coarse serialization finer leases removed: file-disjoint items stall behind one broad dir-scope. NARROW it to the specific files this item writes (never fewer than the real write-set — an under-scope breaches the lease at build time), OR, if the item genuinely spans the directory / is inherently cross-cutting, add a short \`scopeRationale:\` note stating why and this flag clears.`);
    }

    // ── 6d-septies. A scope entry whose path does not resolve but whose BASENAME does (#3337) ──
    // The pure rule — and the reasoning behind every one of its four narrowing axes — lives in
    // check-standards-rules.mjs `scopeBasenameMismatches`; this call site only supplies the tracked-path
    // index built above and emits the message that names the probable intended path. WARNING, never an
    // error: a scope entry for a file the item is about to CREATE is legitimate, and a hard failure would
    // redden exactly that greenfield case.
    for (const finding of scopeBasenameMismatches(raw, trackedIndex))
      warn(scopeBasenameMismatchMessage(id, finding));

    // ── #4448 guards 4 + 5 — errors on edited cards; legacy warnings stay ratcheted. ──
    const scopeReport = changedScopeCards.has(`backlog/${file}`) ? err : warn;
    const scopeDescriptor = { kind: 'backlog-scope-body', file: `backlog/${file}`, fix: 'model' };
    for (const f of scopeMissingTestFile(raw, trackedIndex, body))
      scopeReport(`Backlog item "${id}" scopes "${f.entry}" and mandates a test plan, but its tracked test "we:${f.testPath}" is not in scope: — the lease will not cover the test the build must edit (#4448). Add it, or add a \`scopeRationale:\` note.`, scopeDescriptor);
    const undeclared = bodyDeliverablesMissingFromScope(raw, body);
    if (undeclared.length)
      scopeReport(`Backlog item "${id}" names deliverable${undeclared.length > 1 ? 's' : ''} ${JSON.stringify(undeclared)} under ## MVP / the acceptance section that ${undeclared.length > 1 ? 'are' : 'is'} missing from scope: (#4448). Add ${undeclared.length > 1 ? 'them' : 'it'}, or add a \`scopeRationale:\` note.`, scopeDescriptor);
  }
}

mark("6d-sexies. Optional `scope:` predicted touch-set (#x53zzf9)");
// ── 6d-ter. blockedBy dependency edges (#248) ──
// `blockedBy: ["NNN", …]` is a directional prerequisite edge ("this can't start until NNN is
// resolved"), making the backlog a real DAG that a deterministic readiness function (#249/#250)
// can score without an LLM. Guard the graph's integrity: every edge must resolve to a real item,
// never point at itself, and never form a cycle (the readiness algorithm assumes acyclicity).
const blockedEdges = new Map(); // num -> [target nums], for the cycle walk
const statusByNum = new Map(backlog.map((i) => [i.num, i.status]));
for (const item of backlog) {
  if (item.blockedBy === undefined) continue;
  const backlogFile = item.id ? `backlog/${item.id}.md` : undefined;
  if (!Array.isArray(item.blockedBy)) {
    err(`Backlog item "${item.id}" blockedBy must be an array of NNN ids (e.g. ["079", "092"])`);
    continue;
  }
  const targets = [];
  for (const raw of item.blockedBy) {
    const target = String(raw);
    if (target === item.num) {
      err(`Backlog item "${item.id}" lists itself in blockedBy — an item cannot block itself`);
      continue;
    }
    if (!seenNums.has(target)) {
      err(`Backlog item "${item.id}" blockedBy "#${target}" does not resolve to an existing item`,
        dUnresolvedRef('Backlog', item.id, backlogFile, 'blockedBy', target, 'backlog/'));
      continue;
    }
    targets.push(target);
  }
  if (item.num) blockedEdges.set(item.num, targets);
  // Stale-block guard: a non-resolved item whose blockedBy edges are ALL resolved is no longer actually
  // blocked — the prerequisite landed but the edge (and any `childlessReason: blocked`) was never updated.
  // This is the #1210 trap, and it's the failure mode the CHILDLESS_REASONS exemption above could mask, so
  // surface it here. Partial-resolved is normal (prereqs land one at a time), so only flag a FULLY cleared
  // block. The fix: start the item, or re-point blockedBy at the genuine remaining open dependency.
  if (item.status !== 'resolved' && targets.length && targets.every((t) => statusByNum.get(t) === 'resolved'))
    warn(`Backlog item "${item.id}" is still marked blocked but every blockedBy target (${targets.map((t) => `#${t}`).join(', ')}) is resolved — the block is stale. Start it, or re-point blockedBy at the real remaining open dependency (and clear \`childlessReason: blocked\` if it no longer applies).`);
}
// Cycle detection over the resolved edges (DFS with a colour map). A back-edge means A blocks B
// blocks … blocks A — no item could ever start, so the readiness function would never converge.
// #4167 — the finding is path-less (no single owning file — it names the whole cycle), so `--local`
// always demotes it; skip the walk itself under `--local` rather than run it and discard the result.
if (!LOCAL_MODE) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map();
  const reported = new Set();
  const visit = (n, stack) => {
    colour.set(n, GREY);
    for (const next of blockedEdges.get(n) || []) {
      if (colour.get(next) === GREY) {
        const cycle = [...stack.slice(stack.indexOf(next)), next].join(' → ');
        if (!reported.has(cycle)) { reported.add(cycle); err(`Backlog blockedBy cycle detected: #${cycle}`); }
      } else if ((colour.get(next) || WHITE) === WHITE) {
        visit(next, [...stack, next]);
      }
    }
    colour.set(n, BLACK);
  };
  for (const n of blockedEdges.keys())
    if ((colour.get(n) || WHITE) === WHITE) visit(n, [n]);
}

// Parent-deadlock guard (#142, epic-parity extended to `feature` by #2691/#2998): a child must never list
// its own EPIC (or FEATURE — same grouping-tier rollup shape) parent in `blockedBy`. A grouping-tier item
// resolves only AFTER all its children (the no-open-slice rollup guard below) — so "child blocked until the
// parent resolves" is an unbreakable cycle the plain blockedBy walk can't see (the edge is implicit in the
// parent rollup, not in `blockedEdges`): the parent waits on the child, the child waits on the parent.
// Scoped to a child whose parent is `kind: epic` or `kind: feature` — a SLICED STORY/decision parent
// resolves on its own merits, so "wait for the parent's foundational work" is a legitimate edge there and
// is NOT flagged. Scoped to non-resolved children: a resolved one already escaped the deadlock, so flagging
// it is noise.
const kindByNum = new Map(backlog.map((i) => [i.num, i.kind]));
for (const item of backlog) {
  if (item.status === 'resolved' || item.parent === undefined || !Array.isArray(item.blockedBy)) continue;
  const parentNum = String(item.parent);
  const parentKind = kindByNum.get(parentNum);
  if (parentKind !== 'epic' && parentKind !== 'feature') continue;
  if (item.blockedBy.some((raw) => String(raw) === parentNum))
    err(`Backlog item "${item.id}" lists its own ${parentKind} parent #${parentNum} in \`blockedBy\` — a deadlock: a grouping-tier item resolves only after all its children, so the child can never start. The \`parent: ${parentNum}\` edge already expresses the rollup; drop #${parentNum} from blockedBy (re-point it at the real open prerequisite if one exists).`);
}

// Build the parent→children index once (reused by the epic↔child coherence block below).
const childrenOf = new Map(); // parent num -> [child item, …]
for (const item of backlog) {
  if (item.parent !== undefined) {
    const p = String(item.parent);
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(item);
  }
}

// #4166 — a finer-grained profiling boundary (additive to the section mark below, never a behavior change:
// `mark()` only ever affects CHECK_STANDARDS_PROFILE stderr output). Everything ABOVE this point in "6d-ter"
// is driven by the (now scoped-under-`--local --files=`) `backlog` array; everything BELOW — the utc-day-
// slice / invisible-source-tree / stdout-flush whole-`scripts/`-tree scans, the epic↔child coherence loop,
// program-title / undecided-reason / unsplittableReason / date-status / shortTitle loops — is either
// unrelated to backlog data entirely (the three tree scans) or backlog-driven but out of THIS card's named
// scope. Isolating the two lets the epic's own profiling prove which half #4166 actually moved.
mark("6d-ter (backlog-array-driven: blockedBy edges + cycle walk + parent-deadlock + childrenOf)");
// Workflow-intent invariants (#2084) — the cross-item / clock-needing rules the per-item schema validator
// cannot see: sliced-epic sizing (the double-count guard, formerly inline here) + born-active settlement
// TTL (formerly only a check:health O1 candidate). Single tested source in scripts/lib/workflow-invariants
// (standalone: `npm run check:backlog-workflow`).
try {
  const { validateWorkflowInvariants } = require('./lib/workflow-invariants.cjs');
  const today = localToday();
  const { errors: we, warnings: ww } = validateWorkflowInvariants(backlog, { today });
  for (const e of we) err(e.message, e.descriptor);
  for (const w of ww) warn(w.message, w.descriptor);
} catch (e) {
  err(`Backlog workflow-intent invariants check failed: ${e.message}`);
}

// #70d — the three whole-tree scans below share one declared input set ('6d-ter-tree-scans').
const runTreeScans = sectionGate.shouldRun('6d-ter-tree-scans');
if (!runTreeScans) skippedMark('6d-ter-tree-scans');
// Operator-local date stamps (#2747). The rule "a date-only stamp is the operator's calendar day, never
// the runtime's UTC day" is enforced here rather than left as prose in `scripts/lib/local-date.mjs`: the
// idiom it replaces is one line and re-introduces the bug silently (see lib/utc-day-slice-scan.mjs).
if (runTreeScans) try {
  // Each hit carries its own `file`/`line`, so it MUST be attributed (#952/#1389/#1144): without a
  // descriptor, `--scope=<slug>` classes it "unattributable" and reds a concurrent session on a file it
  // never touched, while `--local --files=<lane set>` demotes it to a note — a false green at this seam.
  for (const hit of findUtcDaySlices(join(ROOT, 'scripts'), ROOT))
    err(utcDaySliceMessage(hit), { kind: 'utc-day-slice', fix: 'model', file: hit.file, line: hit.line });
} catch (e) {
  err(`UTC day-slice scan failed: ${e.message}`);
}

// #2866: backstop for shell writes and the existing scripts/docs source corpus.
if (runTreeScans) try {
  for (const finding of scanInvisibleSourceTree(ROOT)) err(finding.message, finding.descriptor);
} catch (e) {
  err(`Invisible-character scan failed: ${e.message}`);
}

// stdout flushed before a process.exit (#3061). `write(big); process.exit()` TRUNCATES to the pipe buffer
// (~8 KB) whenever a parent CAPTURES stdout — silently, with a zero status. Eight live CLIs carried it, four
// losing over 99 % of their payload, including this gate. Prose did not stop it: five files had each
// rediscovered the mechanism in a local comment. Deterministic and script-decidable ⇒ a scan (memory rule #51).
if (runTreeScans) try {
  // Attributed per hit (#952/#1389/#1144) — an unattributed finding reds a concurrent session on a file it
  // never touched, and `--local --files=<lane set>` would demote a real one to a note.
  // #3417 — the optional Rust `we-scan stdout-flush` port, verified byte-identical to scanStdoutFlush; falls
  // back to the JS scan whenever the binary is unbuilt/stale/wrongly-shaped/erroring (see rust-scan-bridge.mjs).
  const hits = runWeScan('stdout-flush', [`--root=${ROOT}`], {
    referenceFiles: [join(ROOT, 'scripts', 'lib', 'stdout-flush-scan.mjs')],
  }) ?? scanStdoutFlush(ROOT);
  for (const hit of hits)
    err(stdoutFlushMessage(hit), { kind: 'stdout-flush', fix: 'model', file: hit.file, line: hit.line });
} catch (e) {
  err(`stdout-flush scan failed: ${e.message}`);
}

// Epic/feature ↔ child status coherence (docs/agent/backlog-workflow.md → "Closing out" step 4, epic-parity
// extended to `feature` by #2691/#2998): a grouping-tier item's resolution state must agree with its
// children.
//   B — a RESOLVED epic/feature with an open child is the `⚠ open slice` contradiction: the
//       umbrella was closed while work still lives under it. Reopen it or close the child.
//   A — a non-resolved epic/feature that is BLOCKED and has no open child must say WHY it's stalled
//       (a `childlessReason`) so the tile doesn't read as abandoned.
//   C — a storied epic/feature whose every child is resolved is the `all slices done` review cue:
//       reconcile it (resolve it, or add the next slice/child). Warn, don't fail — it's a nudge.
const CHILDLESS_REASONS = new Set(['blocked', 'undecided', 'untriaged', 'program']);
for (const item of backlog) {
  if (item.kind !== 'epic' && item.kind !== 'feature') continue;
  const kids = childrenOf.get(item.num) || [];
  if (!kids.length) continue;
  const openKids = kids.filter((k) => k.status !== 'resolved');
  if (item.status === 'resolved' && openKids.length)
    err(`Backlog item "${item.id}" is a resolved ${item.kind} but has ${openKids.length} open child slice(s) (${openKids.map((k) => `#${k.num}`).join(', ')}) — a closed umbrella with live work under it. Reopen it or resolve/re-parent the open child(ren).`);
  else if (item.status !== 'resolved' && (item.blockedBy?.length) && !openKids.length && !CHILDLESS_REASONS.has(item.childlessReason))
    err(`Backlog item "${item.id}" is a blocked ${item.kind} with no open children and no childlessReason — set childlessReason: ${[...CHILDLESS_REASONS].join('|')} so the board shows why it's stalled, or add the next slice.`);
  else if (item.status !== 'resolved' && !openKids.length && !item.ongoing && !CHILDLESS_REASONS.has(item.childlessReason))
    warn(`Backlog item "${item.id}" is a ${item.kind} whose every child is resolved ('all slices done') — reconcile it: resolve it (its scope is delivered) or scaffold the next slice.`);
  // An `ongoing: true` epic (a perpetual program, e.g. the flagship exercise apps) is intentionally never
  // a resolve cue — between slices it legitimately has every child resolved without being "done".
  // Likewise an epic that DECLARES a `childlessReason` (blocked / undecided / untriaged / program) is in a
  // stated steady state — its remaining scope can't be carved yet (it's blocked) or isn't a "done" signal —
  // so it's exempt from the resolve nudge too. Otherwise a blocked epic clears branch A (it gave its reason)
  // only to be told by branch C to resolve — the contradiction of "stalled" and "done" at once.
}

// A program's title is a short bare NAME, not a one-line pitch (docs/agent/backlog-workflow.md →
// "Naming — a program's title is a short bare name, no subtitle"). A program (an epic with `ongoing:
// true` or `childlessReason: program`) is cited for the life of the constellation, so its H1 must read
// as a name — no `—`/`–`/`:` subtitle clause AND no `(parenthetical)` aside. The elaboration (lens shape,
// front-A/B mechanics, the "cards only" discipline) belongs in the body, not the title. (User directive
// 2026-06-21, extended 2026-06-22 to parentheticals.)
// Match a separator FOLLOWED by a space — `Name: clause`, `Name — clause`, `Name – clause` — regardless
// of a leading space, so the unspaced `conversion: register …` form is caught too (the prior `\s+[—–:]\s+`
// required spaces on BOTH sides and silently missed it; #1442). `—`/`–` are em/en dashes only, so a
// hyphenated word (`Block-model`, `Self-Driven`) never trips it. Also flag any `(` — a bare name carries
// no parenthetical aside; the domain belongs IN the name (`Loan-origination exercise app`), not after it.
for (const item of backlog) {
  if (item.kind !== 'epic') continue;
  if (!(item.ongoing === true || item.childlessReason === 'program')) continue;
  const m = (item.title || '').match(/[—–:]\s|\(/);
  if (m)
    err(`Backlog item "${item.id}" is a program but its title carries a subtitle/aside ("${m[0].trim()}") — a program's H1 must be a short bare name (no \`—\`/\`–\`/\`:\` clause, no \`(parenthetical)\`). Fold the elaboration into the opening paragraph and keep the title a name (docs/agent/backlog-workflow.md → Programs → Naming).`,
        { kind: 'program-title-subtitle', file: `backlog/${item.id}.md` });
}

// No epic may embed "needs a decision" as its childless reason. An open design decision that gates an
// epic's slicing is a first-class `kind: decision` work item (the plan of record — never plan mode, never
// an inline body fork), and the epic depends on it through a `blockedBy` edge — NOT a `childlessReason:
// undecided` shortcut that hides the fork inside the umbrella. (User directive 2026-06-20; mirrors the
// "No Decision+Epic Conflation" rule. docs/agent/backlog-workflow.md → decisions are work items.)
for (const item of backlog) {
  if (item.childlessReason === 'undecided')
    err(`Backlog item "${item.id}" has childlessReason: undecided — an epic must not embed an open decision as its slicing blocker. Carve the fork into its own \`kind: decision\` item and point this epic's \`blockedBy\` at it (then drop childlessReason). If the decision is already resolved, just drop childlessReason so the epic shows as ready to slice.`);
}

// `unsplittableReason` — the story-side mirror of an epic's `childlessReason` (src/_data/backlogMeta.js
// → unsplittableReasonMeta). A `/split` run that rules an oversized story could-not-split records the
// reason to clear the split flag (so the board stops re-flagging it). It's only meaningful on an OPEN
// story in the should-split band (size > 8) — anywhere else it's a misplaced field that would silently
// do nothing — and its value must be a known reason. (docs/agent/backlog-workflow.md → "Splitting".)
// `undecided` is intentionally NOT a valid unsplittable reason: a story that can't be split because a
// buried fork would scatter across the slices must carve that fork into a `kind: decision` item and gate
// on it via `blockedBy` — same rule as the epic side above — not park behind an inline "needs decision".
const UNSPLITTABLE_REASONS = new Set(['foundational', 'atomic', 'fixture']);
for (const item of backlog) {
  if (item.unsplittableReason === undefined) continue;
  if (item.unsplittableReason === 'undecided')
    err(`Backlog item "${item.id}" has unsplittableReason: undecided — a buried fork that blocks splitting is a first-class \`kind: decision\` item, not an inline reason. Carve the decision and point this story's \`blockedBy\` at it, then re-run /split once it's resolved.`);
  else if (!UNSPLITTABLE_REASONS.has(item.unsplittableReason))
    err(`Backlog item "${item.id}" has unsplittableReason: "${item.unsplittableReason}" — not a known reason. Use one of: ${[...UNSPLITTABLE_REASONS].join('|')}.`);
  else if (item.kind !== 'story' || typeof item.size !== 'number' || item.size <= 8 || item.status === 'resolved')
    err(`Backlog item "${item.id}" has unsplittableReason but is not an open oversized story (kind: story, size > 8) — the field only clears the /split flag there. Drop it, or re-size/re-kind the item.`);
}

// Date↔status coherence: dateResolved only makes sense on a resolved item (the burndown
// plots resolutions; a stray date on an open item would mis-place it on the chart).
for (const item of backlog) {
  if (item.dateResolved && item.status !== 'resolved')
    err(`Backlog item "${item.id}" has dateResolved "${item.dateResolved}" but status is "${item.status}" — clear the date or set status: resolved.`);
}

// shortTitle length bound (#2549): the console's scanning surfaces render `shortTitle ?? title`, so a
// short title must stay glanceable (3–5 words, ≤ 42 chars). A too-long one defeats the point — warn (not
// err: it still renders, just isn't scannable). An empty shortTitle should be dropped, not kept as noise.
const SHORT_TITLE_MAX = 42;
for (const item of backlog) {
  if (item.shortTitle === undefined) continue;
  if (typeof item.shortTitle !== 'string' || item.shortTitle.trim() === '')
    warn(`Backlog item "${item.id}" has an empty/non-string shortTitle — drop the field (surfaces fall back to the full title).`);
  else if (item.shortTitle.length > SHORT_TITLE_MAX)
    warn(`Backlog item "${item.id}" shortTitle is ${item.shortTitle.length} chars (> ${SHORT_TITLE_MAX}) — tighten it to a glanceable 3–5 words, or drop it to fall back to the title.`);
}

mark("6d-ter (rest: utc-day-slice/invisible-source/stdout-flush tree scans + epic-coherence + per-item lints — #248)");
// ── 6d-bis. Old-slug redirects (#110): validate `formerSlugs` back-compat aliases ──
// A renamed item lists prior URL segments in `formerSlugs:`; src/backlog-slug-redirects.njk turns
// each into a redirect page at /backlog/<former>/ → /backlog/<id>/. Guard the field so a former slug
// can't shadow a live item or collide with another item's alias (either would make a redirect win
// over a real page, or two redirects fight for one URL).
const realIds = new Set(backlog.map((it) => it.id));
const aliasOwner = new Map();
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
for (const item of backlog) {
  if (item.formerSlugs === undefined) continue;
  if (!Array.isArray(item.formerSlugs)) {
    err(`Backlog item "${item.id}" formerSlugs must be an array of prior URL segments`);
    continue;
  }
  for (const former of item.formerSlugs) {
    if (typeof former !== 'string' || !SLUG_RE.test(former))
      err(`Backlog item "${item.id}" formerSlugs entry "${former}" must be a kebab-case URL segment`);
    else if (former === item.id)
      err(`Backlog item "${item.id}" lists its own current slug in formerSlugs — drop it`);
    else if (realIds.has(former))
      err(`Backlog item "${item.id}" formerSlug "${former}" collides with a live item — a redirect would shadow it`);
    else if (aliasOwner.has(former))
      err(`Backlog formerSlug "${former}" is claimed by both "${aliasOwner.get(former)}" and "${item.id}" — aliases must be unique`);
    else
      aliasOwner.set(former, item.id);
  }
}

mark("6d-bis. Old-slug redirects (#110): validate `formerSlugs` back-compat aliases");
// ── 6e. No hidden reports — every report must be exposed somewhere ────────────
// "Three homes": research → a /research/ topic, spec → the website, everything else → a
// backlog item. reports/ is NOT in the 11ty build, so a report is only reachable when it is
// either backed by a research topic (id = its de-dated slug) or referenced by a backlog item
// (relatedReport). A report that is neither is invisible on the website — fail.
// The fs walk stays here; the de-date + visibility predicate is the pure `validateReportsNotHidden` (#256).
const REPORTS = join(ROOT, 'reports');
const reportFiles = existsSync(REPORTS) ? readdirSync(REPORTS).filter((f) => f.endsWith('.md')) : [];
// #4168 — a SEPARATE scoped view for the per-file content scanners below (6f, 6f-i, 6f-i-b): 6e just
// above needs the FULL `reportFiles` list regardless of scope (a hidden report is a hidden report whether
// or not this lane touched it — that invariant is relational/global, out of #4168's scope by the epic's
// own split), so it must never subset the shared variable those scanners also read.
const scopedReportFiles = SCOPE_TO_FILES ? reportFiles.filter((f) => EFFECTIVE_FILES.has(`reports/${f}`)) : reportFiles;
const researchIds = new Set(research.map((r) => r.id).filter(Boolean));
const backlogReportRefs = relatedReportRefs(backlog);
{
  const { errors: re } = validateReportsNotHidden(reportFiles, { researchIds, backlogReportRefs });
  for (const e of re) err(e.message, e.descriptor);
}

mark("6e. No hidden reports — every report must be exposed somewhere");
// ── 6e-ii. Untracked derived artifacts — local-vs-CI divergence guard (#2180) ──────────────────────
// `check:standards` reads the working tree. On a dev machine, authored-but-never-committed files in
// `reports/`, `src/_data/researchTopics/`, or `src/_includes/research-descriptions/` make existence and
// inventory checks pass locally while a fresh CI clone (no untracked files) fails. This sub-check
// surfaces that gap BEFORE push, so the developer can commit the paired artifacts. The git invocation
// lives here (an fs concern); the pure classifier lives in validateUntrackedDerivedArtifacts (#2180).
// Skipped when `git ls-files` is unavailable (e.g. non-git environments).
try {
  const untrackedRaw = execFileSync(
    'git', ['ls-files', '--others', '--exclude-standard', '--', ...DERIVED_ARTIFACT_DIRS],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const untrackedPaths = untrackedRaw.split('\n').filter(Boolean);
  const { errors: ue } = validateUntrackedDerivedArtifacts(untrackedPaths);
  for (const e of ue) err(e.message, e.descriptor);
} catch (e) {
  // `git` unavailable or not a git repo — skip gracefully (not a gate failure).
}

mark("6e-ii. Untracked derived artifacts — local-vs-CI divergence guard (#2180)");
// ── 6f. Repo-locus prefix on code-path references (#884, enforces #883; #880 slice B) ─
// Every code-path reference in backlog/*.md + reports/*.md must carry a `<repo>:` locus marker so its
// constellation repo is unambiguous in chat / raw markdown. The fs reads stay here; the carve-out scan
// is the pure `scanRepoLocusPrefixes`.
//
// Emit ONE finding PER FILE (#1389), each keyed to its own `descriptor.file`. The earlier single
// aggregate line carried a `files: [...]` list spanning the whole corpus, which `--scope` (#952) could
// only classify all-or-nothing: if ANY bundled file was the session's, every other session's bare ref
// blocked too (false red); if none was dirty-attributable (e.g. the session already committed its file),
// the session's OWN breakage demoted to a note (false green — the #1389 masking). Per-file keying lets
// `--scope` attribute each correctly — the session's files block, concurrent files demote.
{
  // #4168 — `scopedReaddir`/`scopedReportFiles` narrow this to the lane's own `--files` under
  // `--local --files=…`; unchanged (full corpus) otherwise. This check judges each file's OWN content
  // (a bare code-path reference in ITS body), so a file this lane never touched can't newly need a locus
  // prefix it didn't already have — safe to skip entirely, not just demote after the fact.
  const docFiles = [...scopedReaddir('backlog/', ['.md']).map((f) => `backlog/${f}`), ...scopedReportFiles.map((f) => `reports/${f}`)];
  const scanned = scanFilesCached({
    section: '6f', entries: CACHE_ENTRIES, files: docFiles, getKeys: cacheKeys, onStats: (l) => cacheStatLines.push(l),
    load: (file) => readFileSync(join(ROOT, file), 'utf8'), scan: scanRepoLocusPrefixes,
  });
  for (const finding of scanned) {
    const msg =
      `${finding.count} code-path reference(s) in ${finding.file} lack a <repo>: locus prefix ` +
      `(#883 convention; #884 detection, #885 enforces) — e.g. ${finding.sample}`;
    const descriptor = { kind: 'repo-locus', file: finding.file };
    if (REPO_LOCUS_PREFIX_ENFORCED) err(msg, descriptor);
    else warn(msg, descriptor);
  }
}

mark("6f. Repo-locus prefix on code-path references (#884, enforces #883; #880 slice B)");
// ── 6f-i. PUBLISH-SEAM secret sweep on the committed corpus (#3015, under #2978 Fork 3) ───────────
// The BACKSTOP of the hook + CLI + sweep trio (the shape #1574 established for locus prefixes). The two
// write-time gates — `writeBacklogMd` for the CLI funnel, the `--pre` hooks for `Edit`/`Write` — deny
// before the write; both can be bypassed (hooks disabled, a future writer that uses neither), so the
// corpus itself is re-scanned here. A sweep is a LATER catch, not a same-turn deny: it stops a leak from
// surviving a close-out, not from being written.
//
// Scope is the two committed corpora that carry harvested/authored prose: `backlog/*.md` and the memory
// corpus (`agent-memory-src/*.md`). `reports/` is deliberately out — the same argument would apply, but
// widening the sweep's blast radius is a separate call, not a rider on this one.
//
// The detector (`scrubPublish`) was calibrated against THIS corpus: on the 3,319 files present when it
// landed it produced exactly two findings, both true (a real committer email in one card, and #3015's own
// synthetic test marker), both fixed in that same change. It is narrower than the learnings append-seam
// scrub by design — see we:scripts/lib/secret-scrub.mjs's header for the enumerated gaps.
try {
  // #3417 — the optional Rust `we-scan secret-scrub` port, verified byte-identical to scanPublishSecrets;
  // it does its OWN file walk, so the JS `docs` array (and its file reads) is only built on fallback.
  // Wrapped in try/catch (PR #1741 review finding 1) to match the stdout-flush call site above — a bare
  // top-level block here had no wrapping try, so any exception downstream of a malformed `findings` value
  // would have aborted the whole check-standards.mjs script rather than degrading this one section.
  // #4168 — "Secret sweep stays in the lane, scoped": under `--local --files=…` this judges only the
  // lane's own changed files (`scopedReaddir`), and `scoped: SCOPE_TO_FILES` tells the bridge to skip the
  // (always whole-corpus) binary so its file-scoped JS fallback below actually runs instead of a full walk.
  // #70c: with the cache on, the per-file JS scanner runs through the per-file cache (it judges each file's own
  // content only; the Rust port is byte-identical to it). Cache off / any doubt -> the original Rust-or-JS path.
  const secretDocFiles = cacheEnabled()
    ? ['backlog', 'agent-memory-src'].flatMap((label) => scopedReaddir(`${label}/`, ['.md']).map((f) => `${label}/${f}`))
    : null;
  const findings = ((secretDocFiles && scanFilesCached({
    section: '6f-i', entries: CACHE_ENTRIES, files: secretDocFiles, getKeys: cacheKeys, onStats: (l) => cacheStatLines.push(l),
    load: (file) => readFileSync(join(ROOT, file), 'utf8'), scan: scanPublishSecrets,
  })) || runWeScan('secret-scrub', [`--root=${ROOT}`], {
    referenceFiles: [
      join(ROOT, 'scripts', 'check-standards-rules.mjs'),
      join(ROOT, 'scripts', 'lib', 'secret-scrub.mjs'),
    ],
    scoped: SCOPE_TO_FILES,
  })) ?? (() => {
    const docs = [];
    for (const label of ['backlog', 'agent-memory-src']) {
      for (const f of scopedReaddir(`${label}/`, ['.md']))
        docs.push({ file: `${label}/${f}`, content: readFileSync(join(ROOT, label, f), 'utf8') });
    }
    return scanPublishSecrets(docs);
  })();
  for (const { file, reasons } of findings) {
    err(
      `${file} carries ${reasons.join('; ')} — this file is COMMITTED and PUSHED, so a credential in it is a ` +
      `published credential (#3015). Remove the value (and rotate it if it was ever real) and describe it ` +
      `in words instead of pasting it. The write-time gates (writeBacklogMd, the backlog/memory --pre hooks) ` +
      `should have caught this before the write — if they did not, that bypass is the real finding.`,
      { kind: 'publish-secret-scrub', file },
    );
  }
} catch (e) {
  err(`publish-secret sweep failed: ${e.message}`);
}

mark("6f-i. PUBLISH-SEAM secret sweep on the committed corpus (#3015, under #2978 Fork 3)");
// ── 6f-i-b. HARNESS-SCAFFOLDING leak sweep on the committed corpus (#3448) ─────────────────────────
// PR #1803 committed a literal <system-reminder> block into a backlog item — copy-pasted from the
// authoring agent's own context, not an external attack, undetected until human review. This re-walks
// backlog/*.md and reports/*.md (the same corpus 6f already reads for locus prefixes) for the tells of
// an agent accidentally pasting its own harness context into committed content. Pure detector lives in
// scanHarnessScaffolding; the fs walk stays here, mirroring scanRepoLocusPrefixes / scanPublishSecrets.
{
  // #4168 — same scoping as 6f above: judges each file's own content, so a file outside the lane's
  // `--files` list can be skipped entirely under `--local --files=…`.
  const docFiles = [...scopedReaddir('backlog/', ['.md']).map((f) => `backlog/${f}`), ...scopedReportFiles.map((f) => `reports/${f}`)];
  const scanned = scanFilesCached({
    section: '6f-i-b', entries: CACHE_ENTRIES, files: docFiles, getKeys: cacheKeys, onStats: (l) => cacheStatLines.push(l),
    load: (file) => readFileSync(join(ROOT, file), 'utf8'), scan: scanHarnessScaffolding,
  });
  for (const { file, hits } of scanned) {
    for (const hit of hits) {
      err(
        `${file}:${hit.line} carries a ${hit.label} outside a fenced code block (${JSON.stringify(hit.match)}) — ` +
        `this looks like harness-scaffolding accidentally copy-pasted from an authoring agent's own context ` +
        `into committed content (#3448, the PR #1803 leak). Remove it, or fence it in a code block if it is ` +
        `genuinely documenting the pattern.`,
        { kind: 'harness-scaffolding-leak', file },
      );
    }
  }
}

mark("6f-i-b. HARNESS-SCAFFOLDING leak sweep on the committed corpus (#3448)");
// ── 6f-i-c. REGISTRY-DISCOVERY anti-regression guard (#3729-style conflict prevention) ────────────
// `soak/breaks/index.mjs` and `health-smells/index.mjs` build their registry by discovering every module file
// in their own directory (`registry-discovery.mjs`) instead of a hand-maintained import list — the fix for the
// routine merge conflict where every PR adding a break or a smell edited the same few lines. This re-reads both
// files from the working tree and fails the moment either regresses to a hand-maintained list (a direct
// `./<id>.mjs` sibling import) or simply stops calling `loadModuleRegistry(...)`. Pure detector lives in
// `findHandMaintainedRegistryIndex`; the fs read stays here, mirroring the harness-scaffolding sweep above.
{
  const registryFiles = [];
  for (const rel of REGISTRY_DISCOVERY_INDEX_FILES) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) registryFiles.push({ file: rel, content: readFileSync(abs, 'utf8') });
  }
  for (const { file, reason } of findHandMaintainedRegistryIndex(registryFiles)) {
    err(
      `${file} ${reason} (#3729 — this registry is meant to be DISCOVERED FROM DISK precisely so several PRs ` +
      `adding a break/smell in the same window never collide on a hand-maintained index again).`,
      { kind: 'registry-discovery-regression', file },
    );
  }
}

// ── 6f-i-d. LANE-JOURNAL coverage guard (#4370) ──────────────────────────────────────────────────
// Every `git reset --hard` / `git clean` / lease-marker `rmSync` in lane code must sit next to a
// `journalLaneEvent(...)` call (or carry a `journal-exempt: <why>` comment), so the per-pool lane lifecycle
// journal keeps answering "who reset this lane, and why". Pure detector: `findUnjournaledLaneMutations`.
{
  const laneFiles = [];
  for (const rel of LANE_MUTATION_FILES) {
    const abs = join(ROOT, rel);
    if (existsSync(abs)) laneFiles.push({ file: rel, content: readFileSync(abs, 'utf8') });
  }
  for (const { file, line, reason } of findUnjournaledLaneMutations(laneFiles)) {
    err(`${file}:${line} ${reason} (#4370).`, { kind: 'lane-mutation-unjournaled', file });
  }
}

// ── 6f-ii. CITATION-VERIFICATION gate family (#2821, proven subset) ───────────────────────────────
// "A reference asserted without resolving it against the source it points at" (#2821, the #957 root
// class). Four deterministic checks, each reproducing a real review-bounce instance the pure core
// (scripts/lib/citation-check.mjs) resolves against the source:
//   • anchor-authority (#2821 gate 10, the 11-vs-1 core): a platform-decisions `#anchor` attributed to an
//     `#NNN` that is NOT its codifiedIn owner — the `#2439`-vs-`#2398` class 6 review rounds missed.
//   • gate 5: a `we:<path>:<line>` locus that resolves to no file / a line past EOF (`fui:`/`plateau:`
//     cross-repo loci are recognised and skipped — not in this checkout).
//   • gate 3: a `xNNNNNN` hash-slug cited outside the at-land rewrite scope (reports/, the two research
//     dirs), which never self-heals → dead link post-land.
//   • gate 3b (#3100): a `xNNNNNN` hash-slug cited INSIDE the rewrite scope but specifically in
//     `agent-memory-src/` that does not resolve to anything live (see findDanglingMemoryHashSlugs's header
//     for why this dir needs a resolution check, not gate 3's membership check).
// WARN-level for now (CITATION_GATES_ENFORCED=false) — the historical corpus carries many pre-gate hits;
// see the flag's TODO. The fs reads live here; all resolution logic is the pure core.
try {
  const emit = CITATION_GATES_ENFORCED ? err : warn;

  const emitFinding = (f) => {
    switch (f.kind) {
      case 'anchor': {
        const ownerList = f.owners.map((n) => `#${n}`).join(', ');
        emit(`${f.file}: anchor \`#${f.anchor}\` is attributed to #${f.citedNum}, but that anchor's ruling ` +
          `authorities (its codifiedIn / graduatedTo owners) are ${ownerList} — a wrong law citation that ` +
          `outlives the session (#25/#2821 gate 10). Cite one of ${ownerList} for the ruling, or name the ` +
          `build slice explicitly if you mean the implementation. Near: "${f.context}"`,
          { kind: 'citation-anchor-authority', file: f.file });
        break;
      }
      case 'locus': {
        emit(`${f.file}: code-locus \`${f.locus}\` does not resolve — ${f.reason === 'missing-file'
          ? 'no such file in this checkout' : `line ${f.line} is past end-of-file`} (#2821 gate 5). Fix the ` +
          `path/line, or use a \`we:<path>#<symbol>\` anchor for a definition. (\`fui:\`/\`plateau:\` loci ` +
          `are cross-repo and not checked here.)`,
          { kind: 'citation-locus-resolution', file: f.file });
        break;
      }
      case 'hashslug': {
        emit(`${f.file}: hash-slug \`${f.form === 'hash-ref' ? `#${f.slug}` : `${f.slug}-….md`}\` is cited ` +
          `outside the at-land rewrite scope (backlog/, docs/agent/, agent-memory-src/) — ` +
          `numberPendingHashes never rewrites it, so it dangles permanently once the item lands with a real ` +
          `NNN (#2821 gate 3). Name the epic/item in prose, or cite its resolved #NNN.`,
          { kind: 'citation-hash-slug-scope', file: f.file });
        break;
      }
      case 'memoryhash': {
        const slugText = f.form === 'hash-ref' ? `#${f.slug}` : `${f.slug}-….md`;
        const why = f.reason === 'dead-landed'
          ? 'the item it names has already LANDED under a real number, so this citation should already ' +
            'read `#NNN` and does not'
          : 'it does not resolve to any pending or landed backlog item on this tree (typo, or an ' +
            'abandoned lane\'s throwaway id)';
        emit(`${f.file}: hash-slug \`${slugText}\` ${why} (#3100 gate 3b). Replace it with the item's ` +
          `resolved #NNN (or drop the reference if the id never landed).`,
          { kind: 'citation-memory-hash-dangling', file: f.file });
        break;
      }
      default:
        // Unknown kind (a future Rust-side addition the JS side hasn't caught up to) — never silently drop
        // a finding, but don't crash the gate over an unrecognized shape either.
        warn(`citation-check gate produced an unrecognized finding kind ${JSON.stringify(f.kind)} on ${f.file ?? '?'} — report it, this shouldn't happen.`, { kind: 'citation-unknown-finding', file: f.file ?? 'scripts/check-standards.mjs' });
    }
  };

  // #3417 — the optional Rust `we-scan citation-check` port, verified byte-identical to the four
  // JS gates combined; falls back to the JS scan whenever the binary is unbuilt/stale/wrongly-shaped/erroring.
  // #4168 — `scoped: SCOPE_TO_FILES` also forces the fallback under `--local --files=…`, so `scanDir` below
  // (itself scoped via `scopedReaddir`) actually runs instead of the binary's whole-corpus walk.
  const rustFindings = runWeScan('citation-check', [`--root=${ROOT}`], {
    referenceFiles: [
      join(ROOT, 'scripts', 'lib', 'citation-check.mjs'),
      join(ROOT, 'scripts', 'backlog', 'id.mjs'),
    ],
    scoped: SCOPE_TO_FILES,
  });

  if (rustFindings) {
    for (const f of rustFindings) emitFinding(f);
  } else {
    const anchorOwners = buildAnchorOwners(backlog);
    const relExists = (p) => existsSync(join(ROOT, p));
    // Memoized by repo-relative path (#2863) — `findDanglingLoci` calls this once per CITING locus, and a
    // popular file (platform-decisions.md, merge-ai-prs.mjs) is cited from many loci across the corpus.
    // Without the cache that re-reads and re-splits the same file once per citation (measured: 145x / 40x,
    // 113.7 MB of redundant I/O in one gate pass); with it, each distinct file is read at most once.
    const relLineCount = makeMemoizedLineCounter((p) => readFileSync(join(ROOT, p), 'utf8'));
    // #3100 — gate 3b's resolution inputs, derived from the ALREADY-LOADED `backlog` array (no extra fs
    // pass): a hash-named item still on disk is PENDING (in-flight, self-heals at its own land); a landed
    // item's `bornAs` frontmatter names the hash it was born under (already landed — a citation still
    // carrying that hash is stale, not merely mid-flight).
    const pendingHashes = new Set(backlog.filter((b) => isHash(b.num)).map((b) => b.num));
    const bornAsHashes = new Set(backlog.filter((b) => isHash(b.bornAs)).map((b) => b.bornAs));

    // Scan one file at a time — read, run the four detectors, discard — rather than materializing the
    // whole scanned corpus into an array first (#2863). Every detector below is per-file and stateless, so
    // nothing ever needs two files' content at once; the prior shape held ~3848 files' text (≈54 MB
    // resident, 73 MB peak) for the whole pass for no benefit.
    const scanFile = (rel, content) => {
      for (const f of findAnchorRulingMismatches(content, anchorOwners))
        emitFinding({ kind: 'anchor', file: rel, anchor: f.anchor, citedNum: f.citedNum, owners: f.owners, context: f.context });
      for (const f of findDanglingLoci(content, { fileExists: relExists, lineCount: relLineCount }))
        emitFinding({ kind: 'locus', file: rel, locus: f.locus, line: f.line, reason: f.reason });
      for (const f of findOutOfScopeHashSlugs(content, rel))
        emitFinding({ kind: 'hashslug', file: rel, slug: f.slug, form: f.form });
      if (rel.startsWith('agent-memory-src/'))
        for (const f of findDanglingMemoryHashSlugs(content, { pendingHashes, bornAsHashes }))
          emitFinding({ kind: 'memoryhash', file: rel, slug: f.slug, form: f.form, reason: f.reason });
    };
    // Same widened scope as gate 2/3 (#957 round 7) plus agent-memory-src/ (#3100): backlog + docs/agent +
    // agent-memory-src + reports + the two src/ research dirs (the latter render on the public /research/ page).
    // #4168 — `scopedReaddir` narrows each dir to the lane's own `--files` under `--local --files=…`; every
    // detector `scanFile` runs is per-file and stateless (see the comment above `scanFile`), so a file this
    // lane never touched can't produce a NEW finding here — safe to skip reading it at all, not just demote
    // its (identical, already-passing) finding afterward.
    const scanDir = (dir, exts) => {
      const abs = join(ROOT, dir);
      for (const f of scopedReaddir(dir, exts))
        scanFile(`${dir}${f}`, readFileSync(join(abs, f), 'utf8'));
    };
    scanDir('backlog/', ['.md']);
    scanDir('docs/agent/', ['.md']);
    scanDir('agent-memory-src/', ['.md']);
    scanDir('reports/', ['.md']);
    scanDir('src/_data/researchTopics/', ['.json']);
    scanDir('src/_includes/research-descriptions/', ['.njk']);
  }
} catch (e) {
  err(`citation-verification gate failed: ${e.message}`);
}

mark("6f-ii. CITATION-VERIFICATION gate family (#2821, proven subset)");
// ── 6f-ii-b. REFERENCE-RESOLUTION gates (5b/5c/5d — 2026-09-06 staleness audit) ────────────────────
// The gates above resolve a reference's CONTAINER; these resolve its CONTENT, and they resolve the two
// SIBLING repos gate 5 skips by construction.
//
// Root cause they close (audit: we:reports/2026-09-06-open-story-staleness-audit.md). Gate 5 passes a
// `path:line` locus on a BOUNDS check — file exists, line <= EOF. So a citation into a file that GROWS
// stays green forever while pointing at unrelated content: platform-decisions.md reached 4138 lines and
// every pre-growth cite in the backlog still passes, off by 130-520 lines. Meanwhile `graduatedTo` and
// `scope:` were never resolved at all (only shape-checked), which is how a card landed `resolved` naming
// a subtree that does not exist, and how three repo relocations rotted 93 further targets in silence.
//
// DELIBERATELY OUTSIDE the Rust-port branch above. `runWeScan('citation-check')` is verified byte-identical
// to those FOUR gates combined; folding a fifth into `scanFile` would mean it silently does not run
// whenever the Rust path is taken — the exact "a gate that cannot see the target reports it present" hole
// these gates exist to close. When the port grows to cover 5b, move it in and re-verify parity there.
//
// WARN-level, matching CITATION_GATES_ENFORCED and for the same reason: the historical corpus carries
// pre-gate hits, and a gate that reds the build on work nobody is touching gets disabled rather than fixed.
try {
  const emit2 = CITATION_GATES_ENFORCED ? err : warn;
  const { resolvePath, readRepoFile, repoAvailable } = makeRepoResolver({
    exists: existsSync,
    read: (abs) => readFileSync(abs, 'utf8'),
    join,
    root: ROOT,
  });

  // 5c — a resolved item's graduatedTo target must exist.
  for (const f of findDanglingGraduatedTargets(backlog, { resolvePath }))
    emit2(`Backlog item #${f.num} is resolved with graduatedTo \`${f.ref}\` — that path does not exist in ` +
      `the ${f.prefix.replace(':', '')} checkout. Either the work never landed (reopen it), or the target ` +
      `moved and the record is stale (re-point it). A resolve asserts work OUTSIDE its own diff, so this is ` +
      `the one field nothing else can corroborate (#3502).`,
      { kind: 'citation-graduated-target', file: 'backlog/' });

  // 5b — the `we:<path>#<symbol>` anchor form gate 5's own message recommends, now actually resolved.
  // #4168 — per-file (a symbol anchor either resolves against the current tree or it doesn't, independent
  // of any OTHER file), so `scopedReaddir` safely narrows this to the lane's own `--files` under
  // `--local --files=…`. 5c above stays unscoped — it isn't file-attributable at all (see its descriptor's
  // fixed `file: 'backlog/'`), so it's out of #4168's "judges one file's own content" mandate.
  const scanAnchors = (dir, exts) => {
    const abs = join(ROOT, dir);
    for (const name of scopedReaddir(dir, exts)) {
      const rel = `${dir}${name}`;
      for (const f of findDanglingSymbolAnchors(readFileSync(join(abs, name), 'utf8'), { readRepoFile }))
        emit2(`${rel}: symbol anchor \`${f.locus}\` does not resolve — ${f.reason === 'missing-file'
          ? 'no such file in that checkout'
          : `the file exists but contains no \`${f.symbol}\``}. A symbol anchor is the drift-immune ` +
          `citation form (it survives a file growing or being reformatted, which a \`:<line>\` cite does ` +
          `not) — keep it pointing at a real definition.`,
          { kind: 'citation-symbol-anchor', file: rel });
      for (const f of findDanglingMarkdownLinks(readFileSync(join(abs, name), 'utf8'),
        { fromDir: dir.replace(/\/$/, ''), exists: (p) => existsSync(join(ROOT, p)) }))
        emit2(`${rel}: markdown link \`${f.link}\` does not resolve — no such file at \`${f.resolved}\`. ` +
          `Relative links resolve from this file's own directory; repoint it (or use a \`we:<path>\` ref).`,
          { kind: 'citation-markdown-link', file: rel });
    }
  };
  scanAnchors('backlog/', ['.md']);
  scanAnchors('docs/agent/', ['.md']);
  scanAnchors('agent-memory-src/', ['.md']);
  scanAnchors('reports/', ['.md']);

  const skipped = ['fui:', 'plateau:'].filter((p) => !repoAvailable(p));
  if (skipped.length)
    warn(`reference-resolution gates: ${skipped.join(' / ')} checkout(s) absent — targets in those repos ` +
      `were SKIPPED, not verified (detect-or-skip; a gate that cannot see a target must never report it present).`);
} catch (e) {
  err(`reference-resolution gate failed: ${e.message}`);
}

mark("6f-ii-b. REFERENCE-RESOLUTION gates (5b/5c/5d — 2026-09-06 staleness audit)");
// ── 6f-ii-c. HASH-PATH CITATION outside backlog/ (#4075 follow-up, xmd4pfa) ────────────────────────
// A hash-named BACKLOG FILE PATH (`backlog/x<hash>-<slug>.md`) cited from anywhere outside backlog/ itself
// is the citation shape that dangles the moment the drain's JIT numbering (#2288) renames the card away —
// the live incident: scripts/conveyor/flows/build-dispatch.flow.json cited `backlog/xr05jjl-….md`, the card
// landed as #4220, and the dangling reference turned main's CI red for every PR (#4075). Pure detector:
// findHashPathCiteOutsideBacklog (scripts/lib/citation-check.mjs) — deliberately SCOPE-INDEPENDENT (see its
// own header): it fires in ANY dir, not a maintained list, because a maintained list (the JIT-numbering
// rewrite scope itself) is exactly what fell behind here. `git grep`, not a per-dir readdir walk — the whole
// point is catching a citing file TYPE nobody has scoped a scanner to yet, so there is no fixed dir list to
// hand a walker in the first place. DELIBERATELY OUTSIDE the Rust-port branch above (same reasoning as
// 6f-ii-b): a brand-new gate the port doesn't know about must never silently not-run just because the port
// happens to be built.
//
// Resolving paths in the checkout's net diff are errors: they hold numbering and would strand the card.
// Unowned or non-resolving paths retain the gate family's warning policy.
try {
  const emit3 = CITATION_GATES_ENFORCED ? err : warn;
  const citationChanges = localChangedSet({ runGit: (args) => execFileSync('git', args, {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }) });
  const changedFiles = citationChanges ? new Set(citationChanges.changedFiles) : null;
  // #70c: per-file cached raw grep hits (classification below stays whole-tree); null = plain git grep.
  let hits = scopedGrepLines(HASH_PATH_CITE_SOURCE, (f) => !f.startsWith('node_modules/') && !f.startsWith('backlog/')) ?? gitGrepCached({
    section: '6f-ii-c', entries: GREP_CACHE_ENTRIES, root: ROOT, pattern: HASH_PATH_CITE_SOURCE,
    exclude: (f) => f.startsWith('node_modules/') || f.startsWith('backlog/'), getKeys: cacheKeys, onStats: (l) => cacheStatLines.push(l),
  });
  if (!hits) {
    hits = [];
    try {
      hits = execFileSync(
        'git', ['grep', '--threads=1', '-nE', HASH_PATH_CITE_SOURCE, '--', '.', ':!node_modules', ':!backlog'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 },
      ).split('\n').filter(Boolean);
    } catch { /* git grep exits 1 on no match, or git unavailable — no findings either way, never a gate crash */ }
  }
  const seen = new Set();
  for (const { file: rel, path: cited, hash } of findHashPathCitesInGrepLines(hits)) {
    const key = `${rel}\u0000${cited}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (classifyHashPathCite({ cited, exists: (path) => existsSync(join(ROOT, path)), citingFile: rel, changedFiles }) === 'resolving') {
      err(`${rel}: cites a card by its hash-named FILE PATH (\`${cited}\`) — the drain will hold this card from numbering ` +
        `(it would strand on main), cite it as \`#${hash}\` instead.`,
        { kind: 'citation-hash-path-outside-backlog', file: rel });
      continue;
    }
    emit3(`${rel}: cites a card by its hash-named FILE PATH (\`${cited}\`) — the drain's JIT numbering ` +
      `(#2288) renames that exact path away the moment the card lands, so this citation dangles the instant ` +
      `it does (#4075, the build-dispatch.flow.json incident). Cite the card by its stable id instead ` +
      `(\`#${hash}\` while pending, or its resolved \`#NNN\` once landed) — both resolve against the ` +
      `target's own \`bornAs\` frontmatter and survive the rename.`,
      { kind: 'citation-hash-path-outside-backlog', file: rel });
  }
} catch (e) {
  err(`hash-path citation gate failed: ${e.message}`);
}

mark("6f-ii-c. HASH-PATH CITATION outside backlog/ (#4075 follow-up, xmd4pfa)");
// ── 6f-ii-d. DANGLING BACKLOG-GLOB CITATION (#4318) ────────────────────────────────────────────────
// The `backlog/<id>-*.md` WILDCARD-GLOB citation convention (a literal `*`, not a real slug — ~93 corpus
// hits) is authors' own workaround for gate 6f-ii-c above (a real slug always dangles at JIT-numbering;
// the glob form deliberately avoids naming one). But the glob's own `<id>` still dangles the moment it
// graduates hash→NNN or a numeric id gets renumbered — findDanglingBacklogGlobCite resolves it against the
// tree the same way gate 3b already resolves a bare hash-slug, extended to the glob-path form and to
// numeric ids. A `bornAs` hash counts as resolving (same as gate 3b) — so a citation naming an id that has
// since graduated to a real `#NNN` is a STALENESS/hygiene issue (cite the current id instead), never a
// dangling one; the gate's real catch is an id with NEITHER a `num` NOR a `bornAs` anywhere on the tree
// (see citation-check.mjs's own header on findDanglingBacklogGlobCite for the live instance this gate's own
// build turned up on that basis, #4318). Unlike 6f-ii-c, `backlog/` is NOT exempt here: a backlog item can
// dangle-cite a sibling's stale glob just as easily as any other file.
//
// DELIBERATELY OUTSIDE the Rust-port branch above, same reasoning as 6f-ii-b/6f-ii-c: the port is verified
// byte-identical to only the original four gates; folding a fifth in here would mean it silently doesn't
// run whenever the Rust path is taken.
//
// WARN-level, matching CITATION_GATES_ENFORCED and the rest of this gate family — a first run against the
// historical corpus will surface pre-existing hits nobody was checking before.
try {
  const emit4 = CITATION_GATES_ENFORCED ? err : warn;
  // Reuse the already-loaded `backlog` array (no extra fs pass) via the SHARED, tested builder (#4318
  // round-2 review) — every id that currently resolves to a real backlog file, either as a landed/pending
  // item's own `num` or as any item's birth `bornAs` hash (mirrors gate 3b's pendingHashes/bornAsHashes
  // construction, widened to include numeric `num`s too since this gate also catches a numeric id going
  // stale, not just a hash). Calling the shared builder — not re-deriving the union inline — is what lets
  // this module's own tests exercise the EXACT construction this gate ships, not a copy of it.
  const resolvableIds = buildBacklogResolvableIds(backlog);
  // #70c: per-file cached raw grep hits (classification below stays whole-tree); null = plain git grep.
  let hits = scopedGrepLines(BACKLOG_GLOB_CITE_SOURCE, (f) => !f.startsWith('node_modules/')) ?? gitGrepCached({
    section: '6f-ii-d', entries: GREP_CACHE_ENTRIES, root: ROOT, pattern: BACKLOG_GLOB_CITE_SOURCE,
    exclude: (f) => f.startsWith('node_modules/'), getKeys: cacheKeys, onStats: (l) => cacheStatLines.push(l),
  });
  if (!hits) {
    hits = [];
    try {
      hits = execFileSync(
        'git', ['grep', '--threads=1', '-nE', BACKLOG_GLOB_CITE_SOURCE, '--', '.', ':!node_modules'],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 },
      ).split('\n').filter(Boolean);
    } catch (e) {
      // git grep exits 1 on "no match" — that is the common, expected empty case, never a gate crash. Any
      // OTHER exit (git unavailable, output past maxBuffer, a real error) is NOT the same as "no findings" —
      // independent review (#4318, security lens) caught the sibling gates' identical catch-all silently
      // reporting clean on a real scan failure. Route it through the SAME emit4 the gate's own findings use
      // (not a bare `warn`) so CITATION_GATES_ENFORCED promotes a real scan failure to a hard error exactly
      // like it would promote a real finding — a scan that couldn't run is not entitled to a softer floor
      // than a scan that ran and found something.
      if (e?.status !== 1) {
        emit4(`backlog-glob citation gate: git grep failed unexpectedly (${String(e?.message || e).split('\n')[0]}) ` +
          `— this run's findings for gate 6f-ii-d may be INCOMPLETE, not clean.`,
          { kind: 'citation-backlog-glob-scan-error', file: 'scripts/check-standards.mjs', global: true });
      }
    }
  }
  for (const f of findDanglingBacklogGlobCitesInGrepLines(hits, { resolvableIds })) {
    emit4(`${f.file}: cites \`${f.path}\` — id \`${f.id}\` resolves to no currently-tracked or landed ` +
      `backlog item (a graduated hash→NNN id still resolves via bornAs and never trips this; this is a ` +
      `typo, an abandoned lane's throwaway id, or an id that was never landed under this exact form) ` +
      `(#4318). Update the glob to a real id, or cite it by stable \`#NNN\` instead.`,
      { kind: 'citation-backlog-glob-dangling', file: f.file });
  }
} catch (e) {
  err(`backlog-glob citation gate failed: ${e.message}`);
}

mark("6f-ii-d. DANGLING BACKLOG-GLOB CITATION (#4318)");
// ── 6f-ii-e. BLANK-LINE CITATION (#4454) ───────────────────────────────────────────────────────────
// Gate 5 only bounds-checks a `we:<path>:<line>` cite, so a cite into an edited file stays green while it
// points at unrelated text. A deterministic gate cannot judge an English claim about control flow; the
// cheapest mechanical drift signal is that the cited START line is blank (never what a card meant to point
// at). Pure detector: findBlankLineLoci (scripts/lib/citation-check.mjs). A cite drifting onto unrelated
// NON-blank text still passes — the content-aware check is a follow-up.
//
// DELIBERATELY OUTSIDE the Rust-port branch above (same reasoning as 6f-ii-b/c/d): a new detector the port
// doesn't know must never silently not-run, and findDanglingLoci stays byte-identical for the parity test.
// Per-file and stateless, so `scopedReaddir` safely narrows it under `--local --files`. WARN via
// CITATION_GATES_ENFORCED — the historical corpus carries pre-gate hits.
try {
  const emit5 = CITATION_GATES_ENFORCED ? err : warn;
  const relExists5 = (p) => existsSync(join(ROOT, p));
  const readLines5 = makeMemoizedLineReader((p) => readFileSync(join(ROOT, p), 'utf8'));
  const scanBlank = (dir, exts) => {
    const abs = join(ROOT, dir);
    for (const name of scopedReaddir(dir, exts)) {
      const rel = `${dir}${name}`;
      for (const f of findBlankLineLoci(readFileSync(join(abs, name), 'utf8'), { fileExists: relExists5, readLines: readLines5 }))
        emit5(`${rel}: cites \`${f.locus}\` but line ${f.line} of that file is blank — a blank line is never ` +
          `what a citation meant to point at, so the cited file has drifted since the cite was written (#4454). ` +
          `Re-grep the line and re-point the cite, or use the drift-immune \`we:<path>#<symbol>\` form.`,
          { kind: 'citation-blank-line', file: rel });
    }
  };
  scanBlank('backlog/', ['.md']);
  scanBlank('docs/agent/', ['.md']);
  scanBlank('reports/', ['.md']);
  scanBlank('agent-memory-src/', ['.md']);
} catch (e) {
  err(`blank-line citation gate failed: ${e.message}`);
}

mark("6f-ii-e. BLANK-LINE CITATION (#4454)");
// ── 6f-iii. PROVENANCE gate (#3026) — a backticked identifier in prose must resolve, or be marked ──
// The one citation form the #2821 subset cannot reach. Gates 3/5/10 are all LOCUS-shaped (a path, a line,
// an anchor); a bare `` `validateTodoMarkerBlock` `` in a sentence is none of those, so the highest-frequency
// citation form in our prose was the form nothing checked. Seven false symbol cites across four review
// rounds of PR #1112 came through that hole.
//
// DIFF-SCOPED, and that is the design (see findUnresolvedIdentifiers' header for the numbers): corpus-wide
// this fires 1,808 times on overwhelmingly correct prose. We resolve the merge-base against origin/main and
// only report tokens on lines this change ADDED.
//
// SCOPE IS NARROWER THAN #3026 FILED, on measurement: `docs/agent/**` + the `leash: spec` contracts, NOT
// `backlog/`. Over the 40 most recent merges the filed scope produces 503 findings on 22 merges (nearly all
// of them an open item correctly describing work not yet done); this scope produces 0 on 0, while still
// putting 271 real tokens through resolution. #3026 stays open for the backlog half.
//
// WARN, not error, deliberately — three reasons. (1) It matches the sibling citation gates and the
// CITATION_GATES_ENFORCED posture #2821 set for the same "don't red the gate on a corpus nobody is touching"
// reason. (2) The escape vocabulary ships in THIS change, so on day one no existing author knows it; erroring
// would punish people for not following a convention younger than their branch. (3) An unresolvable token is
// a strong smell, not a proof — the resolution index is a whole-tree name scan, and a gate that blocks every
// PR on a smell is worse than no gate. The INFRASTRUCTURE half is fail-closed the way lane-verify.mjs refuses
// a corrupt marker: if the merge base cannot be resolved we say so out loud rather than silently scanning
// nothing and reporting clean. It stays non-fatal (a fresh clone legitimately has no origin/main).
{
  const PROVENANCE_DOC_DIRS = ['docs/'];
  // The `leash: spec` tier (#2771/#2785) — the declarative-leash contracts, derived from the roster so a new
  // spec member is covered automatically rather than by a hand-copied list that drifts.
  const specHomes = new Set(TRUST_CHAIN.filter((e) => e.leash === 'spec').flatMap((e) => e.homes || []));
  const inScope = (p) =>
    (PROVENANCE_DOC_DIRS.some((d) => p.startsWith(d)) && p.endsWith('.md')) || specHomes.has(p);

  let base = null;
  let baseError = null;
  try {
    base = execFileSync('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (e) {
    baseError = String(e?.message || e).split('\n')[0];
  }

  if (!base) {
    // Fail LOUD, not silent. A gate that cannot compute its scope must never report "clean".
    warn(`provenance gate (#3026) could not resolve a diff base (\`git merge-base origin/main HEAD\`: ${baseError ?? 'no output'}) — ` +
      `added-prose identifier citations were NOT checked this run. Fetch origin/main and re-run to restore the check.`,
      { kind: 'provenance-gate-unscoped', file: 'scripts/check-standards.mjs', global: true });
  } else {
    // Added lines per in-scope file, base → WORKING TREE (so uncommitted prose is gated too, not just commits).
    const addedByFile = new Map();
    try {
      const diff = execFileSync('git', ['diff', '--unified=0', base, '--', 'docs', 'scripts'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
      let file = null;
      for (const line of diff.split('\n')) {
        const fm = line.match(/^\+\+\+ b\/(.+)$/);
        if (fm) { file = fm[1] === '/dev/null' ? null : fm[1]; continue; }
        const hm = line.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
        if (hm && file && inScope(file)) {
          const start = Number(hm[1]);
          const count = hm[2] === undefined ? 1 : Number(hm[2]);
          if (count === 0) continue; // pure deletion hunk — nothing was added
          if (!addedByFile.has(file)) addedByFile.set(file, new Set());
          const set = addedByFile.get(file);
          for (let i = 0; i < count; i++) set.add(start + i);
        }
      }
    } catch (e) {
      warn(`provenance gate (#3026) could not read the diff against ${base.slice(0, 8)} (${String(e?.message || e).split('\n')[0]}) — ` +
        `added-prose identifier citations were NOT checked this run.`,
        { kind: 'provenance-gate-unscoped', file: 'scripts/check-standards.mjs', global: true });
    }

    if (addedByFile.size > 0) {
      // Build the resolution index ONLY when something in scope actually changed — it reads the whole source
      // tree, so an untouched run must not pay for it.
      // Source ext + prose-dir + TEST-FILE exclusion all live in `isIndexableSourcePath` (citation-check.mjs)
      // so they are unit-coverable — the test-file exclusion is the gate's most mutation-fragile line (delete
      // it and this suite's own 'enforceFlipReady'/'collectOpenItemIds' literals make every historical
      // regression "resolve"), and it previously had no unit at all.
      let index = null;
      try {
        const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
          .split('\0').filter((f) => isIndexableSourcePath(f));
        // readFileSync + a JS regex treat a NUL byte as an ordinary character, so the three deliberate
        // NUL-sentinel scripts (guard-bash.mjs, renumber-collisions.mjs, component-render-build-hook.cjs)
        // index normally here — unlike plain `grep`, which silently reports nothing on them.
        const bodies = [];
        for (const f of tracked) { try { bodies.push(readFileSync(join(ROOT, f), 'utf8')); } catch { /* unreadable — skip */ } }
        index = buildIdentifierIndex(bodies);
      } catch (e) {
        warn(`provenance gate (#3026) could not build the identifier index (${String(e?.message || e).split('\n')[0]}) — ` +
          `added-prose identifier citations were NOT checked this run.`,
          { kind: 'provenance-gate-unscoped', file: 'scripts/check-standards.mjs', global: true });
      }

      if (index) {
        const markers = PROVENANCE_ESCAPE_MARKERS.map((m) => `\`(${m})\``).join(', ');
        for (const [rel, addedLines] of [...addedByFile.entries()].sort()) {
          let content;
          try { content = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; } // deleted since — nothing to cite
          const syntax = rel.endsWith('.md') ? 'markdown' : 'comment';
          // A file's comments resolve against the tree PLUS its own CODE. Excluding test files wholesale
          // over-corrects: a conformance suite's JSDoc legitimately names the helpers defined right below it
          // (`isOpenItem`, `staleOwedTo`, …) and those must resolve, while a name the JSDoc invents and the
          // file never defines (`collectOpenItemIds` — the real round-1 miss) must not. buildIdentifierIndex
          // strips comments, so the local pass indexes this file's code only, never its own prose.
          const localIndex = syntax === 'comment' ? buildIdentifierIndex([content]) : null;
          const resolves = (t) => index.has(t) || (localIndex !== null && localIndex.has(t));
          for (const f of findUnresolvedIdentifiers(content, { resolves, addedLines, syntax })) {
            if (f.kind === 'escape-no-reason') {
              warn(`${rel}:${f.line}: \`provenance-lint: off\` states no reason, so it does NOT suppress anything ` +
                `(#3026) — an unexplained blanket escape is refused by design. Write ` +
                `\`provenance-lint: off — <why these names do not resolve>\`, and close it with \`provenance-lint: on\`.`,
                { kind: 'provenance-escape-no-reason', file: rel });
              continue;
            }
            if (f.kind === 'escape-unclosed') {
              warn(`${rel}:${f.line}: this \`provenance-lint: off\` region is never closed, so it suppresses ` +
                `every identifier citation to the END OF THE FILE (#3026) — including every section appended ` +
                `later. Close it with \`<!-- provenance-lint: on -->\` right after the block it is meant to ` +
                `cover. Opened at: "${f.context}"`,
                { kind: 'provenance-escape-unclosed', file: rel });
              continue;
            }
            warn(`${rel}:${f.line}: \`${f.token}\` is cited as ${f.form === 'call' ? 'a call' : 'an identifier'} ` +
              `but resolves to NO source file in this checkout (#3026). Either grep the real name and fix the ` +
              `citation, or mark it as not-asserted with one of ${markers} after the closing backtick — ` +
              `\`${f.token}\` (proposed). For a block of such names use ` +
              `\`<!-- provenance-lint: off — <reason> -->\` … \`<!-- provenance-lint: on -->\`. Near: "${f.context}"`,
              { kind: 'provenance-unresolved-identifier', file: rel });
          }
        }
      }
    }
  }
}

mark("6f-iii. PROVENANCE gate (#3026) — a backticked identifier in prose must resolve, or be marked");
// ── 6g. Catalog-index completeness — every artifact type is reachable from a top-level index + nav ──
// The recurring "expose everything" drift (#1803): a type ships detail pages (/<type>/{id}/) but never
// gets a top-level index (/<type>/) or a nav entry, so it's only reachable by deep-linking. Derive the
// detail-page type set from the templates themselves (a permalink "<type>/{{ …id }}/" right after the
// quote — nested permalinks like "capabilities/adapters/{{ … }}/" don't match, by design) so a NEW
// registry can't silently skip its index. A type is satisfied by (a) an index resolving to /<type>/
// (a src/<type>.njk, or any template with permalink "<type>/") and (b) a weNavLink("/<type>/", …) in
// base.njk — unless it's on an explicit exemption allowlist WITH a reason.
{
  const SRC = join(ROOT, 'src');
  const njk = readdirSync(SRC).filter((f) => f.endsWith('.njk'));
  const fileContent = new Map(njk.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));
  const navContent = fileContent.get('_layouts/base.njk') // base.njk lives under _layouts; read it directly
    ?? readFileSync(join(SRC, '_layouts', 'base.njk'), 'utf8');

  // A type is exempt from the INDEX and/or NAV requirement only with a stated reason.
  const INDEX_EXEMPT = {
    projects: 'the homepage (/) is the projects catalog — it lists every project grouped by category',
  };
  const NAV_EXEMPT = {
    projects: 'reached from the homepage hero/grid, not the Standards menu (its catalog is /)',
  };

  // Derive detail-page types: permalink "<type>/{{ …id }}/" anchored right after the opening quote.
  const detailTypes = new Set();
  for (const content of fileContent.values()) {
    const m = content.match(/permalink:\s*["']([a-z0-9-]+)\/\{\{/);
    if (m) detailTypes.add(m[1]);
  }

  for (const type of [...detailTypes].sort()) {
    const hasIndexFile = existsSync(join(SRC, `${type}.njk`));
    const hasIndexPermalink = [...fileContent.values()].some((c) =>
      new RegExp(`permalink:\\s*["']${type}/["']`).test(c));
    const hasIndex = hasIndexFile || hasIndexPermalink;
    const hasNav = navContent.includes(`weNavLink("/${type}/"`) || navContent.includes(`weNavLink('/${type}/'`);

    if (!hasIndex && !(type in INDEX_EXEMPT))
      err(`Catalog type "${type}" has detail pages (/${type}/{id}/) but no top-level index resolving to /${type}/ ` +
          `— add a src/${type}.njk index (mirror src/adapters.njk), or add it to INDEX_EXEMPT in check-standards.mjs with a reason (#1803).`,
          { kind: 'catalog-index', file: `src/${type}.njk` });
    if (!hasNav && !(type in NAV_EXEMPT))
      err(`Catalog type "${type}" has detail pages but no nav entry — add weNavLink("/${type}/", "…") to src/_layouts/base.njk, ` +
          `or add it to NAV_EXEMPT in check-standards.mjs with a reason (#1803).`,
          { kind: 'catalog-nav', file: 'src/_layouts/base.njk' });
  }
}

mark("6g. Catalog-index completeness — every artifact type is reachable from a top-level index + nav");
// ── 7. AGENTS.md inventory must be in sync (generated, not hand-edited) ────────
// #4167 — `renderInventory()` reads the WHOLE repo's registries to re-derive AGENTS.md, and the one finding
// it can produce is unconditionally `global: true` (see below): an isolated `--local` lane defers this to
// the per-merge gate regardless (#1159), so under `--local` don't pay for the render at all.
if (!LOCAL_MODE) {
  try {
    const agentsPath = join(ROOT, 'AGENTS.md');
    const current = readFileSync(agentsPath, 'utf8');
    if (spliceInventory(current, renderInventory()) !== current)
      // `global: true` — AGENTS.md is a DERIVED artifact the integrator regenerates ONCE after merge; an
      // isolated `--local` lane never runs `gen:inventory`, so this defers to the per-merge gate (#1159).
      err('AGENTS.md inventory is stale — run `npm run gen:inventory`', { kind: 'inventory', file: 'AGENTS.md', global: true });
  } catch (e) {
    err(`AGENTS.md inventory check failed: ${e.message}`);
  }
}

mark("7. AGENTS.md inventory must be in sync (generated, not hand-edited)");
// ── 8. No compiled artifacts shadowing TS sources ────────────────────────────
// A stray `tsc <file>` (or an editor "compile on save") emits `.js`/`.d.ts` next to the `.ts`/
// `.tsx` source, ignoring tsconfig `outDir`. Because Vite/vitest resolve extensionless imports
// `.js` BEFORE `.tsx`, the stale `.js` then silently shadows the real source in tests — and tsc
// does not honour `jsxInject`, so JSX fixtures throw `jsx is not defined` while looking "done".
// (This is exactly what masked backlog #067's conformance suite.) Fail on any such shadow so the
// drift can't return; clean with e.g. `find blocks plugs demos -name '*.js' -delete` (paired only).
const COMPILE_ROOTS = ['blocks', 'plugs', 'demos'].map((d) => join(ROOT, d)).filter(existsSync);
const walk = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name === '_site') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};
// The fs walk stays here; the `.js`/`.d.ts` ↔ `.ts`/`.tsx` pairing is the pure `findCompiledShadows` (#256).
const allCompileFiles = COMPILE_ROOTS.flatMap((r) => walk(r));
{
  const { errors: se } = findCompiledShadows(allCompileFiles, (f) => f.replace(ROOT + '/', ''));
  for (const e of se) err(e.message, e.descriptor);
}

mark("8. No compiled artifacts shadowing TS sources");
// ── 8b. Plug runtime dual-mode conformance (#636, enforcing the #606 invariants) ─
// Every plug domain must ship passing tests for BOTH the unplugged (non-invasive)
// and plugged modes, and none may require plugged mode (the unplugged form is the
// mandatory real-app surface; plugged is POC). The fs walk lives here; the pure
// rule is `validatePlugDualMode`. Skip silently when the plug runtime isn't checked
// out here — #606 makes Frontier UI the canonical home, so a WE tree without plugs/
// (post-#449) is expected, not a failure.
{
  const plugsRoot = join(ROOT, 'plugs');
  if (existsSync(plugsRoot)) {
    const sharedTestsDir = join(plugsRoot, '__tests__');
    const sharedTests = existsSync(sharedTestsDir)
      ? walk(sharedTestsDir).filter((f) => /\.(test|spec)\.[tj]sx?$/.test(f))
      : [];
    const sharedTestBlobs = sharedTests.map((f) => ({ f, c: readFileSync(f, 'utf8') }));
    const domains = readdirSync(plugsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^web/.test(e.name))
      .map((e) => {
        const dir = join(plugsRoot, e.name);
        const files = walk(dir);
        const isTest = (f) => /\.(test|spec)\.[tj]sx?$/.test(f);
        const hasSource = files.some((f) => /\.tsx?$/.test(f) && !isTest(f) && !f.includes('/__tests__/'));
        const localTests = files.filter(isTest).map((f) => ({ f, c: readFileSync(f, 'utf8') }));
        const allTests = [...localTests, ...sharedTestBlobs];
        // unplugged-mode test = imports the non-invasive `unplugged` API AND touches this domain.
        const hasUnpluggedTest = allTests.some(
          ({ f, c }) => /unplugged/.test(c) && (c.includes(`/${e.name}/`) || f.includes(e.name)),
        );
        // plugged-mode test = the domain's own tests (register + upgrade in real DOM) or a shared
        // e2e/integration spec exercising it via the global-patched path.
        const hasPluggedTest =
          localTests.length > 0 || sharedTestBlobs.some(({ f, c }) => f.includes(e.name) || c.includes(`/${e.name}/`));
        return { name: e.name, hasSource, hasUnpluggedTest, hasPluggedTest };
      });
    const { errors: pe, warnings: pw } = validatePlugDualMode(domains);
    for (const e of pe) err(e.message, e.descriptor);
    for (const w of pw) warn(w.message, w.descriptor);
  }
}

mark("8b. Plug runtime dual-mode conformance (#636, enforcing the #606 invariants)");
// ── 8c. Block contract↔impl drift conformance (#659, the #606/#641 plugs analogue) ─
// WE blocks are pure protocols; the impl lives in FUI (`implementedBy: @frontierui/blocks/…`).
// When the sibling FUI repo is checked out, every `implementedBy` must resolve to a real impl
// path — a reference that no longer resolves is contract↔impl drift (#170, blocks edition). The
// content arm is detect-or-skip: a WE tree without ../frontierui (CI without the sibling repo) is
// expected, not a failure (mirrors 8b). The fs resolution lives here; the pure rule is
// `validateBlockImplConformance`.
{
  const fuiBlocks = join(ROOT, '..', 'frontierui', 'blocks');
  const fuiPresent = existsSync(fuiBlocks);
  // Resolve `@frontierui/blocks/<rel>` to a real path: a `.ext` reference is a file; an extension-less
  // reference is a dir (optionally with an index module). null when FUI isn't checked out (→ skip).
  const resolveImpl = (implementedBy) => {
    if (!fuiPresent) return null;
    const rel = implementedBy.replace(/^@frontierui\/blocks\//, '').replace(/\/$/, '');
    const target = join(fuiBlocks, rel);
    if (existsSync(target)) return true;
    if (!/\.[a-z]+$/.test(rel)) return ['index.ts', 'index.js'].some((f) => existsSync(join(target, f)));
    return false;
  };
  const blockImpl = blocks
    .filter((b) => b.implementedBy)
    .map((b) => ({ id: b.id, implementedBy: b.implementedBy, implPresent: resolveImpl(b.implementedBy) }));
  // Skip silently when ../frontierui isn't checked out (mirrors 8b) — the content arm just can't run.
  const { errors: be, warnings: bw } = validateBlockImplConformance(blockImpl);
  for (const e of be) err(e.message, e.descriptor);
  for (const w of bw) warn(w.message, w.descriptor);

  // ── 8d. compose-don't-hand-roll deny-list (#937, Fork 1 of #933) ──
  // The inverse of 8c/§3b: a block that hand-rolls behaviour it should have COMPOSED. Curated by block
  // id (COMPOSE_DENY_LIST), so we only read the FUI source of the named targets — concatenate the impl
  // dir's *.ts so a multi-file signature sees the whole surface. The pure rule does the matching; this
  // just gathers source (detect-or-skip when ../frontierui is absent, mirrors 8c).
  {
    const targets = new Set(COMPOSE_DENY_LIST.flatMap((r) => r.appliesTo));
    const readBlockSource = (implementedBy) => {
      if (!fuiPresent || !implementedBy) return null;
      const rel = implementedBy.replace(/^@frontierui\/blocks\//, '').replace(/\/$/, '');
      const target = join(fuiBlocks, rel);
      // implementedBy may name a file or a dir; scan the impl directory's TS either way.
      const dir = /\.[a-z]+$/.test(rel) ? dirname(target) : target;
      if (!existsSync(dir)) return null;
      const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((ent) => {
        const p = join(d, ent.name);
        if (ent.isDirectory()) return walk(p);
        return /\.ts$/.test(ent.name) && !/\.test\.ts$/.test(ent.name) ? [readFileSync(p, 'utf8')] : [];
      });
      return walk(dir).join('\n');
    };
    const composeInput = blocks
      .filter((b) => targets.has(b.id))
      .map((b) => ({ id: b.id, composesBehaviors: b.composesBehaviors, source: readBlockSource(b.implementedBy) }));
    const { errors: ce, warnings: cw } = validateBlockComposesTraits(composeInput);
    for (const e of ce) err(e.message, e.descriptor);
    for (const w of cw) warn(w.message, w.descriptor);
  }

  // ── 8e. Block export-shape drift (#927) — declared `exports` vs the resolved FUI barrel surface ──
  // The deeper #170 arm #659 deferred: not just "does the impl resolve?" (8c) but "does it export the
  // surface the contract declares?". Scoped to barrel blocks (implementedBy `…/index.ts` + a declared
  // `exports`); a real TS program resolves the barrel's actual exports so `export type *` and
  // `@webeverything/contracts/…` re-exports are FOLLOWED (a regex can't). Detect-or-skip when FUI is
  // absent. Warn-first (the pure rule gates on EXPORT_SHAPE_ENFORCED). Renderer/file-pointer blocks have
  // no enumerable barrel → un-coverable here (#1164).
  {
    const barrelBlocks = blocks.filter(
      (b) => b.implementedBy && /\/index\.ts$/.test(b.implementedBy) && Array.isArray(b.exports) && b.exports.length,
    );
    // Build ONE TS program over all barrel entry files, using FUI's tsconfig so the path-mappings
    // (@webeverything/contracts/*, @core/*, …) resolve the re-export specifiers. Wrapped so any TS/FS
    // failure degrades to skip (actualExports=null), never crashes the gate.
    let resolveExports = () => null;
    if (fuiPresent) {
      try {
        const ts = createRequire(import.meta.url)('typescript');
        const fuiRoot = join(ROOT, '..', 'frontierui');
        const entries = barrelBlocks.map((b) =>
          join(fuiRoot, b.implementedBy.replace(/^@frontierui\/blocks\//, 'blocks/')),
        );
        const cfgPath = join(fuiRoot, 'tsconfig.json');
        const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, fuiRoot);
        const program = ts.createProgram(entries, {
          ...parsed.options,
          noEmit: true,
          skipLibCheck: true,
          allowJs: true,
        });
        const checker = program.getTypeChecker();
        resolveExports = (absPath) => {
          const sf = program.getSourceFile(absPath);
          if (!sf) return null;
          const sym = checker.getSymbolAtLocation(sf);
          if (!sym) return null;
          return checker.getExportsOfModule(sym).map((s) => s.getName());
        };
      } catch {
        resolveExports = () => null; // TS unavailable / config unreadable → skip the whole arm
      }
    }
    const exportInput = barrelBlocks.map((b) => ({
      id: b.id,
      implementedBy: b.implementedBy,
      declaredExports: b.exports,
      actualExports: resolveExports(join(ROOT, '..', 'frontierui', b.implementedBy.replace(/^@frontierui\/blocks\//, 'blocks/'))),
    }));
    const { errors: ee, warnings: ew } = validateBlockExportShape(exportInput);
    for (const e of ee) err(e.message, e.descriptor);
    for (const w of ew) warn(w.message, w.descriptor);
    // Renderer / file-pointer blocks have no enumerable barrel — logged un-coverable (#1164), not failed.
    const uncoverable = blocks.filter(
      (b) => b.implementedBy && Array.isArray(b.exports) && b.exports.length && !/\/index\.ts$/.test(b.implementedBy),
    );
    if (fuiPresent && uncoverable.length)
      warn(`Block export-shape arm (#927): ${uncoverable.length} non-barrel block(s) are un-coverable (no enumerable index barrel) — renderer/file-pointer impls, tracked by #1164.`);
  }
}

mark("8c. Block contract↔impl drift conformance (#659, the #606/#641 plugs analogue)");
// ── 8f. Plug contract↔impl drift conformance (#1309, the §8c/#659 plugs analogue) ──
// WE owns the plug platform layer; FUI ports each plug domain UP to the WE contract (#1250 reconcile
// epic). Two arms, both detect-or-skip when ../frontierui is absent (mirrors 8c): (1) every we:plugs/
// <domain> must have a fui:plugs/<domain> impl dir; (2) the declared byte-identical plug-core contract
// files (PLUG_SHARED_CORE_FILES, #1304/#1350) must match FUI byte-for-byte. The fs reads live here; the
// pure rule is `validatePlugWeFuiDrift`. Lands after the reconciliation slices, so it is green.
{
  const wePlugsDir = join(ROOT, 'plugs');
  const fuiPlugsDir = join(ROOT, '..', 'frontierui', 'plugs');
  const fuiPresent = existsSync(fuiPlugsDir);
  // Infrastructure entries under plugs/ that are not reconcilable WE↔FUI domains.
  const INFRA = new Set(['core', '__tests__', 'utils']);
  const domains = existsSync(wePlugsDir)
    ? readdirSync(wePlugsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !INFRA.has(e.name))
        .map((e) => ({ domain: e.name, implPresent: fuiPresent ? existsSync(join(fuiPlugsDir, e.name)) : null }))
    : [];
  const parityFiles = PLUG_SHARED_CORE_FILES.map((rel) => {
    const weFile = join(ROOT, rel);
    const fuiFile = join(ROOT, '..', 'frontierui', rel);
    let identical = null; // FUI absent, or the WE file itself is missing → skip
    if (fuiPresent && existsSync(weFile)) {
      // A declared-shared file missing on the FUI side is itself drift; else compare bytes.
      identical = existsSync(fuiFile) && readFileSync(weFile, 'utf8') === readFileSync(fuiFile, 'utf8');
    }
    return { file: rel, identical };
  });
  const { errors: pe, warnings: pw } = validatePlugWeFuiDrift({ domains, parityFiles });
  for (const e of pe) err(e.message, e.descriptor);
  for (const w of pw) warn(w.message, w.descriptor);
}

mark("8f. Plug contract↔impl drift conformance (#1309, the §8c/#659 plugs analogue)");
// ── 9. Vite dev-proxy allowlist must cover every 11ty catalog route ────────────
// A new catalog page renders on the 11ty server (:8080) but 404s on the Vite dev server (:3000)
// until its top-level URL segment is hand-added to the proxy allowlist in vite.config.mts. The 11ty
// `--serve` watcher picks a new `.njk` up automatically; the Vite proxy does not — its catalog list
// is a hard-coded alternation, so every new discovery surface is one silent papercut from a broken
// local URL. Cross-check each `src/*.njk` permalink's first path segment against the proxy config so
// the drift fails the build instead of becoming a local-only 404 (backlog #210).
// The fs reads (vite.config.mts + the src/*.njk bodies) stay here; the proxy-key extraction is local,
// but `permalinkSegment` (first-segment parse) and `validateViteProxyCoverage` (the bounded-match
// coverage regex — the gnarly bit) are the pure rules, fixture-tested in __tests__ (#256).
try {
  const SRC = join(ROOT, 'src');
  const viteCfg = readFileSync(join(ROOT, 'vite.config.mts'), 'utf8');
  // Proxy keys are the only quoted, path-like object keys whose value is a proxy entry — either an
  // inline `: {` block or the shared `: proxyToEleventy(` helper that DRYs the Eleventy-forwarded
  // entries. (resolve aliases map to string values, not entries; other plugins aren't quoted path
  // keys.) Collect them as the authoritative set of routes Vite forwards to 8080.
  const proxyKeys = [...viteCfg.matchAll(/^\s*(['"])(\^?\/[^'"]*)\1\s*:\s*(?:\{|proxyToEleventy\()/gm)].map((m) => m[2]).join(' ');
  const needed = new Map(); // top-level segment → example njk file that produces it
  for (const f of readdirSync(SRC).filter((n) => n.endsWith('.njk'))) {
    if (f === 'index.njk') continue; // root, served by the `^/(index\.html)?$` rule
    const seg = permalinkSegment(readFileSync(join(SRC, f), 'utf8'), f);
    if (seg && !needed.has(seg)) needed.set(seg, f);
  }
  const segments = [...needed].map(([seg, file]) => ({ seg, file }));
  const { errors: ve } = validateViteProxyCoverage(segments, proxyKeys);
  for (const e of ve) err(e.message, e.descriptor);
} catch (e) {
  err(`Vite proxy allowlist check failed: ${e.message}`);
}

mark("9. Vite dev-proxy allowlist must cover every 11ty catalog route");
// ── 9a-rules. Statute-layer integrity gate (#1828 resolution + #2083 duplicates/orphans/substance) ──
// The statute layer (docs/agent/platform-decisions.md + 3 siblings) renders at /rules/, and ~229
// `codifiedIn:` frontmatter values across backlog/*.md cite anchors in it. platform-decisions.md is
// edited every decision-resolve, so a renamed heading would silently 404 every inbound cite; a `{#id}`
// defined twice renders a duplicate HTML id; an unreferenced named anchor is a dead cluster; a cited
// anchor with no body is a rule in name only. All four rules live in scripts/lib/validate-rules-anchors.cjs
// (standalone: `npm run check:statute`), re-using the loader's anchor extraction so the gate and the
// rendered page can never disagree.
// #70d — `dynamicInputs`: every enforcer path the invariant catalogue names is an input too (the rule checks
// that it exists), so a lane deleting/renaming one still runs this section in scoped mode.
if (!sectionGate.shouldRun('9a-rules', { dynamicInputs: () => {
  const { collectEnforcerPaths, enforcerPathCandidates } = require('./lib/validate-rules-anchors.cjs');
  const cat = JSON.parse(readFileSync(join(ROOT, 'scripts', 'lib', 'invariant-catalogue.json'), 'utf8'));
  return cat.invariants.flatMap((inv) => collectEnforcerPaths(inv?.howChecked).flatMap(enforcerPathCandidates));
} })) skippedMark('9a-rules');
else try {
  const { runStatuteCheck } = require('./lib/validate-rules-anchors.cjs');
  const { errors: re, warnings: rw } = runStatuteCheck();
  for (const e of re) err(e.message, e.descriptor);
  for (const w of rw) warn(w.message, w.descriptor);
} catch (e) {
  err(`Statute-layer integrity check failed: ${e.message}`);
}

mark("9a-rules. Statute-layer integrity gate (#1828 resolution + #2083 duplicates/orphans/substance)");
// ── 9a′. Agent-memory freshness (#2087) ──
// The hand-curated leaves under .claude/agent-memory/ carry no freshness guarantee: a leaf can cite a
// decision the project has since ruled the other way, or a statute anchor renamed out from under it, and
// an agent applies the stale hook silently. This folds the freshness audit (dangling `#NNNN`, cite to an
// unsettled `kind: decision`, orphaned `docs/agent/*.md#anchor`) into the everyday gate. WARNINGS only —
// a curation nudge, never build-breaking (a leaf may deliberately cite an open decision). Standalone:
// `npm run check:memory-freshness`.
if (!sectionGate.shouldRun('9a-prime')) skippedMark('9a-prime');
else try {
  const { runMemoryFreshnessCheck } = require('./lib/memory-freshness.cjs');
  const { warnings: fw } = runMemoryFreshnessCheck();
  for (const w of fw) warn(w.message, w.descriptor);
} catch (e) {
  warn(`Agent-memory freshness audit failed: ${e.message}`);
}

mark("9a′. Agent-memory freshness (#2087)");
// ── 9a′-ii. Agent-memory citation integrity (#2921) ──
// Different in kind from 9a′ above: these three signals reproduce the three factual errors the /review
// of PR #1045 found in one 7-line memory paragraph — a wrong impl arm, a quoted guard section that exists
// in no cited document, and (not mechanizable) a gloss that inverted a ruling's direction — none of which
// any existing gate caught. A leaf making a false claim about the repo is a wrong INSTRUCTION every future
// session loads before acting, so these are ERRORS, not curation nudges. Standalone: none — folded
// straight into check:standards since the whole point is gate-time visibility (#2921 Why-now).
if (!sectionGate.shouldRun('9a-prime-ii')) skippedMark('9a-prime-ii');
else try {
  const { runMemoryCitationLintCheck } = require('./lib/memory-freshness.cjs');
  const { errors: ce } = runMemoryCitationLintCheck();
  for (const e of ce) err(e.message, e.descriptor);
} catch (e) {
  err(`Agent-memory citation-integrity check failed: ${e.message}`);
}

mark("9a′-ii. Agent-memory citation integrity (#2921)");
// ── 9a″. Agent-memory index-tree shape (#2192) ──
// The always-loaded MEMORY.md is injected into every session; the harness silently truncates it above
// its budget, dropping load-bearing rules with no warning. This check enforces: (1) size ≤ budget,
// (2) per-line ≤ 200 chars, (3) MEMORY.md links ONLY index-*.md sub-indexes (not raw leaves), and
// (4) every leaf file is reachable from some index. Errors here are REAL file-local violations authored
// in .claude/agent-memory/ — they block the lane fast-fail. Standalone: `npm run check:memory`.
try {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/check-memory.mjs')], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || '').trim();
    // extract individual violation lines; fall back to the raw output as one error
    const lines = msg.split('\n').filter((l) => l.startsWith('  - ') || l.startsWith('✗'));
    if (lines.length) {
      for (const l of lines.filter((l) => l.startsWith('  - ')))
        err(`memory-index: ${l.replace(/^\s*-\s*/, '')}`, { kind: 'memory-index', file: '.claude/agent-memory/MEMORY.md' });
    } else {
      err(`memory-index: ${msg || 'check:memory failed'}`, { kind: 'memory-index', file: '.claude/agent-memory/MEMORY.md' });
    }
  }
} catch (e) {
  warn(`Agent-memory index-tree check failed: ${e.message}`);
}

mark("9a″. Agent-memory index-tree shape (#2192)");
// ── 9b. Module-resolution exports-lock (#274/#271) ──
// Gather every `@frontierui/*` (locked-scope) entry from the project's SHIPPED native resolution
// manifests — vite `resolve.alias` + every `<script type="importmap">` in the served catalog pages
// (src/*.{njk,html}) — and assert each terminates at the package exports (URL / node_modules / bare
// specifier), never a raw in-repo source path. The lock is "protocol is the only lock"; it guards a
// frontierui repoint (#265) from silently aliasing the shipped config back to WE/foreign source.
// Scope note: POC sandbox demos (demos/*.html) are intentionally NOT scanned — they predate the
// published package and stand-in with a local src path by design (Demo-First); the lock governs the
// project's real resolution config, not throwaway sandboxes. (maas-consumer-demo's @frontierui/jsx
// importmap is a known such case, to be cleaned up with the jsx-runtime dedupe #265/#081.)
try {
  const entries = [];
  // vite resolve.alias: `'key': 'value'` string pairs inside the alias block.
  const viteCfg = readFileSync(join(ROOT, 'vite.config.mts'), 'utf8');
  for (const m of viteCfg.matchAll(/(['"])(@[^'"]+)\1\s*:\s*(['"])([^'"]+)\3/g))
    entries.push({ specifier: m[2], target: m[4], source: 'vite.config.mts resolve.alias' });
  // importmaps in served catalog pages: parse each `<script type="importmap">…</script>` JSON `imports`.
  const importmapSources = [];
  const srcDir = join(ROOT, 'src');
  for (const f of readdirSync(srcDir).filter((n) => n.endsWith('.njk') || n.endsWith('.html')))
    importmapSources.push([`src/${f}`, readFileSync(join(srcDir, f), 'utf8')]);
  for (const [source, body] of importmapSources) {
    for (const block of body.matchAll(/<script[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      let map;
      try { map = JSON.parse(block[1]); } catch { continue; } // skip non-JSON / templated importmaps
      for (const [specifier, target] of Object.entries(map.imports ?? {}))
        entries.push({ specifier, target, source: `${source} importmap` });
    }
  }
  const { errors: me } = validateModuleResolutionLock(entries);
  for (const e of me) err(e.message, e.descriptor);
} catch (e) {
  err(`Module-resolution exports-lock check failed: ${e.message}`);
}

mark("9b. Module-resolution exports-lock (#274/#271)");
// ── 9c. Codegen-placement invariants (#964 — hardening #956's ruling) ──
// #956 settled: `serve()`'s form-generators stay WE-repo reference runtime (#791); `@webeverything`
// ships only contract + vectors (#855). Its skeptic flagged both invariants as true-by-absence; this
// makes them enforced. (1) No `@webeverything/*` published package may re-export `blocks/renderers/*`.
// (2) The WE-side `serve()` form catalog stays frozen to the ratified reference-runtime set — a new
// framework dialect can't be slipped into the WE renderer to manufacture a WE-side codegen consumer; it
// must go through the FUI genWrapper pattern. The fs gather lives here; the pure rules do the asserting.
if (!sectionGate.shouldRun('9c')) skippedMark('9c');
else try {
  // (1) gather every in-repo package.json manifest (root + nested, excluding node_modules) → name + exports.
  const manifests = [];
  const walkPkgs = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.')) continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walkPkgs(p);
      else if (ent.name === 'package.json') {
        const rel = relative(ROOT, p);
        try {
          const raw = readFileSync(p, 'utf8');
          // #2149 Fork 1: duplicate-key merge gate — JSON.parse can't see a dup key, so lint the raw text.
          for (const e of validateNoDuplicateManifestKeys(raw, rel)) err(e.message, e.descriptor);
          const pkg = JSON.parse(raw);
          manifests.push({ name: pkg.name, exports: pkg.exports, source: rel });
        } catch { /* unparseable package.json — skip */ }
      }
    }
  };
  walkPkgs(ROOT);
  const { errors: pe } = validateRenderersNotPublished(manifests);
  for (const e of pe) err(e.message, e.descriptor);

  // (2) parse the WE-side serve() form catalog (`ServeForm` union ids) and assert it stays the ratified set.
  const moduleService = join(ROOT, 'blocks', 'renderers', 'module-service', 'moduleService.ts');
  if (existsSync(moduleService)) {
    const src = readFileSync(moduleService, 'utf8');
    const union = src.match(/export type ServeForm\s*=\s*([^;]+);/);
    const formIds = union
      ? [...union[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
      : [];
    const { errors: fe } = validateReferenceRuntimeForms(formIds);
    for (const e of fe) err(e.message, e.descriptor);
  }
} catch (e) {
  err(`Codegen-placement invariants check failed: ${e.message}`);
}

mark("9c. Codegen-placement invariants (#964 — hardening #956's ruling)");
// ── Demos: operational-wiring gate (routing/base-path/registry/dev-fallback) ────
// Complements check:app-conformance (which validates standard USE). The static checks live in
// check-demos.mjs and are composed here so the everyday gate catches the base-path reload bug class
// (loan-origination / auto-insurance #317/#318). The --live HTTP probe stays opt-in on `check:demos`.
try {
  const { errors: de, warnings: dw } = checkDemos();
  for (const e of de) err(e.message, e.descriptor);
  for (const w of dw) warn(w.message, w.descriptor);
} catch (e) {
  err(`Demo operational-wiring check failed: ${e.message}`);
}

mark("Demos: operational-wiring gate (routing/base-path/registry/dev-fallback)");
// ── Backlog badge single-source (anti-drift) ────────────────────────────────────
// The /backlog/ tile + Prioritisation table (src/backlog.njk) and the /backlog/{id}/ detail page
// (src/backlog-pages.njk) must render every badge/chip from the ONE shared macro file
// (src/_includes/backlog-badges.njk) over the ONE shared vocabulary (src/_data/backlogMeta.js) — never a
// local copy. A re-declared macro is exactly how the two surfaces drifted before (a `preparing`/`program`
// colour added to one but not the other). So: each surface MUST import the shared file, and MUST NOT
// define any of the shared badge macros locally. Mechanical guard so the parity rule isn't just a comment.
{
  const SHARED_BADGE_MACROS = ['kindBadge', 'statusBadge', 'sizeBadge', 'tierBadge', 'unslicedBadge', 'metaBadge', 'epicStatusBadge', 'tagsRow', 'childCircle', 'blockerChip'];
  for (const rel of ['src/backlog.njk', 'src/backlog-pages.njk']) {
    const file = join(ROOT, rel);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, 'utf8');
    if (!/\{%\s*import\s+["']backlog-badges\.njk["']/.test(src))
      err(`${rel} must \`{% import "backlog-badges.njk" as bk with context %}\` — backlog badges render from the one shared macro source (anti-drift), not inline markup.`);
    const localDefs = SHARED_BADGE_MACROS.filter((m) => new RegExp(`\\{%\\s*macro\\s+${m}\\s*\\(`).test(src));
    if (localDefs.length)
      err(`${rel} re-defines shared badge macro(s) locally: ${localDefs.join(', ')}. Delete the local copy and call bk.<name>() — these live only in src/_includes/backlog-badges.njk so the tile and detail page can't drift (#777 dogfood seam).`);
  }
}

mark("Backlog badge single-source (anti-drift)");
// ── 10. Backlog kind-filter UI must cover every BACKLOG_KIND ───────────────────
// The /backlog/ board hides any card whose `data-kind` is not an *active filter chip*
// (src/assets/js/home-display.js → `failKind`). The chip set is built from hard-coded kind
// lists in src/backlog.njk (the "Tracked work" facet + the "Prioritisation" table facet). When a
// new kind is added to BACKLOG_KINDS (the SoT in check-standards-rules.mjs) but a UI list is not
// updated, EVERY item of that kind renders into the DOM yet is permanently invisible — there is no
// chip to re-enable it. That is exactly how `type: review` items (#602/#610) vanished from the board
// while passing every other check. Assert each hard-coded list covers the full kind vocabulary so
// the drift fails the gate instead of silently swallowing a whole class of items.
try {
  const njk = readFileSync(join(ROOT, 'src/backlog.njk'), 'utf8');
  // Both facets declare their order as a bracketed string-array literal of kind tokens. Match every
  // `[ "story", "epic", … ]` whose members are all known kinds — that uniquely identifies the two
  // kind-filter lists without coupling to surrounding template syntax.
  const KIND_TOKENS = [...BACKLOG_KINDS];
  const listLiterals = [...njk.matchAll(/\[((?:\s*["'][a-z]+["']\s*,?)+)\]/g)]
    .map((m) => m[1].match(/["']([a-z]+)["']/g).map((q) => q.replace(/["']/g, '')))
    .filter((toks) => toks.every((t) => BACKLOG_KINDS.has(t)) && toks.includes('decision'));
  if (!listLiterals.length)
    err('Backlog kind-filter check: could not find any kind-list literal in src/backlog.njk (template shape changed — update check-standards.mjs §10)');
  for (const toks of listLiterals) {
    const missing = KIND_TOKENS.filter((t) => !toks.includes(t));
    if (missing.length)
      err(`src/backlog.njk kind-filter list [${toks.join(', ')}] omits backlog kind(s) ${missing.map((t) => `"${t}"`).join(', ')} — those items render but are permanently hidden (no filter chip). Add them to every kind list in backlog.njk.`);
  }
} catch (e) {
  err(`Backlog kind-filter coverage check failed: ${e.message}`);
}

mark("10. Backlog kind-filter UI must cover every BACKLOG_KIND");
// ── 11. Static template a11y lint (#772, complements the #770/#771 rendered axe gate) ──
// Structural a11y rules that live in the .njk source and a headless axe run cannot observe from the
// computed page (it sees rendered DOM, not the authoring miss). Scoped to the site-chrome layouts —
// the #762 regression locus — so spec-content and breadcrumb navs never false-positive.
try {
  const LAYOUTS = join(ROOT, 'src/_layouts');
  const layouts = readdirSync(LAYOUTS)
    .filter((f) => f.endsWith('.njk') || f.endsWith('.html'))
    .map((f) => ({ path: `src/_layouts/${f}`, content: readFileSync(join(LAYOUTS, f), 'utf8') }));
  const { errors: ae, warnings: aw } = validateTemplateA11y(layouts);
  for (const e of ae) err(e.message);
  for (const w of aw) warn(w.message);
} catch (e) {
  err(`Static template a11y lint failed: ${e.message}`);
}

mark("11. Static template a11y lint (#772, complements the #770/#771 rendered axe gate)");
// ── 12. Standard-vs-site surface classifier (#2052, interim per #2006 Fork 2(b)) ──
// The WE repo intermingles WE-the-standard (zero-impl defs/gate/backlog) with the WE-website render (an
// artifact-producing 11ty+Vite product, mis-homed — end-state extraction gated on #872). #2006 Fork 2(b)
// ratified a directory boundary whose interim carrier is this fail-closed classifier: every path in the
// render-tree zone (`src/**`, where the two surfaces interleave) must classify as EXACTLY ONE of
// {standard, site}; a zone path matching neither is a HARD ERROR — so new site code can never masquerade
// as standard, nor a new standard def hide among the loaders, ahead of the physical `site/**` lift. The
// pure classifier (classifySurfacePaths) does the matching; the fs read (tracked paths) lives here.
try {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const { unclassified } = classifySurfacePaths(tracked);
  for (const p of unclassified)
    err(
      `Unclassified surface path "${p}" (#2052/#2006 Fork 2(b)): it lives under the render-tree zone (src/**) but matches neither the site-surface nor the standard-surface set, so the standard-vs-site boundary is ambiguous. Place it on the correct side of the seam — a render file (.njk/.js loader/layout/partial/asset/css) is SITE; a definition (.json registry/data file) is STANDARD — so new site code can't masquerade as standard. Extend the matchers in scripts/check-standards-rules.mjs only if a genuinely new surface class is introduced.`,
      { kind: 'surface-unclassified', file: p, global: false },
    );
} catch (e) {
  err(`Standard-vs-site surface classifier failed: ${e.message}`);
}

mark("12. Standard-vs-site surface classifier (#2052, interim per #2006 Fork 2(b))");
// ── 13. Playwright container-image pin lockstep (#2234) ────────────────────────
// The visual-regression CI jobs (ci.yml's `visual` job + update-visual-baselines.yml) render inside a
// version-locked `mcr.microsoft.com/playwright:vX.Y.Z-jammy` container so rendered pixels stay
// byte-reproducible across machines/CI. Fail loud if the image tag ever drifts from the installed
// `@playwright/test` version (package-lock.json) — the pure lockstep rule lives in
// check-standards-rules.mjs; the fs reads (workflow YAML + lockfile) stay here.
try {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const installedVersion = lock.packages?.['node_modules/@playwright/test']?.version ?? null;
  const filesReferences = PLAYWRIGHT_CONTAINER_PIN_REQUIRED_FILES.map((rel) => {
    const p = join(ROOT, rel);
    const text = existsSync(p) ? readFileSync(p, 'utf8') : '';
    return { file: rel, tags: extractPlaywrightContainerTags(text) };
  });
  const { errors: pce } = validatePlaywrightContainerPin({ installedVersion, filesReferences });
  for (const e of pce) err(e.message, e.descriptor);
} catch (e) {
  err(`Playwright container pin check failed: ${e.message}`);
}

mark("13. Playwright container-image pin lockstep (#2234)");
// ── 14. Enum-totality gate — VERDICTS (#2823, item xiqj3w9) + IMPACT_LEVELS (#xdompzx) ────────
// Every structure total over the `VERDICTS` enum (strictness/marker/label tables + the reducers that branch on a
// verdict) must handle EVERY member — a member added without updating one is the script-decidable class PR #976 hit
// three review rounds running. The gate is DERIVE-BASED (round-2 meta-finding): it DISCOVERS its coverage by scanning
// the enum's consumers in source (any symbol referencing ≥2 verdicts must carry a `@verdicts-total` marker, then is
// checked total), never a hand list — so a new consumer a future PR adds can't regress a table nobody remembered to
// list. The member set is DERIVED from the real `VERDICTS` import, so the gate can't drift from the enum it guards.
// Pure rule in `lib/verdict-totality.mjs`; the fs walk stays here (mirrors scanRepoLocusPrefixes).
if (!sectionGate.shouldRun('14')) skippedMark('14');
else {
  const scanDirs = ['scripts', 'skills-src'];
  const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__']);
  const walkSource = (dir, acc = []) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) { if (!SKIP_DIRS.has(name.name)) walkSource(p, acc); }
      else if ((name.name.endsWith('.mjs') || name.name.endsWith('.js')) && !name.name.includes('.test.')) acc.push(p);
    }
    return acc;
  };
  const docs = [];
  for (const d of scanDirs) {
    const abs = join(ROOT, d);
    if (existsSync(abs)) for (const f of walkSource(abs)) docs.push({ file: relative(ROOT, f), content: readFileSync(f, 'utf8') });
  }
  const { errors: vte } = checkVerdictTotality(docs, VERDICTS);
  for (const e of vte) err(e);
  // #xdompzx review, finding 5 — SECOND TENANT. `IMPACT_LEVELS` (jury-core) is the same enum+rank-table shape this
  // gate exists for: `IMPACT_STRICTNESS` ranks it and `IMPACT_GLOSS` defines it. Enrolling it costs one call
  // because the gate is parameterised on the enum, its symbol name, its markers, and how wide its bare-key
  // discovery reaches.
  //
  // WHAT THIS PASS CATCHES, AND WHAT IT DOES NOT (#xdompzx round-4, finding c — stated because the first version
  // of this comment claimed more than the pass delivers). CATCHES: a THIRD structure total over `IMPACT_LEVELS`
  // that references the enum symbolically (`[IMPACT_LEVELS.X]:`) — a glyph table, a hand-copied twin rank map,
  // exactly the round-2 defect above — which the module-load loop in jury-core cannot see, because that loop
  // checks `IMPACT_STRICTNESS` and `IMPACT_GLOSS` BY NAME. DOES NOT CATCH: a table that spells the levels as bare
  // string keys and never names the enum. Every `IMPACT_LEVELS` value is an ordinary English word, so this
  // enrolment sets `genericKeysNeedSymbol` (see `IMPACT_ENROLMENT`); without it any unrelated
  // `{ ok, degraded, broken }` in scripts/ becomes a false error. A FIFTH LEVEL added to the enum is caught by the
  // module-load assert, not by this pass. The `VERDICTS` pass above is unrestricted and keeps its full reach.
  const { errors: ite } = checkVerdictTotality(docs, IMPACT_LEVELS, IMPACT_ENROLMENT);
  for (const e of ite) err(e);
}

mark("14. Enum-totality gate — VERDICTS (#2823, item xiqj3w9) + IMPACT_LEVELS (#xdompzx)");
// ── 15. Review-label swap must stay in its single home (#2882) ─────────────────
// A doc under skills-src/ or docs/agent/ may not INSTRUCT a raw `gh pr edit … --add-label review:*`. That path
// skips the `reviewed-sha` stamp the drain's staleness gate reads (#2409) and bypasses INVARIANT 2, which is
// enforced in `decideSetLabel`'s pure core and so only binds callers that come through
// `we:scripts/review-set-label.mjs` (#2644). Observed on PR #983: the `/review` skill's raw swap cost five
// re-parks, and nothing else would have caught the invariant gap — no workflow references the review labels.
// Pure rule in `lib/review-skill-guard.mjs`; the fs walk stays here (mirrors the gate above).
{
  // DERIVED from the exported prefix list, never a second hardcoded copy — hardcoding the roots here is the same
  // two-readers-of-one-contract defect this rule exists to prevent, and it fails in the worst direction: widening
  // GUARDED_DOC_PREFIXES would silently no-op because the walk never visits the new root, with every unit test
  // still green (they feed fixtures and bypass the walk entirely). PR #1005 review, minor 1.
  const scanDirs = [...new Set(GUARDED_DOC_PREFIXES.map((p) => p.replace(/\/+$/, '')))];
  const SKIP_DIRS = new Set(['node_modules', '.git']);
  const walkDocs = (dir, acc = []) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) { if (!SKIP_DIRS.has(name.name)) walkDocs(p, acc); }
      else if (name.name.endsWith('.md')) acc.push(p);
    }
    return acc;
  };
  const docs = [];
  for (const d of scanDirs) {
    const abs = join(ROOT, d);
    if (existsSync(abs)) for (const f of walkDocs(abs)) docs.push({ file: relative(ROOT, f), content: readFileSync(f, 'utf8') });
  }
  const { errors: rle } = checkReviewLabelSingleHome(docs);
  for (const e of rle) err(e);
}

mark("15. Review-label swap must stay in its single home (#2882)");
// ── 15b. Review-label single home must hold for CODE too, not just docs (#2416) ──────────────
// Rule 15 stops a MARKDOWN doc from INSTRUCTING the raw swap; nothing stopped a SCRIPT from minting the same
// raw gh-exec label write, or an equivalent `setLabels` add of the accepted label, directly in code — the
// residual #2416 gap in the "review:human PR is never agent-cleared" invariant: a
// second write path never reaches `decideSetLabel`, so it never pays INVARIANT 2 or the #2409 `reviewed-sha`
// stamp. Pure rule in `lib/review-skill-guard.mjs`; scoped to non-test `.mjs`/`.cjs` under `scripts/` — a
// round-2 panel review (#2416) traced a live `.cjs` sibling family under `scripts/lib/` (e.g. loader hooks) that
// the first cut's `.mjs`-only walk never visited; `.js` has no callers under `scripts/` today, so it stays out
// until one exists.
if (!sectionGate.shouldRun('15b')) skippedMark('15b');
else {
  const SKIP_DIRS = new Set(['node_modules', '.git', '__tests__', '__fixtures__']);
  const isScannableScript = (name) => (name.endsWith('.mjs') || name.endsWith('.cjs')) && !name.endsWith('.test.mjs') && !name.endsWith('.test.cjs');
  const walkMjs = (dir, acc = []) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) { if (!SKIP_DIRS.has(name.name)) walkMjs(p, acc); }
      else if (isScannableScript(name.name)) acc.push(p);
    }
    return acc;
  };
  const scriptsRoot = join(ROOT, 'scripts');
  const codeFiles = existsSync(scriptsRoot)
    ? walkMjs(scriptsRoot).map((f) => ({ file: relative(ROOT, f), content: readFileSync(f, 'utf8') }))
    : [];
  const { errors: rlc } = checkReviewLabelSingleHomeCode(codeFiles);
  for (const e of rlc) err(e);
}

mark("15b. Review-label single home must hold for CODE too, not just docs (#2416)");
// ── 16. A DECLARED module contract must cover every specifier the module imports (PR #1064) ─────
// A `scripts/lib/*.mjs` header that declares "from we:<module> — `a`, `b`" is a tripwire: it is what a
// maintainer greps before changing a shared export, and what names the dependency a semantic change would
// break. It is worthless once it drifts, and the first one shipped ALREADY had (`normalizeFindings` imported,
// called, undeclared). Script-decidable ⇒ a gate, not a reviewer's attention (#51). Pure rule in
// check-standards-rules.mjs; the fs read stays here.
{
  const libDir = join(ROOT, 'scripts', 'lib');
  const mods = [];
  if (existsSync(libDir)) {
    for (const name of readdirSync(libDir)) {
      if (!name.endsWith('.mjs')) continue;
      const abs = join(libDir, name);
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      mods.push({ file: `scripts/lib/${name}`, content: readFileSync(abs, 'utf8') });
    }
  }
  for (const e of validateDeclaredModuleContract(mods).errors) err(e.message, e.descriptor);
}

mark("16. A DECLARED module contract must cover every specifier the module imports (PR #1064)");
// ── 17b. `--all` inside a git hook (#3196) ─────────────────────────────────────
// `we:.githooks/post-merge` shipped a commands sync carrying `--all`, where the flag does not mean "deploy
// everything" but "CREATE the machine-global tree" on a machine that never opted in. A hook runs unattended on
// every merge and every clone, so the wrong flag there is applied silently and repeatedly — and it was caught
// by a reviewer, which is the kind of catch that does not repeat. Pure rule (`findGitHookAllFlags`, which
// strips shell comments so the post-merge hook's own explanation of why it does NOT pass the flag is not
// itself reported) lives in check-standards-rules.mjs; only the directory read is here.
{
  const dir = join(ROOT, '.githooks');
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (!statSync(abs).isFile()) continue;
      for (const hit of findGitHookAllFlags(readFileSync(abs, 'utf8'))) err(gitHookAllFlagError(`.githooks/${name}`, hit));
    }
  }
}

mark("17b. `--all` inside a git hook (#3196)");
// ── 17c. Leash pin (#2892 — enforces #2840 trigger 3; guards #2838's flip-edit safeguard) ──────
// No declarative-leash (`POLICY_SPEC`) file may be dropped from the human gate — checked against the roster AND
// against the real `scoreEscalation`, so neither a reclassification nor a rubric edit can quietly hand the
// contract (and with it the shadow→enforce flip) to an agent panel. Pure rule + its rationale live in
// check-standards-rules.mjs (`checkLeashPin`); this only wires the real roster, rubric and filesystem in.
// #4167 — every finding `checkLeashPin` can produce is unconditionally `global: true` (its own
// `descriptor()` helper always sets it), so `--local` always demotes it; skip the whole check.
if (!LOCAL_MODE) {
  const pin = checkLeashPin({
    specBasenames: POLICY_SPEC_BASENAMES,
    roster: TRUST_CHAIN,
    isHumanGated: (path, hunks) => scoreEscalation({ changedFiles: [path], diffHunks: hunks }).humanRequired,
    homeExists: (rel) => existsSync(join(ROOT, rel)),
  });
  for (const e of pin.errors) err(e.message, e.descriptor);
  for (const w of pin.warnings) warn(w.message, w.descriptor);
}

mark("17c. Leash pin (#2892 — enforces #2840 trigger 3; guards #2838's flip-edit safeguard)");
// ── 17. Small-file preference: size+collision composite soft-warn (#2678 ruling, #2782) ────────
// #2678 Fork 1 ratified (b) — WARN (never error, never deny) on a file that is BOTH oversized and
// scope-collision-heavy, keyed on a size+collision composite (never raw line count), with a
// file-header `// @cohesive: <reason>` escape hatch for a genuinely-cohesive large file. Pure rule
// (findLockPointFiles) lives in check-standards-rules.mjs; the fs reads + backlog scope gathering stay
// here. Codified at docs/agent/platform-decisions.md#small-file-preference.
try {
  // Collision universe: every NON-resolved item's scope — a resolved item no longer holds a live lane,
  // so its historical scope is not a real serialization cost.
  const backlogScopes = backlog.filter((it) => it.status !== 'resolved').map((it) => it.scope || []);
  // Candidates: every FILE-shaped (not a directory/glob), "we:"-qualified scope entry named by ANY
  // non-resolved item, deduped. Shared with the #2782 calibration guard so both select one population.
  const candidatePaths = lockPointCandidatePaths(backlogScopes);
  // #2782 review — two hardenings on the read loop:
  //  (a) CONTAINMENT. `scope:` is repo-authored metadata, but it is still untrusted input to a filesystem
  //      read: `join(ROOT, p.slice(3))` on a `we:../../…` entry resolves outside the repo, turning a backlog
  //      field into an arbitrary-file-read primitive. Resolve and require the result to stay under ROOT.
  //  (b) PER-FILE isolation. The whole scan used to sit in ONE try/catch, so a single unreadable candidate
  //      (a path that is really a directory, a permissions hiccup) threw and silently disabled the ENTIRE
  //      gate with one generic warn. A bad candidate is now skipped; the rest of the scan still runs.
  const files = [];
  for (const p of candidatePaths) {
    try {
      const abs = resolve(ROOT, p.slice('we:'.length));
      const rel = relative(ROOT, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) continue; // escapes the repo — never read it
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      files.push({ path: p, text: readFileSync(abs, 'utf8') });
    } catch { /* unreadable candidate: skip THIS file, never disable the gate */ }
  }
  const lockPoints = findLockPointFiles({ files, backlogScopes });
  for (const lp of lockPoints)
    warn(
      `Lock-point file: "${lp.path}" is both large (${lp.codeLines} code lines) and scope-collision-heavy ` +
      `(named in ${lp.collisions} queued items' scope:) — #2678's small-file preference ` +
      `(docs/agent/platform-decisions.md#small-file-preference) flags it as a throughput lock point: many ` +
      `items serialize on this one file even with zero real overlap between them. Split it along its ` +
      `responsibility seams so file-disjoint items can build in parallel, or, if it is genuinely cohesive, ` +
      `silence this warn with a \`// @cohesive: <reason>\` comment in the file HEADER (the marker only ` +
      `counts as a directive above the first line of real content — see #2782).`,
    );
} catch (e) {
  warn(`Small-file preference lock-point scan failed: ${e.message}`);
}

mark("17. Small-file preference: size+collision composite soft-warn (#2678 ruling, #2782)");
// ── 18. Test-only exports: exported, tested, wired to nothing (#2967a) ─────────
// `reduceLensJury` was exported from scripts/lib/converge-core.mjs, unit-tested and called by nothing, so
// multi-juror lenses collapsed last-writer-wins. WARN-first (`TEST_ONLY_EXPORT_ENFORCED`). Pure rule in
// check-standards-rules.mjs; the fs read and the two STRUCTURAL carve-out sets it needs stay here (rule 16's
// split). Rule 19 — the other rule that review named — follows.
if (!sectionGate.shouldRun('18')) skippedMark('18');
else try {
  const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__snapshots__']);
  const isTestPath = (p) => p.includes('/__tests__/') || p.includes('/__fixtures__/') || p.endsWith('.test.mjs');
  const everyModule = [];
  const walkMjs = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walkMjs(abs, relPath);
      else if (ent.name.endsWith('.mjs')) everyModule.push({ file: relPath, content: readFileSync(abs, 'utf8') });
    }
  };
  for (const top of ['scripts', 'skills-src']) if (existsSync(join(ROOT, top))) walkMjs(join(ROOT, top), top);

  // STRUCTURAL carve-outs, both keyed by file basename (rule 18's import matching is basename-based too):
  //  • star-imported modules — scanned over EVERY .mjs INCLUDING tests, because the real case is a test doing
  //    `import * as rules from '../check-standards-rules.mjs'` (its exports are used only via the namespace).
  //  • subprocess-referenced files — a `node scripts/<f>.mjs` string in ANOTHER non-test file (a workflow
  //    harness body a subagent reads, package.json's scripts): the consumer is the OS, invisible to imports.
  //    Deliberately NOT scanned from test files: a CLI only a test shells out to IS a test-only consumer.
  const starImportedSpecifiers = new Set();
  const subprocessReferencedFiles = new Set();
  const pkgPath = join(ROOT, 'package.json');
  const shellSources = everyModule.filter((m) => !isTestPath(m.file));
  if (existsSync(pkgPath)) shellSources.push({ file: 'package.json', content: readFileSync(pkgPath, 'utf8') });
  for (const { content } of everyModule)
    for (const m of content.matchAll(/import\s+\*\s+as\s+[\w$]+\s+from\s*['"]([^'"]+)['"]/g))
      starImportedSpecifiers.add(m[1].split('/').pop());
  for (const { file, content } of shellSources)
    for (const m of content.matchAll(/node\s+(?:--[\w-]+(?:=\S+)?\s+)*(?:we:)?["']?((?:\.\/)?(?:scripts|skills-src)\/[\w./-]+\.mjs)/g)) {
      const base = m[1].split('/').pop();
      if (base !== file.split('/').pop()) subprocessReferencedFiles.add(base); // a self-reference exempts nothing
    }

  const candidates = everyModule.filter((m) => !isTestPath(m.file));
  const testOnly = findTestOnlyExports(candidates, { starImportedSpecifiers, subprocessReferencedFiles });
  for (const e of testOnly.errors) err(e.message, e.descriptor);
  for (const w of testOnly.warnings) warn(w.message, w.descriptor);
} catch (e) {
  warn(`Test-only-export scan failed: ${e.message}`);
}

mark("18. Test-only exports: exported, tested, wired to nothing (#2967a)");
// ── 18b. A skill instructing a raw home a declared operation owns (#3224) ──────
// THE THIRD CALLER. #3029/#3035 derive the CLI and the HTTP routes from one declaration, so those two cannot
// drift. The skill prose telling an agent which command to run is derived from nothing — it is a hand edit
// somebody makes once, if they remember — and 5 of 11 operations were named by ZERO skills when this was
// measured. This closes that by making the omission visible.
//
// It flags a skill line ONLY when the home does not reach the operation. `backlog.mjs claim` delegates, so
// naming it is naming the declared layer; `verify-lane.mjs` does not, so naming it bypasses `verify`. The
// difference is derived from the homes' own sources below, never declared.
try {
  const SKIP = new Set(['node_modules', 'dist', '.git', '__snapshots__', '__tests__']);
  const skills = [];
  const walkMd = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const abs = join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walkMd(abs, relPath);
      // `.md` is where a raw invocation gets HAND-WRITTEN; `.workflow.js` is where one gets GENERATED.
      // The scan was built against the first and never revisited for the second, so the dispatcher's
      // `parallel-execute.workflow.js` — which builds `node scripts/backlog.mjs scaffold` / `… resolve`
      // prompt strings for the agents it launches, i.e. the highest-VOLUME site of this exact bypass —
      // was structurally invisible to it. A generated instruction bypasses the declared layer exactly as
      // a typed one does; the file extension is not the thing that makes it a bypass.
      else if (ent.name.endsWith('.md') || ent.name.endsWith('.workflow.js'))
        skills.push({ file: relPath, content: readFileSync(abs, 'utf8') });
    }
  };
  if (existsSync(join(ROOT, 'skills-src'))) walkMd(join(ROOT, 'skills-src'), 'skills-src');

  // Read each declared home's SOURCE so delegation is derived rather than believed. A home that cannot be
  // read stays `undefined`, and the scan turns that into "unknown" — which never produces a finding.
  const operations = Object.entries(DECLARED_HOMES).map(([name, entries]) => ({
    name,
    declaresOver: entries.map(parseDeclaredHome).filter(Boolean),
  }));
  const homeSources = new Map();
  for (const op of operations) {
    for (const d of op.declaresOver) {
      const p = d.home.replace(/^[a-z][a-z0-9-]*:/, '');
      if (homeSources.has(p)) continue;
      const abs = join(ROOT, p);
      if (existsSync(abs)) homeSources.set(p, readFileSync(abs, 'utf8'));
    }
  }

  const wiring = findSkillsNamingUndelegatedHomes(skills, operations, homeSources);
  for (const e of wiring.errors) err(e.message, e.descriptor);
  for (const w of wiring.warnings) warn(w.message, w.descriptor);

  // #3960 (multi-repo slice 4) — a conveyor fix/ci-heal brief that `cd`s into an acquired lane and then calls a
  // WE tool by a relative `node scripts/...` path breaks the moment that lane is not WE's own checkout.
  const relativeNodeAfterCd = findRelativeNodeScriptsAfterLaneCd(skills);
  for (const e of relativeNodeAfterCd.errors) err(e.message, e.descriptor);
  for (const w of relativeNodeAfterCd.warnings) warn(w.message, w.descriptor);

  // ── #3253 — the CALL SITE, judged against the operation's own declared `input` ──────────────────────────
  // Scans `docs/` as well as `skills-src/`, because the #3224 walk above is `skills-src/**/*.md` only and a
  // doc telling an agent to run a malformed command is exactly as wrong as a skill doing it.
  //
  // A SCHEMA THAT WOULD NOT BUILD IS OMITTED, NOT GUESSED. `resolveOperation` constructs the declaration's io
  // (readers, sinks), and one of those can legitimately refuse on this host — a missing credential, an absent
  // path. An operation we could not load is left out of the map, and the scan treats absence as "no finding".
  // Inventing findings out of our own inability to look is the failure this whole file argues against.
  const docs = [...skills];
  const walkDocsMd = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(ent.name)) continue;
      const abs = join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walkDocsMd(abs, relPath);
      else if (ent.name.endsWith('.md')) docs.push({ file: relPath, content: readFileSync(abs, 'utf8') });
    }
  };
  if (existsSync(join(ROOT, 'docs'))) walkDocsMd(join(ROOT, 'docs'), 'docs');

  // PER-OPERATION control flags, not the flat union (PR #1526 round 3): `--cwd`/`--model` are refused where
  // there is no `judge` step, so judging every site against `CONTROL_FLAGS` green-lit `--cwd` on `scaffold` —
  // a command the real CLI rejects. `acceptedControlFlags` IS the adapter's own filter, so the gate and the
  // refusal cannot disagree.
  const schemas = new Map();
  const controls = new Map();
  for (const name of Object.keys(OPERATIONS)) {
    try {
      const { declaration } = resolveOperation(name);
      if (declaration?.input) {
        schemas.set(name, declaration.input);
        controls.set(name, acceptedControlFlags(declaration));
      }
      // ── #3316 — an `ownedBy` pointer must RESOLVE ────────────────────────────────────────────────────────
      // `op()` checks the SHAPE (a locus prefix, #883) because `registry.mjs` is pure and cannot read a disk.
      // Existence is derivable, so it is derived here rather than restated as a flag on the declaration. It
      // matters: the whole field exists so a caller holding a suspended run can find the process that owns
      // the rest of it, and a pointer at a moved or deleted skill sends them to the same dead end the field
      // was built to close — while LOOKING like it was handled.
      if (declaration?.ownedBy) {
        const rel = declaration.ownedBy.replace(/^[a-z][a-z0-9-]*:/, '');
        if (!existsSync(join(ROOT, rel))) {
          err(
            `operation \`${name}\` declares \`ownedBy: ${declaration.ownedBy}\`, but that file does not exist. A `
            + 'suspended run would name a skill nobody can open (#3316).',
            rel,
          );
        }
      }
    } catch { /* unbuildable on this host — stays unknown, which never produces a finding */ }
  }

  const calls = findMalformedOperationCalls(docs, schemas, controls);
  for (const e of calls.errors) err(e.message, e.descriptor);
  for (const w of calls.warnings) warn(w.message, w.descriptor);
} catch (e) {
  warn(`Skill/operation wiring scan failed: ${e.message}`);
}

mark("18b. A skill instructing a raw home a declared operation owns (#3224)");
// ── 18c. Operation IO modules with no real-mechanism test (#2949 fidelity qualifier; #3264) ────
// THE LADDER MEASURES DETERMINISM, NOT FIDELITY. #2949's acceptance-criteria ladder sorts criteria by who
// checks them — tier 1 is "green or not, nobody judges". That says nothing about WHAT went green. #3264's work
// had a tier-1 criterion, it passed, and the shipped code died live on
// `fatal: invalid reference: origin/ops/review-requests`: `record-verdict-io.mjs` takes an injected `run`, the
// tests drove a stub, and a stub returning `''` has no clone geometry, so no fixture existed in which
// `git fetch origin <branch>` + `git worktree add origin/<branch>` could disagree. Fully tier 1, fully green,
// vacuous about mechanics.
//
// So every `-io` module — the repo's own marker for the impure half of an operation pair — needs at least ONE
// test that imports `scripts/operations/__tests__/helpers/real-repo.mjs` (`withRealRepo`, `withBareOrigin`,
// `withNarrowClone`, built by the harness track). The rule and its shrinking allowlist live in
// `lib/operation-io-fidelity.mjs`; the header there argues the whole case, including why stub tests stay.
//
// THE WALK LIVES IN THE LIB, not here — the same correction PR #1235's review made to the mandate-fence scan
// (section 19 below). A walk written at the call site and re-implemented in the test pins the RULE but never
// the REGISTRATION, so deleting these three lines would leave the whole suite green. `scanOperationIoFidelity`
// is what the test imports, so gutting it reddens, and a separate assertion pins that this call still exists.
//
// Runs OUTSIDE any try/catch, for the same reason section 19 does: this rule ERRORS, and a catch-all that
// demoted a scan failure to a warning is a gate that fails OPEN. The helper's ABSENCE is fine — the scan reads
// test sources as text and never resolves the import — so this lands green before the harness does.
{
  const fidelity = scanOperationIoFidelity(ROOT);
  for (const e of fidelity.errors) err(e.message, e.descriptor);
  for (const w of fidelity.warnings) warn(w.message, w.descriptor);
}

mark("18c. Operation IO modules with no real-mechanism test (#2949 fidelity qualifier; #3264)");
// ── 19. Unfenced mandate params (#2967b) ───────────────────────────────────────
// The WALK lives in `lib/mandate-fence-scan.mjs`, not here (PR #1235 review, finding 4): a walk copied into a
// test pins the rule but never the registration, so `findUnfencedMandateParams([])` here used to leave the
// whole suite green. `scanUnfencedMandateParams` is what the test imports, so neutering it reddens.
// Runs OUTSIDE any try/catch on purpose: this rule ERRORS, and a catch-all that demoted its failure to a
// warning would be a gate that fails OPEN — the exact shape #2967 exists to stop shipping.
if (!sectionGate.shouldRun('19')) skippedMark('19');
else {
  const unfenced = scanUnfencedMandateParams(ROOT);
  for (const e of unfenced.errors) err(e.message, e.descriptor);
  for (const w of unfenced.warnings) warn(w.message, w.descriptor);
}

mark("19. Unfenced mandate params (#2967b)");
// ── Scope attribution (#952, ratified #949 Fork 3-A) ───────────────────────────
// `--scope=<session>` (alias `--mine=<session>`) partitions errors by ownership: an error on a file THIS
// session dirtied (per its claim-time baseline, #949 Fork 2-A) BLOCKS; a concurrent/pre-existing red is
// printed as a non-failing note. A path-less finding can't be proven foreign, so it stays blocking
// (fail-safe). The DEFAULT no-flag run is untouched — whole-repo-strict (CI / close-out unchanged).
const scopeArg = process.argv.find((a) => a.startsWith('--scope=') || a.startsWith('--mine='));
const scopeSession = scopeArg ? scopeArg.split('=').slice(1).join('=') : null;
let externalErrors = []; // errors attributed to other sessions under --scope (printed, non-blocking)
let scopeNote = null;
if (scopeSession) {
  try {
    const claims = parseClaims(readFileSync(join(ROOT, '.claude/skills/batch-backlog-items/claims.json'), 'utf8'));
    const dirty = porcelainFiles(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }));
    const mine = mineFiles(claims, scopeSession, dirty);
    if (mine === null) {
      scopeNote = `--scope="${scopeSession}" has no recorded claim baseline — running whole-repo-strict.`;
    } else {
      const { blocking, external } = partitionFindings(errors, mine);
      externalErrors = external;
      errors.length = 0; errors.push(...blocking); // only my-scope (+ unattributable) errors gate
      scopeNote = `--scope="${scopeSession}" — ${mine.size} owned file(s); ${external.length} external error(s) demoted to notes.`;
    }
  } catch (e) {
    scopeNote = `--scope failed to resolve a baseline (${e.message}) — running whole-repo-strict.`;
  }
}

mark("Scope attribution (#952, ratified #949 Fork 3-A)");
// ── Local / per-lane gating (#1144, consumed by the parallel-batch orchestrator #1147) ─────────
// `--files=<comma|space list>` scopes the BLOCKING set to findings attributable to those files — an
// explicit-list sibling of `--scope` (which derives the set from a session's claim baseline). `--local`
// additionally demotes the GLOBAL-CONSISTENCY findings to non-failing notes — both the path-less ones
// (dup ids, the blockedBy cycle walk) AND the `descriptor.global`-marked ones that DO attribute to a
// lane-edited file but depend on whole-repo / sibling-lane state (cross-registry `unresolved-ref` joins,
// the AGENTS.md derived-artifact `inventory` coherence). A lane runs in its OWN worktree and cannot see
// sibling lanes, so those invariants only become real at MERGE, where the full no-flag gate is the
// authority (#1159). Combined, `--local --files=<lane files>` blocks ONLY on the lane's own file-local
// findings. Applied AFTER
// `--scope` so the two compose (scope demotes concurrent sessions' files; --files/--local narrows further).
// (`LOCAL_MODE` itself is read at the TOP of the file, #4167 — sections that produce only
// always-demoted-under-`--local` findings check it there and skip their own work entirely.)
// #4168 — `filesArg`/`list` reuse the SAME parse `LOCAL_FILES_LIST` hoisted to the top of the file
// (right after `mark`'s definition), rather than re-deriving it here, so the two can never drift on what
// `--files=` means.
// #4166 — the fileSet used to classify blocking-vs-demoted is `EFFECTIVE_FILES` (changed ∪ linked), not the
// literal `--files=` list: a finding on a file the lane's edit affects via a reference but never itself
// touched must still block (see `EFFECTIVE_FILES`'s own docblock, above). `list` (the literal argument)
// stays what the summary/note TEXT reports, so the printed `--files=` echoes exactly what was passed.
const filesArg = filesArgEarly;
let localNote = null;
let list = null;
if (filesArg || LOCAL_MODE) {
  list = LOCAL_FILES_LIST;
  const fileSet = EFFECTIVE_FILES ?? (list ? new Set(list) : null);
  const { blocking, demoted } = partitionLocal(errors, { fileSet, local: LOCAL_MODE });
  externalErrors = [...externalErrors, ...demoted]; // demoted globals/other-file reds print as notes
  errors.length = 0; errors.push(...blocking);
  const linkedCount = LINKED_FILES ? LINKED_FILES.size : 0;
  const scopeDesc = fileSet ? `${fileSet.size} file(s)${linkedCount ? ` (${list.length} changed + ${linkedCount} linked)` : ''}` : 'file-attributable findings only';
  localNote = `${LOCAL_MODE ? '--local ' : ''}${filesArg ? `--files=${list.join(',')} ` : ''}— scoped to ${scopeDesc}; ${demoted.length} finding(s) demoted to notes.`;
}

mark("Local / per-lane gating (#1144, consumed by the parallel-batch orchestrator #1147)");
// ── Report ────────────────────────────────────────────────────────────────────
const summary = {
  diffBranchCoverage,
  blocks: blocks.length, plugs: plugs.length, protocols: protocols.length, intents: intents.length,
  capabilities: capabilities.length, terms: semantics.length, research: research.length, backlog: backlog.length,
  errors: errors.length, warnings: warnings.length,
  ...(scopeSession ? { scope: scopeSession, externalErrors: externalErrors.length } : {}),
  ...(filesArg || LOCAL_MODE ? { local: LOCAL_MODE, files: list ?? null, externalErrors: externalErrors.length } : {}),
  // #70d — only a scoped run can skip a section, so only a scoped run carries this key (unscoped output unchanged).
  ...(SCOPE_TO_FILES ? { skippedSections: Object.fromEntries(sectionGate.skipped.map((id) => [id, SKIP_REASON])) } : {}),
};

if (JSON_MODE) {
  // Single JSON object on stdout — the auto-fix agent's failure feed (#095). Exit code
  // still signals pass/fail, so `check:standards --json` is both pipeable and CI-usable.
  const shape = (list) => list.map((x) => (x.descriptor ? { message: x.message, descriptor: x.descriptor } : { message: x.message }));
  // Map a check-standards `{message, descriptor?}` entry onto a report-model Finding (#431). The
  // descriptor's `kind` becomes the `ruleId` and its `file` the location, so the structured failure
  // class survives into SARIF/JUnit; the terminal/ANSI path below stays bespoke (only `--json` migrates).
  const toFinding = (severity) => (e, i) => reportFinding({
    id: `check-standards/${severity}/${i}`,
    severity,
    title: e.message,
    ruleId: e.descriptor?.kind,
    location: e.descriptor?.file ? { path: e.descriptor.file } : undefined,
    detail: e.descriptor ? JSON.stringify(e.descriptor) : undefined,
    source: 'check-standards',
  });
  const report = buildReport({
    id: 'check-standards',
    title: 'Web Everything — check:standards',
    sources: [reportSource({ id: 'check-standards', name: 'check:standards', kind: 'validator' })],
    sections: [reportSection({
      id: 'findings',
      title: 'Standards conformance findings',
      findings: [...errors.map(toFinding('error')), ...warnings.map(toFinding('warn'))],
    })],
  });
  // `report` is the #431 model-valid view (pipes through the #432 renderers + #434 SARIF/JUnit adapters);
  // `errors`/`warnings` stay for the existing #196 auto-fix feed that targets descriptors directly.
  console.log(JSON.stringify({ ok: errors.length === 0, summary, report, errors: shape(errors), warnings: shape(warnings), ...(scopeSession ? { externalErrors: shape(externalErrors) } : {}) }, null, 2));
} else {
  const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', CYN = '\x1b[36m', DIM = '\x1b[2m', RST = '\x1b[0m';
  console.log(`${DIM}check-standards — Web Everything${RST}`);
  console.log(diffBranchCoverage.message);
  if (scopeNote) console.log(`${CYN}  scope${RST} ${DIM}${scopeNote}${RST}`);
  if (localNote) console.log(`${CYN}  local${RST} ${DIM}${localNote}${RST}`);
  if (SCOPE_TO_FILES && sectionGate.skipped.length)
    console.log(`${CYN}  local${RST} ${DIM}${SKIP_REASON}: ${sectionGate.skipped.join(', ')}${RST}`);
  for (const w of warnings) console.log(`${YEL}  warn${RST} ${w.message}`);
  for (const e of externalErrors) console.log(`${DIM}  note (external) ${e.message}${RST}`);
  for (const e of errors) console.log(`${RED} error${RST} ${e.message}`);
  console.log(
    `\n${errors.length ? RED : GRN}${errors.length} error(s)${RST}, ${warnings.length} warning(s) ` +
    `${DIM}(checked ${blocks.length} blocks, ${plugs.length} plugs, ${protocols.length} protocols, ${intents.length} intents, ${capabilities.length} capabilities, ${semantics.length} terms, ${research.length} research topics, ${backlog.length} backlog items)${RST}`,
  );
}
// `process.exitCode`, NEVER `process.exit()` — remedy (a) in we:scripts/lib/write-all-sync.mjs (#3061). This is
// the LAST statement of the script, so setting the status and falling off the end exits with the same code
// once stdout has DRAINED. `process.exit()` here truncated both modes for any parent that captures stdout:
// `--json` is one ~1.1 MB `console.log` and came back as exactly 8 192 bytes of unparseable JSON through
// `execFileSync` (measured 2026-08-10) — the health gate's own machine feed, unreadable; the human mode is a
// `console.log` loop whose many small async writes truncate RACILY (337 131 bytes to a file, 302 018 through a
// slow pipe in the same measurement), which is why the drain remedy alone would not have been enough here.
mark("Report");
if (PROFILE) {
  const rows = [...profileEntries].sort((a, b) => b[1] - a[1]);
  const total = profileEntries.reduce((s, [, ms]) => s + ms, 0);
  console.error('\ncheck-standards profile (ms per section, sorted desc):');
  for (const [label, ms, rss] of rows) console.error(`  ${ms.toFixed(1).padStart(8)}ms  ${String(Math.round(rss / 1048576)).padStart(5)}MB  ${label}`);
  console.error(`  peak-so-far RSS at end: ${Math.round(Math.max(...profileEntries.map((e) => e[2])) / 1048576)}MB`);
  console.error(`  ${total.toFixed(1).padStart(8)}ms  TOTAL (${profileEntries.length} sections)`);
  for (const l of cacheStatLines) console.error(`  cache ${l}`);
}

process.exitCode = errors.length ? 1 : 0;
