/**
 * @file scripts/__tests__/check-standards.test.mjs
 * @description Unit harness for the validator's backlog rules (#251).
 *
 * `check-standards.mjs` is a top-to-bottom live script, so before this each new rule's correctness —
 * false-positive safety especially — was a manual, un-regressed check (#247 fell back to a throwaway
 * negative-path script + a hand dry-run). These tests exercise the *exact* pure rule the script
 * composes (`validateBacklogItem` from check-standards-rules.mjs) against synthetic fixtures, plus a
 * standing false-positive guard that runs it over the real backlog + registries so a future rule
 * tightening can't silently start erroring on legitimate free-form data.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { loadBlocks } from '../lib/blocks-loader.cjs';
import { loadIntents } from '../lib/intents-loader.cjs';
import { loadProtocols } from '../lib/protocols-loader.cjs';
import { loadDemos } from '../lib/demos-loader.cjs';
import { loadDataRegistry } from '../lib/registry-loader.cjs';
import { loadAdapters } from '../lib/adapters-loader.cjs';
import {
  buildGraduatedKinds, validateBacklogItem, isCanonicalGraduated, dirLevelScopeFinding,
  buildTrackedPathIndex, scopeBasenameMismatches, scopeBasenameMismatchMessage, SCOPE_BASENAME_MAX_SUGGESTIONS,
} from '../check-standards-rules.mjs';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(ROOT, 'src/_data');
const loadJson = (rel) => JSON.parse(readFileSync(join(DATA, rel), 'utf8'));

// ── Synthetic fixtures ────────────────────────────────────────────────────────
// A compact registry so resolution is deterministic: `intent:droplist` / `intent:motion` and
// `block:data-grid` resolve; everything else does not.
const FIXTURE_KINDS = buildGraduatedKinds({
  intents: [{ id: 'droplist' }, { id: 'motion' }],
  blocks: [{ id: 'data-grid' }],
});
const FIXTURE_CTX = {
  projectById: new Map([['plateau-app', { id: 'plateau-app' }]]),
  graduatedKinds: FIXTURE_KINDS,
  knownNums: new Set(['100']),
  reportExists: (rel) => rel === 'reports/real.md',
};
// A minimally-valid item; spread + override per case.
const baseItem = {
  id: '999-fixture',
  num: '999',
  title: 'Fixture item',
  kind: 'task',
  status: 'open',
  summary: 'A synthetic backlog item for the rule harness.',
  dateOpened: '2026-06-09',
};
const run = (overrides) => validateBacklogItem({ ...baseItem, ...overrides }, FIXTURE_CTX);
const messages = (res) => res.errors.map((e) => e.message);

describe('validateBacklogItem — graduatedTo resolution (#247)', () => {
  it('errors on an unknown kind (typo)', () => {
    const res = run({ status: 'resolved', dateResolved: '2026-06-09', graduatedTo: 'intnet:droplist' });
    expect(messages(res)).toContainEqual(expect.stringContaining('uses unknown kind "intnet"'));
  });

  it('errors on an unresolved slug within a known kind', () => {
    const res = run({ status: 'resolved', dateResolved: '2026-06-09', graduatedTo: 'intent:droplsit' });
    expect(messages(res)).toContainEqual(expect.stringContaining('graduatedTo "intent:droplsit" does not resolve'));
    // It is the agent-targetable unresolved-ref descriptor (fed to the #196 fixer), not a bare message.
    const e = res.errors.find((x) => x.message.includes('intent:droplsit'));
    expect(e.descriptor).toMatchObject({ kind: 'unresolved-ref', field: 'graduatedTo', refRegistry: 'intents.json' });
  });

  it('accepts a resolving compact ref', () => {
    const res = run({ status: 'resolved', dateResolved: '2026-06-09', graduatedTo: 'intent:motion' });
    expect(res.errors).toEqual([]);
  });

  it('accepts the `none` sentinel and free-form prose without resolving them', () => {
    for (const graduatedTo of ['none', 'enhanced the existing validation engine', '/intents/motion/', 'reports/x.md']) {
      const res = run({ status: 'resolved', dateResolved: '2026-06-09', graduatedTo });
      expect(res.errors, `graduatedTo: ${graduatedTo}`).toEqual([]);
    }
  });
});

describe('isCanonicalGraduated — graduatedTo leading-token canonicality (#614)', () => {
  it('treats none / resolving typed-id / repo-path / file#anchor as canonical', () => {
    for (const v of ['none', 'intent:motion', 'block:data-grid', 'capabilities/resolver.ts', 'blocks/renderers/x.ts', 'a/b/c.mjs'])
      expect(isCanonicalGraduated(v, FIXTURE_KINDS), v).toBe(true);
  });
  it('treats a leading typed-id or repo-path with a trailing annotation as canonical (entity still leads)', () => {
    for (const v of ['intent:motion — the announcer contract', 'capabilities/resolver.ts (resolveSlot / native-first)'])
      expect(isCanonicalGraduated(v, FIXTURE_KINDS), v).toBe(true);
  });
  it('treats a bare id resolvable in a registry as canonical (the normalizer will prefix it)', () => {
    expect(isCanonicalGraduated('motion', FIXTURE_KINDS)).toBe(true);          // bare intent id
    expect(isCanonicalGraduated('data-grid', FIXTURE_KINDS)).toBe(true);       // bare block id
  });
  it('strips a YAML end-of-line comment before judging', () => {
    expect(isCanonicalGraduated('none   # triage epic — decomposed', FIXTURE_KINDS)).toBe(true);
  });
  it('flags pure prose / an unresolvable lead / an item-id split as non-canonical', () => {
    for (const v of ['Protocol', 'enhanced the existing validation engine', '575, 576, 577', 'plateau: getStandInElement.ts (tag-keyed rehydration)'])
      expect(isCanonicalGraduated(v, FIXTURE_KINDS), v).toBe(false);
  });
  it('leaves the object (crossRef) form alone — not this rule\'s subject', () => {
    expect(isCanonicalGraduated({ url: '/blocks/x/', label: 'X' }, FIXTURE_KINDS)).toBe(true);
  });

  it('nudges a resolved story that records no graduatedTo (warning, not error)', () => {
    // base fixture is a `task` (exempt from the nudge, like a decision); a resolved story/epic is the
    // class that should record what it became (#487 maps the old `issue` exemption to `task`).
    const res = run({ kind: 'story', size: 3, status: 'resolved', dateResolved: '2026-06-09' });
    expect(res.errors).toEqual([]);
    expect(res.warnings.map((w) => w.message)).toContainEqual(expect.stringContaining('no graduatedTo'));
  });
});

describe('validateBacklogItem — repo-locus (#repo-locus)', () => {
  it('errors on an authored locus that is not a known value', () => {
    const res = run({ locus: 'plateu-app', locusAuthored: true });
    expect(messages(res)).toContainEqual(expect.stringContaining('invalid locus "plateu-app"'));
  });
  it('accepts a known authored locus with no error/warning', () => {
    const res = run({ locus: 'plateau-app', locusAuthored: true });
    expect(messages(res)).not.toContainEqual(expect.stringContaining('locus'));
    expect(res.warnings.map((w) => w.message)).not.toContainEqual(expect.stringContaining('locus'));
  });
  it('nudges (warning) an inferred cross-repo locus on a batchable item that was never made explicit', () => {
    const res = run({ locus: 'plateau-app', locusAuthored: false, batchable: true });
    expect(res.errors).toEqual([]);
    expect(res.warnings.map((w) => w.message)).toContainEqual(expect.stringContaining("reads as locus \"plateau-app\""));
  });
  it('does NOT nudge a non-batchable (epic / blocked) cross-repo item — locus only matters for the pack', () => {
    const res = run({ locus: 'plateau-app', locusAuthored: false, batchable: false });
    expect(res.warnings.map((w) => w.message)).not.toContainEqual(expect.stringContaining('reads as locus'));
  });
  it('is silent for the default webeverything locus', () => {
    const res = run({ locus: 'webeverything', locusAuthored: false });
    expect(res.warnings.map((w) => w.message)).not.toContainEqual(expect.stringContaining('locus'));
  });
});

describe('validateBacklogItem — sibling reference + sizing rules', () => {
  it('errors on an unresolved relatedProject', () => {
    const res = run({ relatedProject: 'nonexistent-project' });
    expect(messages(res)).toContainEqual(expect.stringContaining('relatedProject "nonexistent-project" does not resolve'));
  });

  it('errors on a crossRef missing its label', () => {
    const res = run({ crossRef: { url: '/somewhere/' } });
    expect(messages(res)).toContainEqual(expect.stringContaining('crossRef must have both "url" and "label"'));
  });

  it('errors on a non-Fibonacci size', () => {
    const res = run({ kind: 'story', size: 4 });
    expect(messages(res)).toContainEqual(expect.stringContaining('non-Fibonacci size "4"'));
  });

  it('errors on an unresolved parent', () => {
    const res = run({ parent: '777' });
    expect(messages(res)).toContainEqual(expect.stringContaining('parent "#777" does not resolve'));
  });

  it('stays clean for a well-formed item', () => {
    expect(run({}).errors).toEqual([]);
  });
});

// ── `estimatedLoc` — the task-only dispatch estimate (#3839, Fork 4 field of #3801) ──
describe('validateBacklogItem — estimatedLoc (task-only dispatch estimate, #3839)', () => {
  it('errors on a story declaring estimatedLoc', () => {
    const res = run({ kind: 'story', size: 3, estimatedLoc: 80 });
    expect(messages(res)).toContainEqual(expect.stringContaining('declares estimatedLoc but is not a task'));
  });
  it('errors on a non-numeric estimatedLoc', () => {
    const res = run({ estimatedLoc: '80' });
    expect(messages(res)).toContainEqual(expect.stringContaining('non-numeric or non-positive estimatedLoc'));
  });
  it('errors on a non-positive or non-integer estimatedLoc', () => {
    expect(messages(run({ estimatedLoc: 0 }))).toContainEqual(expect.stringContaining('non-numeric or non-positive estimatedLoc'));
    expect(messages(run({ estimatedLoc: 1.5 }))).toContainEqual(expect.stringContaining('non-numeric or non-positive estimatedLoc'));
  });
  it('stays clean for a task carrying a valid estimatedLoc', () => {
    expect(run({ estimatedLoc: 80 }).errors).toEqual([]);
  });
});

// ── Feature-tier invariants (#2691, ratified — docs/agent/backlog-workflow.md#feature-tier; plumbing #2998) ──
describe('validateBacklogItem — feature-tier invariants (ROOT + FLAT, #2691/#2998)', () => {
  it('errors when a feature carries a parent (ROOT invariant)', () => {
    const res = run({ kind: 'feature', parent: '100' });
    expect(messages(res)).toContainEqual(expect.stringContaining('is `kind: feature` but carries a `parent`'));
  });

  it('accepts a parent-less open feature (the well-formed root shape)', () => {
    expect(run({ kind: 'feature' }).errors).toEqual([]);
  });

  it('errors on BOTH invariants at once for a feature nested under a feature', () => {
    // "a feature with a parent, and a feature under a feature" — the #2998 Done-when fixture: #999's
    // parent (#100) is ITSELF kind:feature, so the malformed item trips the ROOT check (carries a parent
    // at all) and the FLAT check (that parent is a feature ancestor) simultaneously.
    const ctx = {
      ...FIXTURE_CTX,
      knownNums: new Set(['100']),
      kindByNum: new Map([['999', 'feature'], ['100', 'feature']]),
      parentByNum: new Map([['999', '100']]),
    };
    const res = validateBacklogItem({ ...baseItem, kind: 'feature', parent: '100' }, ctx);
    const msgs = res.errors.map((e) => e.message);
    expect(msgs).toContainEqual(expect.stringContaining('is `kind: feature` but carries a `parent`'));
    expect(msgs).toContainEqual(expect.stringContaining('is `kind: feature` with a `kind: feature` ancestor'));
  });

  it('FLAT invariant walks past a non-feature intermediate ancestor (feature → epic → feature)', () => {
    const ctx = {
      ...FIXTURE_CTX,
      knownNums: new Set(['100', '101']),
      kindByNum: new Map([['999', 'feature'], ['101', 'epic'], ['100', 'feature']]),
      parentByNum: new Map([['999', '101'], ['101', '100']]),
    };
    const res = validateBacklogItem({ ...baseItem, kind: 'feature', parent: '101' }, ctx);
    expect(res.errors.map((e) => e.message)).toContainEqual(expect.stringContaining('kind: feature` ancestor (#100)'));
  });

  it('does not error on FLAT when no feature ancestor exists, even several hops up', () => {
    const ctx = {
      ...FIXTURE_CTX,
      knownNums: new Set(['100', '101']),
      kindByNum: new Map([['999', 'feature'], ['101', 'epic'], ['100', 'story']]),
      parentByNum: new Map([['999', '101'], ['101', '100']]),
    };
    // Still errors on ROOT (a feature with any parent is malformed) but never on FLAT.
    const res = validateBacklogItem({ ...baseItem, kind: 'feature', parent: '101' }, ctx);
    const msgs = res.errors.map((e) => e.message);
    expect(msgs).toContainEqual(expect.stringContaining('is `kind: feature` but carries a `parent`'));
    expect(msgs).not.toContainEqual(expect.stringContaining('kind: feature` ancestor'));
  });

  it('is cycle-safe (a corrupt parent chain never infinite-loops)', () => {
    const ctx = {
      ...FIXTURE_CTX,
      knownNums: new Set(['100']),
      kindByNum: new Map([['999', 'feature'], ['100', 'epic']]),
      parentByNum: new Map([['999', '100'], ['100', '999']]), // 999 ↔ 100 cycle
    };
    expect(() => validateBacklogItem({ ...baseItem, kind: 'feature', parent: '100' }, ctx)).not.toThrow();
  });
});

// ── False-positive safety over the REAL data (the #247 dry-run, now a standing test) ──
describe('validateBacklogItem — real backlog stays clean', () => {
  // Load the live registries exactly as check-standards.mjs does, build the same resolution table,
  // and assert the pure rule emits zero errors over every real item. This is the regression guard:
  // a future rule tightening that starts erroring on a legitimate free-form graduatedTo / crossRef /
  // size in the real backlog fails here instead of only surfacing on a manual live run.
  const blocks = loadBlocks(); // per-block specs src/_data/blocks/<id>.json, assembled (#882)
  const intents = loadIntents(); // per-intent specs src/_data/intents/<id>.json, assembled (#1145)
  const protocols = loadProtocols(); // per-protocol specs src/_data/protocols/<id>.json, assembled (#1146)
  const projects = loadDataRegistry('projects'); // per-project specs src/_data/projects/<id>.json (#1157)
  const plugs = loadDataRegistry('plugs'); // per-plug specs src/_data/plugs/<id>.json (#1157)
  const adapters = loadAdapters(); // per-adapter specs src/_data/adapters/<id>.json + _groups.json, assembled (#1938)
  const demos = loadDemos(); // per-demo specs src/_data/demos/<id>.json, assembled (#1146)
  const capabilityIds = new Set(loadDataRegistry('capabilities').map((c) => c.id)); // per-cap specs (#1157)
  const loadBacklog = require(join(ROOT, 'src/_data/backlog.js'));
  const backlog = typeof loadBacklog === 'function' ? loadBacklog() : loadBacklog;

  const ctx = {
    projectById: new Map(projects.map((p) => [p.id, p])),
    graduatedKinds: buildGraduatedKinds({ blocks, intents, protocols, projects, plugs, capabilityIds, adapters, demos }),
    knownNums: new Set(backlog.map((b) => b.num).filter(Boolean)),
    reportExists: (rel) => existsSync(join(ROOT, rel)),
    kindByNum: new Map(backlog.map((b) => [b.num, b.kind])),
    parentByNum: new Map(backlog.filter((b) => b.parent !== undefined).map((b) => [b.num, String(b.parent)])),
  };

  it('emits zero errors for every real backlog item', () => {
    const offenders = [];
    for (const item of backlog) {
      const { errors } = validateBacklogItem(item, ctx);
      if (errors.length) offenders.push({ id: item.id, errors: errors.map((e) => e.message) });
    }
    expect(offenders).toEqual([]);
  });
});

// ── `scope:` must be repo-qualified (#883/#2613) ──────────────────────────────────
// The `scope:` shape/qualification rule lives INLINE in check-standards.mjs (it reads RAW frontmatter, before
// the loader normalizes), and that script isn't importable here (top-level `git ls-tree origin/main` +
// `process.exit`). So we mirror its three-branch decision as a pure `classifyScope` — the SAME repo-prefix key
// set as check-standards-rules.mjs `LOCUS_MARKER_RE` — kept in sync by (a) the requested unit cases below and
// (b) the standing corpus guard, which runs the identical predicate over the REAL backlog so a bare entry
// reaching disk fails here, not only on a live gate run.
describe('scope: must be repo-qualified', () => {
  const matter = require('gray-matter');
  const SCOPE_REPO_PREFIX_RE = /^(?:we|fui|plateau|webeverything|frontierui|plateau-app):/;

  /** Mirror of the inline check-standards.mjs branches → 'ok' | 'empty' | 'non-string' | 'bare'. */
  const classifyScope = (scope) => {
    if (!Array.isArray(scope)) return 'non-array';
    if (scope.length === 0) return 'empty';
    if (scope.some((p) => typeof p !== 'string')) return 'non-string';
    if (scope.some((p) => !SCOPE_REPO_PREFIX_RE.test(p))) return 'bare';
    return 'ok';
  };

  it('accepts a we:-qualified (and multi-repo) scope', () => {
    expect(classifyScope(['we:src/backlog-view/', 'we:docs/agent/'])).toBe('ok');
    expect(classifyScope(['we:src/x/', 'fui:plugs/foo/', 'plateau:app/y/'])).toBe('ok');
  });

  it('errors on a bare (non-repo-qualified) entry', () => {
    expect(classifyScope(['src/x/'])).toBe('bare');
    expect(classifyScope(['we:src/x/', 'docs/agent/'])).toBe('bare'); // one bad entry taints the array
  });

  it('still errors on an empty scope', () => {
    expect(classifyScope([])).toBe('empty');
  });

  it('every real backlog item with a scope is repo-qualified', () => {
    const dir = join(ROOT, 'backlog');
    const offenders = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      let data;
      try { data = matter(readFileSync(join(dir, file), 'utf8')).data; } catch { continue; }
      if (data?.scope === undefined) continue;
      if (classifyScope(data.scope) !== 'ok') offenders.push({ id: file.replace(/\.md$/, ''), scope: data.scope });
    }
    expect(offenders).toEqual([]);
  });
});

