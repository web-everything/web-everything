/**
 * @file scripts/__tests__/graduation-import-check.test.mjs
 * @description Unit tests for the PURE core of `we:scripts/graduation-import-check.mjs`. Synthetic fixtures
 *   only — no real repo/git reads (the IO shell is exercised separately, live, as the item's proof-on-the-real-
 *   case run, not here).
 */
import { describe, it, expect } from 'vitest';
import {
  idFromFilename, stripWe, withWe, parseCard, idCompare, extractImportSpecifiers, resolveRelativeImport,
  transitiveBlockedBy, landingDepth, computeSharedFiles, classifyImportPath, rankOwnerCandidates, planTestFileFix,
  buildFindings, describeFix, planEdits, readArrayField, writeArrayField, appendGraduationNote, applyCardEdits,
} from '../graduation-import-check.mjs';

describe('idFromFilename', () => {
  it('takes the leading id token off a numbered card', () => {
    expect(idFromFilename('3895-graduate-telemetry-core.md')).toBe('3895');
  });
  it('takes the leading id token off a not-yet-JIT-numbered (hash) card', () => {
    expect(idFromFilename('x8w8pux-graduation-import-check.md')).toBe('x8w8pux');
  });
});

describe('stripWe / withWe', () => {
  it('round-trips a we:-prefixed path', () => {
    expect(stripWe('we:scripts/foo.mjs')).toBe('scripts/foo.mjs');
    expect(withWe('scripts/foo.mjs')).toBe('we:scripts/foo.mjs');
  });
  it('is a no-op when already in the target form', () => {
    expect(stripWe('scripts/foo.mjs')).toBe('scripts/foo.mjs');
    expect(withWe('we:scripts/foo.mjs')).toBe('we:scripts/foo.mjs');
  });
});

describe('parseCard', () => {
  it('normalizes scope/blockedBy to string arrays and reads parent/status', () => {
    const text = [
      '---',
      'kind: story',
      'parent: "3443"',
      'status: open',
      'blockedBy: ["3901", "3895"]',
      'scope: ["we:a.mjs", "we:b.mjs"]',
      '---',
      '',
      '# Title',
    ].join('\n');
    const card = parseCard('3902-graduate-x.md', text);
    expect(card).toEqual({ id: '3902', kind: 'story', status: 'open', parent: '3443', blockedBy: ['3901', '3895'], scope: ['we:a.mjs', 'we:b.mjs'] });
  });
  it('defaults blockedBy/scope to [] and parent to null when absent', () => {
    const text = '---\nkind: story\nstatus: open\n---\n\n# Title';
    expect(parseCard('9999-x.md', text)).toEqual({ id: '9999', kind: 'story', status: 'open', parent: null, blockedBy: [], scope: [] });
  });
  it('returns null on unparseable frontmatter rather than throwing', () => {
    expect(parseCard('bad.md', '---\n[not: yaml: at: all\n---\n')).toBeNull();
  });
});

describe('idCompare', () => {
  it('compares numerically when both ids are numeric', () => {
    expect(idCompare('3902', '3908')).toBeLessThan(0);
    expect(idCompare('3908', '3902')).toBeGreaterThan(0);
    expect(idCompare('3902', '3902')).toBe(0);
  });
  it('falls back to string compare for a non-numeric (hash) id', () => {
    expect(idCompare('x8w8pux', '3902')).toBe('x8w8pux'.localeCompare('3902'));
  });
});

describe('extractImportSpecifiers', () => {
  it('extracts a default-import from-clause', () => {
    expect(extractImportSpecifiers(`import Foo from './foo.mjs';`)).toEqual(['./foo.mjs']);
  });
  it('extracts a multi-line named-import from-clause', () => {
    const src = `import {\n  a, b,\n  c,\n} from '../telemetry-store.mjs';\n`;
    expect(extractImportSpecifiers(src)).toEqual(['../telemetry-store.mjs']);
  });
  it('extracts a side-effect-only import (no from-clause)', () => {
    expect(extractImportSpecifiers(`import './setup.mjs';`)).toEqual(['./setup.mjs']);
  });
  it('extracts a dynamic import() of a string literal', () => {
    expect(extractImportSpecifiers(`const { x } = await import('./cli-adapter.mjs');`)).toEqual(['./cli-adapter.mjs']);
  });
  it('extracts bare-package and node: specifiers too (caller filters them)', () => {
    expect(extractImportSpecifiers(`import { describe } from 'vitest';\nimport { join } from 'node:path';`))
      .toEqual(['vitest', 'node:path']);
  });
  it('ignores an import mentioned only inside a block comment', () => {
    const src = `/**\n * consumed via \`await import('./real.mjs')\` in prose only\n */\nimport { z } from './only-real-one.mjs';\n`;
    expect(extractImportSpecifiers(src)).toEqual(['./only-real-one.mjs']);
  });
  it('ignores an import mentioned only inside a line comment', () => {
    const src = `// import './commented-out.mjs';\nimport { z } from './live.mjs';\n`;
    expect(extractImportSpecifiers(src)).toEqual(['./live.mjs']);
  });
  it('does not cross a semicolon into the next statement', () => {
    const src = `import { a } from './a.mjs'; import { b } from './b.mjs';`;
    expect(extractImportSpecifiers(src)).toEqual(['./a.mjs', './b.mjs']);
  });
});

