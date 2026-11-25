import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, utimesSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeBlockedChecks, decideGateSendBack, sendBackBlockedGate, sendBackBlockedGates } from '../drain-blocked-reason.mjs';
import { classifyPr, unlandableStateReason } from '../../merge-ai-prs.mjs';
import { classifySkipReason } from '../drain-skip-reasons.mjs';
import { deriveWaitingOn } from '../../operations/pr-sweep-core.mjs';
import { classifyStall } from '../../conveyor/pr-stall-classify.mjs';
import soakBreak from '../../conveyor/soak/breaks/drain-blocked-reason-names-failed-check.mjs';
import { FAILED_CHECK_CONCLUSIONS } from '../rollup-collapse.mjs';

const head = 'a'.repeat(40);
const requiredChecks = ['test', 'merge-gate'];
const row = (name, conclusion = 'SUCCESS', extra = {}) => ({ __typename: 'CheckRun', name, status: 'COMPLETED', conclusion,
  startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z',
  detailsUrl: 'https://example.test/checks/100', checkRunId: 100, appSlug: 'github-actions', ...extra });
const restRow = (name, conclusion = 'success', extra = {}) => ({ id: 100, name, status: 'completed', conclusion,
  output: { title: '', summary: '' }, head_sha: head, ...extra });
const fixture = (extra = {}) => ({ number: 7196, headRefOid: head, baseRefName: 'main', body: 'Fix the gate.', title: 'Gate',
  labels: [{ name: 'ready-to-merge' }, { name: 'review:accepted' }], mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  rowsComplete: true, rowsHead: head, statusCheckRollup: [row('test'), restRow('merge-gate', 'failure', { output: { title: '', summary: '\n test-gaming\nignored second line' } })], ...extra });
const opts = { defaultBranch: 'main', queueRequiredChecks: requiredChecks };
const cliExec = fn => vi.fn((command, argv, options) => command === 'gh'
  ? { status: 0, stdout: JSON.stringify({ headRefOid: head }) } : fn(command, argv, options));
const decision = (pr = fixture(), ledger = {}) => decideGateSendBack({ pr, headSha: pr.headRefOid, requiredChecks, ledger });

