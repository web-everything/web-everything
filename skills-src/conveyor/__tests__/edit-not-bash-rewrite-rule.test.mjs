/**
 * @file skills-src/conveyor/__tests__/edit-not-bash-rewrite-rule.test.mjs
 * @description Grep-shaped proof (fix for PR #2518, epic #3383) that a dispatched agent is told to use the
 *   Edit/Write tool — never a `Bash` rewrite — to change a tracked file's content, and that a fix agent whose
 *   otherwise-clear repair is denied by a permission/tool-use guard reports `blocked-on-infra` rather than
 *   standing down.
 *
 *   Live incident, 2026-09-23 (PR #2518, `web-everything/web-everything`, fix session `fix-2518`): a `python3`
 *   heredoc rewriting `backlog/3945-telemetry-ask-source.md` inside an already-acquired lane clone was denied
 *   — "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Modify Shared
 *   Resources]." — even though Bash itself was fully permitted in that lane, and even though the reviewer's
 *   finding was completely unambiguous. The fix agent then posted the terminal stand-down marker, describing
 *   the denial as needing "human judgment", which stalled a mechanically-clear repair on a person.
 *
 *   These are markdown prompt templates, not executable code, so the proof is textual — same style as
 *   scratch-dir-rule.test.mjs (WE #3444), the sibling incident this one is shaped after.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');

describe('dispatched-agent-system-prompt.md — Edit/Write, never a Bash rewrite', () => {
  const text = read('../dispatched-agent-system-prompt.md');

  it('names the auto-mode classifier hazard for a Bash-based file rewrite', () => {
    expect(text).toMatch(/Modify Shared Resources/);
    expect(text).toMatch(/auto mode classifier/);
  });

  it('directs content changes to the Edit\\/Write tool instead', () => {
    expect(text).toMatch(/Edit\/Write tool/);
    expect(text).toMatch(/never a `Bash` rewrite/);
  });

  it('states the rule applies even inside the agent\'s own lane clone', () => {
    expect(text).toMatch(/EVEN INSIDE your own lane clone/);
  });
});

describe('review-agent-system-prompt.md — the review-side twin of the rule', () => {
  const text = read('../../review/review-agent-system-prompt.md');

  it('names the same auto-mode classifier hazard', () => {
    expect(text).toMatch(/Modify Shared Resources/);
    expect(text).toMatch(/auto mode classifier/);
  });

  it('directs content changes to the Edit\\/Write tool instead', () => {
    expect(text).toMatch(/Edit\/Write tool/);
    expect(text).toMatch(/never a `Bash` rewrite/);
  });
});

describe('fix-agent-brief.md step 3 — Edit/Write for the repair itself', () => {
  const text = read('../fix-agent-brief.md');
  const step3 = text.match(/^### 3\. [^\n]*\n([\s\S]*?)(?=^### 4\. )/m)[1];

  it('instructs the Edit/Write tool for the repair, never a Bash rewrite', () => {
    expect(step3).toMatch(/Edit\/Write tool/);
    expect(step3).toMatch(/never a `Bash`\s*\nrewrite|never a `Bash`\s+rewrite/);
  });

  it('cites the live PR #2518 denial as the concrete evidence', () => {
    expect(step3).toMatch(/PR #2518/);
    expect(step3).toMatch(/\[Modify Shared Resources\]/);
  });
});

describe('fix-agent-brief.md step 3 — permission/tool denial is blocked-on-infra, NOT a stand-down', () => {
  const text = read('../fix-agent-brief.md');
  const step3 = text.match(/^### 3\. [^\n]*\n([\s\S]*?)(?=^### 4\. )/m)[1];

  it('names the denial-while-applying-a-clear-fix case as infrastructure friction, not judgment', () => {
    expect(step3).toMatch(/INFRASTRUCTURE\s*\nFRICTION|INFRASTRUCTURE FRICTION/);
    expect(step3).toMatch(/not a judgment call/i);
  });

  it('reports the completion record with outcome=blocked-on-infra', () => {
    expect(step3).toMatch(/completion-cli\.mjs" report[^\n]*--status=done --outcome=blocked-on-infra/);
  });

  it('returns the structured `→ blocked-on-infra` line hiccup-classify.mjs already recognizes', () => {
    expect(step3).toMatch(/→ blocked-on-infra/);
  });

  it('does NOT call stand-down.mjs for this exit — that script is reserved for a real judgment call', () => {
    // Isolate the denial-exit paragraph from the rest of step 3 (which legitimately calls stand-down.mjs for
    // the ambiguous-finding path described one step earlier, step 2) by anchoring on the exact sentence.
    const denialParagraphStart = step3.indexOf('If applying an otherwise-CLEAR fix is denied');
    expect(denialParagraphStart).toBeGreaterThan(-1);
    const nextHeadingRelative = step3.slice(denialParagraphStart).search(/\n^If `origin\/main` advanced/m);
    const denialParagraph = nextHeadingRelative === -1
      ? step3.slice(denialParagraphStart)
      : step3.slice(denialParagraphStart, denialParagraphStart + nextHeadingRelative);
    // Mentioning stand-down.mjs in prose (to contrast this exit with it) is fine; actually INVOKING it — the
    // shape every real escalation call takes (`node ".../stand-down.mjs" <pr>`) — is not.
    expect(denialParagraph).not.toMatch(/stand-down\.mjs"\s+\{\{PR_NUM\}\}/);
  });

  it('warns against falling back to a Bash rewrite to route around the denial', () => {
    expect(step3).toMatch(/do not fall back to a\s*\nBash rewrite|do not fall back to a Bash rewrite/);
  });
});

describe('fix-agent-brief.md step 9 — the RETURN line names the new outcome', () => {
  const text = read('../fix-agent-brief.md');
  const step9 = text.match(/^### 9\. [^\n]*\n([\s\S]*?)(?=^---)/m)[1];

  it('documents the blocked-on-infra one-line return alongside the existing shapes', () => {
    expect(step9).toMatch(/blocked-on-infra/);
  });
});
