/**
 * @file scripts/__tests__/check-standards-rules-conformance-gates.test.mjs
 * @description Split from check-standards-rules.test.mjs (#3383 test-speedup): the WE↔FUI drift/
 * conformance validators (block-impl, plug-drift, export-shape, composes-traits), the repo-locus-prefix
 * scan, template a11y lint, the shared backlog-item rendering lint, the classification-collapse and
 * native-first-conformance metrics, the standard-vs-site surface classifier, and the polyglot-widening
 * start gate. Pure file-move — same tests, smaller file.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  validateBlockImplConformance, BLOCK_IMPL_DRIFT_ENFORCED,
  validateBlockExportShape, EXPORT_SHAPE_ENFORCED,
  validatePlugWeFuiDrift, PLUG_DRIFT_ENFORCED,
  validateBlockComposesTraits, COMPOSE_TRAITS_ENFORCED,
  scanRepoLocusPrefixes,
  validateTemplateA11y, NAV_ACTIVE_STATE_ENFORCED,
  lintBacklogItemRendering,
  detectClassificationCollapse,
  computeNativeFirstConformance,
  classifySurfacePaths,
  validatePolyglotWideningGate, POLYGLOT_WIDENING_TAG, PILOT_EVIDENCE_NUMS,
} from '../check-standards-rules.mjs';
import { require, ROOT } from './fixtures/check-standards-rules-fixtures.mjs';

describe('validateBlockImplConformance — block contract↔impl drift (#659, the #606/#641 analogue)', () => {
  it('passes a block whose impl resolves in FUI', () => {
    const res = validateBlockImplConformance([
      { id: 'button', implementedBy: '@frontierui/blocks/button/', implPresent: true },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(1);
  });

  it('flags a missing FUI impl as drift (warn until enforced)', () => {
    const res = validateBlockImplConformance([
      { id: 'wizard', implementedBy: '@frontierui/blocks/wizard/WizardElement.ts', implPresent: false },
    ]);
    const bucket = BLOCK_IMPL_DRIFT_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/wizard.*does not resolve.*#170\/#659/);
    const other = BLOCK_IMPL_DRIFT_ENFORCED ? res.warnings : res.errors;
    expect(other.map((e) => e.message).join(' ')).not.toMatch(/does not resolve/);
  });

  it('skips the content arm when FUI is absent (implPresent null) — never a failure', () => {
    const res = validateBlockImplConformance([
      { id: 'button', implementedBy: '@frontierui/blocks/button/', implPresent: null },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.skipped).toBe(1);
    expect(res.checked).toBe(0);
  });

  it('ignores a block with no implementedBy (form gated elsewhere)', () => {
    const res = validateBlockImplConformance([{ id: 'composite-widget', implPresent: true }]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(0);
  });
});

describe('validatePlugWeFuiDrift — plug contract↔impl drift (#1309, the §8c/#659 plugs analogue)', () => {
  it('passes when every WE domain has a FUI impl and shared-core files match', () => {
    const res = validatePlugWeFuiDrift({
      domains: [{ domain: 'webguards', implPresent: true }, { domain: 'webstates', implPresent: true }],
      parityFiles: [{ file: 'plugs/core/Plug.ts', identical: true }],
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(3);
  });

  it('flags a WE domain with no FUI impl as drift', () => {
    const res = validatePlugWeFuiDrift({ domains: [{ domain: 'webportals', implPresent: false }] });
    const bucket = PLUG_DRIFT_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/webportals.*no matching fui:plugs.*#170\/#1309/);
  });

  it('flags a drifted shared-core contract file', () => {
    const res = validatePlugWeFuiDrift({ parityFiles: [{ file: 'plugs/core/Plug.ts', identical: false }] });
    const bucket = PLUG_DRIFT_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/Plug\.ts.*drifted.*byte-identical/);
  });

  it('skips both arms when FUI is absent (null) — never a failure', () => {
    const res = validatePlugWeFuiDrift({
      domains: [{ domain: 'webguards', implPresent: null }],
      parityFiles: [{ file: 'plugs/core/Plug.ts', identical: null }],
    });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.skipped).toBe(2);
    expect(res.checked).toBe(0);
  });
});

describe('validateBlockExportShape — CEM surface ↔ impl export drift (#927, the deeper #170 arm)', () => {
  it('passes a block whose declared exports are all present in the resolved barrel (extras OK)', () => {
    const res = validateBlockExportShape([
      { id: 'router', implementedBy: '@frontierui/blocks/router/index.ts', declaredExports: ['A', 'B'], actualExports: ['A', 'B', 'Extra'] },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(1);
  });

  it('flags a declared export missing from the barrel as drift (warn until enforced)', () => {
    const res = validateBlockExportShape([
      { id: 'tabs', implementedBy: '@frontierui/blocks/tabs/index.ts', declaredExports: ['TabsComponent', 'Present'], actualExports: ['Present'] },
    ]);
    const bucket = EXPORT_SHAPE_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/tabs.*TabsComponent.*#170\/#927/);
    const other = EXPORT_SHAPE_ENFORCED ? res.warnings : res.errors;
    expect(other).toEqual([]);
  });

  it('skips when the barrel could not be resolved (actualExports null) — FUI absent / no barrel', () => {
    const res = validateBlockExportShape([
      { id: 'view', implementedBy: '@frontierui/blocks/view/index.ts', declaredExports: ['X'], actualExports: null },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.skipped).toBe(1);
    expect(res.checked).toBe(0);
  });
});

describe('validateBlockComposesTraits — compose-don\'t-hand-roll deny-list (#937, Fork 1 of #933)', () => {
  const handRolledDisclosure = `
    head.setAttribute('aria-expanded', 'false');
    head.addEventListener('click', () => toggle(head));
  `;

  it('warns a curated target that hand-rolls behaviour it should compose (warn until enforced)', () => {
    const res = validateBlockComposesTraits([
      { id: 'sectioned-nav', source: handRolledDisclosure },
    ]);
    const bucket = COMPOSE_TRAITS_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/sectioned-nav.*nav:section.*#933\/#937/);
    expect(res.checked).toBe(1);
    const other = COMPOSE_TRAITS_ENFORCED ? res.warnings : res.errors;
    expect(other).toEqual([]);
  });

  it('clears the finding once the block composes the behaviour (the migration path)', () => {
    const res = validateBlockComposesTraits([
      { id: 'sectioned-nav', composesBehaviors: ['nav:section'], source: handRolledDisclosure },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(1);
  });

  it('accepts {name} object form in composesBehaviors', () => {
    const res = validateBlockComposesTraits([
      { id: 'sectioned-nav', composesBehaviors: [{ name: 'nav:section' }], source: handRolledDisclosure },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it('never sniffs a block outside the curated allow-list (zero false-positive by construction)', () => {
    const res = validateBlockComposesTraits([
      { id: 'some-other-block', source: handRolledDisclosure },
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(0);
  });

  it('does not fire on a partial signature match (AND across regexes)', () => {
    const res = validateBlockComposesTraits([
      { id: 'sectioned-nav', source: "head.setAttribute('aria-expanded', 'false');" }, // no listener
    ]);
    expect(res.warnings).toEqual([]);
    expect(res.checked).toBe(1);
  });

  it('skips when FUI source is absent (source null) — never a failure', () => {
    const res = validateBlockComposesTraits([{ id: 'sectioned-nav', source: null }]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(res.skipped).toBe(1);
    expect(res.checked).toBe(0);
  });
});

describe('scanRepoLocusPrefixes — #884 repo-locus prefix detection (#883 convention)', () => {
  const scan = (content) => scanRepoLocusPrefixes([{ file: 'backlog/x.md', content }]);

  it('flags a bare unmarked code-path reference', () => {
    const f = scan('Edit `src/_data/blocks.json` to add the field.');
    expect(f.length).toBe(1);
    expect(f[0].sample).toBe('src/_data/blocks.json');
  });

  it('accepts a marked reference (we:/fui:/plateau: or full name)', () => {
    expect(scan('See `we:src/_data/blocks.json`.')).toEqual([]);
    expect(scan('See `fui:blocks/temporal/traits/Clock.ts`.')).toEqual([]);
    expect(scan('See `plateau:src/main.ts`.')).toEqual([]);
    expect(scan('See `webeverything:scripts/gen-cem.mjs`.')).toEqual([]);
  });

  it('exempts a markdown-link target (the link text carries the locus)', () => {
    expect(scan('[we:src/_data/blocks.json](src/_data/blocks.json) is the file.')).toEqual([]);
  });

  it('exempts @scope/pkg npm specifiers and URLs', () => {
    expect(scan('Import from `@frontierui/blocks/index.ts`.')).toEqual([]);
    expect(scan('See https://example.com/path/file.ts for details.')).toEqual([]);
  });

  it('exempts fenced code blocks and WE-relative frontmatter fields', () => {
    expect(scan('```\nsrc/foo.ts\n```\n')).toEqual([]);
    expect(scan('graduatedTo: scripts/gen-cem.mjs')).toEqual([]);
    expect(scan('relatedReport: reports/2026-01-01-x.md')).toEqual([]);
  });

  it('counts multiple unmarked tokens per file', () => {
    const f = scan('`a/b.ts` and `c/d.mjs` and `e/f.json`');
    expect(f[0].count).toBe(3);
  });

  it('carves out JS-ecosystem product names, glob masks, and bare type fragments (#885)', () => {
    // Product names (single Capitalized word + .js) are prose, not repo files.
    expect(scan('Built on Node.js and shipped to Next.js / Three.js.')).toEqual([]);
    // Glob masks are file-type patterns, not concrete paths.
    expect(scan('Match every *.test.ts and *.d.ts under the tree.')).toEqual([]);
    // Bare type-suffix fragments (no name segment) are extensions, not paths.
    expect(scan('Emit `.d.ts` and `.spec.ts` files.')).toEqual([]);
    // But a real file whose name happens to start with a dot still needs a marker.
    expect(scan('Edit `.eleventy.js` config.').length).toBe(1);
    // And a real lowercase .js path is still flagged.
    expect(scan('Run `scripts/gen-cem.mjs` then `src/app.js`.')[0].count).toBe(2);
  });
});

describe('validateTemplateA11y — static template a11y lint (#772, #762 class)', () => {
  const FULL_PAGE = '<!DOCTYPE html><html lang="en"><head><title>X</title></head><body><nav><a href="/a/" aria-current="page">A</a></nav><main>y</main></body></html>';

  it('passes a full-page layout with lang, title, main, and aria-current-wired nav', () => {
    const res = validateTemplateA11y([{ path: 'src/_layouts/base.njk', content: FULL_PAGE }]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('ERRORs <html> without lang, without title, and without a <main> landmark', () => {
    const res = validateTemplateA11y([{ path: 'l.njk', content: '<html><head></head><body><p>x</p></body></html>' }]);
    const msgs = res.errors.map((e) => e.message).join(' ');
    expect(msgs).toMatch(/without a lang/);
    expect(msgs).toMatch(/no <title>/);
    expect(msgs).toMatch(/no <main> landmark/);
  });

  it('flags a hardcoded nav link list lacking aria-current as the #762 class (warn until enforced)', () => {
    const content = '<html lang="en"><head><title>X</title></head><body><nav><a href="/a/">A</a><a href="/b/">B</a></nav><main>y</main></body></html>';
    const res = validateTemplateA11y([{ path: 'src/_layouts/legacy.html', content }]);
    const bucket = NAV_ACTIVE_STATE_ENFORCED ? res.errors : res.warnings;
    expect(bucket.map((e) => e.message).join(' ')).toMatch(/aria-current.*#762/);
    const other = NAV_ACTIVE_STATE_ENFORCED ? res.warnings : res.errors;
    expect(other.map((e) => e.message).join(' ')).not.toMatch(/aria-current/);
  });

  it('does not apply landmark rules to a partial template (no <html>)', () => {
    const res = validateTemplateA11y([{ path: 'partial.njk', content: '<section><p>fragment</p></section>' }]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });
});

describe('lintBacklogItemRendering (#845 — the shared per-item rendering lint)', () => {
  const item = (over = {}) => ({ id: '999-x', kind: 'story', status: 'open', batchable: false, ...over });

  it('errors on a [[wiki-link]] and a dead .md backlog link; warns on raw HTML', () => {
    const body = 'See [[feedback_foo]].\n\nA raw <select> here.\n\nLink to [x](092-thing.md).';
    const { errors, warnings } = lintBacklogItemRendering({ item: item(), body });
    expect(errors.some((e) => /\[\[wiki-link\]\]/.test(e))).toBe(true);
    expect(errors.some((e) => /dead \.md path/.test(e))).toBe(true);
    expect(warnings.some((w) => /raw HTML/.test(w))).toBe(true);
  });

  it('warns on a fork-shaped heading only in a non-decision, non-resolved body', () => {
    const body = '## Open question — A vs B\n\nWeigh the options.';
    expect(lintBacklogItemRendering({ item: item(), body }).warnings.some((w) => /fork-shaped/.test(w))).toBe(true);
    expect(lintBacklogItemRendering({ item: item({ kind: 'decision' }), body }).warnings.some((w) => /fork-shaped/.test(w))).toBe(false);
    expect(lintBacklogItemRendering({ item: item({ status: 'resolved' }), body }).warnings.some((w) => /fork-shaped/.test(w))).toBe(false);
  });

  it('warns on a non-batchability marker only when the item computes batchable', () => {
    const body = 'This is not batchable; re-slice first.';
    expect(lintBacklogItemRendering({ item: item({ batchable: true }), body }).warnings.some((w) => /asserts non-batchability/.test(w))).toBe(true);
    expect(lintBacklogItemRendering({ item: item({ batchable: false }), body }).warnings.some((w) => /asserts non-batchability/.test(w))).toBe(false);
  });

  it('is clean for a well-formed body', () => {
    const body = 'A normal item body linking to [another](/backlog/092-thing/) the right way.';
    const { errors, warnings } = lintBacklogItemRendering({ item: item(), body });
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  describe('premature-epic-closure guard (#777)', () => {
    const epic = (over = {}) => item({ kind: 'epic', status: 'resolved', ...over });

    it('errors on an unchecked scope box in a RESOLVED epic', () => {
      const body = '# T\n\n- [ ] migration slice not done\n';
      expect(lintBacklogItemRendering({ item: epic(), body }).errors.some((e) => /RESOLVED epic with .* unchecked scope box/.test(e))).toBe(true);
    });

    it('warns on forward-looking uncarved-slice language in a RESOLVED epic', () => {
      const body = '# T\n\nThe chrome slice is not carved yet (gated on #765).\n';
      const { errors, warnings } = lintBacklogItemRendering({ item: epic(), body });
      expect(errors).toEqual([]);
      expect(warnings.some((w) => /uncarved-slice language/.test(w))).toBe(true);
    });

    it('does not fire on a checked-and-cited box, or on a non-resolved/non-epic item', () => {
      const checked = '# T\n\n- [x] slice shipped (#123)\n';
      expect(lintBacklogItemRendering({ item: epic(), body: checked }).errors).toEqual([]);
      const openEpic = '# T\n\n- [ ] not carved yet\n';
      expect(lintBacklogItemRendering({ item: epic({ status: 'open' }), body: openEpic }).errors).toEqual([]);
      expect(lintBacklogItemRendering({ item: item({ status: 'resolved' }), body: openEpic }).errors).toEqual([]);
    });

    it('ignores an unchecked box inside a fenced code block', () => {
      const body = '# T\n\n```\n- [ ] this is sample text, not scope\n```\n';
      expect(lintBacklogItemRendering({ item: epic(), body }).errors).toEqual([]);
    });
  });

  describe('dangling-residue guard (#1935)', () => {
    const decision = (over = {}) => item({ kind: 'decision', ...over });
    const residueBody = '# T\n\nOption C is the default. Open residue for the ratification turn: ship C or A-first.\n';

    it('warns on a prose-deferred choice in a RESOLVED decision', () => {
      const { warnings } = lintBacklogItemRendering({ item: decision({ status: 'resolved' }), body: residueBody });
      expect(warnings.some((w) => /defers a choice in prose/.test(w))).toBe(true);
    });

    it('warns on a prose-deferred choice in a prepared (still-open) decision', () => {
      const { warnings } = lintBacklogItemRendering({ item: decision({ preparedDate: '2026-06-28' }), body: residueBody });
      expect(warnings.some((w) => /defers a choice in prose/.test(w))).toBe(true);
    });

    it('does not fire on an OPEN, un-prepared decision (mid-research deferral is legitimate)', () => {
      const { warnings } = lintBacklogItemRendering({ item: decision(), body: residueBody });
      expect(warnings.some((w) => /defers a choice in prose/.test(w))).toBe(false);
    });

    it('does not fire on a non-decision, or when the body has no deferral language', () => {
      expect(lintBacklogItemRendering({ item: item({ status: 'resolved' }), body: residueBody }).warnings.some((w) => /defers a choice in prose/.test(w))).toBe(false);
      const clean = '# T\n\nFork 2 ratified: Option C (static ∪ dynamic).\n';
      expect(lintBacklogItemRendering({ item: decision({ status: 'resolved' }), body: clean }).warnings.some((w) => /defers a choice in prose/.test(w))).toBe(false);
    });

    it('ignores deferral phrasing inside a fenced code block', () => {
      const body = '# T\n\n```\nopen residue: TBD\n```\n';
      expect(lintBacklogItemRendering({ item: decision({ status: 'resolved' }), body }).warnings.some((w) => /defers a choice in prose/.test(w))).toBe(false);
    });
  });

  describe('stale-ratified/verified-done status guard (#3383)', () => {
    const verifiedDoneBody = '# T\n\n> **Verified done, 2026-09-22.** Already built and committed to the branch.\n';
    const ratifiedForkBody = '# T\n\n**(c) same core — ratified at operator review, 2026-09-21.**\n';

    it('warns when an OPEN item body carries the "Verified done, <date>" convention', () => {
      const { warnings } = lintBacklogItemRendering({ item: item({ status: 'open' }), body: verifiedDoneBody });
      expect(warnings.some((w) => /reads as already ratified or built/.test(w))).toBe(true);
    });

    it('warns when an ACTIVE decision body carries a dated, emphasized "ratified at operator review"', () => {
      const { warnings } = lintBacklogItemRendering({ item: item({ kind: 'decision', status: 'active' }), body: ratifiedForkBody });
      expect(warnings.some((w) => /reads as already ratified or built/.test(w))).toBe(true);
    });

    it('does not fire once the item is resolved (definitionally not stale)', () => {
      const { warnings } = lintBacklogItemRendering({ item: item({ status: 'resolved' }), body: verifiedDoneBody });
      expect(warnings.some((w) => /reads as already ratified or built/.test(w))).toBe(false);
    });

    it('does not fire on an epic — a ratified heading there documents design for its children, not epic completion', () => {
      const epicBody = '# T\n\n## Ratified shape (settled 2026-07-22)\n\nHow the children should be built.\n';
      const { warnings } = lintBacklogItemRendering({ item: item({ kind: 'epic', status: 'open' }), body: epicBody });
      expect(warnings.some((w) => /reads as already ratified or built/.test(w))).toBe(false);
    });

    it('does not fire on a body that only cites another item\'s ratification', () => {
      const body = '# T\n\nRuled in #3801 Fork 2 (a): the criteria stays ratified as shape.\n';
      const { warnings } = lintBacklogItemRendering({ item: item({ status: 'open' }), body });
      expect(warnings.some((w) => /reads as already ratified or built/.test(w))).toBe(false);
    });

    it('is clean for a well-formed open body with no completion assertion', () => {
      const { warnings } = lintBacklogItemRendering({ item: item({ status: 'open' }), body: 'A normal open item, still in progress.' });
      expect(warnings.some((w) => /reads as already ratified or built/.test(w))).toBe(false);
    });
  });
});

// ── #1247 classification-axis loud-fail ──────────────────────────────────────
describe('detectClassificationCollapse — loud-fail when the kind axis is unpopulated (#1247)', () => {
  const open = (over = {}) => ({ status: 'open', kind: 'story', size: 3, tier: 'A', batchable: true, sliceable: false, ...over });

  it('returns null on a healthy board (at least one classified pool is non-empty)', () => {
    const items = [open(), open({ kind: 'decision', tier: 'B', batchable: false }), { status: 'resolved' }];
    expect(detectClassificationCollapse(items)).toBeNull();
  });

  it('returns null for an all-resolved backlog (nothing open to classify)', () => {
    expect(detectClassificationCollapse([{ status: 'resolved' }, { status: 'resolved' }])).toBeNull();
  });

  it('flags the #487-class collapse: open items but kind undefined everywhere → all pools zero', () => {
    // consumers ahead of producer: kind undefined → not batchable / not Tier B / not sliceable, yet
    // deriveTier still hands an unblocked item Tier A (so tier alone would NOT catch it).
    const items = [
      { status: 'open', kind: undefined, tier: 'A', batchable: false, sliceable: false },
      { status: 'open', kind: undefined, tier: 'A', batchable: false, sliceable: false },
    ];
    const res = detectClassificationCollapse(items);
    expect(res).not.toBeNull();
    expect(res.openCount).toBe(2);
    expect(res.batchable + res.tierB + res.sliceable).toBe(0);
    expect(res.kindlessOpen).toBe(2);
  });

  it('flags a bucketing-logic break: kind present but every pool empty', () => {
    const items = [open({ batchable: false }), open({ kind: 'epic', batchable: false, sliceable: false })];
    const res = detectClassificationCollapse(items);
    expect(res).not.toBeNull();
    expect(res.kindlessOpen).toBe(0); // kinds are valid — the break is downstream of the field
  });

  it('does not count resolved items toward the open population', () => {
    const items = [{ status: 'resolved', kind: undefined }, open()];
    expect(detectClassificationCollapse(items)).toBeNull();
  });
});

// ── #1267 front-A native-first conformance metric ────────────────────────────
describe('computeNativeFirstConformance — front-A watch metric (#1267)', () => {
  it('counts unregistered native equivalents and lists them with their tracking item', () => {
    const watch = { entries: [
      { id: 'popover', registered: false, trackingItem: '1261' },
      { id: 'view-transitions', registered: true, trackingItem: '1264' },
      { id: 'anchor-positioning', registered: false, trackingItem: '1262' },
    ] };
    const m = computeNativeFirstConformance(watch);
    expect(m.total).toBe(3);
    expect(m.registered).toBe(1);
    expect(m.pending).toBe(2);
    expect(m.pendingList).toEqual(['popover (#1261)', 'anchor-positioning (#1262)']);
  });

  it('treats only registered===true as registered (missing/false/other all pend)', () => {
    const watch = { entries: [{ id: 'a' }, { id: 'b', registered: false }, { id: 'c', registered: true }] };
    expect(computeNativeFirstConformance(watch).pending).toBe(2);
  });

  it('degrades on a missing/empty ledger', () => {
    expect(computeNativeFirstConformance(undefined)).toEqual({ total: 0, registered: 0, pending: 0, pendingList: [] });
    expect(computeNativeFirstConformance({ entries: [] }).pending).toBe(0);
  });
});

// ── Standard-vs-site surface classifier (#2052, interim per #2006 Fork 2(b)) ──────
describe('classifySurfacePaths (#2052 fail-closed standard-vs-site boundary)', () => {
  // Exercise the production read and catch boundary without running unrelated standards sections.
  const source = readFileSync(join(ROOT, 'scripts/check-standards.mjs'), 'utf8');
  const section = source.indexOf('// ── 12. Standard-vs-site surface classifier');
  const start = source.indexOf('try {', section);
  const end = source.indexOf('\nmark("12.', start);
  if (section < 0 || start < 0 || end < 0) throw new Error('surface classifier section missing');
  const runSurfaceCheck = (readTracked = execFileSync) => {
    const errors = [];
    runInNewContext(source.slice(start, end), {
      ROOT, execFileSync: readTracked, classifySurfacePaths,
      err: (message) => errors.push(message),
    });
    return errors;
  };

  it('classifies site render files as site', () => {
    const { site, standard, unclassified } = classifySurfacePaths([
      'src/index.njk', 'src/_layouts/base.njk', 'src/_includes/block-descriptions/foo.njk',
      'src/assets/js/x.js', 'src/css/main.css', 'src/patterns/p.njk', 'src/plateau/q.njk',
    ]);
    expect(site).toHaveLength(7);
    expect(standard).toHaveLength(0);
    expect(unclassified).toHaveLength(0);
  });

  it('classifies standard definition data as standard', () => {
    const { site, standard, unclassified } = classifySurfacePaths([
      'src/_data/blocks/simple-store.json', 'src/_data/intents/x.json',
      'src/_data/capabilityMatrix.json', 'src/_data/__tests__/loader.test.mjs',
    ]);
    expect(standard).toHaveLength(4);
    expect(site).toHaveLength(0);
    expect(unclassified).toHaveLength(0);
  });

  it('classifies src/_data loaders as SITE even though they sit beside the .json defs (the messy seam)', () => {
    const { site, standard } = classifySurfacePaths([
      'src/_data/backlog.js', 'src/_data/intents.data.ts', 'src/_data/blocks.js',
    ]);
    expect(site).toEqual(['src/_data/backlog.js', 'src/_data/intents.data.ts', 'src/_data/blocks.js']);
    expect(standard).toHaveLength(0);
  });

  it('leaves out-of-zone paths NEUTRAL (not standard, not site, not an error)', () => {
    const { site, standard, unclassified } = classifySurfacePaths([
      'node_modules/x/index.js', 'backlog/1.md', 'scripts/check-standards.mjs',
      'capability-manifest/check.ts', 'tools/x.ts',
    ]);
    expect(site).toHaveLength(0);
    expect(standard).toHaveLength(0);
    expect(unclassified).toHaveLength(0); // neutral — correctly not policed
  });

  it('FAIL-CLOSED: an in-zone path matching neither set is unclassified (a new site file masquerading)', () => {
    const { unclassified } = classifySurfacePaths([
      'src/foo.tsx', 'src/_data/newLoader.rb', 'src/widgets/thing.svelte',
    ]);
    expect(unclassified).toEqual(['src/foo.tsx', 'src/_data/newLoader.rb', 'src/widgets/thing.svelte']);
  });

  it('real tree stays clean — every tracked src/** path classifies (0 unclassified)', () => {
    expect(runSurfaceCheck()).toEqual([]);
  });

  it.each([
    ['src/index.njk', []],
    ['src/unknown.tsx', [expect.stringContaining('Unclassified surface path "src/unknown.tsx"')]],
  ])('reads beyond 1 MiB and classifies the final path %s', (lastPath, expected) => {
    const errors = runSurfaceCheck((command, args, options) => {
      expect(command).toBe('git');
      expect(args).toEqual(['ls-files']);
      // Real child output crosses Node's default maxBuffer before the in-zone sentinel.
      return execFileSync(process.execPath, ['-e',
        `process.stdout.write('backlog/fixture-card.md\\n'.repeat(60000) + ${JSON.stringify(lastPath + '\n')})`,
      ], options);
    });
    expect(errors).toEqual(expected);
  });

  it('fails closed when the tracked-path command fails', () => {
    expect(runSurfaceCheck((_command, _args, options) =>
      execFileSync(process.execPath, ['-e', 'process.exit(2)'], options),
    )).toEqual([expect.stringContaining('Standard-vs-site surface classifier failed:')]);
  });
});

// ── Polyglot-widening start-gate (#2089 Fork 2(a) / #forward-target-start-gate, enforcement #2131) ──
describe('validatePolyglotWideningGate — the new-target evidence edge', () => {
  const bootstrap = [...PILOT_EVIDENCE_NUMS][0];

  it('IGNORES an item without the polyglot-widening tag (the declared predicate; no false positives)', () => {
    // A broad `polyglot`-tagged item that is NOT a widening (decision/maintenance) stays untouched.
    const { errors } = validatePolyglotWideningGate({ id: '463', tags: ['polyglot', 'decision'], status: 'open' });
    expect(errors).toEqual([]);
  });

  it('ERRORS on a polyglot-widening item with no evidence edge and no carve-out', () => {
    const { errors } = validatePolyglotWideningGate({ id: '999', tags: [POLYGLOT_WIDENING_TAG], status: 'open' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/forward-target-start-gate/);
    expect(errors[0]).toMatch(new RegExp(`#${bootstrap}`));
  });

  it('CLEARS when it blockedBy the bootstrap pilot-evidence item', () => {
    const { errors } = validatePolyglotWideningGate({ id: '999', tags: [POLYGLOT_WIDENING_TAG], status: 'open', blockedBy: [bootstrap] });
    expect(errors).toEqual([]);
  });

  it('CLEARS via a numeric (non-string) blockedBy edge to the pilot-evidence item', () => {
    const { errors } = validatePolyglotWideningGate({ id: '999', tags: [POLYGLOT_WIDENING_TAG], status: 'open', blockedBy: [Number(bootstrap)] });
    expect(errors).toEqual([]);
  });

  it('CLEARS via a `maintenance` carve-out tag (consumes existing forms, no new target)', () => {
    const { errors } = validatePolyglotWideningGate({ id: '999', tags: [POLYGLOT_WIDENING_TAG, 'maintenance'], status: 'open' });
    expect(errors).toEqual([]);
  });

  it('CLEARS via a `workbench-consume` carve-out tag (serves already-generated wrappers)', () => {
    const { errors } = validatePolyglotWideningGate({ id: '999', tags: [POLYGLOT_WIDENING_TAG, 'workbench-consume'], status: 'open' });
    expect(errors).toEqual([]);
  });

  it('EXEMPTS an item under its own ratified maturityTrigger (the #1735 / #forward-emit-dedicated-ir case)', () => {
    const { errors } = validatePolyglotWideningGate({
      id: '1735', tags: [POLYGLOT_WIDENING_TAG, 'polyglot'], status: 'parked',
      maturityTrigger: 'adoptionSignal:idiomatic-vue-svelte-angular-emitters-shipped',
    });
    expect(errors).toEqual([]);
  });

  it('is PROSPECTIVE — a resolved widening item is skipped (never retracts a shipped increment)', () => {
    const { errors } = validatePolyglotWideningGate({ id: '548', tags: [POLYGLOT_WIDENING_TAG], status: 'resolved' });
    expect(errors).toEqual([]);
  });

  it('an unrelated blockedBy edge does NOT clear the gate (must cite the pilot-evidence item)', () => {
    const { errors } = validatePolyglotWideningGate({ id: '999', tags: [POLYGLOT_WIDENING_TAG], status: 'open', blockedBy: ['1137'] });
    expect(errors).toHaveLength(1);
  });

  it('real backlog stays clean — every live polyglot-widening item carries the edge or a carve-out', () => {
    const loadBacklog = require(join(ROOT, 'src/_data/backlog.js'));
    const backlog = typeof loadBacklog === 'function' ? loadBacklog() : loadBacklog;
    const violations = (Array.isArray(backlog) ? backlog : [])
      .flatMap((item) => validatePolyglotWideningGate(item).errors);
    expect(violations).toEqual([]);
  });
});
