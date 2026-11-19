/**
 * @file scripts/__tests__/conveyor-brief-main-catchup-policy.test.mjs
 * @description #4297 — a lane must catch up with `origin/main` at most once, immediately before the
 * final gate, never speculatively mid-work (the sole sanctioned exception: an active conflict actually
 * blocking the worker's own edits right now). Asserts the four generic worker/fixer procedures actually
 * state this policy, so a future edit cannot silently drop it back to the pre-#4297 (unwritten) state
 * that let a speculative mid-work merge of `main` invalidate the exact-sha-keyed verify marker (#4296)
 * and force a wasted full re-run — the live cost documented in #4294.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './fixtures/check-standards-rules-fixtures.mjs';

const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('delivery brief keeps tests and audit on the single final commit (PR #7085)', () => {
  const body = read('skills-src/conveyor/delivery-agent-brief.md');
  const step7a = body.split(/^### 7a\./m)[1]?.split(/^### 8\./m)[0] ?? '';
  const step8 = body.split(/^### 8\./m)[1]?.split(/^### 9\./m)[0] ?? '';

  it('requires the card to be resolved before step 7a tests the final commit', () => {
    expect(step7a).toContain('On the single final commit (card already resolved per step 8)');
    expect(step7a).not.toMatch(/Commit, then run/i);
  });

  it('states the same resolve, commit, verify, push, audit, PR order in both steps', () => {
    const order = /resolve the card in the lane → make the single commit → run `verify-lane request`\/`check` at that HEAD → push → run `codex-audit` on that exact sha → open the PR/;
    expect(step7a.replace(/\s+/g, ' ')).toMatch(order);
    expect(step8.replace(/\s+/g, ' ')).toMatch(order);
    const commands = [
      'node scripts/operations/run.mjs resolve',
      'git commit -F',
      'node scripts/verify-lane.mjs request',
      'git push origin HEAD:',
      'node scripts/operations/run.mjs codex-audit',
      'node scripts/operations/run.mjs open-pr',
    ].map((command) => step8.indexOf(command));
    expect(commands.every((index) => index >= 0)).toBe(true);
    expect(commands).toEqual([...commands].sort((a, b) => a - b));
  });

  it('invalidates tests and audit if another commit moves HEAD', () => {
    expect(step8).toContain('Any commit after the audit invalidates it: re-run tests and audit on the new HEAD.');
  });
});

describe('conveyor briefs state the at-most-once, right-before-the-gate main-catchup policy (#4297)', () => {
  it('delivery-agent-brief.md: merges main at most once, right before the gate, never speculatively', () => {
    const body = read('skills-src/conveyor/delivery-agent-brief.md');
    expect(body).toMatch(/#4297/);
    expect(body).toMatch(/exactly ONE `origin\/main` touch for the whole build/);
    expect(body).toMatch(/never speculatively/i);
    expect(body).toMatch(/PRESENT conflict/);
  });

  it('delivery-agent-brief.md: step 4a is positioned BEFORE step 5\'s gate, not after', () => {
    const body = read('skills-src/conveyor/delivery-agent-brief.md');
    const idx4a = body.indexOf('### 4a. Catch up with `main` once');
    const idx5 = body.indexOf('### 5. Run the gate GREEN');
    expect(idx4a).toBeGreaterThan(-1);
    expect(idx5).toBeGreaterThan(-1);
    expect(idx4a).toBeLessThan(idx5);
  });

  it('delivery-agent-brief.md: the exception and the normal-case merge are alternatives, never additive', () => {
    // Regression guard for the #4297 round-1 convergence finding: an earlier draft's "at most once" sat
    // right next to an exception that was itself a second merge, so a worker who took the exception could
    // still be told to merge again at the normal-case step — this pins the reconciling language instead.
    const body = read('skills-src/conveyor/delivery-agent-brief.md');
    expect(body).toMatch(/exactly ONE `origin\/main` touch for the whole build — never two/);
    expect(body).toMatch(/alternatives, not additive/i);
    expect(body).toMatch(/skip this step entirely when you reach it/i);
  });

  it('delivery-agent-brief-v2.md: the wrapper owns any catch-up, same at-most-once policy', () => {
    const body = read('skills-src/conveyor/delivery-agent-brief-v2.md');
    expect(body).toMatch(/#4297/);
    expect(body).toMatch(/at most once/i);
    expect(body).toMatch(/never speculatively/i);
  });

  it('fix-agent-brief.md: the conflict-only main touch is capped at most once', () => {
    const body = read('skills-src/conveyor/fix-agent-brief.md');
    expect(body).toMatch(/#4297/);
    expect(body).toMatch(/at most once/i);
    expect(body).toMatch(/never fetch or merge it speculatively/i);
  });

  it('fix-agent-ci-brief.md: the step-2 merge is the one sanctioned catch-up for the whole run', () => {
    const body = read('skills-src/conveyor/fix-agent-ci-brief.md');
    expect(body).toMatch(/#4297/);
    expect(body).toMatch(/ONE sanctioned catch-up with `main` for this whole run/);
    expect(body).toMatch(/[Dd]o NOT merge a second time in this same session/);
  });

  it('fix-agent-ci-brief.md: explains WHY its catch-up is front-loaded instead of gate-adjacent', () => {
    // Regression guard for the #4297 round-1 convergence finding: without this rationale, the ci-heal
    // brief's front-loaded merge (step 2, well before step 4's gate) reads as inconsistent with the other
    // three briefs' right-before-the-gate placement rather than a deliberate, once-only equivalent of it.
    const body = read('skills-src/conveyor/fix-agent-ci-brief.md');
    expect(body).toMatch(/placed FIRST rather than\s+immediately before step 4's gate/);
    expect(body).toMatch(/needs a current base to diagnose against/);
  });
});
