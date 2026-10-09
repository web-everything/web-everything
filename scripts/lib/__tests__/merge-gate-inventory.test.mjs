// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { DRAIN_GATES, GATE_IDS, gateShapedCalls, classifiedCalls, classifiedSkipKinds } from '../merge-gate-inventory.mjs';
import { SKIP_KINDS } from '../drain-skip-reasons.mjs';
import { evaluatePrGates } from '../merge-gate-ci.mjs';

describe('drain gate inventory', () => {
  it('exactly classifies the gate-shaped calls in the drain source', () => {
    const src = readFileSync(new URL('../../merge-ai-prs.mjs', import.meta.url), 'utf8');
    const actual = gateShapedCalls(src);
    const classified = classifiedCalls();
    const difference = {
      unclassified: actual.filter((name) => !classified.includes(name)),
      removed: classified.filter((name) => !actual.includes(name)),
    };
    expect(actual, JSON.stringify(difference)).toEqual(classified);
  });

  it('exactly classifies every drain skip kind', () => {
    expect([...SKIP_KINDS].sort()).toEqual(classifiedSkipKinds());
  });

  it('has unique ids, valid ownership and inputs, and existing tracking cards', () => {
    const files = readdirSync(new URL('../../../backlog/', import.meta.url), { withFileTypes: true });
    expect(new Set(DRAIN_GATES.map((gate) => gate.id)).size).toBe(DRAIN_GATES.length);
    for (const gate of DRAIN_GATES) {
      expect(['merge-gate', 'queue', 'enqueue'], gate.id).toContain(gate.where);
      expect(['github', 'git', 'ledger', 'local-only'], gate.id).toContain(gate.input);
      if (gate.input === 'local-only') expect(gate.card, gate.id).toBeTruthy();
      if (gate.card != null) {
        expect(files.some((file) => file.isFile() && file.name.startsWith(`${gate.card}-`) && file.name.endsWith('.md')), `${gate.id}: backlog/${gate.card}-*.md`).toBe(true);
      }
    }
  });

  it('evaluates each gate exactly once and fails closed without PR facts', () => {
    const result = evaluatePrGates({});
    expect(result.ok).toBe(false);
    expect(new Set(result.results.map((gate) => gate.id))).toEqual(new Set(GATE_IDS));
    expect(result.results).toHaveLength(GATE_IDS.length);
    for (const gate of DRAIN_GATES.filter((gate) => gate.where === 'merge-gate')) {
      expect(result.results.filter((row) => row.id === gate.id)).toEqual([
        expect.objectContaining({ id: gate.id, status: 'fail-closed' }),
      ]);
    }
  });

  it('detects a new unclassified gate call', () => {
    expect(gateShapedCalls('x = decideBrandNewGate(pr)')).toEqual(['decideBrandNewGate']);
    expect(classifiedCalls()).not.toContain('decideBrandNewGate');
  });
});
