/**
 * @file worker-result.test.mjs — item 117 slice S1: schema, validator, legacy mapping, D1 guard.
 */
/** @repo-scanning-test scope=full — see scripts/lib/repo-scan-tests.mjs (reads every skills-src brief; verify runs it when a brief changes, #3887). */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import {
  WORKER_RESULT_SCHEMA, BLOCKER_KINDS, validateWorkerResult, parseWorkerResult, validateAgainstSchema, strictModeProblems,
  mapLegacyOutcome, guardBlockerKind, unparseableOutcome, abortedOutcome,
} from '../worker-result.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const done = (over = {}) => ({ v: 1, outcome: 'done', summary: 'ok', blocker: null, findingsAddressed: [], filesTouched: [], learning: null, ...over });
const blocker = (over = {}) => ({
  kind: 'gate-red', component: 'check:standards', evidence: { text: 'red', refs: [] }, proposedFix: null, ruling: null,
  deniedCommand: null, retryable: true, ...over,
});
const blocked = (b) => done({ outcome: 'blocked', blocker: blocker(b) });

/** fix-4228 (job 33680d94) rewritten as v1: the worker said "decision", the truth was a tooling defect. */
const FIX_4228 = blocked({
  kind: 'needs-ruling', component: 'guard-lane daemon-clone registry',
  evidence: { text: 'The guard denied every push: a stale daemon-clone registry record makes the lane look foreign.', refs: ['job 33680d94', 'PR #4228'] },
  proposedFix: { summary: 'Prune the stale daemon-clone registry record and make the guard self-heal it.', scope: ['we:scripts/guard-lane.mjs', 'we:scripts/lane-registry.mjs'], size: 3 },
  ruling: { question: 'Should the stale registry record be fixed?', options: ['A fix the registry guard', 'B do not fix, retry later'], recommendation: 'A, because every push is denied' },
  retryable: false,
});

describe('schema file', () => {
  it('(a) is strict-mode clean: every object has additionalProperties:false and required = all keys', () => {
    expect(strictModeProblems(WORKER_RESULT_SCHEMA)).toEqual([]);
  });
  it('the strict-mode lint actually catches a narrower required', () => {
    const bad = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string' }, b: { type: 'string' } } };
    expect(strictModeProblems(bad)).toHaveLength(1);
    expect(strictModeProblems({ type: 'object', required: [], properties: {} })).toHaveLength(1);
  });
  it('keeps contract-violation out of the worker-declarable kinds', () => {
    expect(BLOCKER_KINDS).not.toContain('contract-violation');
    expect(BLOCKER_KINDS).toHaveLength(9);
  });
});

