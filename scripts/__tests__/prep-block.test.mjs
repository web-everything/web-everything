import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrepExempt, logPrepEvent, parsePrep, prepVerdict } from '../lib/prep-block.mjs';

const prep = 'PREP:\nAcceptance: observable outcome\nPre-mortem: parser may fail\nFiles: scripts/example.mjs\nTests: focused unit tests';

describe('prep block', () => {
  it('names all missing headings and shows both formats', () => {
    expect(parsePrep('')).toEqual({ present: false, waived: false, waiverReason: '', missing: ['Acceptance', 'Pre-mortem', 'Files', 'Tests'], empty: [] });
    expect(prepVerdict('').reason).toMatch(/Acceptance:[\s\S]*Pre-mortem:[\s\S]*Files:[\s\S]*Tests:[\s\S]*prep: waived — <reason>/);
    expect(prepVerdict('').ok).toBe(false);
  });
  it('accepts all four populated headings', () => {
    expect(prepVerdict(prep)).toEqual({ ok: true, reason: '', waived: false });
  });
  it('refuses the unchanged documented PREP template verbatim', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = readFileSync(join(here, '../../docs/agent/prep-gate.md'), 'utf8');
    const template = doc.match(/```text\r?\n([\s\S]*?)\r?\n```/)?.[1];
    expect(template).toBeDefined();
    expect(prepVerdict(template).ok).toBe(false);
    expect(parsePrep(template).empty).toEqual(['Acceptance', 'Pre-mortem', 'Files', 'Tests']);
  });
  it.each(['<observable criteria>', '- <observable criteria>', '**<observable criteria>**', '<criteria> <more criteria>'])('rejects angle-bracket placeholder-only item %s', (value) => {
    expect(prepVerdict(prep.replace('observable outcome', value)).ok).toBe(false);
  });
  it('allows concrete prose containing angle brackets', () => {
    expect(prepVerdict(prep.replace('observable outcome', 'render <button> with an accessible name')).ok).toBe(true);
  });
  it('accepts case, markdown prefixes, bullets and continuation items', () => {
    expect(prepVerdict('prep:\n- **aCCeptance:**\n- visible result\n## **PRE-MORTEM:**\n  likely failure\n**Files:** scripts/example.mjs\n# Tests:\n* focused tests').ok).toBe(true);
  });
  it('reports missing and empty separately', () => {
    const result = parsePrep('PREP:\nAcceptance:\nFiles: scripts/example.mjs');
    expect(result.missing).toEqual(['Pre-mortem', 'Tests']);
    expect(result.empty).toEqual(['Acceptance']);
    expect(prepVerdict('PREP:\nAcceptance:\nFiles: scripts/example.mjs').reason).toContain('empty or placeholder: Acceptance');
  });
  it.each(['tbd', 'TODO', 'n/a', 'none', '-', '...', '**TODO**', 'a b c d e f g', '........'])('rejects placeholder/short item %s', (value) => {
    expect(prepVerdict(prep.replace('observable outcome', value)).ok).toBe(false);
  });
  it('requires headings inside PREP and does not borrow from later unrelated headings', () => {
    expect(prepVerdict(prep.replace('PREP:\n', '')).ok).toBe(false);
    expect(parsePrep('PREP:\nAcceptance:\nSummary: unrelated text\nlong unrelated prose').empty).toEqual(['Acceptance']);
    expect(parsePrep('PREP:\nAcceptance:\n## Summary\nlong unrelated prose').empty).toEqual(['Acceptance']);
  });
  it.each(['—', '–', '-'])('accepts a reasoned waiver with %s', (dash) => {
    expect(prepVerdict(`  PREP: waived ${dash} urgent incident`)).toEqual({ ok: true, reason: 'urgent incident', waived: true });
  });
  it.each(['prep: waived', 'prep: waived —', 'prep: waived — abc', 'prep: waived — a   '])('rejects incomplete waiver %s', (text) => {
    expect(prepVerdict(text).ok).toBe(false);
  });
  it.each(['resolve the conflict', 'resolve conflict', 'merge conflict', 'rebase onto main', 're-run checks', 'rerun CI', 'retrigger', 'red-team', 'redteam', 'review the PR', 'review this PR', 'code review', 'jury', 'read-only', 'do not edit', 'no code changes', 'file a backlog card', 'file the item', 'card-only'])('shares narrow exemption %s', (text) => {
    expect(isPrepExempt(text)).toBe(true);
  });
  it.each(['review parser implementation', 'merge feature', 'cards UI', 'team build', 'run tests'])('does not exempt broad words: %s', (text) => {
    expect(isPrepExempt(text)).toBe(false);
  });
  it('appends timestamped JSON lines and never throws on IO failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prep-log-'));
    try {
      const logPath = join(dir, 'nested', 'events.log');
      logPrepEvent({ kind: 'waiver', detail: 'urgent incident' }, { logPath });
      logPrepEvent({ kind: 'hook-error', detail: 'bad input' }, { logPath });
      const entries = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ ts: expect.any(String), kind: 'waiver', detail: 'urgent incident' });
      expect(Number.isNaN(Date.parse(entries[0].ts))).toBe(false);
      expect(() => logPrepEvent({ kind: 'waiver', detail: 'x' }, { logPath: dir })).not.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
