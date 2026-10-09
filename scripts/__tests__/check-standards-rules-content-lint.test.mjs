/**
 * @file scripts/__tests__/check-standards-rules-content-lint.test.mjs
 * @description Split from check-standards-rules.test.mjs (#3383 test-speedup): module-resolution
 * exports-lock, codegen-placement invariants, the markdown/backlog-body lint detectors (raw HTML, bad
 * links, duplicate manifest keys, buried fork sections, non-batchable markers), research-freshness
 * derivation, the capability-presence join table, retirement-shape, and dual-mode plug conformance.
 * Pure file-move — same tests, smaller file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isExportsSafeTarget, validateModuleResolutionLock,
  flattenExportsTargets, validateRenderersNotPublished, validateReferenceRuntimeForms, REFERENCE_RUNTIME_FORMS,
  findRawHtmlInMarkdown, findBadBodyLinks,
  findHarnessScaffoldingMarkers, scanHarnessScaffolding,
  findStaleRatifiedClaims,
  findDuplicateKeysPerScope, validateNoDuplicateManifestKeys,
  findBuriedForkSections, findNonBatchableMarkers, findTestPlanGaps, findMustWithoutDoneWhen, findDanglingBacklogRefs, findGuardRelaxationGaps, lintBacklogItemRendering, findNewHealthSmellWithoutSiblingCheck,
  deriveResearchFreshness, addIsoDuration, RESEARCH_REVIEW_HORIZON_DEFAULT,
  validateCapabilityPresence, validateRetirementShape,
  validatePlugDualMode, PLUG_UNPLUGGED_TEST_ENFORCED,
  findRelativeNodeScriptsAfterLaneCd, WE_ONLY_LANE_CONVEYOR_BRIEFS,
} from '../check-standards-rules.mjs';
import { require, ROOT, SRC } from './fixtures/check-standards-rules-fixtures.mjs';
import { renderItem } from '../backlog/scaffold.mjs';

describe('module-resolution exports-lock (#274/#271)', () => {
  it('isExportsSafeTarget: URL / node_modules / bare specifier are safe', () => {
    expect(isExportsSafeTarget('https://esm.sh/@frontierui/jsx-runtime@1')).toBe(true);
    expect(isExportsSafeTarget('/node_modules/@frontierui/jsx-runtime/dist/index.js')).toBe(true);
    expect(isExportsSafeTarget('@frontierui/jsx-runtime')).toBe(true);
    expect(isExportsSafeTarget('@frontierui/jsx-runtime/jsx-dev-runtime')).toBe(true);
  });

  it('isExportsSafeTarget: raw in-repo / foreign source paths are NOT safe', () => {
    expect(isExportsSafeTarget('/plugs/jsx-runtime')).toBe(false);
    expect(isExportsSafeTarget('./jsx-runtime')).toBe(false);
    expect(isExportsSafeTarget('../frontierui/blocks/renderers/jsx')).toBe(false);
    expect(isExportsSafeTarget('/abs/path/frontierui/src/jsx')).toBe(false);
    expect(isExportsSafeTarget('')).toBe(false);
  });

  it('flags a locked-scope entry pointing at WE/foreign source', () => {
    const { errors } = validateModuleResolutionLock([
      { specifier: '@frontierui/jsx-runtime', target: '/plugs/blocks/jsx', source: 'vite.config.mts' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('@frontierui/jsx-runtime');
  });

  it('passes a locked-scope entry that resolves to a URL or bare specifier', () => {
    const { errors } = validateModuleResolutionLock([
      { specifier: '@frontierui/jsx-runtime', target: 'https://esm.sh/@frontierui/jsx-runtime@1', source: 'x' },
      { specifier: '@frontierui/blocks', target: '@frontierui/blocks', source: 'y' },
    ]);
    expect(errors).toEqual([]);
  });

  it('ignores non-locked-scope specifiers (e.g. internal @webinjectors alias)', () => {
    const { errors } = validateModuleResolutionLock([
      { specifier: '@webinjectors', target: '/plugs/webinjectors', source: 'vite.config.mts' },
    ]);
    expect(errors).toEqual([]);
  });

  it('real data stays clean: the live vite aliases carry no locked-scope violation', () => {
    const viteCfg = readFileSync(join(ROOT, 'vite.config.mts'), 'utf8');
    const entries = [...viteCfg.matchAll(/(['"])(@[^'"]+)\1\s*:\s*(['"])([^'"]+)\3/g)].map((m) => ({
      specifier: m[2], target: m[4], source: 'vite.config.mts',
    }));
    const { errors } = validateModuleResolutionLock(entries);
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe('codegen-placement invariants (#964 — hardening #956)', () => {
  it('flattenExportsTargets: pulls leaf strings from a nested exports map', () => {
    expect(flattenExportsTargets('./dist/index.js')).toEqual(['./dist/index.js']);
    expect(flattenExportsTargets({ '.': { import: './a.js', require: './b.cjs' }, './x': './x.js' }))
      .toEqual(['./a.js', './b.cjs', './x.js']);
    expect(flattenExportsTargets(undefined)).toEqual([]);
  });

  it('flags an @webeverything/* package re-exporting blocks/renderers/*', () => {
    const { errors } = validateRenderersNotPublished([
      { name: '@webeverything/contracts', exports: { './serve': './blocks/renderers/module-service/moduleService.js' }, source: 'pkg/package.json' },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('blocks/renderers/');
  });

  it('passes when @webeverything/* exports only contract/vector paths', () => {
    const { errors } = validateRenderersNotPublished([
      { name: '@webeverything/contracts', exports: { '.': './dist/contracts.js', './vectors': './dist/vectors.js' }, source: 'pkg/package.json' },
    ]);
    expect(errors).toEqual([]);
  });

  it('ignores unscoped / @frontierui manifests (only the published @webeverything scope is governed)', () => {
    const { errors } = validateRenderersNotPublished([
      { name: 'web-everything', exports: undefined, source: 'package.json' },
      { name: '@frontierui/blocks', exports: { './renderers': './blocks/renderers/index.js' }, source: '../frontierui/package.json' },
    ]);
    expect(errors).toEqual([]);
  });

  it('flags a new WE-side serve() form beyond the ratified reference-runtime set', () => {
    const { errors } = validateReferenceRuntimeForms(['declarative', 'wc-class', 'html', 'jsx', 'functional', 'vue-sfc']);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('vue-sfc');
    expect(errors[0].message).toContain('genWrapper');
  });

  it('passes the ratified reference-runtime form set', () => {
    const { errors } = validateReferenceRuntimeForms([...REFERENCE_RUNTIME_FORMS]);
    expect(errors).toEqual([]);
  });

  it('real data stays clean: live package manifests carry no published-renderer leak', () => {
    const { errors } = validateRenderersNotPublished([
      { name: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name, exports: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).exports, source: 'package.json' },
    ]);
    expect(errors).toEqual([]);
  });

});

describe('findRawHtmlInMarkdown — raw HTML in backlog body (#290)', () => {
  const names = (body) => findRawHtmlInMarkdown(body).map((f) => f.name);

  it('flags an un-backticked interactive tag (the #020 content-swallow bug)', () => {
    const f = findRawHtmlInMarkdown('A digest with a literal <select> in it.');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ line: 1, name: 'select', tag: '<select>' });
  });

  it('ignores a tag inside an inline code span', () => {
    expect(names('Native: `<select>` and `<dialog>` are the anchors.')).toEqual([]);
  });

  it('ignores tags inside a fenced code block (``` and ~~~)', () => {
    expect(names('before\n```html\n<select><option>x</option></select>\n```\nafter')).toEqual([]);
    expect(names('~~~\n<table><tr><td>x</td></tr></table>\n~~~')).toEqual([]);
  });

  it('does NOT flag placeholder tokens that are not HTML elements (<NNN>, <date>, <slug>)', () => {
    expect(names('Rename to <NNN>-slug on <date>, e.g. <my-id> — these are not tags.')).toEqual([]);
  });

  it('does NOT flag a hyphenated custom element (inert, not a standard element)', () => {
    expect(names('A bare <auto-complete> mounts a window.')).toEqual([]);
  });

  it('reports each raw tag with its body line number', () => {
    const f = findRawHtmlInMarkdown('line one\n\n<div>raw</div> and <ul> here');
    expect(f.map((x) => [x.line, x.name])).toEqual([[3, 'div'], [3, 'div'], [3, 'ul']]);
  });

  it('matches close tags and tags carrying attributes', () => {
    expect(names('<input type="file"> then </form>')).toEqual(['input', 'form']);
  });

  it('returns [] for an empty or non-string body', () => {
    expect(findRawHtmlInMarkdown('')).toEqual([]);
    expect(findRawHtmlInMarkdown(undefined)).toEqual([]);
  });
});

describe('findBadBodyLinks — leaked authoring syntax in a backlog body', () => {
  const kinds = (body) => findBadBodyLinks(body).map((f) => f.kind);

  it('flags a [[wiki-link]] as a wikilink (memory-only syntax)', () => {
    const f = findBadBodyLinks('Per [[feedback_bias_separation_decoupling]] this splits.');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ line: 1, kind: 'wikilink' });
  });

  it('flags localhost, absolute /Users/, and file:// links as dead', () => {
    expect(kinds('see [x](http://localhost:3000/y)')).toEqual(['localhost']);
    expect(kinds('see [x](/Users/me/repo/src/a.ts)')).toEqual(['absfile']);
    expect(kinds('see [x](file:///tmp/a.html)')).toEqual(['absfile']);
  });

  it('flags a link to another backlog item .md file (should be /backlog/NNN-slug/)', () => {
    expect(kinds('see [#178](../backlog/178-access-control.md#L14)')).toEqual(['backlog-md']);
    expect(kinds('see [#016](backlog/016-gap-9.md)')).toEqual(['backlog-md']);
    // The common form: a BARE sibling NNN-slug.md with no backlog/ prefix — renders as a 404 from
    // /backlog/<id>/ just the same (was previously missed by the lint — the #707 broken-link regression).
    expect(kinds('see [#604](604-migrate-the-we-site.md)')).toEqual(['backlog-md']);
    expect(kinds('see [#700](700-converter.md#fork-1)')).toEqual(['backlog-md']);
    expect(kinds('see [#178](./178-access-control.md)')).toEqual(['backlog-md']);
  });

  it('does NOT flag the correct rendered URL or reports/docs .md refs', () => {
    expect(kinds('see [#178](/backlog/178-access-control/)')).toEqual([]);
    expect(kinds('report [r](../reports/2026-06-14-x.md) and [d](docs/agent/backlog-workflow.md)')).toEqual([]);
    expect(kinds('source [s](src/_data/intents.json#L899)')).toEqual([]);
  });

  it('ignores [[ ]] / [[...]] inside code (template-interpolation examples)', () => {
    expect(kinds('reactive `{{ }}`/`[[ ]]` interpolation stays manual')).toEqual([]);
    expect(kinds('before\n```\nrender([[1,2],[3,4]])\n```\nafter')).toEqual([]);
  });

  it('returns [] for an empty or non-string body', () => {
    expect(findBadBodyLinks('')).toEqual([]);
    expect(findBadBodyLinks(undefined)).toEqual([]);
  });
});

describe('findDuplicateKeysPerScope — the #2149 Fork 1 dup-key merge gate for keyed manifests', () => {
  it('flags two same-name keys in one object scope (the clean-but-wrong merge class)', () => {
    // Two lanes both add a "wrangler" dep at different offsets → git line-merges CLEAN into this:
    const raw = '{ "dependencies": { "wrangler": "^3.1.0", "vite": "^5.0.0", "wrangler": "^3.2.0" } }';
    expect(findDuplicateKeysPerScope(raw)).toEqual(['wrangler']);
  });
  it('does NOT flag the SAME key name in DIFFERENT object scopes', () => {
    // "name" appears once per object — legitimate, distinct scopes.
    const raw = '{ "name": "root", "nested": { "name": "child" }, "list": [ { "name": "a" }, { "name": "b" } ] }';
    expect(findDuplicateKeysPerScope(raw)).toEqual([]);
  });
  it('does NOT treat a repeated STRING VALUE as a duplicate key', () => {
    // "^5.0.0" is a value twice, not a key — must not flag.
    const raw = '{ "vite": "^5.0.0", "vitest": "^5.0.0" }';
    expect(findDuplicateKeysPerScope(raw)).toEqual([]);
  });
  it('is not fooled by braces/colons inside string values', () => {
    const raw = '{ "a": "has {a} and : colon", "a": "again" }';
    expect(findDuplicateKeysPerScope(raw)).toEqual(['a']);
  });
  it('returns [] for a clean manifest or a non-string input', () => {
    expect(findDuplicateKeysPerScope('{ "a": 1, "b": 2 }')).toEqual([]);
    expect(findDuplicateKeysPerScope(undefined)).toEqual([]);
  });
  it('validateNoDuplicateManifestKeys yields one labelled finding per dup, [] when clean', () => {
    const findings = validateNoDuplicateManifestKeys('{ "a": 1, "a": 2 }', 'package.json');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('package.json');
    expect(findings[0].message).toContain('"a"');
    expect(validateNoDuplicateManifestKeys('{ "a": 1 }', 'package.json')).toEqual([]);
  });
});

describe('findNewHealthSmellWithoutSiblingCheck — a new health smell needs a sibling-smell grep (#4419)', () => {
  const NEW = 'we:scripts/conveyor/health-smells/new-x.mjs';
  const missing = () => false;
  const flagged = (over = {}) => findNewHealthSmellWithoutSiblingCheck({ scope: [NEW], body: '## MVP\n\nBuild it.', fileExists: missing, ...over });

  it('sibling smell: flags a new smell file with no sibling note', () => {
    expect(flagged()).toEqual(['scripts/conveyor/health-smells/new-x.mjs']);
    expect(flagged({ scope: ['scripts/conveyor/health-smells/new-x.mjs'] })).toHaveLength(1); // bare spelling
  });
  it('sibling smell: quiet when the body has a "sibling smells" line', () => {
    expect(flagged()).toHaveLength(1); // control
    expect(flagged({ body: 'Sibling smells grepped: none overlap.' })).toEqual([]);
  });
  it('sibling smell: quiet when the file already exists (editing is not adding)', () => {
    expect(flagged()).toHaveLength(1); // control
    expect(flagged({ fileExists: () => true })).toEqual([]);
  });
  it('sibling smell: quiet for unrelated scope paths', () => {
    expect(flagged()).toHaveLength(1); // control
    expect(flagged({ scope: ['we:scripts/conveyor/health-watch.mjs', 'we:scripts/conveyor/health-smells/__tests__/new-x.test.mjs'] })).toEqual([]);
  });
  it('sibling smell: a note inside a code fence does not count', () => {
    expect(flagged({ body: 'Intro\n\n```\nsibling smells grepped\n```\n' })).toHaveLength(1);
    expect(flagged({ body: '~~~\nsibling smells\n~~~\n' })).toHaveLength(1);
  });
  it('sibling smell: fails closed — bad scope, bad body, or a throwing probe yields no hit', () => {
    expect(flagged()).toHaveLength(1); // control
    expect(flagged({ scope: 'we:scripts/conveyor/health-smells/new-x.mjs' })).toEqual([]);
    expect(flagged({ scope: undefined })).toEqual([]);
    expect(flagged({ body: undefined })).toEqual([]);
    expect(flagged({ fileExists: () => { throw new Error('EACCES'); } })).toEqual([]);
    expect(flagged({ scope: [NEW, 42, null] })).toHaveLength(1);
  });
  it('sibling smell: wired into lintBacklogItemRendering — warns for open/active story/task, not resolved', () => {
    const lint = (item, extra = {}) => lintBacklogItemRendering({
      item: { id: 'x', kind: 'task', status: 'open', scope: [NEW], ...item }, body: 'Do it.', fileExists: missing, ...extra,
    });
    expect(lint({}).warnings.join()).toMatch(/new health smell .*new-x\.mjs.*sibling smells/);
    expect(lint({ status: 'active', kind: 'story' }).warnings.join()).toMatch(/sibling smells/);
    expect(lint({ status: 'resolved' }).warnings.join()).not.toMatch(/sibling smells/);
    expect(lint({ kind: 'decision' }).warnings.join()).not.toMatch(/sibling smells/);
    expect(lint({}).errors).toEqual([]);
    // default probe is fail-quiet: no probe supplied → never warns
    expect(lintBacklogItemRendering({ item: { id: 'x', kind: 'task', status: 'open', scope: [NEW] }, body: 'Do it.' }).warnings.join()).not.toMatch(/sibling smells/);
  });
});

describe('findBuriedForkSections — a fork section in a non-decision body (#441 carve rule)', () => {
  const headings = (body) => findBuriedForkSections(body).map((f) => f.heading);

  it('flags a fork-shaped section heading', () => {
    const f = findBuriedForkSections('# Title\n\n## Open design points\n\n- A vs B, leaning A.');
    expect(f).toEqual([{ line: 3, heading: 'Open design points' }]);
  });

  it('matches the #192 / #315 / #087 heading variants', () => {
    expect(headings('## Open decisions\n- x')).toEqual(['Open decisions']);
    expect(headings('## Design tensions to settle\n- x')).toEqual(['Design tensions to settle']);
    expect(headings('### Open question — how to single-source\n- x')).toEqual(['Open question — how to single-source']);
  });

  it('SUPPRESSES a section already carved to a decision (#NNN + carve/block/resolve language)', () => {
    // The #192 / #134 / #315 post-carve shape must stay quiet.
    expect(headings('## Open design points\n\nForks live in their own decision items, carved to #441 (blockedBy).')).toEqual([]);
    expect(headings('## Open questions\n\nResolved by the child stories — see #346 / #349.')).toEqual([]);
  });

  it('does NOT suppress when a number is present without carve/resolve language', () => {
    // A bare cross-ref like "5k rows" or "#317 surfaced this" is not a settlement pointer.
    expect(headings('## Open questions\n\nSurfaced in #317 — should the coordinator be a block or a composition?')).toEqual(['Open questions']);
  });

  it('ignores non-fork headings and bounds each section at the next heading', () => {
    const body = '## Scope\n\n## Open decisions\n\n- live fork, no pointer\n\n## Notes\n\ncarved #99 resolved';
    // "Notes" (with the pointer) is a separate section, so it must not suppress "Open decisions".
    expect(headings(body)).toEqual(['Open decisions']);
  });

  it('returns [] for an empty or non-string body', () => {
    expect(findBuriedForkSections('')).toEqual([]);
    expect(findBuriedForkSections(undefined)).toEqual([]);
  });
});

describe('findNonBatchableMarkers — body asserts non-batchability (mis-flagged-batchable lint)', () => {
  const marks = (body) => [...new Set(findNonBatchableMarkers(body).map((h) => h.marker))];

  it('flags the recurring disqualifier phrases', () => {
    expect(marks('Size 8 — not batchable as one; re-slice under #658.')).toEqual(['not batchable', 're-slice']);
    expect(marks('The deliverable is external infrastructure a code-session agent cannot stand up.'))
      .toEqual(['external infra', 'agent cannot provision']);
    expect(marks('Re-flagged **blocked-in-fact**; this is a human-in-the-loop build.'))
      .toEqual(['blocked-in-fact', 'human-in-the-loop']);
  });

  it('matches a backticked slash-command marker (inline code is NOT stripped here)', () => {
    // The #774 shape: the disqualifier is written as a backticked command.
    expect(marks('**Needs a `/decision` (or `/prepare`) pass** to settle scope.')).toEqual(['needs prep/decision']);
  });

  it('reports the body line number', () => {
    const f = findNonBatchableMarkers('# Title\n\nfine line\nnot batchable here');
    expect(f).toEqual([{ line: 4, marker: 'not batchable' }]);
  });

  it('skips markers inside a fenced code block (a sample is not an assertion)', () => {
    const body = '```\n// not batchable — a code comment sample\n```\nreal prose, fine.';
    expect(marks(body)).toEqual([]);
  });

  it('does not fire on an unrelated, genuinely-batchable body', () => {
    expect(marks('Add a uniform live-example slot to every /blocks/ page. Wire the shortcode.')).toEqual([]);
  });

  it('returns [] for an empty or non-string body', () => {
    expect(findNonBatchableMarkers('')).toEqual([]);
    expect(findNonBatchableMarkers(undefined)).toEqual([]);
  });
});

describe('deriveResearchFreshness — staleness derivation (#441 Fork 4 / #477)', () => {
  const now = new Date('2026-06-13T00:00:00Z');

  it('is unreviewed when lastReviewed is missing or malformed', () => {
    expect(deriveResearchFreshness({}, { now }).state).toBe('unreviewed');
    expect(deriveResearchFreshness({ lastReviewed: '' }, { now }).state).toBe('unreviewed');
    expect(deriveResearchFreshness({ lastReviewed: 'June 2026' }, { now }).state).toBe('unreviewed');
  });

  it('is fresh within the horizon, stale once past it (P6M)', () => {
    // reviewed 2026-05 → due 2026-11 → fresh on 2026-06-13
    expect(deriveResearchFreshness({ lastReviewed: '2026-05-01', reviewHorizon: 'P6M' }, { now }))
      .toMatchObject({ state: 'fresh', dueDate: '2026-11-01' });
    // reviewed 2025-01 → due 2025-07 → stale on 2026-06-13
    expect(deriveResearchFreshness({ lastReviewed: '2025-01-01', reviewHorizon: 'P6M' }, { now }))
      .toMatchObject({ state: 'stale', dueDate: '2025-07-01' });
  });

  it('falls back to the global P6M horizon when the topic declares none', () => {
    const fr = deriveResearchFreshness({ lastReviewed: '2026-05-01' }, { now });
    expect(fr.horizon).toBe(RESEARCH_REVIEW_HORIZON_DEFAULT);
    expect(fr.state).toBe('fresh');
  });

  it('treats the horizon boundary as still-fresh (stale only strictly past due)', () => {
    // due exactly == now → not yet past → fresh
    expect(deriveResearchFreshness({ lastReviewed: '2025-12-13', reviewHorizon: 'P6M' }, { now }).state).toBe('fresh');
  });

  it('honours week/day/year durations', () => {
    expect(deriveResearchFreshness({ lastReviewed: '2026-06-01', reviewHorizon: 'P2W' }, { now }).state).toBe('fresh'); // 06-01 + 14d = 06-15 > now 06-13 → fresh
    expect(deriveResearchFreshness({ lastReviewed: '2026-06-10', reviewHorizon: 'P1D' }, { now }).state).toBe('stale'); // due 06-11 < now → stale
    expect(deriveResearchFreshness({ lastReviewed: '2026-01-01', reviewHorizon: 'P1Y' }, { now }).state).toBe('fresh'); // due 2027-01-01 > now → fresh
  });

  it('addIsoDuration returns null for empty / bare-P durations', () => {
    expect(addIsoDuration(new Date('2026-01-01T00:00:00Z'), 'P')).toBeNull();
    expect(addIsoDuration(new Date('2026-01-01T00:00:00Z'), '')).toBeNull();
    expect(addIsoDuration(new Date('2026-01-01T00:00:00Z'), 'P6M').toISOString().slice(0, 10)).toBe('2026-07-01');
  });
});

describe('validateCapabilityPresence — capability×source join table (#352)', () => {
  const ctx = {
    capabilityIds: new Set(['button', 'menu']),
    sourceIds: new Set(['material-3', 'carbon']),
    provenanceKinds: ['notable-inference', 'verified'],
  };
  const run = (rows) => validateCapabilityPresence({ rows }, ctx);

  it('stays clean for well-formed rows', () => {
    const res = run([
      { capabilityId: 'button', sourceId: 'material-3', present: true, provenance: 'verified', url: 'https://m3/button' },
      { capabilityId: 'menu', sourceId: 'carbon', present: true, provenance: 'notable-inference', url: null },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('errors on an unknown capability or source id', () => {
    const res = run([{ capabilityId: 'ghost', sourceId: 'nope', present: true, provenance: 'verified', url: 'x' }]);
    expect(res.errors.map((e) => e.message).join(' ')).toMatch(/unknown capability "ghost".*|unknown corpus source "nope"/);
    expect(res.errors.length).toBe(2);
  });

  it('errors on a non-boolean present and an unknown provenance', () => {
    const res = run([{ capabilityId: 'button', sourceId: 'carbon', present: 'yes', provenance: 'guess' }]);
    const msg = res.errors.map((e) => e.message).join(' ');
    expect(msg).toMatch(/"present" must be a boolean/);
    expect(msg).toMatch(/unknown provenance "guess"/);
  });

  it('errors on a duplicate (capability, source) row', () => {
    const res = run([
      { capabilityId: 'button', sourceId: 'carbon', present: true, provenance: 'verified', url: 'x' },
      { capabilityId: 'button', sourceId: 'carbon', present: true, provenance: 'verified', url: 'y' },
    ]);
    expect(res.errors.map((e) => e.message).join(' ')).toMatch(/duplicate row for \(button, carbon\)/);
  });

  it('warns (not errors) when a verified row lacks its deep doc url', () => {
    const res = run([{ capabilityId: 'button', sourceId: 'material-3', present: true, provenance: 'verified' }]);
    expect(res.errors).toEqual([]);
    expect(res.warnings.map((w) => w.message).join(' ')).toMatch(/verified row \(button, material-3\) has no deep doc url/);
  });

  it('the live seed file (notable-inference) stays clean', () => {
    const presence = require(join(SRC, '_data/benchmarkCapabilityPresence.json'));
    const caps = require(join(SRC, '_data/benchmarkCapabilities.json'));
    const corpus = require(join(SRC, '_data/benchmarkCorpus.json'));
    const res = validateCapabilityPresence(presence, {
      capabilityIds: new Set(caps.capabilities.map((c) => c.id)),
      sourceIds: new Set(corpus.sources.map((s) => s.id)),
      provenanceKinds: presence.provenanceKinds.map((k) => k.id),
    });
    expect(res.errors).toEqual([]);
  });
});

describe('validateRetirementShape — general reference-retirement convention (#584)', () => {
  const run = (entry, opts) => validateRetirementShape(entry, { label: 'ref', ...opts });

  it('passes vacuously when no retirement markers are present (most-permissive default)', () => {
    expect(run({ title: 'MDN', url: 'https://mdn' }).errors).toEqual([]);
  });

  it('accepts a complete death triplet', () => {
    const res = run({ retired: true, retiredDate: '2026-06-14', retiredReason: 'docs 404; folded into Fluent' });
    expect(res.errors).toEqual([]);
  });

  it('errors when retired:true lacks a reason or a date', () => {
    const msg = run({ retired: true }).errors.map((e) => e.message).join(' ');
    expect(msg).toMatch(/requires a retiredReason/);
    expect(msg).toMatch(/requires a retiredDate/);
  });

  it('errors on a non-ISO retiredDate', () => {
    expect(run({ retired: true, retiredReason: 'x', retiredDate: 'June 2026' }).errors
      .map((e) => e.message).join(' ')).toMatch(/retiredDate must be an ISO date/);
  });

  it('errors on death fields without retired:true (all-or-nothing triplet)', () => {
    expect(run({ retiredDate: '2026-06-14', retiredReason: 'x' }).errors
      .map((e) => e.message).join(' ')).toMatch(/without retired:true/);
  });

  it('errors on a non-boolean retired', () => {
    expect(run({ retired: 'yes' }).errors.map((e) => e.message).join(' ')).toMatch(/"retired" must be a boolean/);
  });

  it('treats death and supersession as orthogonal — both can co-exist (state 4)', () => {
    const res = run(
      { retired: true, retiredDate: '2026-06-14', retiredReason: 'docs dead', supersededBy: 'fluent-2' },
      { resolveSupersededBy: (t) => t === 'fluent-2' },
    );
    expect(res.errors).toEqual([]);
  });

  it('errors when supersededBy does not resolve (only where a resolver is supplied)', () => {
    expect(run({ supersededBy: 'ghost' }, { resolveSupersededBy: () => false }).errors
      .map((e) => e.message).join(' ')).toMatch(/supersededBy "ghost" does not resolve/);
    // No resolver → pointer is not resolution-checked (homes without an id space).
    expect(run({ supersededBy: 'https://newer' }).errors).toEqual([]);
  });

  it('the live corpus retired source (#546 FAST) stays clean', () => {
    const corpus = require(join(SRC, '_data/benchmarkCorpus.json'));
    const fast = corpus.sources.find((s) => s.id === 'fast');
    expect(validateRetirementShape(fast, { label: 'fast' }).errors).toEqual([]);
  });
});

describe('validatePlugDualMode — #606 dual-mode plug conformance (#636)', () => {
  it('passes a domain with both an unplugged-mode and plugged-mode test', () => {
    const res = validatePlugDualMode([
      { name: 'webbehaviors', hasSource: true, hasUnpluggedTest: true, hasPluggedTest: true },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('ERRORs a domain that ships no plugged-mode test (missing a mode)', () => {
    const res = validatePlugDualMode([
      { name: 'webfoo', hasSource: true, hasUnpluggedTest: true, hasPluggedTest: false },
    ]);
    expect(res.errors.map((e) => e.message).join(' ')).toMatch(/webfoo.*no plugged-mode test/);
  });

  it('flags a missing unplugged-mode test as the #649 backfill target (warn until enforced)', () => {
    const res = validatePlugDualMode([
      { name: 'webbar', hasSource: true, hasUnpluggedTest: false, hasPluggedTest: true },
    ]);
    const bucket = PLUG_UNPLUGGED_TEST_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/webbar.*no unplugged-mode.*#649/);
    // The opposite bucket carries nothing about the unplugged gap.
    const other = PLUG_UNPLUGGED_TEST_ENFORCED ? res.warnings : res.errors;
    expect(other.map((e) => e.message).join(' ')).not.toMatch(/unplugged-mode/);
  });

  it('skips a non-plug directory (no source files)', () => {
    const res = validatePlugDualMode([
      { name: 'webempty', hasSource: false, hasUnpluggedTest: false, hasPluggedTest: false },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });
});

describe('findHarnessScaffoldingMarkers — leaked harness-scaffolding in backlog/report content (#3448)', () => {
  it('flags a bare <system-reminder> block opening its own line', () => {
    const f = findHarnessScaffoldingMarkers('Some digest.\n\n<system-reminder>\nleaked context\n</system-reminder>\n');
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({ line: 3, label: '<system-reminder> tag' });
    expect(f[1]).toMatchObject({ line: 5, label: '<system-reminder> tag' });
  });

  it('does NOT flag the same marker fenced in a code block (documenting the pattern itself)', () => {
    const body = 'Discussion.\n\n```\n<system-reminder>\nexample\n</system-reminder>\n```\n\nmore prose.';
    expect(findHarnessScaffoldingMarkers(body)).toEqual([]);
  });

  it('does NOT flag a mid-sentence mention describing the incident (no false positive on prose)', () => {
    const body = 'PR #1803 committed a literal <system-reminder> block by accident; the marker `Claude-Session:` and SendUserFile-style tool-invocation instructions were also involved.';
    expect(findHarnessScaffoldingMarkers(body)).toEqual([]);
  });

  it('flags a <system> tag opening its own line, without colliding with <system-reminder>', () => {
    expect(findHarnessScaffoldingMarkers('<system>\ninjected\n</system>').map((h) => h.label))
      .toEqual(['<system> tag', '<system> tag']);
    expect(findHarnessScaffoldingMarkers('<system-reminder>\nx\n</system-reminder>').map((h) => h.label))
      .toEqual(['<system-reminder> tag', '<system-reminder> tag']);
  });

  it('flags a Claude-Session: header opening its own line', () => {
    const f = findHarnessScaffoldingMarkers('Claude-Session: https://claude.ai/code/session_abc123');
    expect(f).toEqual([{ line: 1, label: 'Claude-Session: header', match: 'Claude-Session:' }]);
  });

  it('flags a Claude-Session: header case-insensitively', () => {
    const f = findHarnessScaffoldingMarkers('claude-session: https://claude.ai/code/session_abc123');
    expect(f).toEqual([{ line: 1, label: 'Claude-Session: header', match: 'claude-session:' }]);
  });

  it('flags a leak quoted with a > blockquote prefix (a leak pasted into review discussion)', () => {
    const f = findHarnessScaffoldingMarkers('> <system-reminder>\n> leaked\n> </system-reminder>');
    expect(f.map((h) => h.label)).toEqual(['<system-reminder> tag', '<system-reminder> tag']);
  });

  it('flags a SendUserFile tool-invocation instruction phrase anywhere in the line', () => {
    const f = findHarnessScaffoldingMarkers('To share it, send it with SendUserFile right away.');
    expect(f).toEqual([{ line: 1, label: 'SendUserFile tool-invocation instruction', match: 'with SendUserFile' }]);
  });

  it('scanHarnessScaffolding aggregates per-file hits from a docs array', () => {
    const findings = scanHarnessScaffolding([
      { file: 'backlog/1-a.md', content: 'clean body, no markers here.' },
      { file: 'backlog/2-b.md', content: '<system-reminder>\nleak\n</system-reminder>' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('backlog/2-b.md');
    expect(findings[0].hits.length).toBeGreaterThan(0);
  });

  it('returns [] for an empty or non-string body', () => {
    expect(findHarnessScaffoldingMarkers('')).toEqual([]);
    expect(findHarnessScaffoldingMarkers(undefined)).toEqual([]);
  });
});

describe('findStaleRatifiedClaims — dated ratified/verified-done body assertion vs. open status (#3383)', () => {
  it('flags the "Verified done, <date>" blockquote convention', () => {
    const body = '# T\n\n> **Verified done, 2026-09-22.** Already built and committed straight to the branch.\n';
    const f = findStaleRatifiedClaims(body);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ line: 3, label: '"Verified done" blockquote' });
    expect(f[0].match).toMatch(/Verified done, 2026-09-22\./);
  });

  it('flags a "## Ratified" heading', () => {
    const f = findStaleRatifiedClaims('# T\n\nSome prose.\n\n## Ratified design (2026-09-07, operator)\n\nMore.');
    expect(f).toEqual([{ line: 5, label: '"## Ratified" heading', match: '## Ratified' }]);
  });

  it('flags a dated, emphasized "ratified at operator review" assertion (the #3801 shape)', () => {
    const body = '*Ratified at operator review, 2026-09-21: (c).* The rest of the fork text follows.';
    const f = findStaleRatifiedClaims(body);
    expect(f).toHaveLength(1);
    expect(f[0].label).toBe('dated "ratified" assertion');
  });

  it('does NOT flag a bare, unemphasized mention of "ratified" with no date (the common case)', () => {
    const body = 'Ruled in #3801 Fork 2 (a): the criteria stays ratified as shape, not as a value.';
    expect(findStaleRatifiedClaims(body)).toEqual([]);
  });

  it('does NOT flag an emphasized dated assertion that cites ANOTHER item\'s ratification (#1137/#2821/#3374 shape)', () => {
    // Real corpus false-positive shapes found calibrating this rule — each cites a DIFFERENT item's
    // ratification event, not this card's own, and must not fire.
    expect(findStaleRatifiedClaims('**Go-live gate (ratified #2089 Fork 1(b)) — CLEARED 2026-07-02:**')).toEqual([]);
    expect(findStaleRatifiedClaims('#2801 (records "RATIFIED by the operator on 2026-08-01")')).toEqual([]);
    expect(findStaleRatifiedClaims('> **Ratified 2026-07-22 (#2607).** In delivery-loop machinery…')).toEqual([]);
  });

  it('ignores a marker fenced in a code block (documenting the pattern itself)', () => {
    const body = '# T\n\n```\n> **Verified done, 2026-09-22.** example only\n```\n\nmore prose.';
    expect(findStaleRatifiedClaims(body)).toEqual([]);
  });

  it('returns [] for an empty or non-string body', () => {
    expect(findStaleRatifiedClaims('')).toEqual([]);
    expect(findStaleRatifiedClaims(undefined)).toEqual([]);
  });
});

// #3960 (multi-repo slice 4) — a conveyor fix/ci-heal brief that `cd`s into an acquired lane and then invokes a
// WE tool by a RELATIVE `node scripts/...` path breaks the moment that lane is not WE's own checkout.
describe('findRelativeNodeScriptsAfterLaneCd (#3960)', () => {
  const OLD_PATTERN = [
    '### 1. Reconstitute',
    '',
    '```bash',
    'LANE=$(node scripts/lane-pool.mjs acquire --lane={{LANE}}) && cd "$LANE"',
    '```',
    '',
    '### 2. Repair',
    '',
    '```bash',
    'node scripts/conveyor/rearm-review.mjs {{PR_NUM}}',
    '```',
  ].join('\n');

  it('fails a fixture with the old pattern — a relative call after `cd "$LANE"`', () => {
    const { errors } = findRelativeNodeScriptsAfterLaneCd([{ file: 'skills-src/conveyor/fix-agent-brief.md', content: OLD_PATTERN }]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/relative `node scripts\/\.\.\.` call after `cd "\$LANE"`/);
    expect(errors[0].descriptor).toMatchObject({ kind: 'conveyor-brief-relative-node-after-lane-cd', file: 'skills-src/conveyor/fix-agent-brief.md', line: 10 });
  });

  it('also fires for `cd "{{SOME_TOKEN}}"`, not only the literal `$LANE`', () => {
    const content = 'cd "{{LANE_DIR}}"\nnode scripts/conveyor/stand-down.mjs 1\n';
    expect(findRelativeNodeScriptsAfterLaneCd([{ file: 'skills-src/conveyor/fix-agent-ci-brief.md', content }]).errors).toHaveLength(1);
  });

  it('does not fire before the `cd` line, or for a call already qualified with an absolute root', () => {
    const before = 'node scripts/lane-pool.mjs acquire --lane=1\ncd "$LANE"\n';
    expect(findRelativeNodeScriptsAfterLaneCd([{ file: 'skills-src/conveyor/fix-agent-brief.md', content: before }]).errors).toEqual([]);
    const qualified = 'cd "$LANE"\nnode "{{WE_ROOT}}/scripts/conveyor/rearm-review.mjs" 1\n';
    expect(findRelativeNodeScriptsAfterLaneCd([{ file: 'skills-src/conveyor/fix-agent-brief.md', content: qualified }]).errors).toEqual([]);
  });

  it('passes on the REAL, rewritten fix and ci-heal briefs on disk', () => {
    const fixBrief = readFileSync(join(ROOT, 'skills-src/conveyor/fix-agent-brief.md'), 'utf8');
    const ciHealBrief = readFileSync(join(ROOT, 'skills-src/conveyor/fix-agent-ci-brief.md'), 'utf8');
    expect(findRelativeNodeScriptsAfterLaneCd([
      { file: 'skills-src/conveyor/fix-agent-brief.md', content: fixBrief },
      { file: 'skills-src/conveyor/fix-agent-ci-brief.md', content: ciHealBrief },
    ]).errors).toEqual([]);
  });

  it('exempts the WE-only-lane briefs (delivery-agent-brief.md et al.) even though they share the same `cd` shape', () => {
    for (const file of WE_ONLY_LANE_CONVEYOR_BRIEFS) {
      expect(findRelativeNodeScriptsAfterLaneCd([{ file, content: OLD_PATTERN }]).errors, file).toEqual([]);
    }
    // The real delivery-agent-brief.md IS this exact shape today (`cd "$LANE"` then many relative `node
    // scripts/...` calls) — proving the exemption is load-bearing, not merely untested.
    const deliveryBrief = readFileSync(join(ROOT, 'skills-src/conveyor/delivery-agent-brief.md'), 'utf8');
    expect(deliveryBrief).toMatch(/cd "\$LANE"/);
    expect(deliveryBrief).toMatch(/\bnode scripts\//);
    expect(findRelativeNodeScriptsAfterLaneCd([{ file: 'skills-src/conveyor/delivery-agent-brief.md', content: deliveryBrief }]).errors).toEqual([]);
  });

  it('ignores a file outside skills-src/conveyor entirely', () => {
    expect(findRelativeNodeScriptsAfterLaneCd([{ file: 'docs/agent/some-doc.md', content: OLD_PATTERN }]).errors).toEqual([]);
  });

  it('a `cd` once tripped stays tripped for the rest of the file, across separate fenced blocks/headers', () => {
    const content = 'cd "$LANE"\n\n### later step\n\n```bash\nnode scripts/conveyor/x.mjs\n```\n';
    expect(findRelativeNodeScriptsAfterLaneCd([{ file: 'skills-src/conveyor/fix-agent-brief.md', content }]).errors).toHaveLength(1);
  });
});

describe('findMustWithoutDoneWhen — #4438', () => {
  const card = (done) => `## Explicit MVP cut\n\n**Must (MVP):**\n1. a\n2. b\n3. c\n4. d\n\n**Out:** x\n\n## Done when\n\n${done}\n`;
  it('reports only the uncited Must', () => {
    expect(findMustWithoutDoneWhen(card('1. Must 1 and Must 3 hold. Must 4 too.')).map((g) => g.must)).toEqual([2]);
  });
  it('parses single, list and range forms; prose-only is not a citation', () => {
    expect(findMustWithoutDoneWhen(card('Musts 1, 3'))).toHaveLength(2);
    expect(findMustWithoutDoneWhen(card('Musts 1-4'))).toEqual([]);
    expect(findMustWithoutDoneWhen(card('everything in the MVP is delivered'))).toHaveLength(4);
  });
  it('no MVP section returns []', () => {
    expect(findMustWithoutDoneWhen('## Done when\n\nx\n')).toEqual([]);
  });
  it('lintBacklogItemRendering warns for an open card, not a resolved one', () => {
    const body = card('Must 1');
    expect(lintBacklogItemRendering({ item: { id: 'x', status: 'open' }, body }).warnings.join()).toMatch(/Must 2/);
    expect(lintBacklogItemRendering({ item: { id: 'x', status: 'resolved' }, body }).warnings.join()).not.toMatch(/Must 2/);
  });
});

describe('findDanglingBacklogRefs — #4438', () => {
  const known = new Set(['4377', 'xabc123']);
  it('flags an unknown id, passes known/provisional ids', () => {
    expect(findDanglingBacklogRefs('see we:backlog/9999-nope.md', known)).toEqual([{ id: '9999' }]);
    expect(findDanglingBacklogRefs('see we:backlog/4377-x.md and we:backlog/xabc123 and we:backlog/4377', known)).toEqual([]);
  });
  it('resolves a graduated card via its bornAs hash', async () => {
    const { buildBacklogResolvableIds } = await import('../lib/citation-check.mjs');
    const ids = buildBacklogResolvableIds([{ num: '4400', bornAs: 'xzzz999' }]);
    expect(findDanglingBacklogRefs('we:backlog/xzzz999-s.md', ids)).toEqual([]);
  });
  it('(pending-lane) exempts a ref', () => {
    expect(findDanglingBacklogRefs('we:backlog/9999-nope.md (pending-lane)', known)).toEqual([]);
  });
  it('integration: warns when knownBacklogIds given, skipped when omitted, silent for resolved', () => {
    const body = 'see we:backlog/9999-nope.md\n';
    expect(lintBacklogItemRendering({ item: { id: 'x', status: 'open' }, body, knownBacklogIds: known }).warnings.join()).toMatch(/9999/);
    expect(lintBacklogItemRendering({ item: { id: 'x', status: 'open' }, body }).warnings.join()).not.toMatch(/9999/);
    expect(lintBacklogItemRendering({ item: { id: 'x', status: 'resolved' }, body, knownBacklogIds: known }).warnings.join()).not.toMatch(/9999/);
  });
});

describe('findTestPlanGaps — #4332 Test-plan classification + condition coverage', () => {
  const plan = (cases, design = '') => `## Design\n${design}\n## Test plan\n\n${cases.map((c) => `- ${c}`).join('\n')}\n`;
  const fence = "```js\nif (pr.state === 'closed') skip();\n```";

  it('(a) a case bullet with no capability/preservation marker is reported', () => {
    expect(findTestPlanGaps(plan(['a test that does a thing'])).map((g) => g.kind)).toEqual(['unclassified-case']);
  });
  it('(b) a preservation bullet with no mutation mention is reported', () => {
    expect(findTestPlanGaps(plan(["keeps working. GREEN on today's code."])).map((g) => g.kind)).toEqual(['preservation-without-mutation']);
  });
  it("(c) a Design fence comparing state to 'closed' whose Test plan never says closed is reported", () => {
    expect(findTestPlanGaps(plan(['new thing. Red today: absent.'], fence))).toEqual([{ kind: 'untested-condition', detail: 'closed' }]);
  });
  it('(d) a fully-marked plan with every literal covered returns []', () => {
    expect(findTestPlanGaps(plan(['closed PR is skipped. Red today: absent.', 'guard. GREEN today; mutation: drop it → fails.'], fence))).toEqual([]);
  });
  it('(e) no Test plan section returns []', () => {
    expect(findTestPlanGaps(`## Design\n\n${fence}\n`)).toEqual([]);
  });
  it('(f) lintBacklogItemRendering warns for an open card and is silent for a resolved one', () => {
    const body = plan(['a test that does a thing']);
    const open = lintBacklogItemRendering({ item: { id: '9', kind: 'story', status: 'open' }, body });
    expect(open.errors).toEqual([]);
    expect(open.warnings.some((w) => /Test-plan gaps/.test(w))).toBe(true);
    const done = lintBacklogItemRendering({ item: { id: '9', kind: 'story', status: 'resolved' }, body });
    expect(done.warnings.some((w) => /Test-plan gaps/.test(w))).toBe(false);
  });
});

describe('findTestPlanGaps — #4431 negative-claim-without-case', () => {
  const card = (design, cases) => `## Design\n\n${design}\n\n## Test plan\n\n${cases.map((c) => `- ${c}`).join('\n')}\n`;
  const claim = 'A `changes` verdict must never flip the panel.';
  const unrelated = ['routes normally. Red today: absent.'];

  it('flags a claim whose identifiers the Test plan never names', () => {
    expect(findTestPlanGaps(card(claim, unrelated))).toEqual([{ kind: 'negative-claim-without-case', detail: 'A `changes` verdict must never flip the panel.' }]);
  });
  it('does not flag a claim with no backticked/quoted token', () => {
    expect(findTestPlanGaps(card('A verdict must never flip the panel.', unrelated))).toEqual([]);
  });
  it('detects a hard-wrapped claim', () => {
    expect(findTestPlanGaps(card('A `changes` verdict\nmust never flip\nthe panel.', unrelated)).map((g) => g.kind)).toEqual(['negative-claim-without-case']);
  });
  it('is cleared when the Test plan names the identifier (mutation: drop the bullet → gap)', () => {
    const covered = ['`changes` verdict keeps the panel. Red today: absent.'];
    expect(findTestPlanGaps(card(claim, covered))).toEqual([]);
    expect(findTestPlanGaps(card(claim, unrelated))).toHaveLength(1);
  });
  it('ignores claims inside a code fence', () => {
    expect(findTestPlanGaps(card('```js\n// `changes` must never flip\n```', unrelated))).toEqual([]);
  });
  it('returns [] with no Test plan', () => {
    expect(findTestPlanGaps(`## Design\n\n${claim}\n`)).toEqual([]);
  });
  it('lintBacklogItemRendering warns for open cards only', () => {
    const body = card(claim, unrelated);
    const open = lintBacklogItemRendering({ item: { id: '9', kind: 'story', status: 'open' }, body });
    expect(open.warnings.some((w) => /negative claim/.test(w))).toBe(true);
    const done = lintBacklogItemRendering({ item: { id: '9', kind: 'story', status: 'resolved' }, body });
    expect(done.warnings.some((w) => /negative claim/.test(w))).toBe(false);
  });
});

describe('findGuardRelaxationGaps — #4409 guard-relaxation Must lines', () => {
  const kinds = (b) => findGuardRelaxationGaps(b).map((g) => g.kind);
  const fence = '```\nRelax the refusal only when X\nfail-closed non-code\n```';
  it('#4409 relaxing card missing both phrases warns', () => {
    expect(kinds('Relax the refusal only when X.\n')).toEqual(['missing-fail-closed', 'missing-non-code']);
  });
  it('#4409 only fail-closed present → exactly one gap (non-code)', () => {
    expect(kinds('Relax the refusal only when X.\n\n## Must\n\n- Fail-closed on error.\n')).toEqual(['missing-non-code']);
  });
  it('#4409 a freshly scaffolded, relaxing card still warns', async () => {
    const { renderItem } = await import('../backlog/scaffold.mjs');
    const out = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', digest: 'Relax the refusal only when X.', today: '2026-07-27' });
    expect(kinds(out)).toEqual(['missing-fail-closed', 'missing-non-code']);
  });
  it('#4409 a freshly scaffolded, non-relaxing card has no gap (hint does not trigger)', async () => {
    const { renderItem } = await import('../backlog/scaffold.mjs');
    expect(kinds(renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', digest: 'Add a thing.', today: '2026-07-27' }))).toEqual([]);
  });
  it('#4409 non-relaxing card → no gap', () => {
    expect(kinds('Add a retry loop to the fetcher.\n')).toEqual([]);
  });
  it('#4409 relaxing card with both phrases → no gap', () => {
    expect(kinds('Relax the refusal only when X.\n\n- Must fail closed on error.\n- Enumerate non-code inputs.\n')).toEqual([]);
  });
  it('#4409 unrelated card with only-when and no refus → no gap', () => {
    expect(kinds('Run the job only when the cache is cold.\n')).toEqual([]);
  });
  it('#4409 a relaxing sentence inside a fenced block does not trigger', () => {
    expect(kinds(`Add a thing.\n\n${fence}\n`)).toEqual([]);
  });
  it('#4409 phrases inside a fenced block do not satisfy', () => {
    expect(kinds(`Relax the refusal only when X.\n\n${fence}\n`)).toEqual(['missing-fail-closed', 'missing-non-code']);
  });
  it('#4409 Design-section prose is not scanned', () => {
    expect(kinds('Add a thing.\n\n## Design\n\nRelax the refusal only when X.\n')).toEqual([]);
  });
  it('#4409 lintBacklogItemRendering warns for open, silent for resolved', () => {
    const body = 'Relax the refusal only when X.\n';
    expect(lintBacklogItemRendering({ item: { id: '9', kind: 'story', status: 'open' }, body }).warnings.some((w) => /relaxes a refusal/.test(w))).toBe(true);
    expect(lintBacklogItemRendering({ item: { id: '9', kind: 'story', status: 'resolved' }, body }).warnings.some((w) => /relaxes a refusal/.test(w))).toBe(false);
  });
});

// #5399 S7 — the Must-cite and TODO-placeholder guards read the acceptance section through the shared
// task-agreement reader, so a card titled `## Acceptance` gets exactly the verdict of its `## Done when` twin.
describe('Must-cite and TODO-placeholder guards: `## Acceptance` reads exactly as `## Done when` (#5399 S7)', () => {
  const MVP = '## Explicit MVP cut\n\n**Must (MVP):**\n1. a\n2. b\n3. c\n\n**Out:** x\n\n';
  const lint = (body) => lintBacklogItemRendering({ item: { id: '4999', kind: 'story', status: 'open' }, body });
  const pair = (items) => ['Done when', 'Acceptance'].map((h) => `${MVP}## ${h}\n\n${items}\n`);
  it.each([
    ['numbered cites', '1. Must 1 holds.\n2. Musts 2-3 hold.'],
    ['a partial cite', '- [A1] Must 2 holds.'],
    ['no cite at all', '- [A1] it works.'],
  ])('Must-cite: %s', (_, items) => {
    const [legacy, canonical] = pair(items);
    expect(findMustWithoutDoneWhen(canonical)).toEqual(findMustWithoutDoneWhen(legacy));
    expect(lint(canonical).warnings).toEqual(lint(legacy).warnings);
  });
  it('Must-cite: a cite OUTSIDE the acceptance section never counts, under either heading', () => {
    for (const h of ['Done when', 'Acceptance'])
      expect(findMustWithoutDoneWhen(`${MVP}## Progress\n\nMusts 1-3\n\n## ${h}\n\n- [A1] x\n`)).toHaveLength(3);
  });
  it.each([
    ['placeholder + claim', 'Mutation proof: it fails.', '- [A1] **Executable** — TODO: a command that fails first.', 1],
    ['placeholder, no claim', 'Plain.', '- [A1] **Executable** — TODO: a command that fails first.', 0],
    ['real command + claim', 'Mutation proof: it fails.', '- [A1] **Executable** — `npm test` passes.', 0],
  ])('TODO-placeholder: %s', (_, top, items, n) => {
    const errs = (h) => lint(`${top}\n\n## ${h}\n\n${items}\n`).errors.filter((e) => /unfinished executable acceptance/.test(e));
    expect(errs('Acceptance')).toHaveLength(n);
    expect(errs('Done when')).toHaveLength(n);
  });

  // A4 — the scaffold's skeleton is now `## Acceptance` + `## Non-goals`; both guards must still see it.
  it('a scaffolded body carries ## Acceptance [A1] and ## Non-goals [N1] TODO lines, and no ## Done when', () => {
    const out = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', today: '2026-10-08' });
    expect(out).toMatch(/^## Acceptance\n\n- \[A1\] \*\*Executable\*\* — TODO: a command/m);
    expect(out).toMatch(/^## Non-goals\n\n- \[N1\] TODO:/m);
    expect(out).not.toMatch(/^## Done when/m);
  });
  it('the TODO-placeholder guard sees the scaffolded acceptance section', () => {
    const out = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', today: '2026-10-08', digest: 'Mutation proof: remove it and the test fails.' });
    const body = out.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(lint(body).errors.filter((e) => /unfinished executable acceptance/.test(e))).toHaveLength(1);
  });
  it('the Must-cite check sees the scaffolded acceptance section', () => {
    const out = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', today: '2026-10-08', digest: `Digest.\n\n${MVP.trim()}` });
    const body = out.replace(/^---\n[\s\S]*?\n---\n/, '');
    expect(findMustWithoutDoneWhen(body).map((g) => g.must)).toEqual([1, 2, 3]);
    const cited = body.replace('TODO: a command that fails before this item lands and passes after.', 'Musts 1-3: `npm test` passes.');
    expect(findMustWithoutDoneWhen(cited)).toEqual([]);
  });
});

describe('unfinished executable acceptance beside a mutation-proof claim (#4738)', () => {
  const PLACEHOLDER = '1. **Executable** — TODO: a command that fails before this item lands and passes after.';
  const PROOF = 'Mutation proof: remove the boundary and the test fails.';
  const card = ({ top = PROOF, done = PLACEHOLDER, after = '' } = {}) =>
    `Add a boundary test.\n\n${top}\n\n## Done when\n\n${done}\n${after}`;
  const lint = (body, status = 'open') =>
    lintBacklogItemRendering({ item: { id: '4999', kind: 'story', status }, body });
  const hits = (body, status) => lint(body, status).errors.filter((e) => /unfinished executable acceptance/.test(e));
  const F = '```';
  const T = '~~~';

  it('rejects open mutation-proof cards with unfinished executable acceptance', () => {
    const { errors, warnings } = lint(card());
    const hit = errors.filter((e) => /unfinished executable acceptance/.test(e));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toContain('"4999"');
    expect(hit[0]).toMatch(/replace .*TODO: a command/i);
    expect(warnings.some((w) => /unfinished executable acceptance/.test(w))).toBe(false);
  });
  it('matches bold and hyphenated wording', () => {
    expect(hits(card({ top: '**Mutation proof:** remove the boundary.' }))).toHaveLength(1);
    expect(hits(card({ top: 'This carries a mutation-proof claim in prose.' }))).toHaveLength(1);
  });
  it('matches a subordinate heading and bold/list markup around the placeholder', () => {
    expect(hits(card({ done: `### Executable\n\n- **TODO: a command** that fails first.` }))).toHaveLength(1);
    expect(hits(card({ done: `* _TODO: a command_` }))).toHaveLength(1);
  });
  it('a real command alongside the placeholder does not suppress the error', () => {
    expect(hits(card({ done: `${PLACEHOLDER}\n2. **Executable** — \`npx vitest run x.test.mjs\` passes.` }))).toHaveLength(1);
  });
  it('the claim may sit after the Done when section', () => {
    expect(hits(card({ top: '', after: `\n## Proof plan\n\n${PROOF}\n` }))).toHaveLength(1);
  });
  it('emits one error per card even with several claims', () => {
    expect(hits(card({ top: `${PROOF}\n\nMutation proof again.` }))).toHaveLength(1);
  });

  it('non-open statuses get no new diagnostic', () => {
    for (const status of ['active', 'preparing', 'parked', 'resolved']) expect(hits(card(), status)).toHaveLength(0);
  });
  it('placeholder only, claim only, or a completed command is silent', () => {
    expect(hits(card({ top: '' }))).toHaveLength(0);
    expect(hits(card({ done: '1. **Executable** — `npm test` passes.' }))).toHaveLength(0);
    expect(hits('No proof words here.\n\n## Done when\n\n1. **Executable** — `npm test` passes.\n')).toHaveLength(0);
  });
  it('a placeholder outside Done when is ignored; the section ends at the next level-two heading', () => {
    expect(hits(`${PROOF}\n\n## Progress\n\n${PLACEHOLDER}\n\n## Done when\n\n1. \`npm test\` passes.\n`)).toHaveLength(0);
    expect(hits(card({ done: '1. `npm test` passes.', after: `\n## Follow-ups\n\n${PLACEHOLDER}\n` }))).toHaveLength(0);
  });
  it('fenced examples (backtick and tilde) are ignored for both the claim and the placeholder', () => {
    expect(hits(card({ top: `${F}\n${PROOF}\n${F}` }))).toHaveLength(0);
    expect(hits(card({ top: `${T}\n${PROOF}\n${T}` }))).toHaveLength(0);
    expect(hits(card({ done: `${F}\n${PLACEHOLDER}\n${F}\n1. \`npm test\` passes.` }))).toHaveLength(0);
    expect(hits(card({ done: `${T}md\n${PLACEHOLDER}\n${T}\n1. \`npm test\` passes.` }))).toHaveLength(0);
  });
  it('an inline-code-only mention of mutation proof, or a heading alone, is not a prose claim', () => {
    expect(hits(card({ top: 'Cases name `mutation proof` wording.' }))).toHaveLength(0);
    expect(hits(card({ top: '## Mutation proof' }))).toHaveLength(0);
    expect(hits(card({ top: '### Mutation-proof plan' }))).toHaveLength(0);
  });
  it('the real scaffold output is the placeholder source of truth: silent alone, rejected beside a proof claim', async () => {
    const { renderItem } = await import('../backlog/scaffold.mjs');
    const body = renderItem({ kind: 'story', size: 3, slug: 'x', title: 'X', digest: 'Add a thing.', today: '2026-07-27' });
    expect(hits(body)).toHaveLength(0);
    expect(hits(`${body}\n${PROOF}\n`)).toHaveLength(1);
  });
});
