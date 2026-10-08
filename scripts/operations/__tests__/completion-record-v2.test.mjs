/**
 * @file completion-record-v2.test.mjs — item 117 slice S2: the v2 envelope and the three stores read as one (D2).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPLETION_RECORD_V2, finishEnvelopeRecord, newCompletionRecord, newEnvelopeRecord, parseCompletionRecord, serializeCompletionRecord,
  validateCompletionRecord,
} from '../completion-record.mjs';
import { readEnvelope, tryReadCompletion, writeCompletion } from '../completion-store.mjs';
import { writeDeliveryReport } from '../delivery-report-store.mjs';
import { writeFixReport } from '../fix-report-store.mjs';
import { applyDeliveryUpdate, newDeliveryReport } from '../delivery-report-record.mjs';
import { applyFixUpdate, newFixReport } from '../fix-report-record.mjs';
import { runShow } from '../completion-cli.mjs';
import { legacyOutcomeWord, routeWorkerResult, settleWorkerResult } from '../worker-result-router.mjs';

const T0 = () => '2026-10-08T10:00:00.000Z';
const T1 = () => '2026-10-08T10:05:00.000Z';
const dirs = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wr-v2-')); dirs.push(d); return d; };

const blockedResult = (kind, over = {}) => ({
  v: 1, outcome: 'blocked', summary: 'x', findingsAddressed: [], filesTouched: [], learning: null,
  blocker: { kind, component: 'c', evidence: { text: 'e', refs: [] }, proposedFix: null, ruling: null, deniedCommand: null, retryable: false, ...over },
});

function finished(result, launcher = 'claude-p') {
  const started = newEnvelopeRecord({ session: 'fix-4228', role: 'fix', launcher, model: 'sonnet', pr: 4228, pid: 123, timeoutMs: 60_000, now: T0 });
  const s = settleWorkerResult({ role: 'fix', launcher, value: result });
  const action = routeWorkerResult(s.result, { role: 'fix', launcher, session: 'fix-4228', postmortemMode: 'draft' });
  return finishEnvelopeRecord(started, { result: s.result, parse: s.parse, action, outcome: legacyOutcomeWord(s.result), reroute: s.reroute }, T1);
}

describe('completion record v2 (the launcher-written envelope)', () => {
  it('a started v2 record validates and carries the wrapper job facts (pid, timeout, deadline)', () => {
    const r = newEnvelopeRecord({ session: 'build-1', role: 'build', launcher: 'claude-p', pid: 99, timeoutMs: 3_600_000, now: T0 });
    expect(validateCompletionRecord(r)).toEqual({ ok: true, errors: [] });
    expect(r).toMatchObject({ v: COMPLETION_RECORD_V2, kind: 'build', role: 'build', status: 'started', pid: 99, deadlineAt: '2026-10-08T11:00:00.000Z', result: null });
  });
  it('a done v2 record validates, round-trips through the writer, and keeps the legacy outcome word', () => {
    const dir = tmp();
    const rec = finished(blockedResult('permission-wall', { deniedCommand: 'git push' }));
    expect(rec.outcome).toBe('blocked-on-permission');
    writeCompletion(rec, dir);
    expect(tryReadCompletion('fix-4228', dir)).toMatchObject({ v: 2, status: 'done', result: { blocker: { kind: 'permission-wall' } }, action: { type: 'product-fix-draft' } });
    // the existing per-outcome streak logic still sees the legacy word
    writeCompletion(finished(blockedResult('permission-wall', { deniedCommand: 'git push' })), dir);
    expect(tryReadCompletion('fix-4228', dir).permissionStreak).toBe(2);
  });
  it('refuses: a done v2 record with no result, a role/kind mismatch, an unknown launcher and an unknown version', () => {
    const base = finished({ v: 1, outcome: 'done', summary: 'ok', blocker: null, findingsAddressed: [{ ref: 'F1', disposition: 'fixed', note: '' }], filesTouched: [], learning: null });
    expect(validateCompletionRecord(base).ok).toBe(true);
    expect(validateCompletionRecord({ ...base, result: null }).ok).toBe(false);
    expect(validateCompletionRecord({ ...base, role: 'review' }).errors.join()).toContain('`role` must equal `kind`');
    expect(validateCompletionRecord({ ...base, launcher: 'pigeon' }).ok).toBe(false);
    expect(validateCompletionRecord({ ...base, v: 3 }).errors.join()).toContain('unsupported completion record version');
    expect(parseCompletionRecord(serializeCompletionRecord({ ...base, v: 3 })).ok).toBe(false);
  });
  it('source "none" is only for a record that never reported: a done record that CARRIES a result may not claim it', () => {
    const base = finished({ v: 1, outcome: 'done', summary: 'ok', blocker: null, findingsAddressed: [{ ref: 'F1', disposition: 'fixed', note: '' }], filesTouched: [], learning: null });
    expect(validateCompletionRecord({ ...base, source: 'none' }).errors.join()).toContain('source "none"');
    expect(validateCompletionRecord({ ...base, result: null, source: 'none' }).ok).toBe(true);
  });
  it('a v1 record still reads and validates, and is not rewritten', () => {
    const dir = tmp();
    const v1 = { ...newCompletionRecord({ session: 'fix-9', kind: 'fix', pr: 9, now: T0 }), status: 'done', outcome: 'healed' };
    writeCompletion(v1, dir);
    expect(tryReadCompletion('fix-9', dir).v).toBe(1);
  });
});

describe('the three stores read as one (D2)', () => {
  it('a v1 completion record is mapped to a v2 envelope at read time', () => {
    const dir = tmp();
    writeCompletion({ ...newCompletionRecord({ session: 'fix-7', kind: 'fix', pr: 7, now: T0 }), status: 'done', outcome: 'blocked-on-permission', denied: 'git push' }, dir);
    const e = readEnvelope('fix-7', { completions: dir, deliveryReports: null, fixReports: null });
    expect(e).toMatchObject({ v: 2, source: 'legacy-completion', role: 'fix', result: { outcome: 'blocked', blocker: { kind: 'permission-wall' } }, action: { type: 'product-fix-draft' } });
    expect(validateCompletionRecord(e).ok).toBe(true);
    // the agent-written legacy text is redacted too (the fallback must not be a way around the write-point redaction)
    writeCompletion({ ...newCompletionRecord({ session: 'fix-12', kind: 'fix', pr: 12, now: T0 }), status: 'done', outcome: 'blocked-on-permission', denied: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnop12345"' }, dir);
    expect(JSON.stringify(readEnvelope('fix-12', { completions: dir, deliveryReports: null, fixReports: null }))).not.toContain('ghp_abcdefghijklmnop12345');
  });
  it('a delivery report (build) and a fix report fold in with their own outcome words', () => {
    const dd = tmp(); const fd = tmp(); const cd = tmp();
    writeDeliveryReport(applyDeliveryUpdate(newDeliveryReport({ session: 'build-5', item: '5', now: T0 }), { status: 'done', outcome: 'needs-human-judgment', reason: 'which API shape?', filesTouched: ['a.mjs'] }, T1), dd);
    writeFixReport(applyFixUpdate(newFixReport({ session: 'fix-6', pr: '6', now: T0 }), { status: 'done', outcome: 'escalated-conflict', reason: 'two valid merges' }, T1), fd);
    const b = readEnvelope('build-5', { completions: cd, deliveryReports: dd, fixReports: fd });
    expect(b).toMatchObject({ source: 'legacy-delivery-report', role: 'build', result: { blocker: { kind: 'needs-ruling' } }, action: { type: 'operator' } });
    const f = readEnvelope('fix-6', { completions: cd, deliveryReports: dd, fixReports: fd });
    expect(f).toMatchObject({ source: 'legacy-fix-report', role: 'fix', result: { blocker: { kind: 'conflict' } }, action: { type: 'resolve-conflict' } });
    expect(readEnvelope('nothing-here', { completions: cd, deliveryReports: dd, fixReports: fd })).toBeNull();
  });
  it('a legacy done record with an unknown or missing outcome word fails closed (contract-violation, not success)', () => {
    const cd = tmp();
    writeCompletion({ ...newCompletionRecord({ session: 'fix-8', kind: 'fix', pr: 8, now: T0 }), status: 'done', outcome: 'sort-of-ok' }, cd);
    const e = readEnvelope('fix-8', { completions: cd, deliveryReports: null, fixReports: null });
    expect(e.result.outcome).toBe('unparseable');
    expect(e.action.type).toBe('product-fix-draft');
  });
  it('a started legacy record has no result yet', () => {
    const cd = tmp();
    writeCompletion(newCompletionRecord({ session: 'fix-10', kind: 'fix', pr: 10, now: T0 }), cd);
    expect(readEnvelope('fix-10', { completions: cd, deliveryReports: null, fixReports: null })).toMatchObject({ status: 'started', result: null, action: null });
  });
});

describe('completion-cli show prints result + action', () => {
  it('for a v2 record', () => {
    const dir = tmp();
    const prev = process.env.OPERATION_COMPLETIONS_DIR;
    process.env.OPERATION_COMPLETIONS_DIR = dir;
    try {
      writeCompletion(finished(blockedResult('tooling-defect')), dir);
      const out = runShow({ session: 'fix-4228' });
      expect(out).toMatchObject({ found: true, v: 2, result: { blocker: { kind: 'tooling-defect' } }, action: { type: 'product-fix-draft', hold: 'waiting-on-product-fix' } });
      expect(runShow({ session: 'fix-4228', envelope: true })).toMatchObject({ found: true, v: 2, source: 'worker-result' });
    } finally {
      if (prev === undefined) delete process.env.OPERATION_COMPLETIONS_DIR; else process.env.OPERATION_COMPLETIONS_DIR = prev;
    }
  });
});

describe('completion-cli show --envelope reads a v1 record as v2', () => {
  it('maps a v1 record and leaves the default show untouched', () => {
    const dir = tmp();
    const prev = process.env.OPERATION_COMPLETIONS_DIR;
    process.env.OPERATION_COMPLETIONS_DIR = dir;
    try {
      writeCompletion({ ...newCompletionRecord({ session: 'fix-11', kind: 'fix', pr: 11, now: T0 }), status: 'done', outcome: 'healed' }, dir);
      expect(runShow({ session: 'fix-11' })).toMatchObject({ found: true, v: 1 });
      expect(runShow({ session: 'fix-11', envelope: true })).toMatchObject({ found: true, v: 2, source: 'legacy-completion', result: { outcome: 'done' }, action: { type: 'done' } });
    } finally {
      if (prev === undefined) delete process.env.OPERATION_COMPLETIONS_DIR; else process.env.OPERATION_COMPLETIONS_DIR = prev;
    }
  });
});

describe('completion-cli show --envelope through the real argv parser', () => {
  it('a bare --envelope flag reaches runShow', () => {
    const dir = tmp();
    writeCompletion({ ...newCompletionRecord({ session: 'fix-13', kind: 'fix', pr: 13, now: T0 }), status: 'done', outcome: 'healed' }, dir);
    const run = (...a) => JSON.parse(execFileSync(process.execPath, [join(process.cwd(), 'scripts/operations/completion-cli.mjs'), 'show', '--session=fix-13', ...a], { encoding: 'utf8', env: { ...process.env, OPERATION_COMPLETIONS_DIR: dir } }));
    expect(run()).toMatchObject({ found: true, v: 1 });
    expect(run('--envelope')).toMatchObject({ found: true, v: 2, source: 'legacy-completion', action: { type: 'done' } });
  });
});
