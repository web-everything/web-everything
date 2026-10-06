// The backlog feeds entirely off a directory of markdown files — one per item:
//
//   backlog/<id>.md
//     ---
//     type / status / dateOpened / tags / relatedReport / relatedProject /
//     crossRef / graduatedTo            (metadata only — the registry fields)
//     ---
//     # Title
//     First paragraph (the summary)…
//     …the rest is the detail-page body.
//
// EVERYTHING shown — title, description, detail-page body — is derived from
// markdown, never from hand-typed frontmatter strings:
//   • an item with its own markdown body → title = its H1, summary = its first
//     paragraph, details = the rendered body.
//   • a pointer item (a `relatedReport` and NO body) → it MIRRORS the report:
//     title/summary/details are loaded from the report md itself.
//
// This `.js` data file is the single loader: it parses backlog/*.md into the
// `backlog` array the pages (backlog.njk, backlog-pages.njk) and the validator
// (scripts/check-standards.mjs) all consume. There is no backlog.json.
const { readdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const matter = require('gray-matter');
const { createHash } = require('node:crypto');
const { createBacklogIndex } = require('../../scripts/lib/backlog-index.cjs');
const LOADER_VERSION = createHash('sha1')
  .update(readFileSync(__filename))
  .update(JSON.parse(readFileSync(require.resolve('gray-matter/package.json'), 'utf8')).version)
  .digest('hex');
const { normalizeRelatedReport } = require('../../scripts/lib/related-report.cjs');
const MarkdownIt = require('markdown-it');

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
// #2236 — DETERMINISTIC VISUAL-FIXTURE MODE. The live `backlog/` directory churns on nearly every commit
// (a new item filed, an unrelated item resolved, a title reworded) — none of which is a real LOOK change,
// yet every backlog-derived page (`/backlog/` and `/backlog/<id>/` directly) would shift its rendered
// content on each one, making a pixel-diff visual baseline un-greenable for reasons that have nothing to
// do with styling/layout. When `WE_VISUAL_FIXTURES` is set (the dedicated fixture build the visual spec's
// own Playwright `webServer` boots — see playwright.config.ts + tests/visual/rendered-site-visual.spec.ts),
// the loader instead sources a small, frozen, checked-in fixture set (tests/visual/fixtures/backlog/*.md)
// — same shape, same code path, zero content drift. The LIVE docs build (`npm run build:docs`,
// `npm run dev`, `check:standards`, `npm test`, …) never sets this env var, so its behavior is completely
// unchanged. See tests/visual/pages.json's header comment for how to add a new fixture-backed target.
// #3445 — an explicit `WE_BACKLOG_DIR` override (the dispatcher-fixture-root thread, mirroring
// `--backlog-dir` on `scripts/backlog.mjs` / `scripts/readiness/dispatch-plan.mjs`) wins over both the
// visual-fixture mode and the live directory, so a harness test can point this SAME loader at a throwaway
// `mkdtemp` corpus without also having to fake `WE_VISUAL_FIXTURES`'s checked-in fixture set.
const BACKLOG_DIR = process.env.WE_BACKLOG_DIR
  ? process.env.WE_BACKLOG_DIR
  : process.env.WE_VISUAL_FIXTURES
  ? join(__dirname, '../../tests/visual/fixtures/backlog')
  : join(__dirname, '../../backlog');
const ROOT = join(__dirname, '../..');

// The leading id token of a backlog filename stem — a landed numeric `NNN` (any width up to 5) OR a
// provisional `xNNNNNN` hash (#2288 JIT numbering). Held as ONE source string so the num/slug pair below
// can't drift (#xzxc92d note b). Mirrors `scripts/backlog/id.mjs` ID_TOKEN_RE — CJS can't import that ESM
// module, so keep the two in sync by hand.
const ID_TOKEN = '\\d{1,5}|x[0-9a-z]{6}';

const toDateString = (v) =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v;

// Optional `scope:` (#x53zzf9) — an item's PREDICTED touch-set: repo-relative path prefixes a /workflow probe
// agent writes ONCE so the deterministic conveyor dispatcher (scripts/readiness/dispatch-plan.mjs) can hold
// overlapping items apart by SCRIPT (the judgment/deterministic split of platform-decisions.md
// #deterministic-core-thin-judgment). The loader only sanitizes it to a clean string[] (drop non-strings /
// blanks) or `undefined` when absent/empty — the array-of-strings SHAPE is enforced by check:standards; the
// OVERLAP semantics live in the dispatcher, never here.
const normalizeScope = (v) => {
  if (!Array.isArray(v)) return undefined;
  const list = v.map((s) => (s == null ? '' : String(s).trim())).filter(Boolean);
  return list.length ? list : undefined;
};

// HAS-PREDICTED-SCOPE readiness lens (#2618) — a PURE derivation (exported for direct regression testing,
// like `deriveTier` / `normalizeScope`; inert to the Eleventy build). It is TRUE for an OPEN, unblocked,
// agent-ready (Tier-A) BUILD item that carries NO usable predicted `scope:` — such a card reads as dev-ready
// but is NOT fully shaped. It mirrors the conveyor dispatcher's exact `unshaped-no-scope` / needs-probe hold
// (scripts/readiness/dispatch-plan.mjs): the item is "assume-overlaps-everything" and is NEVER launched to
// build blind — its `scope:` is auto-prepared upstream first. A SURFACING lens, not a hard gate (the item
// stays Tier A). `normalizeScope` collapses an absent / non-array / empty / all-blank scope to `undefined`,
// so `!normalizeScope(item.scope)` catches every "no usable scope" shape the dispatcher's `normScope()` does.
// Tier A already excludes decisions, non-open, blocked, project-pending and human-gated items; `kind !==
// 'epic'` drops umbrellas (sliced into children, never built directly, and out of the build queue).
const deriveUnshapedNoScope = (item) =>
  item.tier === 'A' && item.kind !== 'epic' && item.kind !== 'feature' && !normalizeScope(item.scope);

// Infer an item's repo-LOCUS when no explicit `locus:` is authored. THREE precise signals, tried in order —
// locus is "which gate/loop honestly CLOSES the item", so the signal must indicate where it BUILDS, never mere
// provenance:
//   1. structural — a descendant of the flagship-exercise-apps epic #314 (immutable NNN) is `exercise-app`,
//      via {@link isExerciseAppDescendant}. The big noise source here is the `exercise-app` *tag*, which WE
//      standards/blocks carry to mean "surfaced by an exercise app" (a discovery marker), NOT "lives in the
//      exercise app" — so this signal is structural, never the tag.
//   2. scope-prefix (#xdx3ifb multi-repo slice 3) — {@link inferLocusFromScope}: an item's own predicted
//      `scope:` already names which repo it touches (`we:`/`fui:`/`plateau:`, the SAME prefixes
//      `scripts/lib/repo-profile.mjs#repoProfile` resolves for every other multi-repo consumer), so a
//      `plateau:`-scoped item now resolves to `locus: 'plateau-app'` — its real gate — instead of falling
//      straight through to the `webeverything` default a tag-only inference would have given it. Tried
//      BEFORE tags: scope is a predicted TOUCH-SET (higher precision than a tag), and an item can easily carry
//      no cross-repo tag at all while still declaring an unambiguous cross-repo scope.
//   3. tag markers (unchanged) — the remaining, lower-precision signal for whatever scope doesn't catch.
// Values stay a subset of check-standards-rules.mjs `LOCI` keys; an explicit `locus:` always wins.
const EXERCISE_APP_ROOT = '314'; // #314 flagship-exercise-apps — its descendants run via the /exercise-app loop
const LOCUS_TAG_MARKERS = [
  [/frontier-?ui/i, 'frontierui'],
  [/technical-configurator|intent-configurator|dev-browser|\bplateau-app\b/i, 'plateau-app'],
];
function inferLocusFromTags(tags) {
  const joined = (Array.isArray(tags) ? tags : []).join(' ');
  for (const [re, locus] of LOCUS_TAG_MARKERS) if (re.test(joined)) return locus;
  return 'webeverything';
}
// #xdx3ifb multi-repo slice 3 — the scope-prefix → locus table. Mirrors `scripts/lib/repo-profile.mjs`'s
// `SCOPE_PREFIXES`/`CANONICAL_PREFIX` exactly (same prefixes, same repos) — CJS can't import that ESM module
// (the SAME barrier `ID_TOKEN` above already documents for `scripts/backlog/id.mjs`), so keep the two in sync
// by hand. `we`'s locus name genuinely differs from its repo key (`'webeverything'`, the LOCI key, vs `'we'`,
// the repo-profile key) — every other repo's locus name already equals its repo key.
const SCOPE_PREFIX_LOCUS = {
  we: 'webeverything', webeverything: 'webeverything',
  fui: 'frontierui', frontierui: 'frontierui',
  plateau: 'plateau-app', 'plateau-app': 'plateau-app',
};
function inferLocusFromScope(scope) {
  const list = normalizeScope(scope);
  if (!list) return null;
  for (const entry of list) {
    const m = /^([a-z][a-z0-9-]*):/i.exec(entry);
    const locus = m && Object.hasOwn(SCOPE_PREFIX_LOCUS, m[1].toLowerCase()) ? SCOPE_PREFIX_LOCUS[m[1].toLowerCase()] : null;
    if (locus) return locus;
  }
  return null;
}
// Walk the `parent` chain (via the num→item map) looking for the exercise-app root. Cycle-guarded.
function isExerciseAppDescendant(item, byNum) {
  const seen = new Set();
  let cur = item;
  while (cur && cur.parent != null && !seen.has(String(cur.parent))) {
    const pnum = String(cur.parent);
    if (pnum === EXERCISE_APP_ROOT) return true;
    seen.add(pnum);
    cur = byNum.get(pnum);
  }
  return false;
}

// D3-READINESS (#608/#621) — the pure derivation of `projectPending` + `relatedProjectStatus`, factored
// out of the loader so it can be regression-tested over synthetic items (mirrors how `engine.test.mjs`
// exercises `computeSelection`). Given the items and a `relatedProject → status` map, it computes the
// shipped-surface proxy internally (≥1 resolved item filed against a project ⇒ it has shipped) and
// returns, aligned by index, `{ relatedProjectStatus, projectPending }` for each item:
//   • relatedProjectStatus — the status of the item's `relatedProject` (`'unknown'` if not in the map,
//     `undefined` if the item has no `relatedProject`);
//   • projectPending — true ⇔ an OPEN issue/idea whose `relatedProject` is a `concept` project with
//     ZERO shipped surface. A `concept` project that already has shipped work is status-DRIFT (#617),
//     not a pending project, so its dependents are NOT demoted. We never demote on a `concept` label alone.
//
// #1260 — the shipped-surface proxy was originally "≥1 resolved item with `relatedProject: <proj>` in its
// OWN frontmatter", which missed a real shipped-surface shape, leaving a live project falsely
// `project pending`: resolved build work tied to the project via a `parent:` CHAIN (the normal carve shape —
// slices parented to an impl epic that names the project, none repeating the `relatedProject` tag). That is
// now counted by walking each resolved item's parent chain for a `relatedProject`. A second surface — a
// shipped RUNTIME/DEMO — is supplied by the caller as `builtSurfaceProjects` (projects named by a
// conformance/demo, computed from the demos registry).
//
// The webcharts LESSON gates which signals count: a signal must witness a BUILT/RUNTIME artifact (a resolved
// build item filed against the project, or a demo), never a bare DESIGN/SCAFFOLD surface — a project whose
// spec/scaffold shipped but whose runtime genuinely doesn't exist (an open impl epic only) must STAY
// pending. So two tempting signals are DELIBERATELY excluded: (a) a project SPEC PAGE (webcharts has one yet
// isn't built), and (b) `graduatedTo: project:<id>` — that marks an item that SCAFFOLDED the project entity
// (e.g. webcharts #570 created the project + its design slices), which is project creation, not a runtime,
// so counting it would wrongly clear a designed-not-built project. The parent-chain walk likewise keys only
// on `relatedProject` (a build filed against the project), never on a `graduatedTo: project` ancestor.
function deriveProjectReadiness(items, projectStatus, builtSurfaceProjects = new Set()) {
  const byNum = new Map(items.map((it) => [String(it.num), it]));
  // Walk a resolved item's `parent:` chain (cycle-guarded) for the first `relatedProject` it can reach —
  // so a build slice parented to an impl epic counts toward that epic's project even when the slice itself
  // carries no `relatedProject`. Returns the item's own `relatedProject` first (the #617 original signal).
  const projectViaChain = (it) => {
    const seen = new Set();
    let cur = it;
    while (cur && !seen.has(String(cur.num))) {
      seen.add(String(cur.num));
      if (typeof cur.relatedProject === 'string') return cur.relatedProject;
      if (cur.parent == null) break;
      cur = byNum.get(String(cur.parent));
    }
    return undefined;
  };
  const shippedSurface = new Set(builtSurfaceProjects);
  for (const it of items) {
    if (it.status !== 'resolved') continue;
    const viaChain = projectViaChain(it);
    if (viaChain) shippedSurface.add(viaChain);
  }
  return items.map((item) => {
    const relatedProjectStatus = typeof item.relatedProject === 'string'
      ? (projectStatus.get(item.relatedProject) ?? 'unknown') : undefined;
    const projectPending = item.status === 'open'
      && item.kind !== 'decision'
      && relatedProjectStatus === 'concept'
      && !shippedSurface.has(item.relatedProject);
    return { relatedProjectStatus, projectPending };
  });
}

// Derived agent-readiness tier — a DETERMINISTIC pure function of structured fields only (type +
// resolved prerequisites + projectPending), extracted so it can be unit-pinned independently of a full
// loader run (the sibling of `deriveProjectReadiness`; see src/_data/__tests__/tier.test.ts). The prose
// rationale lives at the call site below. `blockers` is the lightweight `[{ status }]` array the loader
// attaches; `projectPending` is `deriveProjectReadiness`'s D3-readiness demotion (#608).
//   A — agent-ready:    open issue/idea, every blocker resolved, project not pending, no human gate.
//   B — one nod away:   open decision, every blocker resolved (a still-blocked decision can't be
//                        ratified yet — its prerequisite ruling is open — so it is NOT B).
//   C — needs design:   any other open item (blocked issue/idea/decision, a pending-project build, or
//                        an item held on a human-only action — see `humanGate` below).
//   undefined — non-open items carry no tier (readiness is moot once claimed/done/shelved).
// A `humanGate` (a residual that ONLY a human can do — credentialed deploy, agent-training feedback,
// external account setup, a human review/approval) demotes an item out of Tier A exactly like a
// pending project: it's agent-unworkable however clean the frontmatter, but it is NOT a `blockedBy`
// edge (nothing in the backlog will resolve it — a person acts), so it surfaces in its own held
// section rather than looking mysteriously absent. See docs/agent/backlog-workflow.md → Human gate.
function deriveTier(item) {
  if (item.status !== 'open') return undefined;
  // `feature` (#2691/#2998) is the grouping tier ABOVE epic — unlike an epic (which CAN be an unstoried,
  // sized bucket and so IS buildable-as-a-whole), a feature never carries `size` and is never buildable
  // work, so it carries no tier at all (not A, not B/C) — epic-parity stops here on purpose.
  if (item.kind === 'feature') return undefined;
  const blockersClear = item.blockers.every((b) => b.status === 'resolved');
  if (item.kind !== 'decision' && blockersClear && !item.projectPending && !item.humanGate) return 'A';
  if (item.kind === 'decision' && blockersClear) return 'B';
  return 'C';
}

// SLICEABLE (#2998) — a PURE derivation (extracted like `deriveTier`, for direct regression testing over
// synthetic items) of "this open item is a grouping container ready to be carved into slices, not built
// directly." An open `epic` OR `feature` with every `blockedBy` resolved is sliceable — `feature` is
// epic-parity-by-design (the grouping tier ABOVE epic; see `deriveTier`'s feature branch above): it never
// carries `size` or a tier, so its only readiness action is decomposition, exactly like an epic. Only an
// OPEN `blockedBy` withholds sliceability — its decomposition may turn on the blocker's outcome. See the
// call site in `derive()` (below) for the full "why slicing is orthogonal to tier" rationale.
function deriveSliceable(item) {
  return item.status === 'open' && (item.kind === 'epic' || item.kind === 'feature')
    && item.blockers.every((b) => b.status === 'resolved');
}

// NOT-BATCHABLE REASON (#2998) — a PURE derivation (extracted like `deriveTier`/`deriveSliceable`) of the
// single reason an OPEN item isn't in the batch pool. `epic` and `feature` are both excluded up front —
// both are grouping containers with their own slice pills (`sliceable`), never a batch-pool member — so a
// feature reads `null` here exactly like an epic, not 'oversized'/'blocked'/etc. See the call site in
// `derive()` (below) for the full precedence rationale.
function deriveNotBatchableReason(item) {
  if (item.status !== 'open' || item.batchable || item.kind === 'epic' || item.kind === 'feature') return null;
  if (item.stopTheWorld) return 'stop-the-world';
  if (item.humanGate) return 'human-gate';        // rendered by the humanGate pill
  if (item.openBlockers.length) return 'blocked';   // any blocked item — build OR a Tier-C decision
  if (item.projectPending) return 'project-pending';
  if (item.kind === 'decision') return 'decision';  // Tier-B, ready to ratify — decision-ready badge covers it
  if (item.kind === 'story' && typeof item.size === 'number' && item.size > 8) return 'oversized'; // split pill
  return null;
}

// BUILD STATE (#2472) — where an item sits in the LOCAL loop pipeline, the first "backlog-driven console"
// increment (#2474 → #2472): the `/backlog/` tracker joining the batch skill's offline loop-state files it
// didn't read before, so a card can show live-ish pipeline position, not just its static `status`. This is
// the PURE derivation (mirrors `deriveTier` — extracted so it can be unit-pinned over synthetic items,
// independent of a loader run). Given an item and the two lookups the loader builds from `claims.json` /
// `queued.json`, it picks the highest-precedence state:
//   resolved  — frontmatter `status: resolved` (a done item never mislabels as a stale claim; top wins).
//   queued    — the item's num is marked ready-to-merge in queued.json (a lane pushed, awaiting the drain).
//   claimed   — a live session holds the item in claims.json (the status:open→active lock); carries `session`.
//   <status>  — otherwise the item's own status (open/active/preparing/parked) — the additive fallback.
// PURELY ADDITIVE: called with no lookups (or when both files are absent) it returns `{ state: item.status }`
// for every item, so nothing new renders (the badge draws only for `claimed`/`queued`). `claimedBy` is a
// Map keyed by BOTH the full item id and its leading num-token → owning session; `queuedNums` is a Set of
// ready-to-merge nums (padded to width-3, matching queued-state.mjs).
function deriveBuildState(item, { claimedBy, queuedNums } = {}) {
  if (item.status === 'resolved') return { state: 'resolved' };
  if (queuedNums && queuedNums.has(String(item.num).padStart(3, '0'))) return { state: 'queued' };
  const session = claimedBy && (claimedBy.get(item.id) || claimedBy.get(String(item.num)));
  if (session) return { state: 'claimed', session };
  return { state: item.status };
}

// Valid `humanGate.kind` values (the pill + held-section vocabulary live in backlogMeta.js). A gate is
// `{ kind, what, short? }`: `kind` classifies the human action; `what` is the full prose instruction (a
// runbook pointer / the feedback asked for, shown in the badge tooltip); optional `short` is a concise
// one-line summary rendered as the detail-page banner under the badges. Unknown kinds still gate (fail-safe
// demotion) but render generic.
const HUMAN_GATE_KINDS = new Set(['deploy', 'credential', 'feedback', 'review', 'setup']);

// Strip inline markdown so a line makes a clean one-line summary.
const stripInline = (s) => s
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/\*([^*]+)\*/g, '$1')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .trim();

