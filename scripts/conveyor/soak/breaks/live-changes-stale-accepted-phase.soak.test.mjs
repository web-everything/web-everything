import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import b from './live-changes-stale-accepted-phase.mjs';
import { defineBreakTest } from '../define-break-test.mjs';
defineBreakTest(b);

describe('live changes behavioral fix probe', () => {
  const roots = [];
  const fixtureRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'soak-live-changes-probe-'));
    roots.push(root);
    mkdirSync(join(root, 'scripts/conveyor'), { recursive: true });
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('requires both real reconcile fixtures to pass in the current tree', () => {
    expect(b.fixPresent(fileURLToPath(new URL('../../../../', import.meta.url)))).toBe(true);
  });

  const dispatch = { dispatch: [{ kind: 'fix', prNumber: 1563, phase: 'bounced' }], refusals: [] };
  const note = { kind: 'stood-down', prNumber: 1563, text: 'needs your decision' };
  const held = { dispatch: [], refusals: [{ kind: 'stood-down' }], notes: [note] };

  it.each([
    ['stale phase hides the fixer', { ...dispatch, dispatch: [] }, held],
    ['unanswered stand-down dispatches', dispatch, { ...held, dispatch: dispatch.dispatch }],
    ['missing operator note', dispatch, { ...held, notes: [] }],
    ['duplicate operator notes', dispatch, { ...held, notes: [note, note] }],
    ['incomplete planner output', {}, {}],
  ])('rejects %s in the requested tree', (_name, stalePlan, heldPlan) => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), `
      export function planReconcile({ prs: [pr] }) {
        return pr.comments.length === 2 ? ${JSON.stringify(stalePlan)} : ${JSON.stringify(heldPlan)};
      }
    `);
    expect(b.fixPresent(root)).toBe(false);
  });

  it('fails closed when the requested tree has no readable planner', () => {
    expect(b.fixPresent(fixtureRoot())).toBe(false);
  });

  it('fails closed when the requested planner throws', () => {
    const root = fixtureRoot();
    writeFileSync(join(root, 'scripts/conveyor/reconcile-core.mjs'), `
      export function planReconcile() { throw new Error('unavailable evidence'); }
    `);
    expect(b.fixPresent(root)).toBe(false);
  });
});