// ── scope defaults to FILE-LEVEL — a bare directory scope is FLAGGED unless justified (#2739) ──
// Exercises the SHIPPED `dirLevelScopeFinding` (check-standards-rules.mjs, #2751) — the same pure predicate
// check-standards.mjs's §6d-sexies WARN calls — against synthetic fixtures plus a standing real-corpus sanity
// check. #2751 extracted this out of a hand-mirrored local copy (which could drift from the rule it claimed to
// pin, undetectably) so this test now imports and runs the exact code the gate runs.
describe('scope defaults to file-level — dir-level scope flagged unless justified', () => {
  const matter = require('gray-matter');

  it('flags a bare directory scope entry (prefix ending in "/")', () => {
    expect(dirLevelScopeFinding({ status: 'open', scope: ['we:scripts/readiness/'] }))
      .toEqual(['we:scripts/readiness/']);
    // Only the dir-level entries are returned; a file-level sibling in the same array is left alone.
    expect(dirLevelScopeFinding({ status: 'open', scope: ['we:scripts/check-standards.mjs', 'we:scripts/conveyor/'] }))
      .toEqual(['we:scripts/conveyor/']);
  });

  it('does NOT flag an all-file-level scope', () => {
    expect(dirLevelScopeFinding({ status: 'open', scope: ['we:scripts/check-standards.mjs', 'we:scripts/__tests__/check-standards.test.mjs'] }))
      .toEqual([]);
  });

  it('clears the flag when a non-empty scopeRationale justifies the directory span', () => {
    expect(dirLevelScopeFinding({ status: 'open', scope: ['we:scripts/readiness/'], scopeRationale: 'integration item — rewires every reader in the module' }))
      .toEqual([]);
    // A whitespace-only rationale is not a justification.
    expect(dirLevelScopeFinding({ status: 'open', scope: ['we:scripts/readiness/'], scopeRationale: '   ' }))
      .toEqual(['we:scripts/readiness/']);
  });

  it('skips resolved items (their scope is historical — no author will re-scope them)', () => {
    expect(dirLevelScopeFinding({ status: 'resolved', scope: ['we:scripts/readiness/'] })).toEqual([]);
  });

  it('does not double-signal a bare (non-repo-qualified) dir entry — that is the separate hard error', () => {
    expect(dirLevelScopeFinding({ status: 'open', scope: ['scripts/readiness/'] })).toEqual([]);
  });

  it('never flags an item whose scope is already file-level or justified across the REAL backlog', () => {
    // Real-corpus sanity/fuzz check (#2751): NOT a drift guard — the shipped `dirLevelScopeFinding`'s own filter
    // chain already guarantees these three properties the moment it returns a non-empty array, so no future
    // behavior change to the function itself could fail this loop (that job belongs to the wiring test below,
    // which pins registration, and to the unit cases above, which pin behavior). What THIS loop actually checks
    // is that the shipped predicate stays well-typed over real, messy backlog frontmatter — i.e. every flagged
    // item really does carry a `/`-terminated entry, no rationale, and isn't resolved — NOT an assertion of zero
    // findings (the finer-lease debt is exactly what the warning surfaces, so real dir-scoped items legitimately
    // match).
    const dir = join(ROOT, 'backlog');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      let data;
      try { data = matter(readFileSync(join(dir, file), 'utf8')).data; } catch { continue; }
      if (data?.scope === undefined) continue;
      const finding = dirLevelScopeFinding(data);
      if (finding.length) {
        expect(data.status, `${file} flagged but resolved`).not.toBe('resolved');
        const rationale = typeof data.scopeRationale === 'string' ? data.scopeRationale.trim() : '';
        expect(rationale, `${file} flagged but carries a scopeRationale`).toBe('');
        for (const entry of finding) expect(entry.endsWith('/'), `${file}: ${entry}`).toBe(true);
      }
    }
  });

  // ── #2751 wiring: §6d-sexies must call the SHIPPED function, not re-derive it inline ─────────────
  // Same technique as check-standards-rules.test.mjs:2376 ("rule 19 is WIRED"): a mutated/reverted call site
  // could otherwise leave every test above green because they exercise the imported function directly, never
  // check-standards.mjs's own use of it. This reads the gate's OWN source and asserts §6d-sexies still imports
  // and calls `dirLevelScopeFinding` — un-swallowed by a try/catch, since a rule that WARNS may not be silenced.
  it('§6d-sexies is WIRED: check-standards.mjs imports and calls the shipped dirLevelScopeFinding', () => {
    const gate = readFileSync(join(ROOT, 'scripts/check-standards.mjs'), 'utf8');
    expect(gate).toMatch(/dirLevelScopeFinding,?\s*\n?\s*\} from '\.\/check-standards-rules\.mjs';/);
    const from = gate.indexOf('// ── 6d-sexies.');
    expect(from).toBeGreaterThan(-1);
    const nextSection = gate.indexOf('\n// ── ', from + 1);
    const section = gate.slice(from, nextSection < 0 ? undefined : nextSection);
    expect(section).toMatch(/const dirs = dirLevelScopeFinding\(raw\);/);
    // Narrow, local window around the call site — the §6d-sexies section also legitimately wraps the earlier
    // gray-matter frontmatter parse in its OWN unrelated try/catch (malformed YAML is skipped, reported
    // elsewhere), so a whole-section try/catch scan would false-positive on that. What must never happen is
    // THIS call (plus its `warn`) getting silently swallowed, so check only the text immediately around it.
    const callIdx = section.indexOf('const dirs = dirLevelScopeFinding(raw);');
    expect(callIdx).toBeGreaterThan(-1);
    const localWindow = section.slice(Math.max(0, callIdx - 200), callIdx + 200);
    expect(localWindow).not.toMatch(/try\s*\{/);
  });
});