describe('resolveRelativeImport', () => {
  it('resolves a sibling-directory relative import to a repo path', () => {
    expect(resolveRelativeImport('scripts/operations/__tests__/telemetry-wiring.test.mjs', '../minimal-context-provider.mjs'))
      .toBe('scripts/operations/minimal-context-provider.mjs');
  });
  it('resolves a same-directory relative import', () => {
    expect(resolveRelativeImport('scripts/operations/telemetry-cli.mjs', './telemetry.mjs'))
      .toBe('scripts/operations/telemetry.mjs');
  });
  it('returns null for a non-relative (bare or node:) specifier', () => {
    expect(resolveRelativeImport('scripts/x.mjs', 'vitest')).toBeNull();
    expect(resolveRelativeImport('scripts/x.mjs', 'node:fs')).toBeNull();
  });
});

describe('transitiveBlockedBy', () => {
  const cardsById = new Map([
    ['A', { id: 'A', blockedBy: ['B'], scope: [], status: 'open' }],
    ['B', { id: 'B', blockedBy: ['C'], scope: [], status: 'open' }],
    ['C', { id: 'C', blockedBy: [], scope: [], status: 'open' }],
  ]);
  it('walks the full transitive chain', () => {
    expect(transitiveBlockedBy('A', cardsById)).toEqual(new Set(['B', 'C']));
  });
  it('is cycle-safe', () => {
    const cyc = new Map([
      ['A', { id: 'A', blockedBy: ['B'], scope: [], status: 'open' }],
      ['B', { id: 'B', blockedBy: ['A'], scope: [], status: 'open' }],
    ]);
    expect(transitiveBlockedBy('A', cyc)).toEqual(new Set(['B', 'A']));
  });
});

describe('landingDepth', () => {
  it('is 0 for a card with no blockedBy', () => {
    const cardsById = new Map([['A', { id: 'A', blockedBy: [], status: 'open' }]]);
    expect(landingDepth('A', cardsById)).toBe(0);
  });
  it('takes the longest OPEN-blocker chain (matches the real #3902→#3906/#3903→…→#3908 shape)', () => {
    const cardsById = new Map([
      ['3902', { id: '3902', blockedBy: [], status: 'open' }],
      ['3906', { id: '3906', blockedBy: ['3902'], status: 'open' }],
      ['3903', { id: '3903', blockedBy: ['3902', '3906'], status: 'open' }],
      ['3904', { id: '3904', blockedBy: ['3903'], status: 'open' }],
      ['3905', { id: '3905', blockedBy: ['3903'], status: 'open' }],
      ['3907', { id: '3907', blockedBy: ['3902'], status: 'open' }],
      ['3908', { id: '3908', blockedBy: ['3906', '3904', '3907'], status: 'open' }],
    ]);
    expect(landingDepth('3902', cardsById)).toBe(0);
    expect(landingDepth('3905', cardsById)).toBe(3);
    expect(landingDepth('3908', cardsById)).toBe(4);
    expect(landingDepth('3908', cardsById)).toBeGreaterThan(landingDepth('3905', cardsById)); // #3908 lands after #3905 (D wave after C wave)
  });
  it('does not count a RESOLVED blocker toward depth (it already landed)', () => {
    const cardsById = new Map([
      ['A', { id: 'A', blockedBy: [], status: 'resolved' }],
      ['B', { id: 'B', blockedBy: ['A'], status: 'open' }],
    ]);
    expect(landingDepth('B', cardsById)).toBe(0);
  });
  it('is cycle-safe', () => {
    const cardsById = new Map([
      ['A', { id: 'A', blockedBy: ['B'], status: 'open' }],
      ['B', { id: 'B', blockedBy: ['A'], status: 'open' }],
    ]);
    expect(() => landingDepth('A', cardsById)).not.toThrow();
  });
});

