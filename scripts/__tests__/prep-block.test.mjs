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
  it.each(['PREP:', '## PREP:', '**PREP:**', '- PREP:', '* PREP:', '+ PREP:', '## - **pReP:**'])('accepts start marker %s with or without trailing text', (marker) => {
    for (const suffix of ['', ' implementation plan']) {
      const text = prep.replace('PREP:', marker + suffix);
      expect(parsePrep(text)).toEqual({ present: true, waived: false, waiverReason: '', missing: [], empty: [] });
      expect(prepVerdict(text)).toEqual({ ok: true, reason: '', waived: false });
    }
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
  it.each(['- npm test: unit suite', 'npm test: unit suite', 'Summary: focused unit suite', '##Summary', '####### Summary'])('counts %s as section content', (content) => {
    const text = prep.replace('Tests: focused unit tests', `Tests:\n${content}`);
    expect(parsePrep(text)).toEqual({ present: true, waived: false, waiverReason: '', missing: [], empty: [] });
    expect(prepVerdict(text)).toEqual({ ok: true, reason: '', waived: false });
  });
  it.each(['# Summary', '## Summary', '### Summary', '#### Summary', '##### Summary', '###### Summary', '  ## Summary'])('ends Tests at unrelated markdown heading %s without borrowing following prose', (heading) => {
    const text = prep.replace('Tests: focused unit tests', `Tests:\n${heading}\nUnrelated summary prose`);
    expect(parsePrep(text)).toEqual({ present: true, waived: false, waiverReason: '', missing: [], empty: ['Tests'] });
    expect(prepVerdict(text)).toEqual({ ok: false, reason: expect.stringContaining('empty or placeholder: Tests'), waived: false });
  });
  it('keeps populated Tests valid when followed by a summary heading', () => {
    expect(prepVerdict(`${prep}\n## Summary\nUnrelated summary prose`)).toEqual({ ok: true, reason: '', waived: false });
  });
  it.each(['Acceptance', 'Pre-mortem', 'Files', 'Tests'])('recognizes markdown %s as a PREP heading before applying the section boundary', (heading) => {
    const result = parsePrep(`PREP:\n## **${heading}:**\nConcrete continuation content`);
    expect(result).toEqual({ present: true, waived: false, waiverReason: '', empty: [],
      missing: ['Acceptance', 'Pre-mortem', 'Files', 'Tests'].filter((name) => name !== heading) });
  });
  it.each(['Acceptance', 'Pre-mortem', 'Files', 'Tests'])('ends the preceding section at the known %s heading', (heading) => {
    const previous = heading === 'Acceptance' ? 'Tests' : 'Acceptance';
    const result = parsePrep(`PREP:\n${previous}:\n${heading}: concrete section content`);
    expect(result.empty).toEqual([previous]);
    expect(result.missing).toEqual(['Acceptance', 'Pre-mortem', 'Files', 'Tests'].filter((name) => name !== previous && name !== heading));
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
  it('requires headings inside PREP and does not borrow content across a new PREP line', () => {
    expect(prepVerdict(prep.replace('PREP:\n', '')).ok).toBe(false);
    expect(parsePrep('PREP:\nAcceptance:\nPREP:\nSummary: unrelated text\nlong unrelated prose').empty).toEqual(['Acceptance']);
    expect(parsePrep('PREP:\nAcceptance:\nprep: another block\n## Summary\nlong unrelated prose').empty).toEqual(['Acceptance']);
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
  it.each(['implement X, rerun the tests, then open-pr', 'build X, re-run the tests, then open-pr',
    'add a jury feature', 'add code for read-only access', 'add a code review guard', 'add a rerun function'])('build instructions override exemption words: %s', (text) => {
    expect(isPrepExempt(text)).toBe(false);
  });
  it.each(['implement', 'build', 'add', 'fix', 'refactor', 'write'])('gives %s precedence over incidental exemptions', (verb) => {
    for (const phrase of ['code review guard', 'jury', 'read-only access', 're-run helper', 'merge conflict detector', 'card-only workflow']) {
      expect(isPrepExempt(`${verb} ${phrase}`)).toBe(false);
    }
  });
  it.each(['fix merge conflict', 'fix the merge conflict', 'resolve conflict', 'resolve the conflict',
    'resolve merge conflict', 'resolve the merge conflict', 'rebase onto main', 're-run CI', 'rerun CI',
    'retrigger CI', 'file a backlog card', 'file the item', 'card-only', 'review the PR', 'review this PR', 'code review'])('keeps explicit leading exempt task despite build words: %s', (task) => {
    expect(isPrepExempt(`${task}; inspect the fix`)).toBe(true);
    expect(isPrepExempt(`implement a guard for ${task}`)).toBe(false);
  });
  it.each(['red-team; fix', 'jury; refactor', 'read-only; write', 're-run checks; fix',
    'retrigger jobs; build', 'merge conflict; fix', 'file a task; fix', 'review parser; fix',
    'fix conflict', 'review fixes'])('does not widen the task allowlist: %s', (text) => {
    expect(isPrepExempt(text)).toBe(false);
  });
  it.each(['', '   ', '.', '!', '?', ',', ';', ':', ' and open-pr', ' then open-pr'])('allows conflict resolution with task boundary %j', (suffix) => {
    expect(isPrepExempt(`fix merge conflict${suffix}`)).toBe(true);
  });
  it.each([' detector', ' guard', '-detector', 's'])('refuses conflict-related builds with suffix %j', (suffix) => {
    expect(isPrepExempt(`fix merge conflict${suffix}`)).toBe(false);
  });
  it.each([undefined, null, 123, {}])('does not exempt non-string input %j', (text) => {
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
