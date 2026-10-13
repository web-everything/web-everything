/**
 * #2892 — the leash-pin `check:standards` rule (`checkLeashPin`): no pinned declarative-leash file may be dropped
 * from the human gate. Driven two ways — synthetic rosters / rubrics (each way to DROP a file must go red) and the
 * REAL roster + REAL `scoreEscalation` (the live tree must be green), which is the wiring `check-standards.mjs` runs.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLeashPin, LEASH_PIN_SNAPSHOT } from '../check-standards-rules.mjs';
import { TRUST_CHAIN, POLICY_SPEC_BASENAMES, RATIFIED_POLICY_SPEC_FLOOR } from '../lib/gate-config.mjs';
import { scoreEscalation } from '../lib/review-escalation.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const realGate = (path, hunks) => scoreEscalation({ humanSurfaces: 'broad', changedFiles: [path], diffHunks: hunks }).humanRequired;
const real = (over = {}) => checkLeashPin({ specBasenames: POLICY_SPEC_BASENAMES, roster: TRUST_CHAIN, isHumanGated: realGate, homeExists: (rel) => existsSync(join(ROOT, rel)), ...over });

describe('checkLeashPin — the live tree', () => {
  it('is GREEN against the real roster, the real rubric and the real filesystem — no errors, and only growth warnings are ever possible', () => {
    const r = real();
    expect(r.errors).toEqual([]);
    // Roster GROWTH is a warning by design (see below), so this must not go red the day a leash file is added.
    expect(r.warnings.every((w) => w.descriptor.angle === 'unpinned-growth')).toBe(true);
  });
  it('every snapshot entry is STILL a live leash file (a drop is an error), and the snapshot covers the ratified floor', () => {
    for (const f of LEASH_PIN_SNAPSHOT) expect(POLICY_SPEC_BASENAMES.has(f), f).toBe(true);
    for (const f of RATIFIED_POLICY_SPEC_FLOOR) expect(LEASH_PIN_SNAPSHOT).toContain(f);
  });
  it('pins the review-policy contract — the file that owns #2838\'s landMode flip', () => {
    expect(LEASH_PIN_SNAPSHOT).toContain('review-policy.contract.json');
  });
});

describe('checkLeashPin — every way to DROP a leash file from the human gate goes red', () => {
  it('CLASSIFICATION: a spec member reclassified to derivation code (leash:code) is an error naming the file', () => {
    const roster = TRUST_CHAIN.map((e) => (e.file === 'review-policy.contract.json' ? { ...e, leash: 'code' } : e));
    // Recompute the set the way gate-config does — "policy members whose leash is not exactly 'code'".
    const spec = new Set(roster.filter((m) => m.tier === 'policy' && m.leash !== 'code').map((m) => m.file));
    const r = real({ roster, specBasenames: spec });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('review-policy.contract.json');
    expect(r.errors[0].message).toContain('no longer in POLICY_SPEC_BASENAMES');
    expect(r.errors[0].descriptor).toMatchObject({ kind: 'leash-pin', angle: 'classification', pinned: 'review-policy.contract.json' });
  });
  it('CLASSIFICATION: a roster entry deleted outright is caught, one error per dropped file', () => {
    const spec = new Set([...POLICY_SPEC_BASENAMES].filter((f) => f !== 'gate-config.mjs' && f !== 'review-runner.mjs'));
    const r = real({ specBasenames: spec });
    expect(r.errors.map((e) => e.descriptor.pinned).sort()).toEqual(['gate-config.mjs', 'review-runner.mjs']);
  });
  it('BEHAVIOUR: a rubric that stops human-gating a leash file — with the roster still looking right — is caught', () => {
    // A composition that only fires on a content hit: the leash path floor became conditional.
    const contentOnly = (path, hunks) => typeof hunks === 'string' && hunks.includes('@principle');
    const r = real({ isHumanGated: contentOnly });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.every((e) => e.descriptor.angle === 'behaviour')).toBe(true);
    // both hunk shapes are probed for every pinned file: a whitespace-only touch AND not-computed.
    expect(r.errors).toHaveLength(LEASH_PIN_SNAPSHOT.length * 2);
    expect(new Set(r.errors.map((e) => e.descriptor.hunks))).toEqual(new Set(['whitespace-only', 'null']));
  });
  it('BEHAVIOUR: a floor that holds for a whitespace-only touch but not for NOT-COMPUTED hunks is still caught', () => {
    const r = real({ isHumanGated: (path, hunks) => hunks !== null });
    expect(r.errors).toHaveLength(LEASH_PIN_SNAPSHOT.length);
    expect(r.errors.every((e) => e.descriptor.hunks === 'null')).toBe(true);
  });
  it('BEHAVIOUR: the two probes are DISTINCT inputs through the real rubric — one a real diff section, one null', () => {
    const seen = new Map();
    real({ isHumanGated: (path, hunks) => { seen.set(hunks === null ? 'null' : 'diff', hunks); return true; } });
    expect(seen.get('null')).toBeNull();
    expect(seen.get('diff')).toMatch(/^diff --git a\/.+ b\/.+\n[\s\S]*\n@@ -1 \+1 @@\n- x\n\+ x \n$/);
  });
  it('BEHAVIOUR: a floor gated ONLY on the file having no section of its own (the old empty/null coincidence) is caught by the real-diff probe', () => {
    // A rubric that fires for a leash file only when it has NO diff section: null passes, a real section does not.
    const r = real({ isHumanGated: (path, hunks) => hunks === null });
    expect(r.errors).toHaveLength(LEASH_PIN_SNAPSHOT.length);
    expect(r.errors.every((e) => e.descriptor.hunks === 'whitespace-only')).toBe(true);
  });
  it('BEHAVIOUR: probes the file at its REGISTERED HOME, so a directory-sensitive rubric cannot pass on a bare name', () => {
    const seen = [];
    real({ isHumanGated: (path, hunks) => { seen.push(path); return true; } });
    expect(seen).toContain('scripts/lib/review-policy.contract.json');
    expect(seen).toContain('scripts/lib/__tests__/gate-invariants.test.mjs');
  });
  it('VACUOUS: a pinned file whose registered home is gone from disk (renamed / deleted) is an error, not a silent pass', () => {
    const r = real({ homeExists: (rel) => !rel.endsWith('review-runner-core.mjs') });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('review-runner-core.mjs');
    expect(r.errors[0].message).toMatch(/no registered home on disk/);
    expect(r.errors[0].descriptor.angle).toBe('vacuous');
  });
  it('a missing / empty `specBasenames` is not a crash and not a pass — every pinned file is reported', () => {
    expect(real({ specBasenames: undefined }).errors).toHaveLength(LEASH_PIN_SNAPSHOT.length);
    expect(real({ specBasenames: new Set() }).errors).toHaveLength(LEASH_PIN_SNAPSHOT.length);
  });
  it('the SNAPSHOT is the default pin — omitting `pinned` cannot weaken the rule; an emptied roster + rubric is caught against it', () => {
    expect(checkLeashPin({ specBasenames: POLICY_SPEC_BASENAMES, roster: TRUST_CHAIN, isHumanGated: realGate }).errors).toEqual([]);
    expect(checkLeashPin({ specBasenames: new Set(), roster: [], isHumanGated: () => false }).errors).toHaveLength(LEASH_PIN_SNAPSHOT.length);
  });
});

describe('checkLeashPin — growth is a WARNING, never an error', () => {
  it('a leash file the roster gained but the snapshot does not name is warned about, and does not fail', () => {
    const spec = new Set([...POLICY_SPEC_BASENAMES, 'a-new-contract.json']);
    const roster = [...TRUST_CHAIN, { role: 'x', file: 'a-new-contract.json', tier: 'policy', leash: 'spec', homes: ['scripts/lib/a-new-contract.json'] }];
    const r = real({ specBasenames: spec, roster, homeExists: () => true });
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].message).toContain('a-new-contract.json');
    expect(r.warnings[0].descriptor.angle).toBe('unpinned-growth');
  });
});

describe('the rule is wired into the live gate (source-level guard — running the whole script here would re-run every gate)', () => {
  it('check-standards.mjs imports checkLeashPin and reports its errors and warnings through the gate\'s own channels', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(ROOT, 'scripts', 'check-standards.mjs'), 'utf8');
    expect(src).toMatch(/\bcheckLeashPin\b[^\n]*\n?[^\n]*from '\.\/check-standards-rules\.mjs'|import \{[^}]*\bcheckLeashPin\b[^}]*\} from '\.\/check-standards-rules\.mjs'/);
    expect(src).toContain('checkLeashPin({');
    expect(src).toContain('specBasenames: POLICY_SPEC_BASENAMES');
    expect(src).toContain('roster: TRUST_CHAIN');
    expect(src).toContain('homeExists: (rel) => existsSync(join(ROOT, rel))');   // omitting it silently disables the vacuity check
    expect(src).toContain('scoreEscalation(');
    expect(src).toContain('for (const e of pin.errors) err(');
    expect(src).toContain('for (const w of pin.warnings) warn(');
  });
});