// First real paragraph of a markdown body (skips headings/rules/quotes/lists/code/meta).
function firstParagraph(body) {
  const buf = [];
  for (const raw of body.split('\n')) {
    const l = raw.trim();
    // A real ATX heading is hash(es) + a space (`# Title`); a `#NNN` cross-reference is NOT a heading,
    // so a digest opening with "#719 …" must keep its lead paragraph (the lost-summary bug, #745).
    const skip = !l || l === '---' || /^#{1,6}\s/.test(l) || /^>/.test(l)
      || /^```/.test(l) || /^[-*|]/.test(l) || /^\*\*[^*]+:\*\*/.test(l);
    if (skip) { if (buf.length) break; else continue; }
    buf.push(l);
  }
  return buf.length ? buf.join(' ') : undefined;
}

// Derive { title, summary, details } from a markdown document.
// Reports carry a metadata block (Date/Point/…) before a `---` rule and a
// `**Point:**` lead; item bodies are plain (H1 + paragraphs).
function derive(text, { isReport = false } = {}) {
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : undefined;

  let lead;
  let bodyMd;
  if (isReport) {
    const meta = text.match(/\*\*(?:Point|Goal|Subject|Scope|Purpose|Summary):\*\*\s*(.+)/i);
    if (meta) lead = stripInline(meta[1]);
    const hrIdx = text.search(/^\s*---\s*$/m); // drop the H1 + metadata block
    bodyMd = hrIdx !== -1
      ? text.slice(text.indexOf('\n', hrIdx) + 1).trimStart()
      : (titleMatch ? text.replace(titleMatch[0], '').trimStart() : text);
  } else {
    bodyMd = titleMatch ? text.replace(titleMatch[0], '').trimStart() : text;
  }

  if (!lead) { const p = firstParagraph(bodyMd); if (p) lead = stripInline(p); }
  return {
    title,
    summary: lead,
    details: bodyMd.trim() ? md.render(bodyMd) : undefined,
  };
}

function loadReport(relPath) {
  const p = join(ROOT, normalizeRelatedReport(relPath));
  if (!existsSync(p)) return null;
  const { content } = matter(readFileSync(p, 'utf8')); // reports have no frontmatter
  return derive(content, { isReport: true });
}

// #4166 — the loader body, factored out from the default export so a SCOPED caller (below) can hand it an
// explicit, narrower file list instead of always re-deriving the full `readdirSync(BACKLOG_DIR)` listing.
// `fileNames`, when given, is used AS-IS (basenames, `<id>.md`) instead of the whole-directory listing —
// every line below is byte-identical to before this split.
function buildBacklog(fileNames) {
  // Malformed YAML frontmatter in ONE item must not take down the whole load (#430): a single bad
  // file (the recurring trigger is a `graduatedTo:`/scalar value with an unquoted colon, which
  // js-yaml reads as a nested mapping and throws on) would otherwise hard-crash every consumer —
  // Eleventy, check:readiness, check:standards. We catch per-item, skip the bad file, and collect
  // it so the failure degrades to a reported warning, not a crash.
  const malformed = [];
  const files = Array.isArray(fileNames) ? fileNames : readdirSync(BACKLOG_DIR).filter((f) => f.endsWith('.md'));
  const index = createBacklogIndex({
    backlogDir: BACKLOG_DIR,
    loaderVersion: LOADER_VERSION,
    readCard(file, { skipCache }) {
      const id = file.replace(/\.md$/, '');
      // Filenames lead with EITHER a numeric `NNN` (a LANDED item) or a provisional `xNNNNNN` hash (an
      // in-flight item the drain has not numbered yet — #2288 JIT numbering). `num` is that leading
      // token; a hash is a valid unique key, so everything keyed off `num` works unchanged and a
      // provisional item shows as "#x7k2q9a" until it lands. `slug` is the human text; `id` stays the
      // full filename stem so it remains the route key (permalink = /backlog/<id>/).
      // NOTE: `ID_TOKEN` mirrors `scripts/backlog/id.mjs` ID_TOKEN_RE (CJS can't import that ESM
      // module) — keep the two in sync. Extracted to ONE constant here (#xzxc92d note b) so the
      // num/slug pair can't drift against each other.
      const num = (id.match(new RegExp(`^(${ID_TOKEN})-`)) || [])[1];
      const slug = id.replace(new RegExp(`^(${ID_TOKEN})-`), '');
      let data, content;
      try {
        // Explicit options bypass gray-matter's cache, which retains even failed parses.
        ({ data, content } = matter(readFileSync(join(BACKLOG_DIR, file), 'utf8'), {}));
      } catch (err) {
        // Skip-and-report: one malformed item is a warning, never a crash.
        malformed.push({ file, reason: err.reason || err.message });
        return null;
      }
      const ownBody = content.trim();
      // Report pointers depend on a separate, ROOT-relative file: always re-parse them.
      if (!ownBody && typeof data.relatedReport === 'string') skipCache();

      // Own markdown body wins; else mirror the related report; else nothing.
      const src = ownBody
        ? derive(ownBody)
        : (typeof data.relatedReport === 'string' ? loadReport(data.relatedReport) : null) || {};

      const reportDate = typeof data.relatedReport === 'string'
        ? (data.relatedReport.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]
        : undefined;

      return {
        ...data,
        id,
        num,
        slug,
        title: src.title || data.title || id,
        summary: src.summary || data.summary,
        dateOpened: toDateString(data.dateOpened),
        dateStarted: toDateString(data.dateStarted),
        dateResolved: toDateString(data.dateResolved),
        reportDate,
        // Optional predicted touch-set (#x53zzf9) — sanitized to a clean string[] or undefined. Overrides the
        // raw `...data.scope` spread above so every consumer sees the normalized shape.
        scope: normalizeScope(data.scope),
        details: src.details || data.details || undefined,
      };
    },
  });
  const items = index.load(files).filter(Boolean); // drop malformed cards (reported below)

  if (malformed.length) {
    const lines = malformed.map((m) => `  • ${m.file} — ${m.reason}`).join('\n');
    console.warn(
      `[backlog] ${malformed.length} item(s) skipped — malformed YAML frontmatter ` +
        `(fix the file; an unquoted colon in a scalar is the usual cause):\n${lines}`,
    );
  }

  // Resolve `blockedBy: ["NNN", …]` (a directional prerequisite edge — "cannot start until NNN is
  // resolved", distinct from the "see also" `crossRef` and the epic-grouping `parent`) into a
  // `blockers` array of lightweight references, so a detail page can link each prerequisite.
  // Kept lightweight ({ id, num, slug, title, status }) rather than full item objects to avoid
  // cyclic refs. The validator (check-standards.mjs) guards unresolvable / self / cyclic edges;
  // here we simply drop any NNN that doesn't resolve so a page never renders a dead link.
  const byNum = new Map(items.map((it) => [it.num, it]));

  // D3-READINESS (#608) — a build can't be agent-ready if the STANDARD it builds into doesn't exist
  // yet. `check:standards` gates on mechanics (tier + size + resolved `blockedBy`); it never asks
  // whether the item's `relatedProject` is a real, shipped project. So an open issue/idea whose
  // `relatedProject` is still `status: concept` AND has NO shipped surface is "project-pending": the
  // project must exist first, so the item is NOT truly batchable however clean its frontmatter looks.
  //
  // Precision mirrors the audit's D3 fix (#613): a `concept` project with substantial SHIPPED work is
  // data-drift (the status lags reality — see #617), NOT a pending project, so its dependents stay
  // ready. The deterministic shipped-surface proxy is "has ≥1 resolved item filed against it" — webplugs
  // (0 resolved, pending the #606 ownership ruling) is pending; webblocks/webdocs (many resolved,
  // mislabeled concept) are not. We never demote on a `concept` label alone.
  let projectStatus = new Map();
  try {
    // per-project specs src/_data/projects/<id>.json, assembled (#1157)
    const { loadDataRegistry } = require('../../scripts/lib/registry-loader.cjs');
    projectStatus = new Map(loadDataRegistry('projects').map((p) => [p.id, p.status]));
  } catch { /* missing/malformed projects → no D3-readiness demotion (degrade, don't crash) */ }
  // #1260 — a shipped RUNTIME/DEMO surface also clears `project pending`: every project named by a
  // conformance/demo (a built, runnable artifact — the webcharts-safe signal, never a bare spec page) is
  // treated as having shipped surface. Computed here (the demos registry is a sibling loader) and passed
  // into the pure derivation so the function itself stays testable over plain items.
  let builtSurfaceProjects = new Set();
  try {
    const loadDemos = require('./demos.js');
    const demos = Array.isArray(loadDemos) ? loadDemos : (typeof loadDemos === 'function' ? loadDemos() : []);
    for (const d of demos) {
      const named = Array.isArray(d.projects) ? d.projects : (d.project ? [d.project] : []);
      for (const p of named) if (typeof p === 'string') builtSurfaceProjects.add(p);
    }
  } catch { /* missing/malformed demos → fall back to item-only surface signals (degrade, don't crash) */ }
  // D3-readiness fields (#608/#621), derived by the pure helper so the loader and its regression test
  // share one source of truth. Aligned by index with `items`.
  const projectReadiness = deriveProjectReadiness(items, projectStatus, builtSurfaceProjects);

  items.forEach((item, idx) => {
    const edges = Array.isArray(item.blockedBy) ? item.blockedBy : [];
    // Resolve each `blockedBy` NNN to its target item. FAIL-SAFE (#2062): an edge that DOESN'T resolve
    // (target file missing/renamed, a typo'd NNN) must NOT silently vanish — a dropped edge would leave
    // `blockers` empty, so `deriveTier`'s `blockers.every(resolved)` reads TRUE and the still-blocked item
    // false-surfaces as Tier A / batchable (the #2031-packed-despite-open-#2017 defect). So a dead edge is
    // kept as a synthetic blocker with a non-resolved status — it GATES (Tier C) rather than disappears.
    // The validator (check-standards.mjs) still flags the unresolvable edge for the human to fix.
    item.blockers = edges.map((n) => {
      const num = String(n);
      const target = byNum.get(num);
      if (target) {
        const { id, slug, title, status } = target;
        return { id, num, slug, title, status };
      }
      // Unresolvable edge — gate on it (status !== 'resolved') so it can't false-clear the tier.
      return { id: undefined, num, slug: undefined, title: undefined, status: 'unresolved-edge' };
    });

    // Derived agent-readiness tier — a DETERMINISTIC pure function of structured frontmatter only
    // (type + resolved prerequisites + projectPending), so it's identical across rebuilds, no LLM in
    // the path. It mirrors the four-signal rubric in docs/agent/backlog-workflow.md but ONLY its
    // structurally decidable core: the two prose signals (body verbs, whether the `relatedReport` is a
    // settled plan) are deliberately not read here, which is why the tier is an agent-ready *hint*, not
    // a guarantee — the LLM selection pass still refines it. The rubric itself lives in `deriveTier`
    // (above), extracted so it can be unit-pinned; see its doc-comment for the A/B/C definitions.
    // D3-readiness (#608): the build's standard must exist first. `projectPending` ⇒ the
    // `relatedProject` is a `concept` project with zero shipped (resolved) surface — not mere
    // status-drift (a concept label over real work, see #617), but a project that genuinely isn't
    // built yet. Such a build is NOT agent-ready even with every `blockedBy` resolved, so it is
    // demoted out of Tier A (it falls to C, alongside structurally-blocked work). Exposed as its own
    // field so the detail page, check:standards, and the audit can name the reason precisely.
    item.relatedProjectStatus = projectReadiness[idx].relatedProjectStatus;
    item.projectPending = projectReadiness[idx].projectPending;

    // Human gate (#1137 class) — a residual only a person can clear (credentialed deploy, agent-training
    // feedback, account setup, human review). `humanGate` is `{ kind, what }` from frontmatter; spread in
    // via `...data` above. Expose a normalized boolean + a known-kind flag for the tab/selector; deriveTier
    // reads `item.humanGate` directly to demote it out of Tier A (a non-`blockedBy` hold, like projectPending).
    item.humanGated = !!item.humanGate;
    item.humanGateKind = item.humanGate && typeof item.humanGate === 'object' ? item.humanGate.kind : undefined;
    item.humanGateKnownKind = HUMAN_GATE_KINDS.has(item.humanGateKind);
    // Pending human setup — a human-gated item still awaiting the action (not yet resolved). Drives the
    // "Human setup" tab (backlog.njk), which gathers the residuals only a person can clear. A derived
    // boolean rather than a template-side `rejectattr` because Eleventy's Nunjucks `rejectattr` only honors
    // the attribute-presence form, not the 3-arg `equalto` test — and `where` does strict `===` on one value.
    item.humanSetupPending = item.humanGated && item.status !== 'resolved';

    item.tier = deriveTier(item);

    // Batchable (deterministic) — the candidate set a POINTS-BUDGETED batch may pack
    // (docs/agent/backlog-workflow.md → "Running a batch"): a Tier-A item small enough to chain — a
    // `task` (bounded sub-work, never sized), or a `story` of `size` ≤ 8. A `story` of `size` ≥ 13 and
    // any `epic` are agent-ready but never batched. So `batchable` ⊂ `tier === 'A'`. There is no
    // separate ≤3 "core" tier: the budget packs SMALLEST-FIRST (the selection rank orders by effort),
    // reaching a single `size·8` only when the remaining budget fits — one pool, ordered by `batchCost`.
    // The one non-structural guard the batch skill adds — no buried design fork in the body — can't be
    // decided from fields, so this flag is the size+tier gate; selection still skims the body for a fork.
    const batchShape = item.kind === 'task'
      || (item.kind === 'story' && typeof item.size === 'number' && item.size <= 8);
    // A `stop-the-world` migration (e.g. #487 schema migration) is shape-batchable and Tier A, but it can
    // NEVER ride a routine batch: it needs the whole backlog drained (quiescent) + a dedicated run, so the
    // selector already refuses to pack it. Encode that in `batchable` itself so the flag — and the tab's
    // "Batchable" filter that keys off it — only ever shows GENUINELY batchable work, not a migration that
    // merely looks shape-eligible. (Its run-precondition is quiescence, surfaced as a stop-the-world pill.)
    item.stopTheWorld = Array.isArray(item.tags) && item.tags.includes('stop-the-world');
    // FILLER (#1620) — a `priority: low` Tier-A item is settled & valid work that is just not worth doing
    // now, so it is demoted OUT of the batch pool exactly as the readiness `--select` engine does
    // (scripts/readiness/engine.mjs `isFiller`): it stops false-surfacing as batchable (no green "batch"
    // pill, excluded from the `countBatch`/`pointsBatch` tally) but is NOT hidden — it stays a visible Tier-A
    // card carrying the `low priority` reasonPill (backlogMeta.priorityMeta.low), hand-pickable when nothing
    // better is open. Demote-not-hide; distinct from a park (which removes the item until a gate clears). This
    // aligns the UI's Batchable filter with the CLI's auto-pack, which already excludes filler.
    item.filler = item.tier === 'A' && item.priority === 'low';
    item.batchable = item.tier === 'A' && batchShape && !item.stopTheWorld && !item.filler;

    // Why an OPEN item is not in the batch pool — the single reason a tab pill renders so a non-batchable
    // item never looks unexplained (the #1137/#487 rigor: every "looks ready but isn't" carries its reason
    // in data, not just in a body note). Ordered by precedence; null when batchable, an epic (own slice
    // pills), or non-open. `human-gate`/`oversized`/`decision` already have dedicated pills elsewhere, so
    // this drives only the three that lacked one — `stop-the-world`, `project-pending`, `blocked`.
    item.openBlockers = (item.blockers || []).filter((b) => b.status !== 'resolved').map((b) => b.num);
    // Precedence matters: the BLOCKING reasons (blocked / project-pending / human-gate) come before the
    // `decision` short-circuit so that **every Tier-C ("Not ready") item carries a reason pill** — a blocked
    // *decision* is Tier C and must show "blocked by #NNN", not fall through to the bare `decision` case
    // (which is reserved for a Tier-B, ready-to-ratify decision the decision-ready badge already explains).
    // By construction a Tier-C issue/idea always has open blockers, projectPending, or a humanGate, and a
    // Tier-C decision always has open blockers — so this chain yields a non-null reason for every not-ready item.
    item.notBatchableReason = deriveNotBatchableReason(item);

    // HAS-PREDICTED-SCOPE readiness lens (#2618) — an OPEN, unblocked, agent-ready (Tier-A) BUILD item that
    // carries NO predicted `scope:` reads as dev-ready but is NOT fully shaped. It mirrors the exact
    // `unshaped-no-scope` (needs-probe) condition the conveyor dispatcher holds on
    // (scripts/readiness/dispatch-plan.mjs): such an item is "assume-overlaps-everything" and is NEVER
    // launched to build blind — it is auto-prepared (its `scope:` authored upstream) before it can dispatch.
    // This is a SURFACING lens, not a hard gate: the item stays agent-ready (Tier A), it just also carries a
    // "needs scope" hint so a dev-ready-looking card with no touch-set doesn't read as fully shaped (per the
    // PR #663 empty-scope refinement — an unscoped item is unshaped/needs-probe, not blocked). `item.scope`
    // is already normalizeScope()'d to `undefined` when the frontmatter scope is absent / non-array / empty /
    // all-blank, so `!item.scope` catches every "no usable scope" shape the dispatcher's normScope() does.
    // Epics (umbrellas — sliced into children, never built directly; excluded from the build queue) don't
    // apply; Tier A already excludes decisions and non-open items, so this is precisely the build pool. The
    // predicate is the pure `deriveUnshapedNoScope` (exported + unit-pinned), so the loader field, the badge,
    // and the check:readiness note never drift from one another.
    item.unshapedNoScope = deriveUnshapedNoScope(item);

    // Active batchable — a batch-shaped item already CLAIMED (status:active). It carries no tier (tier is
    // open-only, deriveTier above), so it drops out of `batchable` and the open-only Prioritisation table.
    // We pin it back like an in-flight decision so a concurrent batcher sees the batch work genuinely
    // underway — the authoritative status:open→active lock, not just the ephemeral reservations.json
    // soft-hold (which is dev-only and lease-expires). Mirrors the activeDecisions pin in backlog.njk;
    // disjoint from `batchable` (open) by the status gate, so the two never double-count.
    item.activeBatchable = item.status === 'active' && batchShape;

    // An open `epic` with every prerequisite cleared can't be BUILT directly — its work lives in child
    // stories/tasks. It is ready to be SLICED, not implemented. We surface that as its own readiness class
    // so the Prioritisation tab doesn't tally a container epic as buildable work standing NEXT TO the very
    // slices its work already lives in (a visual double-count — the complaint that drove this).
    //
    // ORTHOGONAL TO TIER (like `splittable`, NOT `⊂ Tier A`): slicing is *decomposition* — an authoring
    // act — so it does NOT depend on the leaves being buildable. The `projectPending` / `humanGate`
    // demotions gate BUILDING a leaf into a not-yet-shipped standard (or past a human-only residual); they
    // never gate carving the umbrella. A `concept`-project epic like #1004 (webcharts: design shipped, no
    // impl) is therefore Tier C **and** sliceable — "not ready to build, but ready to slice" — and the
    // slice IS its call-to-action (carving it produces the build slices that inherit the project-pending
    // demotion). Only an epic with an OPEN `blockedBy` stays non-sliceable: its decomposition may turn on
    // the blocker's outcome, so it shows "blocked by #NNN" until that clears. `batchable` (task/story) and
    // `sliceable` (epic) remain disjoint by kind, so the two pools never double-count.
    item.sliceable = deriveSliceable(item);

    // Splittable (deterministic) — an open `story` too big to chain (`size` > 8, i.e. the 13 band) is the
    // `/split` skill's story-class candidate: real buildable work, but better cut into ≤5 slices first
    // (docs/agent/backlog-workflow.md → "Splitting"). The exact complement of `batchable`'s size gate
    // among sized stories. Unlike a `sliceable` epic — which literally can't be built and so is PULLED OUT
    // of the agent-ready pool — an oversized story IS buildable as-is, so `splittable` is an ORTHOGONAL
    // flag layered ON TOP of its tier (it stays in the agent-ready/not-ready bucket), not a tier of its own.
    // Independent of `tier`: a still-blocked (Tier C) oversized story is just as worth splitting.
    // `unsplittableReason` is the story-side escape hatch (mirrors an epic's `childlessReason`): once a
    // `/split` run rules a story could-not-split, recording the reason CLEARS the split flag (so it stops
    // re-flagging) and the table shows a muted "atomic · <reason>" pill instead — analyzed, not a to-do.
    item.splittable = item.status === 'open' && item.kind === 'story'
      && typeof item.size === 'number' && item.size > 8 && !item.unsplittableReason;

    // Batch COST (deterministic) — the context-budget weight used to pack a POINTS-BUDGETED batch
    // (docs/agent/backlog-workflow.md → "Running a batch"). Distinct from burndown `size`: a `task`
    // carries no burndown points (they roll up to a parent) but still consumes a session's context, so
    // it is weighted at a nominal TASK_COST (2). A `story`/unstoried-epic uses its own `size`. The
    // budget sums this, NOT burndown `size`, so a task-heavy chain can't slip through "free".
    item.batchCost = item.kind === 'task' ? 2
      : typeof item.size === 'number' ? item.size
      : undefined;

    // Repo-LOCUS (#447-follow / #498/#500 / backlog-workflow.md → "Repo-locus") — which repo's gate can
    // honestly CLOSE this item, i.e. its **gate home**. A cross-locus `/batch` is locus-agnostic: it packs
    // items of any locus and gates EACH in its own locus (the LOCI registry's `gateCommand`/`repoPath`), so
    // no item is dropped for locus — but the locus must be RIGHT, since it selects which gate runs. The
    // locus is `locus:` frontmatter when AUTHORED (an explicit decision — e.g. a frontier-ui-tagged item
    // built and gated IN WE declares `locus: webeverything`), else the structural exercise-app check, else
    // (#xdx3ifb multi-repo slice 3) INFERRED from the item's own predicted `scope:` prefix — a `plateau:`-
    // scoped item resolves to `plateau-app`, its real gate, rather than falling through to `webeverything` —
    // else from cross-repo tag markers (biasing toward `webeverything` — a wrongly-inferred cross-repo locus
    // would route close-out to the wrong repo's gate, so inference only fires on high-precision
    // structural/scope/tag markers), else `webeverything`. `locusAuthored` lets check:standards nudge
    // unset-but-inferred items to declare it explicitly. Inferred values are a subset of
    // check-standards-rules.mjs `LOCI` keys.
    item.locusAuthored = typeof item.locus === 'string' && item.locus.length > 0;
    item.locus = item.locusAuthored ? item.locus
      : isExerciseAppDescendant(item, byNum) ? 'exercise-app'
      : inferLocusFromScope(item.scope) || inferLocusFromTags(item.tags);

    // CTA INVARIANT (#1275) — every OPEN item must render at least one pill: a call-to-action telling
    // whoever picks it up what to DO next (build / slice / split / ratify / unblock / graduate the
    // project / clear a human gate), or a passive reason it's parked. `hasCta` is the exact union of every
    // pill the Prioritisation table can render — the agent-ready tier badge (A = build it, B = ratify/
    // prepare), the batch/slice/split action badges, and the `reasonPill` set (stop-the-world / human-gate
    // / blocked-by / project-pending). It MUST stay in lockstep with backlog.njk + backlog-badges.njk's
    // `reasonPill`. `check:standards` hard-errors on any open item where this is false, so a not-ready item
    // can never ship as a bare tier badge with no next step — the dead-end #1004 surfaced. By construction
    // it holds: a Tier-C item is blocked (openBlockers), project-pending, or human-gated; a Tier-C epic is
    // additionally sliceable when its blockers clear — so every branch lights a pill.
    item.hasCta = item.tier === 'A' || item.tier === 'B'
      || item.batchable || item.activeBatchable
      || item.sliceable || item.splittable
      || item.stopTheWorld || !!item.humanGate
      || item.openBlockers.length > 0 || item.projectPending;
  });

  // Reverse dependency edges + unblock-leverage (#254) — INVERT `blockedBy` so each item knows who
  // depends on it, then score how much work resolving it would free. A pure, deterministic function of
  // the structured edge set (no body parsing, no LLM), so it's identical across rebuilds — the same
  // "downstream-unblock leverage" the next-backlog-item skill ranks by, made visible on /backlog/.
  const dependentsByNum = new Map(items.map((it) => [it.num, []]));
  for (const item of items) {
    for (const b of item.blockers) {
      // `b` is a resolvable prerequisite of `item` → `item` is a dependent of `b`.
      if (dependentsByNum.has(b.num)) dependentsByNum.get(b.num).push(item);
    }
  }
  const isOpen = (it) => it.status === 'open';
  // Distinct OPEN items reachable along the reverse-dependency chain (the full set an item ultimately
  // gates). Memoised DFS; the validator forbids cycles, but the in-stack guard keeps a stray cycle from
  // looping forever (it just stops descending at the back-edge). DAG ⇒ the memo is always complete.
  const transOpenCache = new Map();
  function transitiveOpenDependents(num, stack = new Set()) {
    if (transOpenCache.has(num)) return transOpenCache.get(num);
    if (stack.has(num)) return new Set(); // cycle guard
    stack.add(num);
    const acc = new Set();
    for (const dep of dependentsByNum.get(num) || []) {
      if (isOpen(dep)) acc.add(dep.num);
      for (const n of transitiveOpenDependents(dep.num, stack)) acc.add(n);
    }
    stack.delete(num);
    transOpenCache.set(num, acc);
    return acc;
  }
  for (const item of items) {
    const directDeps = dependentsByNum.get(item.num) || [];
    const openDirect = directDeps.filter(isOpen);
    item.dependents = directDeps.map(({ id, num, slug, title, status }) => ({ id, num, slug, title, status }));
    item.directUnblocks = openDirect.length; // open items directly blocked by this one
    item.transitiveUnblocks = transitiveOpenDependents(item.num).size; // all open items it ultimately gates
    // The dependents that would flip to agent-ready if THIS item resolved: open issue/idea whose every
    // *other* blocker is already resolved, so this item is their last open prerequisite. This is the
    // leverage that actually frees work (an edge to a still-multiply-blocked item frees nothing yet).
    item.unblocksToReady = openDirect.filter((dep) =>
      dep.kind !== 'decision' &&
      dep.blockers.every((b) => b.status === 'resolved' || b.num === item.num),
    ).length;
    // Single composite for a deterministic template sort: transitive reach dominates (×1000, counts are
    // far below that), direct count breaks ties. Higher = frees more work. (direct ≤ transitive always.)
    item.leverageScore = item.transitiveUnblocks * 1000 + item.directUnblocks;
  }

  // Roll children up under their epic so an epic tile can list what it contains — `parent` is the
  // grouping edge ("rolls under epic NNN"), distinct from the `blockedBy` prerequisite edge. Each child
  // is a lightweight ref (no cyclic full objects), carrying the fields the circle chip needs (status +
  // tier for colour, size/workItem for the tooltip). Ordered by `num` so the circles read in filing
  // order, independent of the dateOpened sort applied to `items` below.
  for (const item of items) {
    item.children = items
      .filter((c) => c.parent != null && String(c.parent) === item.num)
      .sort((a, b) => String(a.num).localeCompare(String(b.num)))
      .map(({ id, num, slug, title, status, kind, size, tier }) =>
        ({ id, num, slug, title, status, kind, size, tier }));
    // How many child slices are still unresolved — drives the tile's epic-state badge. An open epic with
    // 0 open children is effectively delivered (ready to resolve); a resolved epic with >0 open children
    // is a contradiction worth flagging.
    item.openChildCount = item.children.filter((c) => c.status !== 'resolved').length;

    // For a ready-to-slice epic, WHICH action it actually needs — so the Prioritisation bucket separates
    // the few epics that want attention from the many that are just live rollups (their work already sits
    // in the agent-ready/batch pool as open children, so the epic itself is nothing to "do"):
    //   'unsliced'  no child slices, NO reason recorded → ready to /slice now (cut slices, or record why)
    //   'parked'    a `childlessReason` IS recorded (and no open children) → decomposition is gated on that
    //               reason (blocked / undecided / untriaged); the note IS the blocker, so it's NOT a slice
    //               to-do — surface the reason, never prompt a slice. Applies whether or not a wave was
    //               already carved+resolved: a recorded reason means remaining scope is still uncarved.
    //   'done'      every child resolved, epic open, AND no childlessReason → needs an explicit resolve.
    //   'tracking'  open child slices remain           → NO epic-level action; progress IS the children
    //   'program'   a perpetual/burndown program → NEVER a resolve cue, even with all children resolved
    //               between slices. Two flavours, kept aligned with the gate (scripts/check-standards.mjs):
    //               `ongoing: true` = continuous by design (e.g. flagship exercise apps); OR
    //               `childlessReason: program` = incremental burndown whose tail drains on pickup, so the
    //               carved wave finishing is NOT delivery (#1442). The UI used to ignore `childlessReason`
    //               here and flag such epics 'done' while the gate stayed silent — that divergence is the
    //               bug this branch closes: 'done' now fires iff !ongoing ∧ all children resolved ∧
    //               no childlessReason, exactly the gate's resolve-cue predicate.
    // Only 'unsliced' + 'done' are "actionable"; 'parked' + 'tracking' + 'program' are not. Set only on
    // sliceable epics (`sliceable` is assigned in the enrichment loop above, before this one).
    if (item.sliceable) {
      item.epicState = (item.ongoing || item.childlessReason === 'program')
        ? 'program'
        : item.openChildCount > 0
          ? 'tracking'
          : item.children.length > 0
            ? (item.childlessReason ? 'parked' : 'done')
            : (item.childlessReason ? 'parked' : 'unsliced');
    }
  }

  items.sort((a, b) =>
    String(b.dateOpened || '').localeCompare(String(a.dateOpened || '')) ||
    a.id.localeCompare(b.id));

  // Burndown-point totals per readiness group, surfaced beside the item counts on the Prioritisation
  // tab's tags (backlog.njk). Summed from `size` (tasks and most decisions carry none, so they
  // contribute 0) — a story-point total, not item-weighted. Computed here (a live-reloading data file)
  // rather than via a template filter, which would need a config reload to take effect.
  const sumSize = (pred) => items.reduce((t, it) =>
    t + (pred(it) && typeof it.size === 'number' ? it.size : 0), 0);
  items.pointsBatch = sumSize((it) => it.batchable === true);
  // pointsTierA / countAgentReady = BUILDABLE agent-ready only (Tier A minus container epics). Epics
  // roll into the `sliceable` tallies below so the "agent-ready" chip never double-counts an epic
  // alongside its own slices. (Only fed to the Prioritisation chip — no other consumer, #safe-to-narrow.)
  items.pointsTierA = sumSize((it) => it.tier === 'A' && !it.sliceable);
  items.pointsSlice = sumSize((it) => it.sliceable === true);
  items.pointsTierB = sumSize((it) => it.tier === 'B');
  items.pointsTierC = sumSize((it) => it.tier === 'C');

  // Prepared open decisions — a Tier-B item with `preparedDate` set has its forks researched +
  // options stated (the "prepared-fork shape"), so it's ready to ratify rather than research. Counted
  // here (not via a template filter, which can't test attribute presence) to surface on the Prioritisation tab.
  items.countPreparedB = items.filter((it) => it.status === 'open' && it.tier === 'B' && it.preparedDate).length;

  // Buildable agent-ready (Tier A minus epics) and ready-to-slice (Tier-A epics) — split here, not via a
  // template filter, because Nunjucks `where` can't express "tier A AND not sliceable". Drives the
  // Prioritisation chips so a container epic is shown as slice-work, not as a buildable Tier-A item.
  items.countAgentReady = items.filter((it) => it.tier === 'A' && !it.sliceable).length;
  items.countSliceable = items.filter((it) => it.sliceable === true).length;
  // Low-priority (`priority: low`, #1620) tallies, one per Prioritisation readiness bucket — so the tab's
  // "Hide low priority" toggle can decrement EACH summary pill's count/points (not just hide table rows).
  // `priority: low` isn't Tier-A-only (`filler` is): a low-priority DECISION (Tier B) or EPIC (sliceable)
  // is just as demoted, so the toggle must reach every bucket. Each predicate mirrors the pill it adjusts
  // (agent-ready = Tier A minus epics; decision = Tier B; epics = sliceable; not-ready = Tier C) so the
  // subtraction is exact. `countLowOpen` is the whole-view total (drives the section count badge).
  const isLow = (it) => it.priority === 'low';
  items.countLowAgentReady = items.filter((it) => isLow(it) && it.tier === 'A' && !it.sliceable).length;
  items.pointsLowAgentReady = sumSize((it) => isLow(it) && it.tier === 'A' && !it.sliceable);
  items.countLowDecision = items.filter((it) => isLow(it) && it.tier === 'B').length;
  items.pointsLowDecision = sumSize((it) => isLow(it) && it.tier === 'B');
  // …and the prepared subset of those, so the decision pill's "N ✓ prepared" sub-tally stays consistent
  // with its headline count when the toggle hides low-priority decisions (else prepared could exceed total).
  items.countLowPreparedDecision = items.filter((it) => isLow(it) && it.tier === 'B' && it.preparedDate).length;
  items.countLowSliceable = items.filter((it) => isLow(it) && it.sliceable === true).length;
  items.countLowNotReady = items.filter((it) => isLow(it) && it.tier === 'C').length;
  items.pointsLowNotReady = sumSize((it) => isLow(it) && it.tier === 'C');
  items.countLowOpen = items.filter((it) => it.status === 'open' && isLow(it)).length;
  // Oversized stories (story · size > 8) flagged as `/split` candidates. NOT a separate readiness bucket (an
  // oversized story is real buildable work; see the `splittable` note above). Includes Tier-C blocked
  // oversized stories too. `countSplittableReady` is the agent-ready (Tier A) subset — the "· N to split"
  // sub-tally folded onto the single "agent-ready" Prioritisation pill (the old standalone "to split" pill
  // was merged in: agent-ready-beyond-batch is the SUPERSET — it also holds stop-the-world / unsized Tier-A
  // items that aren't splittable — so the pill anchors on agent-ready and shows the split count inside it).
  // Blocked (Tier C) oversized stories aren't agent-ready, so they sit under the "not ready" pill, still
  // carrying a `split` badge and reachable via the "Splittable only" chip.
  items.countSplittable = items.filter((it) => it.splittable === true).length;
  items.countSplittableReady = items.filter((it) => it.splittable === true && it.tier === 'A').length;
  // Of the ready-to-slice epics, how many actually need a human/agent action (slice or resolve) versus
  // are just tracking open children. The chip leads with this so the screen never reads as "N epic
  // to-dos" when most are passive rollups.
  items.countEpicUnsliced = items.filter((it) => it.epicState === 'unsliced').length;
  items.countEpicDone = items.filter((it) => it.epicState === 'done').length;
  items.countEpicParked = items.filter((it) => it.epicState === 'parked').length;
  items.countEpicProgram = items.filter((it) => it.epicState === 'program').length;
  items.countEpicActionable = items.countEpicUnsliced + items.countEpicDone;

  // Active batches (DEV-ONLY, advisory) — the live soft-reservations a running `/batch` stamps in
  // `.claude/skills/batch-backlog-items/reservations.json` (`held[]` of `{num, session, at}`; the
  // `session` slug — `batch-YYYY-MM-DD-n1-n2…` — names the batch and groups its items). Surfaced on the
  // Prioritisation tab so a concurrent batcher can see what's already being worked. Honest scope: this is
  // ephemeral session state — on the dev server it live-reloads as batches reserve/clear, but a STATIC
  // build freezes whatever was held at build time, so we treat it as a dev-only convenience. Stale holds
  // (older than `ttlMinutes`, default 120) are dropped here exactly as `check:readiness` ignores them, so
  // a crashed session can't show a phantom batch forever. Each item also gets `reservedBy` (its holding
  // session) for the per-row marker. Read defensively — a missing/garbled file just means "no batches".
  items.activeBatches = [];
  try {
    // #2236 — fixture builds are frozen-content renders; never read the dev-only, gitignored soft-hold
    // file (even if one happens to exist on the machine building the fixture site) so the fixture output
    // stays a pure function of the checked-in fixture set, never incidental local session state.
    const resPath = process.env.WE_VISUAL_FIXTURES
      ? null
      : join(ROOT, '.claude/skills/batch-backlog-items/reservations.json');
    if (resPath && existsSync(resPath)) {
      const res = JSON.parse(readFileSync(resPath, 'utf8'));
      const ttlMs = (typeof res.ttlMinutes === 'number' ? res.ttlMinutes : 120) * 60_000;
      const now = Date.now();
      const live = (Array.isArray(res.held) ? res.held : [])
        .filter((h) => h && h.session && h.num && !Number.isNaN(Date.parse(h.at)) && (now - Date.parse(h.at)) <= ttlMs);
      const byNum = new Map(items.map((it) => [String(it.num), it]));
      const bySession = new Map();
      for (const h of live) {
        const num = String(h.num);
        const it = byNum.get(num);
        if (it) it.reservedBy = h.session; // per-row "held by" marker
        if (!bySession.has(h.session)) bySession.set(h.session, { session: h.session, at: h.at, nums: [] });
        const b = bySession.get(h.session);
        b.nums.push(num);
        if (Date.parse(h.at) < Date.parse(b.at)) b.at = h.at; // earliest hold = batch start
      }
      // Derive a human date (the slug carries YYYY-MM-DD; fall back to the earliest hold's day) and the
      // burndown-point sum of an item's held work, so the chip can show "N items · M pts" like the others.
      items.activeBatches = [...bySession.values()].map((b) => {
        const m = /batch-(\d{4}-\d{2}-\d{2})/.exec(b.session);
        const pts = b.nums.reduce((t, n) => {
          const it = byNum.get(n);
          return t + (it && typeof it.size === 'number' ? it.size : 0);
        }, 0);
        return { ...b, nums: b.nums.sort((x, y) => Number(x) - Number(y)), date: m ? m[1] : b.at.slice(0, 10), points: pts };
      }).sort((a, b) => String(b.at).localeCompare(String(a.at))); // most-recently-started first
    }
  } catch { /* advisory only — never break the build over reservation state */ }

  // BUILD STATE (#2474 → #2472) — the first "backlog-driven console" increment: attach each item's position
  // in the LOCAL loop pipeline, joined from the batch skill's offline loop-state files the tracker didn't
  // read before. Two files, BOTH read DEFENSIVELY (missing / garbled → treated as empty, never throws) —
  // exactly the reservations soft-hold pattern above:
  //   • claims.json  — `{ ttlMinutes, sessions: [{ session, ids: [<full-slug>], at }] }` — which items a
  //                    live session hard-claimed (the status:open→active lock). TTL-pruned (default 120 min)
  //                    so a crashed session can't pin a phantom claim forever, mirroring the reservation TTL.
  //   • queued.json  — `{ queued: [{ num, lane?, batchSlug? }] }` — items a lane pushed + marked
  //                    ready-to-merge, waiting for the drain. No TTL (a durable ready-to-merge signal).
  // The join is via the pure `deriveBuildState` (precedence resolved > queued > claimed > status), so it's
  // unit-pinnable independent of the fs read here. PURELY ADDITIVE: if both files are absent, every item's
  // buildState just equals its status and nothing new renders (the badge draws only for claimed/queued).
  // Fixture builds (#2236) never read the dev-only, gitignored files, same guard as reservations above —
  // the fixture output stays a pure function of the checked-in fixture set.
  const claimedBy = new Map();
  const queuedNums = new Set();
  try {
    const claimsPath = process.env.WE_VISUAL_FIXTURES
      ? null
      : join(ROOT, '.claude/skills/batch-backlog-items/claims.json');
    if (claimsPath && existsSync(claimsPath)) {
      const raw = JSON.parse(readFileSync(claimsPath, 'utf8'));
      const ttlMs = (typeof raw.ttlMinutes === 'number' ? raw.ttlMinutes : 120) * 60_000;
      const now = Date.now();
      for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
        if (!s || !s.session || !s.at) continue;
        const t = Date.parse(s.at);
        if (Number.isNaN(t) || now - t > ttlMs) continue; // TTL-prune a stale/crashed session's claims
        for (const cid of Array.isArray(s.ids) ? s.ids : []) {
          const claimId = String(cid);
          claimedBy.set(claimId, s.session); // full slug (`964-check-…`, how `claim` stamps it)
          const numTok = (claimId.match(new RegExp(`^(${ID_TOKEN})`)) || [])[1];
          if (numTok) claimedBy.set(numTok, s.session); // …and the leading num token, for robustness
        }
      }
    }
  } catch { /* advisory only — a corrupt claims file just means "nothing claimed" */ }
  try {
    const queuedPath = process.env.WE_VISUAL_FIXTURES
      ? null
      : join(ROOT, '.claude/skills/batch-backlog-items/queued.json');
    if (queuedPath && existsSync(queuedPath)) {
      const raw = JSON.parse(readFileSync(queuedPath, 'utf8'));
      for (const q of Array.isArray(raw.queued) ? raw.queued : []) {
        if (q && q.num != null) queuedNums.add(String(q.num).padStart(3, '0')); // match queued-state.mjs padding
      }
    }
  } catch { /* advisory only — a corrupt queued file just means "nothing queued" */ }
  for (const item of items) {
    item.buildState = deriveBuildState(item, { claimedBy, queuedNums });
  }

  // Active work (#1854 v2) — a COMMAND CENTER for everything in flight at once, grouped into
  // OPERATION-TYPE LANES so someone juggling many concurrent runs can coordinate them. Lanes are derived
  // here from structured fields only (status + kind + reservation membership) — the deterministic, build-
  // time skeleton, refreshed on rebuild as items are claimed/resolved:
  //   • Preparing — a decision claimed by /prepare (status:preparing): forks being researched to DoR.
  //   • Deciding  — an active decision (status:active, kind:decision): a ratification call in progress.
  //   • Slicing   — an active epic (status:active, kind:epic): being /sliced into child stories.
  //   • Batching  — items soft-held by a running /batch (reservedBy), grouped by batch session.
  //   • Building  — any other active story/task (status:active): a single /next or ad-hoc build.
  //   • Workflows — multi-agent /workflow runs; LIVE-only (journal-backed), rendered client-side.
  // The genuinely-LIVE layer — running workflows AND a per-session "what's happening right now" digest for
  // each active item — can't live here (it's in the harness transcripts, not the repo), so the tab polls
  // /active-progress.json (written by the dev-only watcher scripts/dev/active-progress-watch.mjs) and
  // overlays it onto these lane rows. Dev-only, frozen on a static build, read defensively.
  const activeLite = ({ id, num, slug, title, status, kind, size, tier, reservedBy, relatedProject }) =>
    ({ id, num, slug, title, status, kind, size, tier, reservedBy, relatedProject });
  const lanes = { preparing: [], deciding: [], slicing: [], programs: [], building: [] };
  const batchBySession = new Map(
    (items.activeBatches || []).map((b) => [b.session, { session: b.session, date: b.date, points: b.points, items: [] }]),
  );
  for (const it of items) {
    const lite = activeLite(it);
    if (it.status === 'preparing') { lanes.preparing.push(lite); continue; }
    if (it.status !== 'active') continue;
    const grp = it.reservedBy ? batchBySession.get(it.reservedBy) : null;
    if (grp) grp.items.push(lite);                       // batch membership wins
    else if (it.kind === 'decision') lanes.deciding.push(lite);
    // An active epic is being SLICED — UNLESS it's an `ongoing` program (a perpetual umbrella like the
    // flagship exercise apps), which is legitimately always-active and is NOT a slice operation. Calling
    // those "slicing" overclaims, so they get their own Programs lane.
    else if (it.kind === 'epic' || it.kind === 'feature') (it.ongoing ? lanes.programs : lanes.slicing).push(lite);
    else lanes.building.push(lite);                       // story / task / anything else active
  }
  const byNumAsc = (a, b) => Number(a.num) - Number(b.num);
  for (const k of Object.keys(lanes)) lanes[k].sort(byNumAsc);
  const batches = [...batchBySession.values()].filter((b) => b.items.length);
  const batchItemCount = batches.reduce((t, b) => t + b.items.length, 0);
  items.activeWork = {
    lanes,
    batches,
    // Vitals — the at-a-glance roll-up the command center leads with (live workflow/agent totals are
    // added client-side from the poll). `count` also drives the tab badge.
    vitals: {
      preparing: lanes.preparing.length,
      deciding: lanes.deciding.length,
      slicing: lanes.slicing.length,
      programs: lanes.programs.length,
      batching: batchItemCount,
      batches: batches.length,
      building: lanes.building.length,
    },
    count: lanes.preparing.length + lanes.deciding.length + lanes.slicing.length
      + lanes.programs.length + lanes.building.length + batchItemCount,
  };

  return items;
}

module.exports = function backlog() { return buildBacklog(); };

// #4166 — a SCOPED entry point for check-standards.mjs's `--local --files=` reference-following checks
// (blockedBy edges, formerSlugs, the backlog-consuming lints in its 6d family): parses only the given
// backlog/*.md basenames through the SAME pipeline the default export uses, instead of the whole ~4.1k-item
// corpus — the measured cost this card targets. Cross-item derived fields that need items OUTSIDE the given
// set for full accuracy (the `children` rollup, `dependents`/`transitiveUnblocks` reverse-edge reach, the
// `projectPending` parent-chain walk) are correspondingly UNDER-COUNTED — never over-counted — relative to a
// full load. That is safe for `check:standards`'s own purpose: every finding it can produce is either (a)
// attributed to the item's OWN file, in which case `--local --files=`'s existing classification
// (`partitionLocal`, scripts/readiness/claimScope.mjs) already demotes it to a note whenever that file sits
// outside the effective scope, whether or not this loader under-counted its derived fields; or (b) a
// path-less/aggregate finding (ctaless, the classification-collapse guard), which `--local` ALREADY demotes
// unconditionally (`partitionLocal`'s "path-less global → note iff --local"). The caller is responsible for
// widening `fileNames` to the full effective scope BEFORE calling — changed files, their outgoing
// `blockedBy`/`parent`/`formerSlugs` targets, and any file GIT-GREP finds referencing a changed item's id —
// exactly what `computeBacklogScope` in check-standards.mjs does; passing only the literal `--files=` set
// would reproduce the false-green #4166 exists to close (a lane-caused broken edge on a file the lane didn't
// itself edit, silently demoted). The Eleventy site build and every other consumer keep calling the default
// export, completely unaffected by this addition.
module.exports.loadBacklogScoped = function loadBacklogScoped(fileNames) { return buildBacklog(fileNames); };

// Named export of the pure D3-readiness derivation (#621) for direct regression testing — Eleventy only
// ever invokes the default function export, so attaching this property is inert to the build.
module.exports.deriveProjectReadiness = deriveProjectReadiness;
// Named export of the pure tier rubric for direct regression testing (the decision-with-open-blocker
// demotion); inert to the Eleventy build, which only invokes the default function export.
module.exports.deriveTier = deriveTier;
// Named exports of the pure sliceable / not-batchable-reason derivations (#2998) for direct regression
// testing — inert to the Eleventy build, which only invokes the default function export.
module.exports.deriveSliceable = deriveSliceable;
module.exports.deriveNotBatchableReason = deriveNotBatchableReason;
// Named export of the pure build-state precedence (#2472) for direct regression testing — inert to the
// Eleventy build, which only invokes the default function export.
module.exports.deriveBuildState = deriveBuildState;
module.exports.HUMAN_GATE_KINDS = HUMAN_GATE_KINDS;
// Named export of the pure `scope:` sanitizer (#x53zzf9) for direct regression testing — inert to the
// Eleventy build, which only invokes the default function export.
module.exports.normalizeScope = normalizeScope;
// Named export of the pure has-predicted-scope lens predicate (#2618) for direct regression testing — inert
// to the Eleventy build, which only invokes the default function export.
module.exports.deriveUnshapedNoScope = deriveUnshapedNoScope;
// Named export of the pure scope-prefix → locus derivation (#xdx3ifb multi-repo slice 3) for direct
// regression testing — inert to the Eleventy build, which only invokes the default function export.
module.exports.inferLocusFromScope = inferLocusFromScope;
// Named export of the title/summary/details derivation (#745) for direct regression testing — Eleventy
// only ever invokes the default function export, so attaching this property is inert to the build.
module.exports.derive = derive;