describe('BLOCKED required-check evidence', () => {
  it('names the failed check and first non-empty summary line', () => {
    expect(describeBlockedChecks(fixture(), requiredChecks)).toEqual({ failed: ['required check "merge-gate" FAILURE: test-gaming'], waiting: [], text: 'required check "merge-gate" FAILURE: test-gaming' });
  });
  it.each(FAILED_CHECK_CONCLUSIONS)('recognizes %s as failed', conclusion => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [row('merge-gate', conclusion)] }), ['merge-gate']).failed[0]).toContain(conclusion);
  });
  it('uses title then description when summary has no non-empty line', () => {
    const pr = fixture({ statusCheckRollup: [restRow('merge-gate', 'failure', { output: { summary: '  ', title: '\n title\nmore' } })] });
    expect(describeBlockedChecks(pr, ['merge-gate']).text).toBe('required check "merge-gate" FAILURE: title');
    pr.statusCheckRollup = [{ __typename: 'StatusContext', context: 'merge-gate', state: 'FAILURE', description: 'description' }];
    expect(describeBlockedChecks(pr, ['merge-gate']).text).toContain(': description');
  });
  it.each(['IN_PROGRESS', 'QUEUED', 'PENDING'])('reports %s as waiting', status => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [row('merge-gate', null, { status })] }), ['merge-gate']).text).toBe(`waiting on required check "merge-gate" (${status})`);
  });
  it('reports an absent required check as waiting', () => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [] }), ['merge-gate']).text).toBe('waiting on required check "merge-gate" (absent)');
  });
  it('uses the latest run rather than an old failure', () => {
    expect(describeBlockedChecks(fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE', { checkRunId: undefined, completedAt: '2026-01-01' }), row('merge-gate', 'SUCCESS', { checkRunId: undefined, completedAt: '2026-02-01' })] }), ['merge-gate']).failed).toEqual([]);
  });
  it.each([false, true])('a newer untimestamped queued replacement supersedes an older timestamped failure without send-back (reverse=%s)', reverse => {
    const older = restRow('merge-gate', 'failure', { id: 100, output: { title: '', summary: 'old failure' } });
    const replacement = restRow('merge-gate', null, { id: 101, status: 'queued' });
    const pr = fixture({ statusCheckRollup: [row('test'), ...(reverse ? [replacement, older] : [older, replacement])] });
    expect(describeBlockedChecks(pr, requiredChecks)).toEqual({ failed: [],
      waiting: ['waiting on required check "merge-gate" (QUEUED)'], text: 'waiting on required check "merge-gate" (QUEUED)' });
    expect(decision(pr)).toEqual({ send: false });
  });
  it('treats an untimestamped queued rollup replacement without run IDs as waiting with no send-back', () => {
    const pr = fixture({ statusCheckRollup: [row('test'),
      row('merge-gate', 'FAILURE', { checkRunId: undefined, completedAt: '2026-01-01T00:00:00Z' }),
      row('merge-gate', null, { checkRunId: undefined, status: 'QUEUED', startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' })] });
    expect(describeBlockedChecks(pr, requiredChecks).failed).toEqual([]);
    expect(describeBlockedChecks(pr, requiredChecks).text).toBe('waiting on required check "merge-gate" (QUEUED)');
    expect(decision(pr)).toEqual({ send: false });
  });
  it('uses run identity over timestamp availability when a newer failure supersedes an older queued run', () => {
    const pr = fixture({ statusCheckRollup: [row('test'),
      restRow('merge-gate', 'failure', { id: 101 }),
      restRow('merge-gate', null, { id: 100, status: 'queued' })] });
    expect(describeBlockedChecks(pr, requiredChecks).failed).toEqual(['required check "merge-gate" FAILURE']);
    expect(decision(pr).send).toBe(true);
  });
  it.each(['IN_PROGRESS', 'QUEUED'])('selects a newer paged failure over an older %s run listed last without mutating rows', status => {
    const newer = Object.freeze(row('merge-gate', 'FAILURE', { checkRunId: 101 }));
    const older = Object.freeze(row('merge-gate', null, { checkRunId: 100, status,
      startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' }));
    const rows = Object.freeze([row('test'), newer, older]);
    const pr = fixture({ statusCheckRollup: rows });
    expect(describeBlockedChecks(pr, requiredChecks)).toEqual({ failed: ['required check "merge-gate" FAILURE'],
      waiting: [], text: 'required check "merge-gate" FAILURE' });
    expect(decision(pr)).toEqual({ send: true, body: 'required check "merge-gate" FAILURE' });
    expect(pr.statusCheckRollup).toBe(rows);
    expect(newer).not.toHaveProperty('id');
    expect(older).not.toHaveProperty('id');
  });
  it('reports a generic reason without throwing for a paged failure with no finding fields', () => {
    const pr = fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE')] });
    expect(() => describeBlockedChecks(pr, ['merge-gate'])).not.toThrow();
    expect(describeBlockedChecks(pr, ['merge-gate'])).toEqual({ failed: ['required check "merge-gate" FAILURE'],
      waiting: [], text: 'required check "merge-gate" FAILURE' });
  });
  it.each([undefined, null, '', 0, -1, 'opaque-id'])('uses checkRunId when id is unusable (%s)', id => {
    const pr = fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE', { id, checkRunId: 101 }),
      row('merge-gate', null, { checkRunId: 100, status: 'QUEUED' })] });
    expect(describeBlockedChecks(pr, ['merge-gate']).text).toBe('required check "merge-gate" FAILURE');
  });
  it('preserves usable ids when checkRunId is also present', () => {
    const pr = fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE', { id: 101, checkRunId: 100 }),
      row('merge-gate', null, { id: 100, checkRunId: 101, status: 'QUEUED' })] });
    expect(describeBlockedChecks(pr, ['merge-gate']).text).toBe('required check "merge-gate" FAILURE');
  });
  it.each([null, {}, { statusCheckRollup: 'bad' }, { statusCheckRollup: [null] }, { statusCheckRollup: [{ name: 'merge-gate', status: 'ALIEN' }] }])('retains the old reason on unreadable/odd evidence %j', pr => {
    expect(describeBlockedChecks(pr, requiredChecks)).toBeNull();
  });
  it('never throws on hostile accessors or invalid requirements', () => {
    expect(describeBlockedChecks({ get statusCheckRollup() { throw Error('unreadable'); } }, requiredChecks)).toBeNull();
    for (const required of [null, [], [42], ['']]) expect(describeBlockedChecks(fixture(), required)).toBeNull();
  });
  it('never merges or enqueues a failed required check, including prestage mode', () => {
    for (const preparePendingCi of [false, true]) {
      const result = classifyPr(fixture(), { ...opts, preparePendingCi });
      expect(result.decision).toBe('skip');
      expect(result.queueBlockedRelief).toBeUndefined();
      expect(result.reason).toContain(unlandableStateReason('BLOCKED') + '; required check "merge-gate" FAILURE: test-gaming');
      expect(classifySkipReason(result.reason)).toBe('checks-failed');
    }
  });
  it('classifies waiting as checks-pending', () => {
    const pr = fixture({ statusCheckRollup: [row('test'), row('merge-gate', null, { status: 'IN_PROGRESS' })] });
    expect(classifyPr(pr, opts).reason).toContain('waiting on required check "merge-gate" (IN_PROGRESS)');
    expect(classifySkipReason(classifyPr(pr, opts).reason)).toBe('checks-pending');
  });
});

describe('gate send-back', () => {
  it('requires a ready label and red required check', () => {
    expect(decision()).toEqual({ send: true, body: 'required check "merge-gate" FAILURE: test-gaming' });
    expect(decision(fixture({ labels: [] })).send).toBe(false);
    expect(decision(fixture({ statusCheckRollup: [row('test'), row('merge-gate', null, { status: 'IN_PROGRESS' })] })).send).toBe(false);
  });
  it.each(['abc', '', 'z'.repeat(40)])('refuses non-40-hex head %s', headSha => {
    expect(decideGateSendBack({ pr: fixture(), headSha, requiredChecks, ledger: {} }).send).toBe(false);
  });
  it('refuses a moved head or unreadable ledger', () => {
    expect(decideGateSendBack({ pr: fixture(), headSha: 'b'.repeat(40), requiredChecks, ledger: {} }).send).toBe(false);
    expect(decision(fixture(), null).send).toBe(false);
  });
  function withLedger(run) {
    const dir = mkdtempSync(join(tmpdir(), 'drain-blocked-'));
    try { run(join(dir, 'ledger.json')); } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('never clears a hold: invokes only --to=changes and records only after success, once per head', () => withLedger(ledgerPath => {
    const pr = fixture({ labels: [...fixture().labels, { name: 'review:human' }, { name: 'review:changes' }, { name: 'review:held-mechanical' }] });
    let liveHead = head;
    const exec = vi.fn((command, argv, options) => {
      if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: liveHead }) };
      expect(command).toBe(process.execPath);
      expect(argv.filter(a => a.startsWith('--to='))).toEqual(['--to=changes']);
      expect(argv).not.toEqual(expect.arrayContaining([expect.stringMatching(/--(?:remove|add)-label/)]));
      expect(argv).toContain('--repo=o/r');
      expect(options.maxBuffer).toBeGreaterThan(0);
      expect(readFileSync(argv.find(a => a.startsWith('--body-file=')).slice(12), 'utf8')).toBe(decision().body);
      if (exec.mock.calls.length === 2) expect(existsSync(ledgerPath)).toBe(false);
      return { status: 0 };
    });
    const run = p => sendBackBlockedGate({ pr: p, headSha: p.headRefOid, requiredChecks, repo: 'o/r', ledgerPath, exec });
    expect(run(pr).sent).toBe(true);
    expect(run(pr).sent).toBe(false);
    expect(exec).toHaveBeenCalledTimes(2);
    liveHead = 'b'.repeat(40);
    expect(run({ ...pr, headRefOid: liveHead, rowsHead: liveHead }).sent).toBe(true);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(run(pr).sent).toBe(false);
    expect(exec).toHaveBeenCalledTimes(4);
    expect(readFileSync(ledgerPath, 'utf8')).toContain('b'.repeat(40));
  }));
  it.each(['nonzero', 'throw'])('does not record the head when review-set-label fails: %s', mode => withLedger(ledgerPath => {
    const exec = cliExec(() => { if (mode === 'throw') throw Error('failed'); return { status: 1 }; });
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }).sent).toBe(false);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(existsSync(`${ledgerPath}.${head}.refused`)).toBe(true);
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }))
      .toMatchObject({ sent: false, reason: expect.stringContaining('refusal marker') });
    expect(exec).toHaveBeenCalledTimes(2);
  }));
  it('retains the refusal marker after an external mutation followed by timeout and prevents a second writer invocation', () => withLedger(ledgerPath => {
    let mutations = 0;
    const exec = cliExec(() => {
      mutations++;
      return { status: null, signal: 'SIGTERM', error: Object.assign(Error('writer timed out'), { code: 'ETIMEDOUT' }) };
    });
    const run = () => sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec });
    expect(run()).toMatchObject({ sent: false, reason: expect.stringContaining('operator must reconcile') });
    expect(mutations).toBe(1);
    expect(existsSync(ledgerPath)).toBe(false);
    expect(readFileSync(`${ledgerPath}.${head}.refused`, 'utf8')).toContain('operator must reconcile');
    expect(run()).toMatchObject({ sent: false, reason: expect.stringContaining('refusal marker') });
    expect(mutations).toBe(1);
    expect(exec).toHaveBeenCalledTimes(2);
  }));
  it('runs send-back at the BLOCKED skip pass with injected exec, leaving red PRs skipped', () => withLedger(ledgerPath => {
    const pr = fixture();
    const verdict = { ...classifyPr(pr, opts), repo: null, listedHeadSha: head };
    const exec = cliExec(() => ({ status: 0 }));
    const outcomes = sendBackBlockedGates({ prsByRepo: new Map([[null, [pr]]]), verdicts: [verdict],
      requiredChecksOf: () => requiredChecks, localSlug: 'o/r', cwdOf: () => undefined, ledgerPath, exec });
    expect(outcomes).toEqual([{ num: pr.number, repo: null, sent: true, recorded: true }]);
    expect(verdict.decision).toBe('skip');
    expect(exec).toHaveBeenCalledTimes(2);
  }));
  it('reports ledger persistence failure after a successful send-back for operator repair', () => withLedger(ledgerPath => {
    const exec = cliExec(() => {
      // Make the destination unwritable as a file after the successful CLI response.
      mkdirSync(ledgerPath); return { status: 0 }; });
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }))
      .toMatchObject({ sent: true, recorded: false, reason: expect.stringContaining('operator must repair') });
    expect(readFileSync(`${ledgerPath}.${head}.refused`, 'utf8')).toContain('operator must reconcile');
    rmSync(ledgerPath, { recursive: true });
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }))
      .toMatchObject({ sent: false, reason: expect.stringContaining('refusal marker') });
    expect(exec).toHaveBeenCalledTimes(2);
  }));
  it('refuses a corrupt persisted ledger without invoking the CLI', () => withLedger(ledgerPath => {
    writeFileSync(ledgerPath, 'broken');
    const exec = vi.fn();
    expect(sendBackBlockedGate({ pr: fixture(), headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec }).sent).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  }));
});