function card({ id, status = 'open', parent = '3443', blockedBy = [], scope = [] }) {
  return { id, kind: 'story', status, parent, blockedBy, scope };
}

describe('computeSharedFiles', () => {
  it('flags a path declared in 2+ open cards, sorted by idCompare', () => {
    const cardsById = new Map([
      ['3906', card({ id: '3906', scope: ['we:scripts/operations/run.mjs'] })],
      ['3856', card({ id: '3856', scope: ['we:scripts/operations/run.mjs', 'we:scripts/operations/land-advance-io.mjs'] })],
    ]);
    expect(computeSharedFiles(cardsById)).toEqual(new Map([['we:scripts/operations/run.mjs', ['3856', '3906']]]));
  });
  it('ignores a singly-owned path', () => {
    const cardsById = new Map([['A', card({ id: 'A', scope: ['we:only-mine.mjs'] })]]);
    expect(computeSharedFiles(cardsById).size).toBe(0);
  });
  it('does not count a RESOLVED card toward sharing', () => {
    const cardsById = new Map([
      ['A', card({ id: 'A', scope: ['we:x.mjs'] })],
      ['B', card({ id: 'B', status: 'resolved', scope: ['we:x.mjs'] })],
    ]);
    expect(computeSharedFiles(cardsById).size).toBe(0);
  });
});

describe('classifyImportPath', () => {
  it('classifies on-main first, even if it also happens to be in a card scope', () => {
    const cardsById = new Map([['A', card({ id: 'A', scope: ['we:x.mjs'] })]]);
    const mainPaths = new Set(['x.mjs']);
    expect(classifyImportPath({ repoPath: 'x.mjs', ownerId: 'A', cardsById, mainPaths })).toEqual({ kind: 'on-main' });
  });
  it('classifies own', () => {
    const cardsById = new Map([['A', card({ id: 'A', scope: ['we:x.mjs'] })]]);
    expect(classifyImportPath({ repoPath: 'x.mjs', ownerId: 'A', cardsById, mainPaths: new Set() })).toEqual({ kind: 'own' });
  });
  it('classifies blocker (declared blockedBy, transitively)', () => {
    const cardsById = new Map([
      ['A', card({ id: 'A', blockedBy: ['B'] })],
      ['B', card({ id: 'B', scope: ['we:x.mjs'] })],
    ]);
    expect(classifyImportPath({ repoPath: 'x.mjs', ownerId: 'A', cardsById, mainPaths: new Set() })).toEqual({ kind: 'blocker', ownerId: 'B' });
  });
  it('classifies later (owned by another OPEN card, no blockedBy edge)', () => {
    const cardsById = new Map([
      ['A', card({ id: 'A' })],
      ['B', card({ id: 'B', scope: ['we:x.mjs'] })],
    ]);
    expect(classifyImportPath({ repoPath: 'x.mjs', ownerId: 'A', cardsById, mainPaths: new Set() })).toEqual({ kind: 'later', ownerId: 'B' });
  });
  it('does NOT classify an open card under a DIFFERENT epic as later (siblings only)', () => {
    const cardsById = new Map([
      ['A', card({ id: 'A', parent: '3443' })],
      ['B', card({ id: 'B', parent: '3383', scope: ['we:x.mjs'] })], // a bug card on an unrelated epic
    ]);
    expect(classifyImportPath({ repoPath: 'x.mjs', ownerId: 'A', cardsById, mainPaths: new Set() })).toEqual({ kind: 'unowned' });
  });
  it('does NOT classify a RESOLVED card that owns the path as later (only open cards count)', () => {
    const cardsById = new Map([
      ['A', card({ id: 'A' })],
      ['B', card({ id: 'B', status: 'resolved', scope: ['we:x.mjs'] })],
    ]);
    expect(classifyImportPath({ repoPath: 'x.mjs', ownerId: 'A', cardsById, mainPaths: new Set() })).toEqual({ kind: 'unowned' });
  });
  it('classifies unowned when no card and no main blob has it', () => {
    const cardsById = new Map([['A', card({ id: 'A' })]]);
    expect(classifyImportPath({ repoPath: 'ghost.mjs', ownerId: 'A', cardsById, mainPaths: new Set() })).toEqual({ kind: 'unowned' });
  });
});

