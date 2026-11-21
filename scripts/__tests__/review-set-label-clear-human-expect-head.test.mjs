import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReviewLabelCli, buildVerdictComment } from '../review-set-label.mjs';

const head = 'a'.repeat(40);

describe('clear-human mandatory head binding', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clear-human-pin-'));
    vi.stubEnv('WE_VERDICT_LEDGER_DIR', join(dir, 'ledger'));
    vi.stubEnv('WE_VERDICT_LEDGER_STORE', '');
    vi.stubEnv('WE_VERDICT_LEDGER_BOARD', '');
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

  function run(extraArgv, heads = [head]) {
    const appendLedgerVerdict = vi.fn(), appendApproval = vi.fn();
    const provider = {
      name: 'stub', currentRepo: () => 'o/n',
      readPostingIdentity: () => ({ login: 'chalbert', type: 'User' }),
      readPrState: vi.fn(() => {
        const next = heads.length > 1 ? heads.shift() : heads[0];
        if (next instanceof Error) throw next;
        return { state: 'OPEN', headRefOid: next, labels: ['review:human'], comments: [], body: '' };
      }),
      readComments: () => [], readLabels: () => ['review:human'],
      setLabels: vi.fn(), postComment: vi.fn(),
    };
    vi.spyOn(process, 'exit').mockImplementation(code => { throw Object.assign(new Error('exit'), { exitCode: code }); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let exitCode = 0;
    try {
      runReviewLabelCli({
        argv: ['7', '--repo=o/n', '--to=clear-human', '--actor=operator', '--reason=reviewed', ...extraArgv],
        appendLedgerVerdict, appendApproval,
        allowClearHuman: true, defaultActor: 'test', usage: 'test', provider,
        buildComment: buildVerdictComment, successResult: o => o, refusalResult: o => o, emit: () => {},
      });
    } catch (e) { if (typeof e.exitCode === 'number') exitCode = e.exitCode; else throw e; }
    return { exitCode, provider, appendLedgerVerdict, appendApproval };
  }

  it.each([
    ['missing --expect-head', [], [head]],
    ['failed initial head read', [`--expect-head=${head}`], [new Error('unreadable head')]],
    ['moved head on initial read', [`--expect-head=${head}`], ['b'.repeat(40)]],
    ['moved head on pre-write re-read', [`--expect-head=${head}`], [head, 'b'.repeat(40)]],
    ['failed pre-write head re-read', [`--expect-head=${head}`], [head, new Error('unreadable head')]],
  ])('refuses %s with exit 2 and no writes', (_name, args, heads) => {
    const r = run(args, [...heads]);
    expect(r.exitCode).toBe(2);
    expect(r.appendLedgerVerdict).not.toHaveBeenCalled();
    expect(r.appendApproval).not.toHaveBeenCalled();
    expect(r.provider.setLabels).not.toHaveBeenCalled();
    expect(r.provider.postComment).not.toHaveBeenCalled();
  });

  // Tracked by the full label-authorship fix, F1/F2 (label-authorship-sec-prep-2026-11-20).
  it.todo('F1 operator-channel rejects a forged operator login without trusted authorship');
  it.todo('F1/F2 operator-channel requires authenticated operator evidence through the broker');
});