describe('audit safeguards', () => {
  const run = (ledgerPath, exec, pr = fixture(), extra = {}) => sendBackBlockedGate({ pr, headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec, ...extra });
  const withLedger = fn => {
    const directory = mkdtempSync(join(tmpdir(), 'drain-audit-'));
    try { fn(join(directory, 'ledger.json')); }
    finally { chmodSync(directory, 0o700); rmSync(directory, { recursive: true, force: true }); }
  };
  it.each([{ rowsComplete: false }, { rowsComplete: undefined }, { rowsComplete: 'true' }, { rowsHead: undefined }, { rowsHead: 'b'.repeat(40) }])('refuses incomplete or unpinned rows: %j', extra => {
    expect(decision(fixture(extra))).toEqual({ send: false });
    expect(describeBlockedChecks(fixture(extra), requiredChecks).failed).toHaveLength(1);
  });
  it.each(['summary', 'title'])('extracts REST output.%s findings', field => {
    const pr = fixture({ statusCheckRollup: [restRow('merge-gate', 'failure', { output: { [field]: '\n nested finding\nignored' } })] });
    expect(decision(pr).body).toBe('required check "merge-gate" FAILURE: nested finding');
  });
  it('still sends a generic failure without finding text', () => withLedger(path => {
    const exec = cliExec((_command, argv) => {
      expect(readFileSync(argv.find(a => a.startsWith('--body-file=')).slice(12), 'utf8')).toBe('required check "merge-gate" FAILURE');
      return { status: 0 };
    });
    expect(run(path, exec, fixture({ statusCheckRollup: [row('merge-gate', 'FAILURE')] })).sent).toBe(true);
  }));
  it.each(['moved', 'failed', 'malformed'])('refuses a %s live head immediately before the writer', mode => withLedger(path => {
    const exec = vi.fn(() => ({ status: mode === 'failed' ? 1 : 0,
      stdout: mode === 'malformed' ? '?' : JSON.stringify({ headRefOid: 'b'.repeat(40) }) }));
    expect(run(path, exec).sent).toBe(false);
    expect(exec).toHaveBeenCalledOnce();
    expect(exec.mock.calls[0][0]).toBe('gh');
    expect(exec.mock.calls[0][1]).toEqual(['pr', 'view', '7196', '--repo=o/r', '--json=headRefOid,comments']);
    expect(existsSync(path)).toBe(false);
  }));
  it('skips contention and preserves different-PR ledger updates on the next locked read', () => withLedger(path => {
    const nested = cliExec(() => ({ status: 0 }));
    const exec = cliExec(() => {
      expect(run(path, nested, fixture({ number: 7197 })).reason).toContain('locked');
      return { status: 0 };
    });
    expect(run(path, exec).recorded).toBe(true);
    expect(nested).not.toHaveBeenCalled();
    expect(run(path, nested, fixture({ number: 7197 })).recorded).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'o/r#7196': { [head]: true }, 'o/r#7197': { [head]: true } });
  }));
  it('reaps an abandoned lock but waits until the next pass to send', () => withLedger(path => {
    writeFileSync(`${path}.lock`, '');
    utimesSync(`${path}.lock`, new Date(0), new Date(0));
    const exec = cliExec(() => ({ status: 0 }));
    expect(run(path, exec).reason).toContain('locked');
    expect(exec).not.toHaveBeenCalled();
    expect(run(path, exec).recorded).toBe(true);
    expect(existsSync(`${path}.lock`)).toBe(false);
  }));
  it('serializes two stale reapers and a replacement writer, preserving exclusive ownership and both PR entries', () => withLedger(path => {
    writeFileSync(`${path}.lock`, '');
    utimesSync(`${path}.lock`, new Date(0), new Date(0));
    const otherPr = fixture({ number: 7197 });
    const secondReaperExec = cliExec(() => ({ status: 0 }));
    const replacementExec = cliExec(() => ({ status: 0 }));
    let secondReaper, replacementDuringReap, concurrentWriter, heldLock;
    // Pause the first reaper after its stale snapshot; interleave the second
    // reaper and a replacement acquisition before the first can unlink.
    const firstReaper = run(path, cliExec(() => ({ status: 0 })), fixture(), { statLock: lockPath => {
      const snapshot = statSync(lockPath);
      secondReaper = run(path, secondReaperExec, otherPr);
      replacementDuringReap = run(path, replacementExec);
      return snapshot;
    } });
    expect(firstReaper.reason).toContain('locked');
    expect(secondReaper).toMatchObject({ sent: false, reason: expect.stringContaining('guard busy') });
    expect(replacementDuringReap).toMatchObject({ sent: false, reason: expect.stringContaining('guard busy') });
    expect(secondReaperExec).not.toHaveBeenCalled();
    expect(replacementExec).not.toHaveBeenCalled();
    const writer = cliExec(() => {
      concurrentWriter = run(path, secondReaperExec, otherPr);
      heldLock = existsSync(`${path}.lock`);
      return { status: 0 };
    });
    expect(run(path, writer)).toMatchObject({ sent: true, recorded: true });
    expect(concurrentWriter).toMatchObject({ sent: false, reason: expect.stringContaining('locked') });
    expect(heldLock).toBe(true);
    expect(secondReaperExec).not.toHaveBeenCalled();
    expect(run(path, secondReaperExec, otherPr)).toMatchObject({ sent: true, recorded: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ 'o/r#7196': { [head]: true }, 'o/r#7197': { [head]: true } });
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(existsSync(`${path}.lock.guard`)).toBe(false);
  }));
  it('refuses an abandoned acquisition guard and names operator repair without deleting it', () => withLedger(path => {
    writeFileSync(`${path}.lock.guard`, '');
    utimesSync(`${path}.lock.guard`, new Date(0), new Date(0));
    const exec = cliExec(() => ({ status: 0 }));
    expect(run(path, exec)).toMatchObject({ sent: false, reason: expect.stringContaining('operator must repair a persistent guard') });
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(`${path}.lock.guard`)).toBe(true);
  }));
  it.each([0o300, 0o500])('refuses unreadable or unwritable ledger directories (%s)', mode => withLedger(path => {
    const directory = join(path, '..');
    chmodSync(directory, mode);
    const exec = vi.fn();
    try { expect(run(path, exec).sent).toBe(false); expect(exec).not.toHaveBeenCalled(); }
    finally { chmodSync(directory, 0o700); }
  }));
  it('refuses an unreadable refusal marker', () => withLedger(path => {
    mkdirSync(`${path}.${head}.refused`);
    const exec = vi.fn();
    expect(run(path, exec).sent).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  }));
  it('uses an independent soak fix signal even when the diagnostic scenario fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'drain-soak-'));
    const previous = process.env.SOAK_TREE_ROOT;
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      const source = join(process.cwd(), 'scripts/lib/drain-skip-reasons.mjs');
      writeFileSync(join(root, 'scripts/lib/drain-skip-reasons.mjs'), readFileSync(source));
      writeFileSync(join(root, 'scripts/lib/drain-blocked-reason.mjs'), 'export const describeBlockedChecks = () => null;');
      process.env.SOAK_TREE_ROOT = root;
      expect(soakBreak.fixPresent(root)).toBe(true);
      expect(soakBreak.judge(await soakBreak.run())).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.SOAK_TREE_ROOT; else process.env.SOAK_TREE_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('maps failed checks to the same CI actor and stalled recovery as pending checks', () => {
    const row = { repo: 'web-everything/web-everything', number: 7196, waitingOn: 'drain-skip:checks-failed', actor: 'ci',
      stalled: true, liveJob: null, why: 'required check failed', evidence: [], next: null };
    const derived = deriveWaitingOn({ ...fixture(), repo: row.repo, comments: [], statusCheckRollup: [] },
      { now: Date.now(), drainSkips: [{ num: row.number, repo: row.repo, kind: 'checks-failed', reason: row.why }] });
    expect(derived).toMatchObject({ state: row.waitingOn, actor: 'ci' });
    const result = classifyStall({ row, head });
    expect(result).toMatchObject({ lane: 'system', action: 'tooling-card', smell: 'ci-job-hung' });
    expect(classifyStall({ row: { ...row, stalled: false }, head })).toBeNull();
    expect(classifyStall({ row: { ...row, liveJob: 'ci' }, head })).toBeNull();
    expect(classifyStall({ row: { ...row, actor: 'operator' }, head }).reason).toContain('does not fit');
  });
});

