/**
 * @file invariant-catalogue-guard-lane-sync.test.mjs — pins the `guard-lane.denies-primary-tree-edit`
 * catalogue entry (scripts/lib/invariant-catalogue.json) against what scripts/guard-lane.mjs actually does.
 *
 * WHY THIS FILE (#2936). The catalogue's own enforcer-link gate (`validateInvariantEnforcers` in
 * validate-rules-anchors.cjs) only checks that `howChecked` names a code path that EXISTS — it never reads
 * what that code path DOES. That let the catalogue keep asserting an agent-memory exemption for six weeks
 * after #2986 removed it from scripts/guard-lane.mjs: the entry was "enforced" and its cite resolved, while
 * the guard it described had already started denying the exact edit the catalogue promised was allowed. This
 * suite closes that gap for the one entry that drifted, by asserting the SEMANTIC claim (not just the link)
 * against the guard's real decision.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { laneGuardDecision } from '../../guard-lane.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const catalogue = JSON.parse(readFileSync(join(ROOT, 'scripts', 'lib', 'invariant-catalogue.json'), 'utf8'));
const guardSrc = readFileSync(join(ROOT, 'scripts', 'guard-lane.mjs'), 'utf8');

const entry = catalogue.invariants.find((inv) => inv.id === 'guard-lane.denies-primary-tree-edit');

describe('invariant-catalogue guard-lane.denies-primary-tree-edit stays in sync with the guard (#2936)', () => {
  it('the entry exists and is still marked enforced', () => {
    expect(entry).toBeTruthy();
    expect(entry.status).toBe('enforced');
  });

  it('the guard denies a primary agent-memory-tree edit — proving the code grants NO exemption', () => {
    // Real shape: <workspace>/webeverything/agent-memory-src/foo.md — a primary-tree memory path.
    const workspace = '/ws';
    const weRoot = join(workspace, 'webeverything');
    const memoryFile = join(weRoot, 'agent-memory-src', 'foo.md');
    const decision = laneGuardDecision(memoryFile, weRoot, {});
    expect(decision).not.toBeNull(); // denied, not allowed
  });

  it('the statement does NOT claim an agent-memory (or any) exemption the code does not grant', () => {
    // The failure this test exists to catch: a claimed "except ... exempt" carve-out with no matching
    // early-return in the guard. Fails LOUD if the catalogue regresses to the stale wording (or a new one).
    const claimsExemption = /except[^.]*exempt/i.test(entry.statement);
    expect(claimsExemption).toBe(false);
  });

  it('howChecked names the classification term the code actually declares (isMemory, not a removed inAgentMemory)', () => {
    expect(entry.howChecked).not.toMatch(/inAgentMemory/);
    const terms = entry.howChecked.match(/\b(?:is|in)[A-Z]\w*\b/g) || [];
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(guardSrc, `howChecked names "${term}", which guard-lane.mjs must declare`).toMatch(
        new RegExp(`\\b(?:const|let)\\s+${term}\\b`),
      );
    }
  });
});
