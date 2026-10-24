/** Phase 1 RED: size adds a split card and review capacity, never a refusal. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as openPrIo from '../open-pr-io.mjs';
import * as sizeAdmission from '../../lib/pr-size-admission.mjs';
import * as prLand from '../../pr-land.mjs';
import { REVIEW_LABELS } from '../../lib/review-labels.mjs';

const argv = ['--ref=lane/size-admission'];
const opened = { outcome: 'opened', pr: 5854, url: 'https://example.invalid/pull/5854' };
const text = '200\t0\tdocs/agent/a.md\0' + '101\t0\tdocs/agent/b.md\0';
const request = { ref: 'lane/size-admission', pr: 5854, base: 'main', sha: 'HEAD', body: 'Describe the change.' };
const card = { run: { verdict: { num: 9001, id: 'xsplit1', rel: 'backlog/xsplit1-split.md' } } };

function wrapper(overrides = {}) {
  const diffStat = vi.fn(() => text);
  const fileItem = vi.fn(() => card);
  const spawn = vi.fn(() => ({ status: 0, stdout: JSON.stringify(opened) }));
  const run = openPrIo.createPrLandRunner({ prePrReview: () => ({ action: 'pass' }),
    diffStat, fileItem, spawn, dupBornAs: () => [], env: {}, ...overrides });
  return { run, diffStat, fileItem, spawn };
}

// Proposed direct-producer seam. The implementation phase exports admitPrSize from
// pr-land and CALLS IT from runCli before forge.create, using its body and verdict
// in createParams/applyReviewEscalationLabel. All effects here are injected.
function direct(overrides = {}) {
  const effects = { diffStat: vi.fn(() => ({ text, sha: 'pinned-sha' })),
    fileItem: vi.fn(() => card), lookupSplitCard: vi.fn(() => null), ...overrides };
  return { effects, run: (input = request) => {
    expect(prLand.admitPrSize, 'direct pr-land must expose its injected admission seam').toBeTypeOf('function');
    return prLand.admitPrSize(input, effects);
  } };
}

describe('legacy size imports remain compatible with the shared home', () => {
  it('open-pr-io re-exports the shared 300-line constant and measurement function (the declaration stays import-free)', () => {
    expect(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES).toBe(300);
    expect(openPrIo.OPEN_PR_MAX_NON_TEST_LINES).toBe(sizeAdmission.OPEN_PR_MAX_NON_TEST_LINES);
    expect(openPrIo.measureNonTestLines).toBe(sizeAdmission.measureNonTestLines);
  });
  it('open-pr-io re-exports the shared diff-stat reader', () => {
    expect(openPrIo.createPrDiffStatReader).toBe(sizeAdmission.createPrDiffStatReader);
  });
});

describe('open-pr delegates size admission to the direct producer', () => {
  it('301 non-test lines are not refused: one producer invocation and no duplicate wrapper measurement/card', () => {
    const { run, diffStat, fileItem, spawn } = wrapper();
    expect(run({ argv })).toMatchObject(opened);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(diffStat).not.toHaveBeenCalled();
    expect(fileItem).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/pr-land\.mjs$/), ...argv, '--json']);
  });

  it('unreadable wrapper diff cannot refuse or duplicate the producer’s unknown-size handling', () => {
    const diffStat = vi.fn(() => { throw new Error('diff unavailable'); });
    const { run, spawn } = wrapper({ diffStat });
    expect(run({ argv })).toMatchObject(opened);
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('a pre-PR review refusal still stops before producer effects', () => {
    const { run, diffStat, spawn } = wrapper({ prePrReview: () => ({ action: 'refuse', reason: 'pre-pr-review-missing' }) });
    expect(run({ argv })).toMatchObject({ outcome: 'refused', reason: 'pre-pr-review-missing' });
    expect(diffStat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('a reviewed SHA is passed intact to the producer for measurement and publication', () => {
    const { run, spawn } = wrapper({ prePrReview: () => ({ action: 'pass', sha: 'reviewed-sha' }) });
    const requested = [...argv, '--sha=HEAD'];
    expect(run({ argv: requested })).toMatchObject(opened);
    expect(spawn.mock.calls[0][1].filter((arg) => arg.startsWith('--sha='))).toEqual(['--sha=reviewed-sha']);
    expect(requested).toEqual([...argv, '--sha=HEAD']);
  });

  it('an audited gate.bypass is recorded while the same producer still handles size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'size-bypass-'));
    try {
      const bodyFile = join(dir, 'body.md');
      writeFileSync(bodyFile, request.body);
      let body;
      const spawn = vi.fn((_command, args) => {
        body = readFileSync(args.find((a) => a.startsWith('--body-file=')).slice('--body-file='.length), 'utf8');
        expect(args.some((a) => /skip-size|size-bypass/.test(a))).toBe(false);
        return { status: 0, stdout: JSON.stringify(opened) };
      });
      const { run } = wrapper({ spawn, prePrReview: () => ({ action: 'pass', bypass: {
        reason: 'operator reason', actor: 'operator', operatorInstruction: 'Ship this change',
      } }) });
      expect(run({ argv: [...argv, `--body-file=${bodyFile}`] })).toMatchObject(opened);
      expect(body).toContain('operator reason');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('direct pr-land uses the same admission and existing review-label path', () => {
  it('direct pr-land: 301 lines proceed, one card names PR + groups, body notes both, reviewers escalated', async () => {
    const { run, effects } = direct();
    const result = await run();
    expect(result).toMatchObject({ status: 'over', lines: 301, reviewLabel: REVIEW_LABELS.pending, sha: 'pinned-sha' });
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
    const filed = effects.fileItem.mock.calls[0][0];
    expect(filed.title).toContain('#5854');
    expect(filed.digest).toMatch(/docs\/agent[^\n]*301/);
    expect(result.body).toContain('301 non-test lines (> 300)');
    expect(result.body).toMatch(/split card.*(?:9001|xsplit1).*filed/i);
    expect(result.body).toContain('extra reviewers requested via the size escalation (review:pending)');
    expect(result.body).toMatch(/file groups[^\n]*docs\/agent[^\n]*301/i);
    const verdict = prLand.resolveProducerReviewLabel({ changedFiles: ['docs/agent/a.md'], diffLines: 301, sizeAdmission: result });
    expect(verdict).toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
  });

  it.each([
    ['exactly 300', '300\t0\tdocs/example.md\0'],
    ['test-only big diff', '1000\t0\tscripts/a.test.mjs\0'],
    ['backlog-only big diff', '1000\t0\tbacklog/a.md\0'],
  ])('direct pr-land: %s needs no size action', async (_name, evidence) => {
    const { run, effects } = direct({ diffStat: vi.fn(() => evidence) });
    expect(await run()).toMatchObject({ status: 'ok', body: request.body, reviewLabel: null });
    expect(effects.fileItem).not.toHaveBeenCalled();
  });

  it('direct pr-land: throwing reader proceeds with size unknown and extra reviewers, no required card', async () => {
    const { run, effects } = direct({ diffStat: vi.fn(() => { throw new Error('diff unavailable'); }) });
    const result = await run();
    expect(result).toMatchObject({ status: 'unknown', reviewLabel: REVIEW_LABELS.pending });
    expect(result.body).toContain('size unknown: extra reviewers requested');
    expect(result.body).toMatch(/file groups/i);
    expect(effects.fileItem).not.toHaveBeenCalled();
    expect(prLand.resolveProducerReviewLabel({ changedFiles: [], diffLines: 0, sizeAdmission: result }))
      .toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
  });

  it('direct pr-land: an audited review bypass never skips size handling', async () => {
    const { run, effects } = direct();
    const result = await run({ ...request, gate: { action: 'pass', bypass: {
      reason: 'operator reason', actor: 'operator', operatorInstruction: 'Ship this change',
    } } });
    expect(result).toMatchObject({ status: 'over', reviewLabel: REVIEW_LABELS.pending });
    expect(effects.diffStat).toHaveBeenCalledTimes(1);
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
  });

  it('direct pr-land measures the reviewed SHA and returns the pinned publication SHA', async () => {
    const { run, effects } = direct({ diffStat: vi.fn(() => ({ text, sha: 'reviewed-sha' })) });
    const result = await run({ ...request, sha: 'reviewed-sha' });
    expect(effects.diffStat).toHaveBeenCalledWith({ base: 'main', sha: 'reviewed-sha' });
    expect(result.sha).toBe('reviewed-sha');
  });

  it('direct pr-land: card failure still proceeds and escalates', async () => {
    const { run, effects } = direct({ fileItem: vi.fn(() => { throw new Error('filing unavailable'); }) });
    const result = await run();
    expect(result).toMatchObject({ status: 'over', reviewLabel: REVIEW_LABELS.pending });
    expect(result.body).toContain('split card not filed: filing unavailable');
    expect(result.body).toContain('extra reviewers requested');
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
  });

  it('direct pr-land: repeated admission with the updated body does not file twice', async () => {
    const { run, effects } = direct();
    const first = await run();
    const second = await run({ ...request, body: first.body });
    expect(effects.fileItem).toHaveBeenCalledTimes(1);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
  });

  it.each(['over', 'unknown'])('forces %s through review:pending even below the existing 400-line threshold', (status) => {
    // #size-adds-reviewers-never-refuses: reuse the producer rubric/label path.
    expect(prLand.resolveProducerReviewLabel({ changedFiles: ['docs/example.md'], diffLines: 301,
      sizeAdmission: { status, lines: status === 'unknown' ? null : 301 } }))
      .toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
  });

  it('forcing size escalation preserves an existing stronger human-review requirement', () => {
    const verdict = prLand.resolveProducerReviewLabel({ changedFiles: [], diffLines: 301,
      deviation: 'operator ruling required', sizeAdmission: { status: 'over', lines: 301 } });
    expect(verdict).toMatchObject({ label: REVIEW_LABELS.human, humanRequired: true });
  });

  it.each([
    ['301-line admission requests review:pending', 'over', null, REVIEW_LABELS.pending],
    ['unknown evidence requests review:pending', 'unknown', null, REVIEW_LABELS.pending],
    ['301-line admission preserves human-required escalation', 'over', 'operator ruling required', REVIEW_LABELS.human],
    ['unknown evidence preserves human-required escalation', 'unknown', 'operator ruling required', REVIEW_LABELS.human],
  ])('%s through the admission-to-producer review-label path', async (_name, status, deviation, label) => {
    const { run } = direct(status === 'unknown' ? {
      diffStat: vi.fn(() => { throw new Error('diff unavailable'); }),
    } : {});
    const admission = await run();
    expect(admission.status).toBe(status);
    const verdict = prLand.resolveProducerReviewLabel({
      changedFiles: ['docs/example.md'], diffLines: admission.lines ?? 0,
      sizeAdmission: admission, deviation,
    });
    expect(verdict).toMatchObject({ label, apply: true, humanRequired: label === REVIEW_LABELS.human });
  });

  it('the production opening paths contain no legacy size refusal outcomes', () => {
    for (const path of ['scripts/operations/open-pr-io.mjs', 'scripts/operations/open-pr.mjs', 'scripts/pr-land.mjs']) {
      expect(readFileSync(join(process.cwd(), path), 'utf8')).not.toMatch(/pr-too-large|pr-size-unreadable/);
    }
  });

  it('CLI wiring calls the injected admission seam before create and consumes its body and escalation', () => {
    // Complements the effect tests: a new exported helper alone cannot fix direct callers.
    const source = readFileSync(join(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
    const cli = source.slice(source.indexOf('function runCli('));
    const call = /\b(\w+)\s*=\s*(?:await\s+)?admitPrSize\s*\(/.exec(cli);
    expect(call, 'runCli must actually invoke shared size admission').not.toBeNull();
    expect(call.index).toBeLessThan(cli.indexOf('forge.create(createParams)'));
    expect(cli).toMatch(new RegExp('body\\s*:\\s*' + call[1] + '\\.body|createParams\\.body\\s*=\\s*' + call[1] + '\\.body'));
    expect(cli).toMatch(new RegExp('sizeAdmission\\s*:\\s*' + call[1] + '\\b'));
    expect(source).toContain('#size-adds-reviewers-never-refuses');
  });
});

describe('pr-land CLI size failure boundaries', () => {
  const source = readFileSync(join(process.cwd(), 'scripts/pr-land.mjs'), 'utf8');
  // Execute the production block with injected IO without running publication or Git commands.
  const block = source.slice(source.indexOf('  let sizeBody = CREATE_BODY;'), source.indexOf('\n  if (prNum == null) {', source.indexOf('  let sizeBody = CREATE_BODY;')));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runBlock = new AsyncFunction('forge', 'admitPrSize', 'prNum', 'REVIEW_LABELS', `
    const CREATE_BODY = 'create body', REF = 'lane/test', REMOTE = 'origin', BASE = 'main', refSha = 'sha', REPO = '.';
    const composePrBody = (body) => body;
    const createParams = {};
    ${block}
    return { sizeAdmission, createParams };
  `);

  it.each([false, true])('only edits an existing PR after a successful live body read (read succeeds: %s)', async (readSucceeds) => {
    const forge = {
      viewPr: vi.fn(() => {
        if (!readSucceeds) throw new Error('body unavailable');
        return { body: 'live body' };
      }),
      editBody: vi.fn(),
    };
    const admit = vi.fn(async ({ body }) => ({ status: 'over', body: `${body}\nSize note`, reviewLabel: REVIEW_LABELS.pending }));
    await runBlock(forge, admit, 5854, REVIEW_LABELS);
    expect(admit).toHaveBeenCalledTimes(1);
    if (readSucceeds) expect(forge.editBody).toHaveBeenCalledWith(5854, 'live body\nSize note');
    else expect(forge.editBody).not.toHaveBeenCalled();
  });

  it.each([
    ['synchronous throw', () => { throw new Error('admission failed'); }],
    ['async rejection', async () => { throw new Error('admission failed'); }],
  ])('%s preserves new and existing bodies and forces unknown-size review', async (_name, admit) => {
    for (const prNum of [null, 5854]) {
      const forge = { viewPr: vi.fn(() => ({ body: 'live body' })), editBody: vi.fn() };
      const body = prNum == null ? 'create body' : 'live body';
      const result = await runBlock(forge, admit, prNum, REVIEW_LABELS);
      expect(result).toEqual({ sizeAdmission: { status: 'unknown', body, reviewLabel: REVIEW_LABELS.pending }, createParams: { body } });
      expect(forge.editBody).not.toHaveBeenCalled();
      expect(prLand.resolveProducerReviewLabel({ sizeAdmission: result.sizeAdmission }))
        .toMatchObject({ label: REVIEW_LABELS.pending, apply: true });
    }
  });

  it('entry-point rejection emits internal-error with a nonzero exit code', async () => {
    const entry = source.slice(source.indexOf('if (IS_CLI) runCli()'), source.indexOf('\nasync function runCli()'));
    const emit = vi.fn();
    const run = new Function('runCli', 'emit', 'REPO', entry.replace('if (IS_CLI) ', 'return '));
    await run(async () => { throw new Error('unexpected failure'); }, emit, '.');
    expect(emit).toHaveBeenCalledWith({ repo: '.', merged: false, reason: 'internal-error', detail: 'unexpected failure' }, 3);
    expect(source).toMatch(/async function runCli\(\)\s*\{\s*\/\/[^\n]*\n\s*emit = emitResult;/);
  });
});