describe('rankOwnerCandidates', () => {
  it('ranks by greatest landingDepth first', () => {
    const cardsById = new Map([
      ['3902', card({ id: '3902' })],
      ['3906', card({ id: '3906', blockedBy: ['3902'] })],
      ['3908', card({ id: '3908', blockedBy: ['3906'] })],
    ]);
    expect(rankOwnerCandidates(['3902', '3908'], cardsById)).toEqual(['3908', '3902']);
  });
  it('the real #3901/#3856 shape: the already-more-constrained card outranks the blocker-free leaf even at EQUAL depth', () => {
    // #3901 (a foundational leaf, zero blockedBy) and #3856 (7 existing blockers, none reaching #3901) both
    // have landingDepth 0 here (neither is blocked by anything OPEN) — the tie-break must still prefer #3856,
    // since it already carries blockedBy entries and #3901 currently has none.
    const cardsById = new Map([
      ['3901', card({ id: '3901' })], // leaf: no blockedBy at all
      ['3856', card({ id: '3856', blockedBy: ['3853', '3854', '3851', '3852', '3855', '3865', '3891'] })],
    ]);
    for (const c of ['3853', '3854', '3851', '3852', '3855', '3865', '3891']) cardsById.set(c, card({ id: c, status: 'resolved' })); // all landed — depth(3856) is 0 too
    expect(landingDepth('3901', cardsById)).toBe(0);
    expect(landingDepth('3856', cardsById)).toBe(0); // confirms this is a genuine depth TIE
    expect(rankOwnerCandidates(['3901', '3856'], cardsById)).toEqual(['3856', '3901']);
  });
  it('is deterministic on a full tie (lower id wins, by idCompare)', () => {
    const cardsById = new Map([
      ['A', card({ id: 'A' })],
      ['B', card({ id: 'B' })],
    ]);
    expect(rankOwnerCandidates(['B', 'A'], cardsById)).toEqual(['A', 'B']);
  });
});

describe('planTestFileFix', () => {
  it('needs no extra blockedBy when the target already (transitively) covers every other import', () => {
    const cardsById = new Map([
      ['OWNER', card({ id: 'OWNER', scope: ['we:owner-file.mjs'] })],
      ['MID', card({ id: 'MID', blockedBy: ['OWNER'] })],
      ['DEEP', card({ id: 'DEEP', blockedBy: ['MID'], scope: ['we:deep-file.mjs'] })],
    ]);
    const classifications = [
      { repoPath: 'deep-file.mjs', kind: 'later', ownerId: 'DEEP' },
      { repoPath: 'owner-file.mjs', kind: 'own' }, // fine under the CURRENT owner; becomes a hazard only if the new owner doesn't reach it
    ];
    const plan = planTestFileFix({ currentOwnerId: 'OWNER', classifications, cardsById, mainPaths: new Set() });
    expect(plan.target).toBe('DEEP');
    expect(plan.addBlockedBy).toEqual([]); // DEEP already depends on OWNER via MID — no new edge needed
    expect(plan.cycleWarnings).toEqual([]);
  });

  it('adds blockedBy for an import that only becomes later once relocated to the new owner (real #3895/#3908 shape)', () => {
    // Mirrors the LIVE finding: a test moves to fix imports owned by DEEP, but also needs SIBLING's file —
    // an unrelated card with no order relationship to DEEP, so it is a hazard only after the move.
    const cardsById = new Map([
      ['OWNER', card({ id: 'OWNER', scope: ['we:owner-file.mjs'] })],
      ['MID', card({ id: 'MID', blockedBy: ['OWNER'] })],
      ['DEEP', card({ id: 'DEEP', blockedBy: ['MID'], scope: ['we:deep-file.mjs'] })],
      ['SIBLING', card({ id: 'SIBLING', scope: ['we:sibling-file.mjs'] })],
    ]);
    const classifications = [
      { repoPath: 'deep-file.mjs', kind: 'later', ownerId: 'DEEP' },
      { repoPath: 'sibling-file.mjs', kind: 'later', ownerId: 'SIBLING' },
      { repoPath: 'owner-file.mjs', kind: 'own' },
    ];
    const plan = planTestFileFix({ currentOwnerId: 'OWNER', classifications, cardsById, mainPaths: new Set() });
    expect(plan.target).toBe('DEEP'); // strictly deeper than SIBLING (depth 2 vs 0), and than OWNER (depth 0)
    expect(plan.addBlockedBy).toEqual(['SIBLING']); // owner-file.mjs is covered via MID; sibling-file.mjs is not
    expect(plan.cycleWarnings).toEqual([]);
  });

  it('the real #3901/#3856 shape: STAYS at the current owner and blocks it on the other, never the reverse', () => {
    // action-dispatch-paths.test.mjs lives at #3856 (owns land-advance-io.mjs) and also imports
    // action-store.mjs/action-record.mjs, both #3901's. #3901 is a blocker-free leaf; #3856 already has 7
    // blockers. The WRONG fix (what the first version of this tool did) moves the test to #3901 and blocks
    // #3901 on #3856 — stalling everything #3901 feeds behind the whole land-advance chain. The right fix:
    // target stays #3856 (current owner), and #3856 gains blockedBy #3901.
    const cardsById = new Map([
      ['3901', card({ id: '3901', scope: ['we:action-store.mjs', 'we:action-record.mjs'] })], // leaf
      ['3856', card({ id: '3856', blockedBy: ['3853'], scope: ['we:land-advance-io.mjs'] })],
      ['3853', card({ id: '3853', status: 'resolved' })],
    ]);
    const classifications = [
      { repoPath: 'action-store.mjs', kind: 'later', ownerId: '3901' },
      { repoPath: 'action-record.mjs', kind: 'later', ownerId: '3901' },
      { repoPath: 'land-advance-io.mjs', kind: 'own' },
    ];
    const plan = planTestFileFix({ currentOwnerId: '3856', classifications, cardsById, mainPaths: new Set() });
    expect(plan.target).toBe('3856'); // STAYS — never moves to the blocker-free leaf
    expect(plan.addBlockedBy).toEqual(['3901']);
    expect(plan.cycleWarnings).toEqual([]);
  });

  it('flags a genuine cycle instead of silently proposing a self-defeating edge', () => {
    const cardsById = new Map([
      ['OWNER', card({ id: 'OWNER' })], // no blockedBy at all
      ['T_LANDED', card({ id: 'T_LANDED', status: 'resolved' })],
      ['T', card({ id: 'T', blockedBy: ['T_LANDED'], scope: ['we:t-file.mjs'] })], // already has a (landed) blocker
      ['R', card({ id: 'R', blockedBy: ['T'], scope: ['we:r-file.mjs'] })], // R already depends on T
    ]);
    // r-file.mjs was fine under the file's original owner; T is the only real `later` import, and it outranks
    // OWNER (which has no blockedBy at all — T already carries one, even if landed) — so T is picked, but T
    // needing R would cycle (R already needs T).
    const classifications = [
      { repoPath: 't-file.mjs', kind: 'later', ownerId: 'T' },
      { repoPath: 'r-file.mjs', kind: 'own' },
    ];
    const plan = planTestFileFix({ currentOwnerId: 'OWNER', classifications, cardsById, mainPaths: new Set() });
    expect(plan.target).toBe('T');
    expect(plan.addBlockedBy).toEqual([]);
    expect(plan.cycleWarnings).toEqual([{ path: 'r-file.mjs', ownerId: 'R' }]);
  });

  it('returns null when there is no later import to move for', () => {
    const cardsById = new Map([['A', card({ id: 'A' })]]);
    expect(planTestFileFix({ currentOwnerId: 'A', classifications: [{ repoPath: 'x.mjs', kind: 'own' }], cardsById, mainPaths: new Set() })).toBeNull();
  });
});

