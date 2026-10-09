/**
 * @file skills-src/conveyor/__tests__/scratch-dir-rule.test.mjs
 * @description Grep-shaped proof (WE #3444) that a dispatched agent's standing identity and the two briefs
 *   built from it all tell it where scratch files belong. Four sessions independently wedged writing an
 *   ephemeral file (a commit-message file, a captured gate log) into their own harness-provided job-scratch
 *   directory (`~/.claude/jobs/<id>/tmp/`), which Claude Code can flag as a sensitive-file write and produce
 *   a permission prompt nobody is present to answer. These are markdown prompt templates, not executable
 *   code, so the proof is textual: each file must both name the job-scratch/`/tmp` hazard and direct scratch
 *   writes into the lane clone instead.
 *
 *   Also home of the resolve-ordering proof (WE #3468): the delivery-agent brief must resolve the card
 *   exactly once, in the lane, at step 8 just before the commit — never at the gate (step 5), and never
 *   described as something that happens only after the daemon merges. Same grep-shaped style: the brief is
 *   a markdown template, so the proof reads its text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');

describe('dispatched-agent-system-prompt.md — the standing rule', () => {
  const text = read('../dispatched-agent-system-prompt.md');

  it('names the job-scratch directory (and /tmp) as a write hazard', () => {
    expect(text).toMatch(/job-scratch directory/);
    expect(text).toMatch(/`\/tmp`/);
    expect(text).toMatch(/~\/\.claude\/jobs\/<session-id>\/tmp\//);
  });

  it('directs ephemeral writes into the lane clone instead', () => {
    expect(text).toMatch(/lane clone you acquire in your own\s+first step/);
  });
});

describe('delivery-agent-brief.md — step 8 msgfile site', () => {
  const text = read('../delivery-agent-brief.md');

  it('points <msgfile> at the lane, not the job-scratch dir', () => {
    expect(text).toMatch(/<msgfile> MUST live inside \$LANE/);
    expect(text).toMatch(/~\/\.claude\/jobs\/<id>\/tmp\//);
  });
});

describe('review-agent-system-prompt.md — the review-side standing rule (#xy8di3v)', () => {
  const text = read('../../review/review-agent-system-prompt.md');

  it('names the job-scratch directory (and /tmp) as a write hazard', () => {
    expect(text).toMatch(/job-scratch directory/);
    expect(text).toMatch(/`\/tmp`/);
    expect(text).toMatch(/~\/\.claude\/jobs\/<session-id>\/tmp\//);
  });

  it('directs ephemeral writes into the lane clone instead', () => {
    expect(text).toMatch(/lane clone you acquire in your own\s+first step/);
  });
});

describe('review-agent-brief.md — the review-side twin of the rule', () => {
  const text = read('../../review/review-agent-brief.md');

  it('states the same job-scratch/tmp rule directly in its own prose', () => {
    expect(text).toMatch(/job-scratch directory/);
    expect(text).toMatch(/`\/tmp`/);
  });

  it('points at the standing system prompt as the source of the "real, not a template" doctrine (#xy8di3v — '
    + 'review dispatch now carries one, so the brief no longer claims it does not)', () => {
    expect(text).toMatch(/--append-system-prompt-file/);
    expect(text).toMatch(/review-agent-system-prompt\.md/);
  });

  it('directs ephemeral writes into the lane clone acquired in step 1', () => {
    expect(text).toMatch(/inside the lane clone you acquire in step 1/);
  });
});

describe('delivery-agent-brief.md — resolve rides the PR, never runs before the work is built (#3468)', () => {
  const text = read('../delivery-agent-brief.md');
  // Split on the numbered arc headings ("### 5. Run the gate…"), so each step is asserted on its own text and a
  // stray mention elsewhere (the cross-locus section, the guardrails) cannot satisfy or break the ordering check.
  const stepBody = (n) => {
    const m = text.match(new RegExp(`^### ${n}\\. [^\\n]*\\n([\\s\\S]*?)(?=^### \\d+\\. |^## )`, 'm'));
    expect(m, `step ${n} heading not found in the brief`).not.toBeNull();
    return m[1];
  };
  const RESOLVE_CALL = /run\.mjs resolve --ref=\{\{ITEM_NUM\}\}/;

  it('step 5 (the gate) does NOT run resolve — nothing is built, converged or committed yet', () => {
    const step5 = stepBody(5);
    expect(step5).not.toMatch(RESOLVE_CALL);
    expect(step5).not.toMatch(/Then resolve/);
  });

  it('the brief runs `run.mjs resolve` exactly once, and it is in step 8', () => {
    const calls = text.match(new RegExp(RESOLVE_CALL.source, 'g')) ?? [];
    expect(calls).toHaveLength(1);
    expect(stepBody(8)).toMatch(RESOLVE_CALL);
  });

  it('within step 8 the resolve comes BEFORE the commit, so the flip rides the one commit and the PR', () => {
    const step8 = stepBody(8);
    const resolveAt = step8.search(RESOLVE_CALL);
    const commitAt = step8.search(/git commit -F/);
    expect(resolveAt).toBeGreaterThanOrEqual(0);
    expect(commitAt).toBeGreaterThan(resolveAt);
  });

  it('states the doctrine it follows: claim and resolve both ride the PR, and only when every acceptance item holds', () => {
    const step8 = stepBody(8);
    expect(step8).toMatch(/resolve rides the SAME PR/);
    expect(step8).toMatch(/only if every `## Acceptance` item/);
  });

  it('the guardrails no longer place resolve after the daemon merge', () => {
    expect(text).not.toMatch(/daemon merge →\s+resolve/);
    expect(text).toMatch(/Never resolve before the work is built, converged and about to be committed/);
  });
});