describe('validateWorkerResult', () => {
  it('accepts a minimal done result and a full blocked one', () => {
    expect(validateWorkerResult(done()).ok).toBe(true);
    expect(validateWorkerResult(blocked()).ok).toBe(true);
  });
  it('(b) fix-4228 replay validates, and the D1 guard maps it to tooling-defect (not the operator)', () => {
    const v = validateWorkerResult(FIX_4228, { role: 'fix' });
    expect(v.ok).toBe(true);
    const g = guardBlockerKind(v.result);
    expect(g.result.blocker.kind).toBe('tooling-defect');
    expect(g.result.blocker.ruling).toBeNull();
    expect(g.reroute).toMatchObject({ from: 'needs-ruling', to: 'tooling-defect' });
    expect(guardBlockerKind(g.result).reroute).toBeNull();
  });
  it('rejects unknown keys, missing keys, wrong types, bad enums and unknown versions', () => {
    expect(validateWorkerResult({ ...done(), extra: 1 }).ok).toBe(false);
    const { learning, ...missing } = done();
    expect(validateWorkerResult(missing).problems).toContain('$.learning: required');
    expect(validateWorkerResult(done({ summary: 5 })).ok).toBe(false);
    expect(validateWorkerResult(done({ outcome: 'unparseable' })).ok).toBe(false);
    expect(validateWorkerResult(done({ v: 2 })).problems[0]).toMatch(/unknown version/);
    expect(validateWorkerResult(blocked({ kind: 'contract-violation' })).ok).toBe(false);
    expect(validateWorkerResult(null).ok).toBe(false);
    expect(validateWorkerResult([]).ok).toBe(false);
  });
  it('blocked <=> blocker', () => {
    expect(validateWorkerResult(done({ outcome: 'blocked' })).problems.join()).toMatch(/blocker: required/);
    expect(validateWorkerResult(done({ blocker: blocker() })).problems.join()).toMatch(/must be null/);
  });
  it('needs-ruling <=> a ruling with at least 2 options', () => {
    expect(validateWorkerResult(blocked({ kind: 'needs-ruling' })).problems.join()).toMatch(/ruling: required/);
    const one = { question: 'q', options: ['A'], recommendation: 'A' };
    expect(validateWorkerResult(blocked({ kind: 'needs-ruling', ruling: one })).problems.join()).toMatch(/at least 2/);
    expect(validateWorkerResult(blocked({ ruling: { ...one, options: ['A', 'B'] } })).problems.join()).toMatch(/ruling: must be null/);
  });
  it('role rules: a fix that is done needs a fixed finding; a build that is done needs files', () => {
    expect(validateWorkerResult(done(), { role: 'fix' }).ok).toBe(false);
    const fixed = done({ findingsAddressed: [{ ref: 'F-abc123', disposition: 'fixed', note: '' }] });
    expect(validateWorkerResult(fixed, { role: 'fix' }).ok).toBe(true);
    expect(validateWorkerResult(done(), { role: 'build' }).ok).toBe(false);
    expect(validateWorkerResult(done({ filesTouched: ['a/b.mjs'] }), { role: 'build' }).ok).toBe(true);
    expect(validateWorkerResult(done(), { role: 'review' }).ok).toBe(true);
  });
  it('fails closed on an unknown or mis-cased role instead of skipping the role rules', () => {
    expect(validateWorkerResult(done(), { role: 'Fix' }).problems.join()).toMatch(/unknown role/);
    expect(validateWorkerResult(done(), { role: 'fixer' }).ok).toBe(false);
  });
  it('enforces length caps and repo-relative file paths', () => {
    expect(validateWorkerResult(done({ summary: 'x'.repeat(281) })).ok).toBe(false);
    expect(validateWorkerResult(done({ filesTouched: ['/etc/passwd'] })).ok).toBe(false);
    expect(validateWorkerResult(done({ filesTouched: ['../x'] })).ok).toBe(false);
    expect(validateWorkerResult(blocked({ evidence: { text: 'x'.repeat(2001), refs: [] } })).ok).toBe(false);
    expect(validateWorkerResult(done({ findingsAddressed: [{ ref: '  ', disposition: 'fixed', note: '' }] })).ok).toBe(false);
    expect(validateWorkerResult(done({ findingsAddressed: [{ ref: 'x'.repeat(301), disposition: 'fixed', note: '' }] })).ok).toBe(false);
    expect(validateWorkerResult(done({ findingsAddressed: [{ ref: 'F1', disposition: 'fixed', note: 'n'.repeat(301) }] })).ok).toBe(false);
  });
  it('deniedCommand is permission-wall only and is sanitized on the returned copy', () => {
    expect(validateWorkerResult(blocked({ deniedCommand: 'ls' })).ok).toBe(false);
    const v = validateWorkerResult(blocked({ kind: 'permission-wall', deniedCommand: 'curl https://u:p@host/x --token ghp_abcdefghijklmnop' }));
    expect(v.ok).toBe(true);
    expect(v.result.blocker.deniedCommand).not.toMatch(/ghp_|u:p@/);
  });
  it('never mutates its input', () => {
    const input = blocked({ kind: 'permission-wall', deniedCommand: 'ls `x`' });
    const copy = structuredClone(input);
    validateWorkerResult(input);
    expect(input).toEqual(copy);
  });
  it('parseWorkerResult fails closed on invalid JSON', () => {
    expect(parseWorkerResult('{not json').ok).toBe(false);
    expect(parseWorkerResult(JSON.stringify(done())).ok).toBe(true);
  });
  it('the schema interpreter handles the nested paths it reports', () => {
    expect(validateAgainstSchema(WORKER_RESULT_SCHEMA, blocked({ evidence: { text: 1, refs: [2] } }))).toEqual(
      expect.arrayContaining(['$.blocker.evidence.text: expected string, got integer', '$.blocker.evidence.refs[0]: expected string, got integer']));
  });
});

describe('D1 reroute guard', () => {
  const ruling = (options, scope = []) => blocked({
    kind: 'needs-ruling', ruling: { question: 'q', options, recommendation: options[0] },
    proposedFix: scope.length ? { summary: 's', scope, size: 1 } : null,
  });
  const kind = (r) => guardBlockerKind(validateWorkerResult(r).result).result.blocker.kind;
  it('reroutes on code paths in proposedFix.scope', () => {
    expect(kind(ruling(['Ship it as is', 'Rework the layout'], ['we:scripts/x.mjs']))).toBe('tooling-defect');
  });
  it('reroutes when the options are only fix / do-not-fix', () => {
    expect(kind(ruling(['A: fix the hook', "B: don't fix"]))).toBe('tooling-defect');
  });
  it('keeps a genuine taste call', () => {
    expect(kind(ruling(['A: a dense table', 'B: card grid'], ['we:docs/design-note.md']))).toBe('needs-ruling');
    expect(kind(ruling(['Rename it to Panel', 'Keep Dialog']))).toBe('needs-ruling');
  });
  it('leaves other kinds and non-blocked results alone', () => {
    expect(guardBlockerKind(done()).reroute).toBeNull();
    expect(guardBlockerKind(blocked({ kind: 'gate-red', proposedFix: { summary: 's', scope: ['we:scripts/x.mjs'], size: 1 } })).reroute).toBeNull();
    expect(guardBlockerKind(null).reroute).toBeNull();
  });
});