describe('buildFindings + describeFix', () => {
  const cardsById = new Map([
    ['3895', card({ id: '3895' })],
    ['3902', card({ id: '3902' })],
    ['3908', card({ id: '3908', blockedBy: ['3902'] })],
    ['3915', card({ id: '3915' })],
  ]);

  it('proposes MOVE (to the deepest-landing owner) for a test file with several later imports', () => {
    const results = [{
      ownerId: '3895',
      file: 'we:scripts/operations/__tests__/telemetry-wiring.test.mjs',
      classifications: [
        { specifier: '../minimal-context-provider.mjs', repoPath: 'scripts/operations/minimal-context-provider.mjs', kind: 'later', ownerId: '3902' },
        { specifier: '../review-dispatch-wrapper.mjs', repoPath: 'scripts/operations/review-dispatch-wrapper.mjs', kind: 'later', ownerId: '3908' },
        { specifier: '../telemetry-store.mjs', repoPath: 'scripts/operations/telemetry-store.mjs', kind: 'own' },
      ],
    }];
    const findings = buildFindings({ cardsById, mainPaths: new Set(), results });
    expect(findings).toHaveLength(1);
    expect(findings[0].fix.kind).toBe('move');
    expect(findings[0].fix.target).toBe('3908'); // deeper than #3895 (current owner, depth 0) and #3902
    expect(describeFix(findings[0])).toMatch(/move to #3908/);
  });

  it('a test file STAYS when the current owner already outranks its later owner (the #3901/#3856 shape)', () => {
    const stayCardsById = new Map([
      ['3908', card({ id: '3908', blockedBy: ['3853'], scope: ['we:scripts/operations/own-thing.mjs'] })], // stands in for #3856 (already has a blocker)
      ['3853', card({ id: '3853', status: 'resolved' })], // #3908's existing (landed) blocker — unrelated to #3902
      ['3902', card({ id: '3902', scope: ['we:scripts/operations/later-thing.mjs'] })], // leaf, stands in for #3901 — no blockedBy at all
    ]);
    const results = [{
      ownerId: '3908',
      file: 'we:scripts/operations/__tests__/action-dispatch-paths.test.mjs',
      classifications: [
        { specifier: '../own-thing.mjs', repoPath: 'scripts/operations/own-thing.mjs', kind: 'own' },
        { specifier: '../later-thing.mjs', repoPath: 'scripts/operations/later-thing.mjs', kind: 'later', ownerId: '3902' },
      ],
    }];
    const findings = buildFindings({ cardsById: stayCardsById, mainPaths: new Set(), results });
    expect(findings[0].fix.kind).toBe('move');
    expect(findings[0].fix.target).toBe('3908'); // stays — #3908 already has a blocker, #3902 has none
    expect(findings[0].fix.addBlockedBy).toEqual(['3902']);
    expect(describeFix(findings[0])).toMatch(/^stays here; add blockedBy #3902/);
  });

  it('proposes BLOCKEDBY for an impl file with a later import', () => {
    const results = [{
      ownerId: '3895',
      file: 'we:scripts/operations/telemetry.mjs',
      classifications: [
        { specifier: '../host-process-sample.mjs', repoPath: 'scripts/operations/host-process-sample.mjs', kind: 'later', ownerId: '3915' },
      ],
    }];
    const findings = buildFindings({ cardsById, mainPaths: new Set(), results });
    expect(findings[0].fix).toEqual({ kind: 'blockedBy', targets: ['3915'], cycleWarnings: [] });
    expect(describeFix(findings[0])).toBe('add blockedBy #3915');
  });

  it('guards an impl-file blockedBy proposal against a cycle too', () => {
    const cyclic = new Map([
      ['OWNER', card({ id: 'OWNER' })],
      ['R', card({ id: 'R', blockedBy: ['OWNER'] })], // R already depends on OWNER
    ]);
    const results = [{
      ownerId: 'OWNER', file: 'we:owner-impl.mjs',
      classifications: [{ specifier: './r.mjs', repoPath: 'r.mjs', kind: 'later', ownerId: 'R' }],
    }];
    const findings = buildFindings({ cardsById: cyclic, mainPaths: new Set(), results });
    expect(findings[0].fix.targets).toEqual([]);
    expect(findings[0].fix.cycleWarnings).toEqual([{ path: null, ownerId: 'R' }]);
    expect(describeFix(findings[0])).toMatch(/MANUAL/);
  });

  it('produces no finding when every import is on-main/own/blocker', () => {
    const results = [{
      ownerId: '3895', file: 'we:scripts/operations/telemetry-store.mjs',
      classifications: [{ specifier: './telemetry.mjs', repoPath: 'scripts/operations/telemetry.mjs', kind: 'own' }],
    }];
    expect(buildFindings({ cardsById, mainPaths: new Set(), results })).toEqual([]);
  });

  it('proposes ADD-TO-SCOPE for an unowned import (no card in the epic claims it)', () => {
    const results = [{
      ownerId: '3895', file: 'we:scripts/operations/telemetry.mjs',
      classifications: [{ specifier: './ghost.mjs', repoPath: 'scripts/operations/ghost.mjs', kind: 'unowned' }],
    }];
    const findings = buildFindings({ cardsById, mainPaths: new Set(), results });
    expect(findings[0].fix).toEqual({ kind: 'add-to-scope', owner: '3895', paths: ['we:scripts/operations/ghost.mjs'], addToScope: { owner: '3895', paths: ['we:scripts/operations/ghost.mjs'] } });
    expect(describeFix(findings[0])).toMatch(/add `we:scripts\/operations\/ghost\.mjs` to #3895's own scope/);
  });

  it('attaches addToScope to a move fix when the same file has BOTH a later and an unowned import', () => {
    // A dedicated cardsById so the later owner (3915) unambiguously outranks the current owner (3895) —
    // avoids relying on a tie-break for what this test wants to demonstrate (addToScope following the move).
    const mixedCardsById = new Map([
      ['3895', card({ id: '3895' })],
      ['3902', card({ id: '3902' })],
      ['3915', card({ id: '3915', blockedBy: ['3902'] })], // depth 1 > current owner's depth 0
    ]);
    const results = [{
      ownerId: '3895',
      file: 'we:scripts/operations/__tests__/mixed.test.mjs',
      classifications: [
        { specifier: '../host-process-sample.mjs', repoPath: 'scripts/operations/host-process-sample.mjs', kind: 'later', ownerId: '3915' },
        { specifier: './ghost.mjs', repoPath: 'scripts/operations/ghost.mjs', kind: 'unowned' },
      ],
    }];
    const findings = buildFindings({ cardsById: mixedCardsById, mainPaths: new Set(), results });
    expect(findings[0].fix.kind).toBe('move');
    expect(findings[0].fix.target).toBe('3915');
    expect(findings[0].fix.addToScope).toEqual({ owner: '3915', paths: ['we:scripts/operations/ghost.mjs'] }); // follows the file to its new home
  });
});

describe('planEdits', () => {
  it('plans a move: removes from source scope, adds to target scope, notes both sides', () => {
    const findings = [{
      ownerId: '3895', file: 'we:scripts/operations/__tests__/telemetry-wiring.test.mjs', isTest: true,
      later: [{ ownerId: '3908' }], unowned: [], fix: { kind: 'move', target: '3908', addBlockedBy: [], cycleWarnings: [] },
    }];
    const edits = planEdits(findings, '2026-09-24');
    expect(edits.get('3895').removeScope).toEqual(['we:scripts/operations/__tests__/telemetry-wiring.test.mjs']);
    expect(edits.get('3908').addScope).toEqual(['we:scripts/operations/__tests__/telemetry-wiring.test.mjs']);
    expect(edits.get('3895').notes[0]).toMatch(/moved .* to #3908/);
    expect(edits.get('3908').notes[0]).toMatch(/moved .* here from #3895/);
  });

  it('a "stays" move (target === ownerId) touches NO scope, only adds the blockedBy', () => {
    const findings = [{
      ownerId: '3856', file: 'we:scripts/operations/__tests__/action-dispatch-paths.test.mjs', isTest: true,
      later: [{ ownerId: '3901' }], unowned: [], fix: { kind: 'move', target: '3856', addBlockedBy: ['3901'], cycleWarnings: [] },
    }];
    const edits = planEdits(findings, '2026-09-24');
    expect(edits.has('3856')).toBe(true);
    expect(edits.get('3856').removeScope).toEqual([]);
    expect(edits.get('3856').addScope).toEqual([]);
    expect(edits.get('3856').addBlockedBy).toEqual(['3901']);
    expect(edits.get('3901').addBlockedBy).toEqual([]); // #3901 gets a NOTE, never a new blocker itself
    expect(edits.get('3901').notes.some((n) => /blocker of #3856/.test(n))).toBe(true);
  });

  it('also blocks the new owner on a residual later import surfaced only by the move', () => {
    const findings = [{
      ownerId: '3895', file: 'we:x.test.mjs', isTest: true,
      later: [{ ownerId: '3908' }], unowned: [], fix: { kind: 'move', target: '3908', addBlockedBy: ['3905'], cycleWarnings: [] },
    }];
    const edits = planEdits(findings, '2026-09-24');
    expect(edits.get('3908').addBlockedBy).toEqual(['3905']);
    expect(edits.get('3908').notes.some((n) => /added blockedBy #3905/.test(n))).toBe(true);
    expect(edits.get('3905').notes.some((n) => /blocker of #3908/.test(n))).toBe(true);
  });

  it('plans a blockedBy add on both sides', () => {
    const findings = [{
      ownerId: '3895', file: 'we:scripts/operations/telemetry.mjs', isTest: false,
      later: [{ ownerId: '3915' }], unowned: [], fix: { kind: 'blockedBy', targets: ['3915'] },
    }];
    const edits = planEdits(findings, '2026-09-24');
    expect(edits.get('3895').addBlockedBy).toEqual(['3915']);
    expect(edits.get('3895').notes[0]).toMatch(/added blockedBy #3915/);
    expect(edits.get('3915').notes[0]).toMatch(/blocker of #3895/);
  });

  it('plans an add-to-scope: appends the unowned path to the owning card, with a note', () => {
    const findings = [{
      ownerId: '3862', file: 'we:scripts/conveyor/__tests__/session-reaper-cli.test.mjs', isTest: true,
      later: [], unowned: [{}],
      fix: {
        kind: 'add-to-scope', owner: '3862', paths: ['we:scripts/conveyor/__tests__/helpers/session-reaper-cli-harness.mjs'],
        addToScope: { owner: '3862', paths: ['we:scripts/conveyor/__tests__/helpers/session-reaper-cli-harness.mjs'] },
      },
    }];
    const edits = planEdits(findings, '2026-09-24');
    expect(edits.get('3862').addScope).toEqual(['we:scripts/conveyor/__tests__/helpers/session-reaper-cli-harness.mjs']);
    expect(edits.get('3862').notes[0]).toMatch(/added .*session-reaper-cli-harness\.mjs.* to this card's own scope/);
  });

  it('produces no edit for a cycle-only finding (nothing safe to apply)', () => {
    const findings = [{ ownerId: '3895', file: 'we:x.mjs', isTest: false, later: [], unowned: [], fix: { kind: 'blockedBy', targets: [], cycleWarnings: [{ path: null, ownerId: '9' }] } }];
    expect(planEdits(findings, '2026-09-24').size).toBe(0);
  });
});

describe('readArrayField / writeArrayField', () => {
  const content = '---\nstatus: open\nblockedBy: ["3901"]\nscope: ["we:a.mjs", "we:b.mjs"]\n---\n\nbody\n';
  it('reads an inline JSON-array frontmatter field', () => {
    expect(readArrayField(content, 'scope')).toEqual(['we:a.mjs', 'we:b.mjs']);
    expect(readArrayField(content, 'blockedBy')).toEqual(['3901']);
  });
  it('returns [] for an absent field', () => {
    expect(readArrayField(content, 'tags')).toEqual([]);
  });
  it('writes back in the repo house style (comma-space separated)', () => {
    const next = writeArrayField(content, 'scope', ['we:a.mjs', 'we:c.mjs']);
    expect(next).toContain('scope: ["we:a.mjs", "we:c.mjs"]');
    expect(readArrayField(next, 'blockedBy')).toEqual(['3901']); // untouched
  });
});

describe('appendGraduationNote', () => {
  it('creates the section on first use', () => {
    const next = appendGraduationNote('# Title\n\nbody\n', '- 2026-09-24: did a thing.');
    expect(next).toContain('## Graduation import check');
    expect(next).toContain('- 2026-09-24: did a thing.');
  });
  it('stacks a second note right after the heading (newest first)', () => {
    let content = appendGraduationNote('# Title\n\nbody\n', '- first note.');
    content = appendGraduationNote(content, '- second note.');
    const headingIdx = content.indexOf('## Graduation import check');
    expect(content.indexOf('- second note.')).toBeLessThan(content.indexOf('- first note.'));
    expect(headingIdx).toBeLessThan(content.indexOf('- second note.'));
  });
  it('is idempotent for a byte-identical line', () => {
    let content = appendGraduationNote('# Title\n\nbody\n', '- same note.');
    const again = appendGraduationNote(content, '- same note.');
    expect(again).toBe(content);
  });
});

describe('applyCardEdits (round trip)', () => {
  it('applies a move-out edit: scope shrinks, note appended, other fields untouched', () => {
    const content = [
      '---', 'kind: story', 'size: 5', 'parent: "3443"', 'status: open',
      'scope: ["we:a.test.mjs", "we:b.mjs"]', 'dateOpened: "2026-09-22"', 'tags: []', '---', '',
      '# Title', '', 'Body text.',
    ].join('\n');
    const next = applyCardEdits(content, { removeScope: ['we:a.test.mjs'], notes: ['- 2026-09-24: moved out.'] });
    expect(readArrayField(next, 'scope')).toEqual(['we:b.mjs']);
    expect(next).toContain('parent: "3443"'); // untouched
    expect(next).toContain('size: 5'); // untouched
    expect(next).toContain('## Graduation import check');
    expect(next).toContain('- 2026-09-24: moved out.');
  });

  it('applies a move-in edit: scope grows without duplicating an existing entry', () => {
    const content = '---\nstatus: open\nscope: ["we:b.mjs"]\n---\n\n# Title\n';
    const next = applyCardEdits(content, { addScope: ['we:a.test.mjs', 'we:b.mjs'] });
    expect(readArrayField(next, 'scope')).toEqual(['we:b.mjs', 'we:a.test.mjs']);
  });

  it('applies a blockedBy add without disturbing an existing entry', () => {
    const content = '---\nstatus: open\nblockedBy: ["3901"]\nscope: []\n---\n\n# Title\n';
    const next = applyCardEdits(content, { addBlockedBy: ['3915'] });
    expect(readArrayField(next, 'blockedBy')).toEqual(['3901', '3915']);
  });

  it('adds a blockedBy field that did not previously exist', () => {
    const content = '---\nstatus: open\nscope: []\n---\n\n# Title\n';
    const next = applyCardEdits(content, { addBlockedBy: ['3915'] });
    expect(readArrayField(next, 'blockedBy')).toEqual(['3915']);
  });
});