// ── #3337 — a scope entry whose path does not resolve but whose BASENAME does ────────────────────
// `scope:` is matched by EXACT path (`coversFile`), so an entry naming a path that does not exist covers
// NOTHING: the file the item really writes goes undeclared and the dispatcher can launch it beside an item
// that writes the very same file. Nothing caught that before this. Exercises the SHIPPED
// `scopeBasenameMismatches` (never a hand-mirrored copy — the #2751 lesson) against synthetic fixtures, then
// pins the four narrowing axes that keep it from adding noise to a ~1400-warning pile, then pins the wiring.
describe('#3337 scope entry basename matches a tracked file at a different path', () => {
  const matter = require('gray-matter');
  // A small synthetic tree standing in for `git ls-files` — includes the real #3321 shape (a `scripts/lib/*`
  // module whose test lives at the TOP-level `scripts/__tests__/`, not a sibling `scripts/lib/__tests__/`).
  const INDEX = buildTrackedPathIndex([
    'scripts/check-standards-rules.mjs',
    'scripts/__tests__/lane-verify.test.mjs',
    'scripts/lib/pr-merge-gate.mjs',
    'skills-src/review/SKILL.md',
    'skills-src/drain/SKILL.md',
    'skills-src/jury/SKILL.md',
    'src/a/index.ts', 'src/b/index.ts', 'src/c/index.ts', 'src/d/index.ts',
  ]);
  const open = (scope, extra) => ({ status: 'open', scope, ...extra });

  it('warns on the #3321 shape — wrong directory, right basename — and names the tracked path', () => {
    const found = scopeBasenameMismatches(open(['we:scripts/lib/__tests__/lane-verify.test.mjs']), INDEX);
    expect(found).toEqual([{
      entry: 'we:scripts/lib/__tests__/lane-verify.test.mjs',
      path: 'scripts/lib/__tests__/lane-verify.test.mjs',
      suggestions: ['scripts/__tests__/lane-verify.test.mjs'],
    }]);
    // The actionable half: the message must NAME the probable intended path, repo-qualified.
    expect(scopeBasenameMismatchMessage('9999-x', found[0]))
      .toContain('Did you mean "we:scripts/__tests__/lane-verify.test.mjs"?');
  });

  it('stays SILENT on an entry that resolves, and on a basename that matches nothing (a new file)', () => {
    expect(scopeBasenameMismatches(open(['we:scripts/lib/pr-merge-gate.mjs']), INDEX)).toEqual([]);
    // #3307's `we:scripts/lib/claim-sweep.mjs` shape: no basename match anywhere ⇒ a genuine new file, and
    // the greenfield case is exactly what must not redden.
    expect(scopeBasenameMismatches(open(['we:scripts/lib/claim-sweep.mjs']), INDEX)).toEqual([]);
  });

  it('axis 1 — only `we:` entries are checked; a sibling repo\'s tree is not visible to this gate', () => {
    // "Not found" in fui:/plateau: means "not checkable", never "wrong".
    expect(scopeBasenameMismatches(open(['fui:scripts/lib/__tests__/lane-verify.test.mjs']), INDEX)).toEqual([]);
    expect(scopeBasenameMismatches(open(['plateau-app:scripts/check-standards-rules.mjs']), INDEX)).toEqual([]);
    expect(scopeBasenameMismatches(open(['scripts/lib/__tests__/lane-verify.test.mjs']), INDEX)).toEqual([]);
  });

  it('axis 2 — a SUBTREE entry leases a tree, not an exact path, so it is never resolution-checked', () => {
    for (const entry of ['we:scripts/lib/__tests__/', 'we:scripts/lib/__tests__', 'we:scripts/lib/*.test.mjs'])
      expect(scopeBasenameMismatches(open([entry]), INDEX), entry).toEqual([]);
  });

  it('axis 3 — a generic basename is disambiguated by the longest shared TRAILING path segments', () => {
    // `SKILL.md` matches three tracked files; only one shares the `review/SKILL.md` tail, so the warning
    // offers ONE probable path instead of a useless list of every SKILL.md in the repo.
    expect(scopeBasenameMismatches(open(['we:.claude/skills/review/SKILL.md']), INDEX)[0].suggestions)
      .toEqual(['skills-src/review/SKILL.md']);
  });

  it('axis 4 — a top tier wider than the cap is SILENCE, not an unactionable "this looks wrong"', () => {
    // Four `index.ts`, none sharing the entry's parent directory ⇒ every candidate ties at the basename, the
    // tier exceeds the cap, and there is no path worth suggesting.
    expect(SCOPE_BASENAME_MAX_SUGGESTIONS).toBe(3);
    expect(scopeBasenameMismatches(open(['we:src/zzz/index.ts']), INDEX)).toEqual([]);
    // …but a tie AT the cap still warns, and offers every tied path.
    const capped = buildTrackedPathIndex(['src/a/index.ts', 'src/b/index.ts', 'src/c/index.ts']);
    const found = scopeBasenameMismatches(open(['we:src/zzz/index.ts']), capped);
    expect(found[0].suggestions).toEqual(['src/a/index.ts', 'src/b/index.ts', 'src/c/index.ts']);
    expect(scopeBasenameMismatchMessage('9999-x', found[0])).toContain('Did you mean one of ');
  });

  it('skips resolved items and clears on a non-empty scopeRationale (the greenfield escape)', () => {
    const entry = ['we:scripts/lib/__tests__/lane-verify.test.mjs'];
    expect(scopeBasenameMismatches({ status: 'resolved', scope: entry }, INDEX)).toEqual([]);
    expect(scopeBasenameMismatches(open(entry, { scopeRationale: 'this item CREATES the sibling test dir' }), INDEX))
      .toEqual([]);
    // Whitespace is not a justification.
    expect(scopeBasenameMismatches(open(entry, { scopeRationale: '  ' }), INDEX)).toHaveLength(1);
  });

  it('an unreadable tracked list means NOT CHECKABLE — never "nothing resolves"', () => {
    // check-standards.mjs falls back to an empty index when `git ls-files` throws; that must flag nothing
    // rather than warn on the entire corpus.
    expect(scopeBasenameMismatches(open(['we:scripts/lib/__tests__/lane-verify.test.mjs']), buildTrackedPathIndex([])))
      .toEqual([]);
    expect(scopeBasenameMismatches(open(['we:anything.mjs']), undefined)).toEqual([]);
    expect(scopeBasenameMismatches({ status: 'open', scope: 'not-an-array' }, INDEX)).toEqual([]);
  });

  it('every finding over the REAL backlog is well-formed and carries at least one suggestion', () => {
    // Real-corpus false-positive guard, in the shape of the #2751 loop above: not an assertion of zero
    // findings (the mis-scoped paths are exactly what the rule surfaces), but a standing check that the
    // shipped predicate stays well-typed over real, messy frontmatter — and, critically, that it never
    // emits a finding with NOTHING to suggest, which would be the unactionable warning it must not be.
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean);
    const index = buildTrackedPathIndex(tracked);
    const dir = join(ROOT, 'backlog');
    let total = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      let data;
      try { data = matter(readFileSync(join(dir, file), 'utf8')).data; } catch { continue; }
      if (data?.scope === undefined) continue;
      for (const f of scopeBasenameMismatches(data, index)) {
        total++;
        expect(data.status, `${file} flagged but resolved`).not.toBe('resolved');
        expect(f.entry.startsWith('we:'), `${file}: ${f.entry}`).toBe(true);
        expect(index.paths.has(f.path), `${file}: ${f.entry} actually resolves`).toBe(false);
        expect(f.suggestions.length, `${file}: ${f.entry} has no suggestion`).toBeGreaterThan(0);
        expect(f.suggestions.length).toBeLessThanOrEqual(SCOPE_BASENAME_MAX_SUGGESTIONS);
        for (const s of f.suggestions) expect(index.paths.has(s), `${file}: suggested ${s}`).toBe(true);
      }
    }
    // The rule must stay a needle, not a firehose: a corpus-wide count in the hundreds would drown the
    // gate's existing warnings rather than add to them. It was 4 when this landed.
    expect(total).toBeLessThan(30);
  });

  // ── #3337 wiring: §6d-septies must call the SHIPPED function, not re-derive it inline ──────────
  it('§6d-septies is WIRED: check-standards.mjs imports and calls the shipped rule, un-swallowed', () => {
    const gate = readFileSync(join(ROOT, 'scripts/check-standards.mjs'), 'utf8');
    expect(gate).toMatch(/buildTrackedPathIndex,\s*scopeBasenameMismatches,\s*scopeBasenameMismatchMessage,/);
    const from = gate.indexOf('// ── 6d-septies.');
    expect(from).toBeGreaterThan(-1);
    const call = 'for (const finding of scopeBasenameMismatches(raw, trackedIndex))';
    const callIdx = gate.indexOf(call, from);
    expect(callIdx).toBeGreaterThan(-1);
    expect(gate.slice(callIdx, callIdx + 200)).toMatch(/warn\(scopeBasenameMismatchMessage\(id, finding\)\)/);
    // The WARN itself must never be silenced by a try/catch. The `git ls-files` read above legitimately has
    // one (a non-git environment is a silent no-op, by design), so scan only the window around the call.
    expect(gate.slice(Math.max(0, callIdx - 200), callIdx + 200)).not.toMatch(/try\s*\{/);
  });
});