describe('fail-closed envelope outcomes (D6)', () => {
  it('unparseable is a contract-violation with a dedupe signature and bounded evidence', () => {
    const u = unparseableOutcome({ role: 'fix', launcher: 'claude-p', reason: 'reaper-kill', transcriptPath: '/t.jsonl', prose: `${'x'.repeat(900)}END` });
    expect(u.outcome).toBe('unparseable');
    expect(u.blocker.kind).toBe('contract-violation');
    expect(u.signature).toBe('fix|claude-p|reaper-kill');
    expect(u.blocker.evidence.text).toMatch(/transcript: \/t\.jsonl/);
    expect(u.blocker.evidence.text.length).toBeLessThanOrEqual(2000);
    expect(unparseableOutcome({ role: 'fix', launcher: 'agy', reason: 'made-up' }).signature).toBe('fix|agy|schema-violation');
  });
  it('the prose tail kept as evidence is redacted and single-line (never routed, never a secret)', () => {
    const u = unparseableOutcome({ role: 'fix', launcher: 'codex-exec', reason: 'timeout', prose: 'env dump\nGITHUB_TOKEN=ghp_abcdefghijklmnop1234\ncurl https://u:pw@host/x' });
    expect(u.blocker.evidence.text).not.toMatch(/ghp_|u:pw@/);
    expect(u.blocker.evidence.text.split('\n').filter((l) => l.startsWith('last prose:'))[0]).not.toMatch(/env dump\n/);
    expect(u.blocker.evidence.text).not.toMatch(/last prose:[^\n]*\n/);
    expect(u.blocker.evidence.text).toMatch(/reason: timeout/);
  });
  it('an operator stop is aborted and carries no signature, so no product-fix job', () => {
    expect(abortedOutcome({ role: 'fix', launcher: 'claude-bg' })).toMatchObject({ outcome: 'aborted', blocker: null, signature: null });
  });
});

describe('(c) legacy outcome mapping is total over the briefs', () => {
  const files = [];
  const walk = (dir) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/-brief[^/]*\.md$/.test(p)) files.push(p); } };
  walk(join(ROOT, 'skills-src'));
  const words = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/--outcome=(<[^>\s]+>|[A-Za-z][A-Za-z-]*)/g)) {
      const raw = m[1];
      if (raw.startsWith('<')) { if (raw.includes('|')) raw.slice(1, -1).split('|').forEach((w) => words.add(w)); continue; } // `<outcome>` is a template slot
      if (!raw.endsWith('-')) words.add(raw);
    }
  }
  it('finds the brief files and a sensible number of words', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(words.size).toBeGreaterThanOrEqual(15);
  });
  it('maps every --outcome= value used in skills-src/**/*-brief*.md', () => {
    const unmapped = [...words].filter((w) => !mapLegacyOutcome(w));
    expect(unmapped).toEqual([]);
  });
  it('maps every word of the delivery-report, fix-report and PR-marker vocabularies too', () => {
    for (const w of ['done', 'blocked', 'needs-human-judgment', 'fixed', 'escalated-needs-judgment', 'escalated-conflict', 'pushed', 'no-change', 're-blocked']) {
      expect(mapLegacyOutcome(w), w).not.toBeNull();
    }
  });
  it('lands on the section-4 table', () => {
    const kinds = (w) => mapLegacyOutcome(w).kind;
    expect(kinds('blocked-on-permission')).toBe('permission-wall');
    expect(kinds('blocked-on-infra')).toBe('infra-transient');
    expect(kinds('blocked-on-load-flake')).toBe('host-load');
    expect(kinds('waiting-on-system-fix')).toBe('tooling-defect');
    expect(kinds('escalated-rearm-refused')).toBe('tooling-defect');
    expect(kinds('escalated-conflict')).toBe('conflict');
    expect(kinds('gate-red')).toBe('gate-red');
    for (const w of ['needs-human', 'needs-human-judgment', 'escalated-needs-human', 'escalated-needs-judgment']) expect(kinds(w)).toBe('needs-ruling');
    expect(mapLegacyOutcome('healed')).toMatchObject({ outcome: 'done', kind: null });
    expect(mapLegacyOutcome('not-a-ci-break').outcome).toBe('not-applicable');
  });
  it('maps every kind a mapping can emit into the schema enum', () => {
    for (const w of words) { const m = mapLegacyOutcome(w); if (m.kind) expect(BLOCKER_KINDS).toContain(m.kind); }
  });
  it('splits a bare blocked on files touched and rejects unknown or missing words (fail closed)', () => {
    expect(mapLegacyOutcome('blocked').kind).toBe('spec-defect');
    expect(mapLegacyOutcome('blocked', { filesTouched: ['a.mjs'] }).kind).toBe('gate-red');
    expect(mapLegacyOutcome('banana')).toBeNull();
    expect(mapLegacyOutcome('unreported')).toBeNull();
    expect(mapLegacyOutcome(undefined)).toBeNull();
    expect(mapLegacyOutcome('constructor')).toBeNull();
  });
});