describe('stale merge-gate run vs later review verdict', () => {
  const runUrl = 'https://github.com/o/r/actions/runs/45545719563/job/1';
  const gate = (extra = {}) => restRow('merge-gate', 'failure', { detailsUrl: runUrl, completedAt: '2026-11-25T04:18:00Z', ...extra });
  const prWith = (g = gate(), more = []) => fixture({ statusCheckRollup: [row('test'), g, ...more] });
  const verdictAt = (createdAt, body = '✅ review — accepted') => ({ id: 'C_1', body, createdAt, viewerDidAuthor: true });
  const withDir = fn => {
    const directory = mkdtempSync(join(tmpdir(), 'drain-stale-'));
    try { fn(join(directory, 'ledger.json')); } finally { rmSync(directory, { recursive: true, force: true }); }
  };
  const exec = (comments, writes = []) => vi.fn((command, argv) => {
    if (command === 'gh' && argv[0] === 'run') { writes.push(argv); return { status: 0 }; }
    if (command === 'gh') return { status: 0, stdout: JSON.stringify({ headRefOid: head, ...(comments ? { comments } : {}) }) };
    writes.push(argv); return { status: 0 };
  });
  const go = (ledgerPath, ex, pr) => sendBackBlockedGate({ pr, headSha: head, requiredChecks, repo: 'o/r', ledgerPath, exec: ex });
  const reruns = writes => writes.filter(a => a[0] === 'run');
  const sends = writes => writes.filter(a => a[0] !== 'run');

  it('run older than the verdict: no send-back, one re-run request, none on the second pass', () => withDir(ledgerPath => {
    const writes = [];
    const ex = exec([verdictAt('2026-11-25T07:30:00Z')], writes);
    expect(go(ledgerPath, ex, prWith())).toMatchObject({ sent: false, reason: expect.stringContaining('re-run requested') });
    expect(reruns(writes)).toEqual([['run', 'rerun', '45545719563', '--repo=o/r']]);
    expect(sends(writes)).toEqual([]);
    expect(go(ledgerPath, ex, prWith())).toMatchObject({ sent: false });
    expect(reruns(writes)).toHaveLength(1);
    expect(sends(writes)).toEqual([]);
  }));
  it('run newer than the verdict still sends back', () => withDir(ledgerPath => {
    const writes = [];
    expect(go(ledgerPath, exec([verdictAt('2026-11-25T03:00:00Z')], writes), prWith()).sent).toBe(true);
    expect(reruns(writes)).toEqual([]);
  }));
  it.each([
    ['no comments read', undefined],
    ['verdict time unreadable', [verdictAt('not-a-date')]],
    ['no verdict comment', [{ id: 'C', body: 'hello', createdAt: '2026-11-25T07:30:00Z', viewerDidAuthor: true }]],
    ['verdict from an untrusted author', [{ ...verdictAt('2026-11-25T07:30:00Z'), viewerDidAuthor: false, author: { login: 'rando' } }]],
  ])('unreadable evidence sends back as today: %s', (_name, comments) => withDir(ledgerPath => {
    const writes = [];
    expect(go(ledgerPath, exec(comments, writes), prWith()).sent).toBe(true);
    expect(reruns(writes)).toEqual([]);
  }));
  it('run completion time unreadable sends back as today', () => withDir(ledgerPath => {
    const writes = [];
    expect(go(ledgerPath, exec([verdictAt('2026-11-25T07:30:00Z')], writes), prWith(gate({ completedAt: undefined }))).sent).toBe(true);
    expect(reruns(writes)).toEqual([]);
  }));
  it('another failed check besides merge-gate sends back', () => withDir(ledgerPath => {
    const writes = [];
    const pr = fixture({ statusCheckRollup: [row('test', 'FAILURE'), gate()] });
    expect(go(ledgerPath, exec([verdictAt('2026-11-25T07:30:00Z')], writes), pr).sent).toBe(true);
    expect(reruns(writes)).toEqual([]);
  }));
});
