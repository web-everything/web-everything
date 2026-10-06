/**
 * @file scripts/conveyor/__tests__/hiccup-classify.test.mjs
 * @description Unit proof of the #3421 hiccup classifier — pure, no I/O. Pins the two named regression
 *   fixtures from #3422's own discussion: the #3416 guard-suppression case (a live dispatch guard held a
 *   launch) and the #3412 free-form-question case (a dispatched agent returned prose instead of a
 *   predefined structured response) — plus the #3421 addendum's confidence/blacklist axis for a
 *   missing-operation finding: clean-self-clears, flagged-criterion-batches, blacklisted-call-escalates.
 */
import { describe, it, expect } from 'vitest';
import {
  isStructuredReturn, classifySuppressedBuilds, classifyAgentReturn,
  assessMissingOperationConfidence, isBlacklistedOperation, CONFIDENCE_CRITERIA, DEFAULT_OPERATION_BLACKLIST,
} from '../hiccup-classify.mjs';

describe('classifySuppressedBuilds — #3416 guard-suppression fixture', () => {
  it('classifies a tick-core suppressedBuilds entry as a blocking guard-suppression hiccup', () => {
    const hiccups = classifySuppressedBuilds([{ num: 3416, lane: 5, by: 'num' }]);
    expect(hiccups).toHaveLength(1);
    expect(hiccups[0]).toMatchObject({ kind: 'guard-suppression', blocking: true, num: 3416, lane: 5, by: 'num' });
    expect(hiccups[0].proposedFix).toContain('3416');
  });

  it('one record per suppressed entry, and an empty/absent list classifies to nothing', () => {
    expect(classifySuppressedBuilds([{ num: 1, lane: 2, by: 'lane' }, { num: 3, lane: 4, by: 'num' }])).toHaveLength(2);
    expect(classifySuppressedBuilds([])).toEqual([]);
    expect(classifySuppressedBuilds(undefined)).toEqual([]);
    expect(classifySuppressedBuilds(null)).toEqual([]);
  });

  it('drops a malformed entry with no num rather than throwing', () => {
    expect(classifySuppressedBuilds([{ lane: 5, by: 'lane' }])).toEqual([]);
  });
});

describe('classifyAgentReturn — #3412 free-form-question fixture', () => {
  it('classifies an unstructured free-form return as a blocking hiccup', () => {
    const h = classifyAgentReturn({ num: 3412, text: 'What would you like me to do here?' });
    expect(h).toMatchObject({ kind: 'free-form-response', blocking: true, num: 3412 });
    expect(h.proposedFix).toContain('3412');
  });

  it('a recognized structured one-line return classifies to null (not a hiccup)', () => {
    expect(classifyAgentReturn({ num: 10, text: '#10 → PR #42 (ready-to-merge)' })).toBeNull();
    expect(classifyAgentReturn({ num: 10, text: '#10 → not-ready (stale/superseded)' })).toBeNull();
    expect(classifyAgentReturn({ num: 10, text: '#10 → blocked-on-infra (github outage)' })).toBeNull();
    expect(classifyAgentReturn({ num: 10, text: '#10 → escalated review:human' })).toBeNull();
    expect(classifyAgentReturn({ num: 10, text: '#10 → gate-red' })).toBeNull();
  });

  it('empty/absent text is nothing to classify yet, not a hiccup', () => {
    expect(classifyAgentReturn({ num: 10, text: '' })).toBeNull();
    expect(classifyAgentReturn({ num: 10 })).toBeNull();
    expect(classifyAgentReturn(undefined)).toBeNull();
  });

  it('isStructuredReturn matches case-insensitively and rejects plain prose', () => {
    expect(isStructuredReturn('#3 → pr #7 (ready-to-merge)')).toBe(true);
    expect(isStructuredReturn('I think this PR looks fine to me')).toBe(false);
  });

  // PR #2518 / #3945 (2026-09-23) — the fix-agent-brief's new escalation exit (a permission/tool-use denial
  // applying an otherwise-clear fix) returns this exact shape instead of standing down. It must read as a
  // KNOWN structured return, same as every other brief exit, so a dispatched fixer using it is never flagged
  // as the #3412 free-form-response hiccup.
  it('recognizes the fix-agent-brief\'s new tool/permission-denial exit as a KNOWN structured return', () => {
    const text = '#3945 → blocked-on-infra (tool/permission denial applying an otherwise-clear fix on PR #2518)';
    expect(isStructuredReturn(text)).toBe(true);
    expect(classifyAgentReturn({ num: 3945, text })).toBeNull();
  });

  // PR #3990 review (correctness): the brief tells a fixer to return `#N → blocked-on-permission (<denied
  // command>)`, and nothing defended the widened `blocked-on-(?:infra|permission)` pattern — a regression to
  // `infra` only would file a spurious hiccup for every permission denial.
  it('recognizes the fix-agent-brief\'s `blocked-on-permission` return (with its denied-command detail) as KNOWN', () => {
    const text = '#1 → blocked-on-permission (git checkout --theirs f)';
    expect(isStructuredReturn(text)).toBe(true);
    expect(classifyAgentReturn({ num: 1, text })).toBeNull();
    const briefLine = '# → blocked-on-permission (tool/permission denial applying an otherwise-clear fix on PR #3990)';
    expect(isStructuredReturn(briefLine)).toBe(true);
  });

  it.each(['blocked-on-infra', 'blocked-on-permission'])('recognizes `→ %s` in every spacing/case the brief can emit', (word) => {
    for (const text of [`#7 → ${word}`, `#7 →  ${word.toUpperCase()} (x)`, `# → ${word} (y)`]) expect(isStructuredReturn(text)).toBe(true);
  });

  it('does not match the bare word without the `→` return arrow (free prose stays a hiccup)', () => {
    expect(isStructuredReturn('I was blocked-on-permission earlier, so I asked what to do next?')).toBe(false);
  });
});

describe('assessMissingOperationConfidence — #3421 addendum axis', () => {
  const cleanCriteria = Object.fromEntries(CONFIDENCE_CRITERIA.map((k) => [k, false]));

  it('clean-self-clears: no flagged criterion, no blacklist hit', () => {
    const r = assessMissingOperationConfidence({ call: 'node scripts/backlog.mjs claim 42', criteria: cleanCriteria });
    expect(r).toEqual({ selfClears: true, batched: false, escalate: false, reason: 'clean' });
  });

  it('flagged-criterion-batches: any flagged named criterion joins the batch, not a self-clear', () => {
    const r = assessMissingOperationConfidence({ call: 'read a config file', criteria: { ...cleanCriteria, securityRisk: true } });
    expect(r).toEqual({ selfClears: false, batched: true, escalate: false, reason: 'flagged-criterion:securityRisk' });
  });

  it('blacklisted-call-escalates: a blacklisted call always escalates, independent of a clean criteria map', () => {
    const r = assessMissingOperationConfidence({ call: 'git push --force origin main', criteria: cleanCriteria });
    expect(r).toEqual({ selfClears: false, batched: false, escalate: true, reason: 'blacklisted-call' });
  });

  it('blacklist wins even over a flagged criterion (checked first, independently)', () => {
    const r = assessMissingOperationConfidence({ call: 'sudo rm -rf /', criteria: { ...cleanCriteria, dataLeakRisk: true } });
    expect(r.escalate).toBe(true);
    expect(r.reason).toBe('blacklisted-call');
  });

  it('a custom blacklist overrides the default', () => {
    expect(isBlacklistedOperation('deploy to prod', ['deploy'])).toBe(true);
    expect(isBlacklistedOperation('deploy to prod', DEFAULT_OPERATION_BLACKLIST)).toBe(false);
  });

  it('default export list is non-empty and case-insensitive', () => {
    expect(DEFAULT_OPERATION_BLACKLIST.length).toBeGreaterThan(0);
    expect(isBlacklistedOperation('GIT PUSH --FORCE origin main')).toBe(true);
  });

  it('an absent criteria map is treated as clean (no throw)', () => {
    expect(assessMissingOperationConfidence({ call: 'ls' })).toEqual({ selfClears: true, batched: false, escalate: false, reason: 'clean' });
  });
});
