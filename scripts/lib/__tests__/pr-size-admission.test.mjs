/** Phase 1 RED contracts: the shared size home is intentionally a behavior-free stub. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sizeAdmission from '../pr-size-admission.mjs';
import { outcomePayload } from '../../operations/cli-adapter.mjs';
import { fileIntoBatch } from '../../operations/card-batch-file.mjs';

vi.mock('../../operations/card-batch-file.mjs', () => ({ fileIntoBatch: vi.fn() }));
vi.mock('../../conveyor/infra-blocked.mjs', () => ({ originSlugOf: () => 'web-everything/web-everything' }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  const execFileSync = vi.fn(actual.execFileSync);
  return { ...actual, execFileSync, default: { ...actual.default, execFileSync } };
});

// Effect seam: createSizeAdmissionRunner({ diffStat, fileItem, lookupSplitCard, publishSplitCard })
// returns a runner({ ref, pr?, base, sha, body }) -> { status, lines, body, reviewLabel, sha? }.
// fileItem accepts the declared operation's title/kind/size/digest/scope fields and returns
// the CLI's outcomePayload envelope with a top-level verdict.
afterEach(() => vi.restoreAllMocks());

describe('planSizeAdmission — size dials capacity, never permission', () => {
  it.each([0, 299, 300])('exactly %i non-test lines need no action', (lines) => {
    expect(sizeAdmission.planSizeAdmission({ lines, exempt: false })).toMatchObject({ status: 'ok', lines });
  });
  it.each([301, 399, 400, 1000])('%i non-test lines plan over rather than a refusal', (lines) => {
    expect(sizeAdmission.planSizeAdmission({ lines, exempt: false })).toMatchObject({ status: 'over', lines });
  });
  it('backlog-only big diff is exempt', () => {
    expect(sizeAdmission.planSizeAdmission({ lines: 1000, exempt: true })).toMatchObject({ status: 'ok', lines: 1000 });
  });
  it('reader errors plan unknown without inventing a zero line count', () => {
    expect(sizeAdmission.planSizeAdmission(new Error('diff unavailable'))).toMatchObject({ status: 'unknown', lines: null });
  });
  it.each([undefined, null, {}, { lines: NaN }, { lines: -1 }, { lines: Infinity }])(
    'incomplete evidence %j plans unknown rather than ok', (evidence) => {
      expect(sizeAdmission.planSizeAdmission(evidence)).toMatchObject({ status: 'unknown', lines: null });
    });
});

const evidence = '100\t50\tscripts/operations/a.mjs\0'
  + '50\t0\tscripts/operations/b.mjs\0'
  + '101\t0\tdocs/agent/a.md\0'
  + '900\t0\tscripts/operations/__tests__/a.test.mjs\0';
const request = { ref: 'lane/size-admission', pr: 5854, base: 'main', sha: 'HEAD', body: 'Existing PR description.' };
const cardResult = { verdict: { num: 9001, id: 'xsplit1', rel: 'backlog/xsplit1-split.md' } };
function effects(overrides = {}) {
  return {
    diffStat: vi.fn(() => ({ text: evidence, sha: 'pinned-sha' })),
    fileItem: vi.fn(() => cardResult),
    lookupSplitCard: vi.fn(() => null),
    publishSplitCard: vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-filing-1' })),
    ...overrides,
  };
}
function expectSizeNote(body) {
  expect(body).toContain(request.body);
  expect(body).toMatch(/## Size\b/);
  expect(body).toContain('301 non-test lines (> 300)');
  expect(body).toMatch(/split card.*(?:9001|xsplit1).*filed/i);
  expect(body).toContain('extra reviewers requested via the size escalation (review:pending)');
  expect(body).toMatch(/file groups[^\n]*scripts\/operations[^\n]*200/i);
  expect(body).toMatch(/file groups[^\n]*docs\/agent[^\n]*101/i);
  expect(body).not.toMatch(/900 non-test|a\.test\.mjs/);
}

describe('shared admission effects', () => {
  it.each([
    '/private/tmp/size-admission/scripts/operations/run.mjs',
    'C:\\workspace\\size-admission\\scripts\\operations\\run.mjs',
  ])('withholds absolute paths from the card note when file-item fails (%s)', async (localPath) => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error(`Command failed: node "${localPath}" file-item\nprivate diagnostic`); });
    const io = effects();
    delete io.fileItem;
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(execFileSync).toHaveBeenCalledWith(process.execPath,
      expect.arrayContaining(['file-item', '--json']), expect.any(Object));
    expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
    expect(result.body).not.toContain(localPath);
    expect(result.body).not.toContain('private diagnostic');
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toContain('<!-- size-admission:lane%2Fsize-admission - -->');
    expect(io.publishSplitCard).not.toHaveBeenCalled();
  });

  it.each(['new', 'local retry', 'old body marker'])('awaits durable publication before reporting a %s split card filed', async (mode) => {
    let finish;
    const io = effects({
      lookupSplitCard: () => mode === 'new' ? null : cardResult.verdict,
      publishSplitCard: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
    });
    const body = mode === 'old body marker'
      ? `${request.body}\n\n## Size\n\nstale\n<!-- size-admission:${encodeURIComponent(request.ref)} 9001 -->\n`
      : request.body;
    let completed = false;
    const pending = sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body }).then((result) => {
      completed = true;
      return result;
    });
    // Allow lookup and filing to finish; publication must still hold the body back.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(io.publishSplitCard).toHaveBeenCalledWith(cardResult.verdict, expect.objectContaining({ ref: request.ref }));
    expect(completed).toBe(false);
    finish({ batched: true, batchRef: 'lane/card-batch-filing-1' });
    expectSizeNote((await pending).body);
    expect(io.fileItem).toHaveBeenCalledTimes(mode === 'new' ? 1 : 0);
  });

  it.each(['refusal', 'exception', 'missing confirmation'])('publication %s proceeds without a filed claim or success marker, then retries the same card', async (failure) => {
    const io = effects({ lookupSplitCard: () => cardResult.verdict,
      publishSplitCard: vi.fn(async () => {
        if (failure === 'exception') throw new Error('publication failed');
        return failure === 'refusal' ? { batched: false, reason: 'lease held' } : undefined;
      }),
    });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toContain('<!-- size-admission:lane%2Fsize-admission - -->');
    io.publishSplitCard.mockResolvedValue({ batched: true, batchRef: 'lane/card-batch-filing-1' });
    expectSizeNote((await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: result.body })).body);
    expect(io.fileItem).not.toHaveBeenCalled();
  });

  it('reports the durably published member when concurrent filers created different local card ids', async () => {
    const io = effects({ publishSplitCard: async () => ({ batched: true, deduped: true,
      member: { cardId: 'xwinner' }, batchRef: 'lane/card-batch-filing-1' }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.body).toContain('split card xwinner filed via lane/card-batch-filing-1');
    expect(result.body).toContain('<!-- size-admission:lane%2Fsize-admission xwinner -->');
    expect(result.body).not.toContain('split card 9001 filed');
  });

  it.each([undefined, { cardId: 'bad\nidentity' }])('does not claim publication when a deduplicated member lacks a safe identity (%j)', async (member) => {
    const io = effects({ publishSplitCard: async () => ({ batched: true, deduped: true, member }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toContain('<!-- size-admission:lane%2Fsize-admission - -->');
  });

  it.each(['a', '界'])('bounds both PR notes and file-item arguments for twelve thousand long %s file groups', async (letter) => {
    const text = Array.from({ length: 12_000 }, (_, i) =>
      `1\t0\tpackages/${String(i).padStart(5, '0')}-${letter.repeat(180)}/index.mjs\0`).join('');
    const io = effects({ diffStat: () => text });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.status).toBe('over');
    expect(Buffer.byteLength(result.body)).toBeLessThan(16_384);
    expect(result.body).toMatch(/omitted/);
    const fields = io.fileItem.mock.calls[0][0];
    for (const value of Object.values(fields)) expect(Buffer.byteLength(String(value))).toBeLessThan(16_384);
    expect(fields.digest).toMatch(/omitted/);
    expect(fields.scope.split(',').every((path) => path.startsWith('we:packages/'))).toBe(true);
  });

  it('omits a single over-budget group and scope path whole, including when filing fails', async () => {
    const path = `packages/${'界'.repeat(20_000)}/index.mjs`;
    const io = effects({ diffStat: () => `301\t0\t${path}\0`, fileItem: vi.fn(() => { throw new Error('unavailable'); }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(Buffer.byteLength(result.body)).toBeLessThan(16_384);
    expect(result.body).toContain('1 group omitted');
    expect(result.body).toContain('split card not filed (file-item failed)');
    const fields = io.fileItem.mock.calls[0][0];
    expect(fields.scope).toBe('');
    expect(fields.digest).toContain('1 scope path omitted');
  });

  it.each(['refusal', 'exception'])('default publisher does not mistake a locally scaffolded card for publication after batch %s', async (mode) => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-split-publish-'));
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, cardResult.verdict.rel), `size-split-ref:${encodeURIComponent(request.ref)}. File groups: we:scripts: 301`);
    vi.mocked(execFileSync).mockReturnValue(''); // absent from the canonical remote base
    vi.mocked(fileIntoBatch).mockImplementation(async () => {
      if (mode === 'exception') throw new Error('publication failed');
      return { batched: false, reason: 'batch unavailable' };
    });
    const fileItem = vi.fn();
    try {
      const result = await sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => evidence, fileItem })(request);
      expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
      expect(result.body).toContain('split card not filed (file-item failed)');
      expect(result.body).toContain('<!-- size-admission:lane%2Fsize-admission - -->');
      expect(fileItem).not.toHaveBeenCalled();
      vi.mocked(fileIntoBatch).mockResolvedValue({ batched: true, batchRef: 'lane/card-batch-filing-1' });
      expectSizeNote((await sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => evidence, fileItem })({ ...request, body: result.body })).body);
      expect(fileItem).not.toHaveBeenCalled();
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('default publisher reuses a card already in the canonical backlog without batching it again', async () => {
    const io = effects();
    delete io.publishSplitCard;
    vi.mocked(execFileSync).mockReturnValue(`100644 blob ${'a'.repeat(40)}\t${cardResult.verdict.rel}\0`);
    vi.mocked(fileIntoBatch).mockClear();
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expectSizeNote(result.body);
    expect(fileIntoBatch).not.toHaveBeenCalled();
  });

  it.each(['unreadable entry', `040000 tree ${'a'.repeat(40)}\tbacklog/xsplit1-split.md\0`,
    `120000 blob ${'a'.repeat(40)}\tbacklog/xsplit1-split.md\0`])
  ('default publisher does not treat incomplete or nonregular canonical evidence as a published card (%j)', async (entry) => {
    const io = effects();
    delete io.publishSplitCard;
    vi.mocked(execFileSync).mockReturnValue(entry);
    vi.mocked(fileIntoBatch).mockResolvedValue({ batched: false, reason: 'publication unavailable' });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).not.toContain('<!-- size-published:');
  });

  it.each([
    ['numbered', { num: 9001, id: '9001' }, '9001'],
    ['hash-only', { num: null, id: 'xsplit1' }, 'xsplit1'],
  ])('default file-item adapter creates and returns a reusable split card through the CLI output contract (%s)', async (_name, verdict, id) => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-split-adapter-'));
    mkdirSync(join(cwd, 'backlog'));
    vi.mocked(fileIntoBatch).mockResolvedValue({ batched: true, batchRef: 'lane/card-batch-filing-1' });
    const exec = vi.fn((command, args, options) => {
      if (command === 'git') {
        expect(args).toEqual(['ls-tree', '-z', '--full-tree', 'origin/main', '--', expect.stringMatching(/^backlog\//)]);
        expect(options).toMatchObject({ cwd, timeout: 5000 });
        return '';
      }
      expect(command).toBe(process.execPath);
      expect(args[0]).toBe(join(cwd, 'scripts/operations/run.mjs'));
      expect(args[0]).toMatch(/scripts\/operations\/run\.mjs$/);
      expect(args[1]).toBe('file-item');
      expect(args.at(-1)).toBe('--json');
      expect(options).toMatchObject({ cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      const fields = Object.fromEntries(args.slice(2, -1).map((arg) => {
        const separator = arg.indexOf('=');
        return [arg.slice(2, separator), arg.slice(separator + 1)];
      }));
      expect(fields).toEqual({
        title: 'Split PR #5854 into focused changes', kind: 'story', size: '3',
        digest: expect.stringContaining(`size-split-ref:${encodeURIComponent(request.ref)}. `),
        scope: 'we:scripts/operations/a.mjs,we:scripts/operations/b.mjs,we:docs/agent/a.md',
      });
      const rel = `backlog/${id}-split.md`;
      writeFileSync(join(cwd, rel), fields.digest);
      return JSON.stringify(outcomePayload({
        run: { id: 'split-contract', op: 'file-item', effects: [], pending: null,
          verdict: { ...verdict, rel }, findings: [] },
        stopped: 'complete',
      }));
    });
    vi.mocked(execFileSync).mockImplementation(exec);
    const run = (body = request.body) => sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => evidence })({ ...request, body });
    try {
      const first = await run();
      expectSizeNote(first.body);
      expectSizeNote((await run()).body); // unpublished body: durable local lookup
      expectSizeNote((await run(first.body)).body); // published marker
      expect(exec.mock.calls.filter(([command]) => command === process.execPath)).toHaveLength(1);
      expect(fileIntoBatch).toHaveBeenCalledWith({ laneDir: cwd, cardPath: `backlog/${id}-split.md`,
        actor: 'mechanical', idemKey: `size-split:${request.ref}`,
        source: { repo: 'web-everything/web-everything', pr: request.pr, head: request.sha, note: `Split oversized PR ${request.ref}` },
      });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it.each(['\n## Injected', '\rInjected', '\u2028Injected', '9001\n', '9001\r', '9001\u2028', '`bad`', '"bad"', '--bad', '../bad', 'ｂａｄ', 'bad\u200b', 'safe%0Abad', '%'])
  ('rejects a hostile or malformed marker card id %j and files a real card', async (id) => {
    const io = effects();
    const body = `${request.body}\n\n## Size\n\nstale\n<!-- size-admission:${encodeURIComponent(request.ref)} ${id === '%' ? id : encodeURIComponent(id)} -->\n`;
    const result = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expectSizeNote(result.body);
    expect(result.body).not.toContain('Injected');
  });

  it('invalid local card identifiers cannot suppress filing or inject body text', async () => {
    const io = effects({ lookupSplitCard: () => ({ id: '9001\n## Injected' }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expectSizeNote(result.body);
    expect(result.body).not.toContain('Injected');
  });

  it('invalid CLI card identifiers are not published or persisted as filing evidence', async () => {
    const io = effects({ fileItem: () => ({ verdict: { id: '9001\n## Injected' } }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toContain('<!-- size-admission:lane%2Fsize-admission - -->');
    expect(result.body).not.toContain('Injected');
  });

  it.each(['successful', 'unknown-size', 'failed-filing'])
  ('preserves unrelated body sections when retrying %s admission', async (prior) => {
    const io = effects(prior === 'unknown-size' ? { diffStat: () => { throw new Error('unavailable'); } }
      : prior === 'failed-filing' ? { fileItem: () => { throw new Error('unavailable'); } } : {});
    const unrelated = '\n\n## Testing\n\nKeep this section exactly.\n';
    const other = '\n\n## Size\n\nOther ref size note.\n<!-- size-admission:lane%2Fother 123 -->\n';
    const first = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: request.body + other });
    const body = first.body + unrelated;
    const second = await sizeAdmission.createSizeAdmissionRunner(effects())({ ...request, body });
    expect(second.body).toContain(request.body + other);
    expect(second.body).toContain(unrelated);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(2);
    expect(second.body.match(/<!-- size-admission:lane%2Fsize-admission /g)).toHaveLength(1);
    expectSizeNote(second.body);
  });

  it('301 non-test lines proceed with one split card naming PR and file groups, reviewers escalated and body noting both', async () => {
    const io = effects();
    const run = sizeAdmission.createSizeAdmissionRunner(io);
    const result = await run(request);
    expect(result).toMatchObject({ status: 'over', lines: 301, reviewLabel: 'review:pending', sha: 'pinned-sha' });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    const card = io.fileItem.mock.calls[0][0];
    expect(card).toMatchObject({ kind: 'story', size: expect.any(Number) });
    expect(card.title).toContain('#5854');
    expect(card.digest).toMatch(/scripts\/operations[^\n]*200/);
    expect(card.digest).toMatch(/docs\/agent[^\n]*101/);
    expect(card.scope).toContain('we:scripts/operations/a.mjs');
    expect(card.scope).not.toContain('a.test.mjs');
    expectSizeNote(result.body);
  });

  it('a new PR without a number names its ref in the split card', async () => {
    const io = effects();
    await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, pr: null });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(io.fileItem.mock.calls[0][0].title).toContain(request.ref);
  });

  it.each([
    ['exactly 300', '200\t100\tscripts/a.mjs\0', 300],
    ['test-only big diff', '1000\t0\tscripts/__tests__/a.mjs\0', 0],
    ['backlog-only big diff', '1000\t0\tbacklog/a.md\0', 1000],
  ])('%s does nothing: no card, reviewer escalation or Size section', async (_name, text, lines) => {
    const io = effects({ diffStat: vi.fn(() => text) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'ok', lines, body: request.body, reviewLabel: null });
    expect(io.fileItem).not.toHaveBeenCalled();
  });

  it.each([
    ['reader throws', () => { throw new Error('diff unavailable'); }],
    ['malformed evidence', () => '1\t0\tscripts/a.mjs\0truncated'],
    ['unmeasurable binary', () => '-\t-\tassets/image.png\0'],
  ])('unreadable diff (%s) proceeds, says size unknown, escalates reviewers and needs no card', async (_name, diffStat) => {
    const io = effects({ diffStat: vi.fn(diffStat) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'unknown', lines: null, reviewLabel: 'review:pending' });
    expect(result.body).toContain('size unknown: extra reviewers requested');
    expect(result.body).toMatch(/file groups/i);
    expect(result.body).toContain(request.body);
    expect(io.fileItem).not.toHaveBeenCalled();
  });

  it('card filing failure still proceeds and escalates with the filing reason in the body', async () => {
    const io = effects({ fileItem: vi.fn(() => { throw new Error('filing unavailable'); }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toContain('extra reviewers requested');
    expect(result.body).toMatch(/file groups[^\n]*200/i);
    expect(io.fileItem).toHaveBeenCalledTimes(1);
  });

  it('an unsuccessful file-item verdict also proceeds without claiming a card was filed', async () => {
    const io = effects({ fileItem: vi.fn(() => ({ verdict: { outcome: 'refused', reason: 'operation unavailable' } })) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).not.toMatch(/split card (?!not filed)\S+ filed/);
  });

  it('same-ref retries reuse the body marker across fresh runners: one card and one Size section', async () => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    const second = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: first.body });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(io.publishSplitCard).toHaveBeenCalledTimes(1);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
    expectSizeNote(second.body);
  });

  it('retains confirmed publication through unknown-size retries after the original batch has sealed', async () => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(first.body).toContain('<!-- size-published:lane%2Fsize-admission 9001 -->');
    const unknown = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: () => { throw new Error('unknown'); } }))({ ...request, body: first.body });
    io.publishSplitCard.mockRejectedValue(new Error('original batch sealed'));
    io.lookupSplitCard.mockReturnValue(null);
    const retry = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: unknown.body });
    expectSizeNote(retry.body);
    expect(io.publishSplitCard).toHaveBeenCalledTimes(1);
    expect(retry.body.match(/<!-- size-published:/g)).toHaveLength(1);
  });

  it('injected lookup reuses a card for the same ref even when the body has no marker', async () => {
    const io = effects({ lookupSplitCard: vi.fn(() => cardResult.verdict) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(io.lookupSplitCard).toHaveBeenCalledWith(expect.objectContaining({ ref: request.ref }));
    expect(io.fileItem).not.toHaveBeenCalled();
    expectSizeNote(result.body);
  });

  it('local split-card lookup keeps prefix-related refs lane/foobar and lane/foo distinct across fresh runners', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-split-refs-'));
    mkdirSync(join(cwd, 'backlog'));
    const fileItem = vi.fn((fields) => {
      const num = 9000 + fileItem.mock.calls.length;
      writeFileSync(join(cwd, 'backlog', `${num}-split.md`), fields.digest);
      return { verdict: { num } };
    });
    const run = (ref) => sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => evidence, fileItem,
      publishSplitCard: effects().publishSplitCard })({ ...request, ref, pr: null });
    try {
      expect((await run('lane/foobar')).body).toContain('split card 9001 filed');
      expect((await run('lane/foo')).body).toContain('split card 9002 filed');
      expect(fileItem).toHaveBeenCalledTimes(2);
      expect(fileItem.mock.calls[0][0].title).toContain('lane/foobar');
      expect(fileItem.mock.calls[1][0].title).toContain('lane/foo');
      // Exact-ref retries reuse their own durable card without a PR-body marker.
      expect((await run('lane/foobar')).body).toContain('split card 9001 filed');
      expect((await run('lane/foo')).body).toContain('split card 9002 filed');
      expect(fileItem).toHaveBeenCalledTimes(2);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('a different ref cannot inherit another ref’s split-card marker', async () => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, ref: 'lane/other', body: first.body });
    expect(io.fileItem).toHaveBeenCalledTimes(2);
  });
});

// Reader failures still reject evidence. Admission catches them as unknown; it must not
// weaken the audited measurement to get a non-blocking result.
function readerFixture({ numstat = '301\t0\tscripts/a.mjs\0', root = 'repo-top\n', read: override = () => undefined } = {}) {
  const git = vi.fn((args, options) => {
    const value = override(args, options);
    if (value !== undefined) return value;
    if (args.includes('--show-toplevel')) return root;
    if (args.includes('rev-parse')) return 'resolved-sha\n';
    if (args.includes('diff')) return numstat;
    if (args.includes('merge-base')) return 'base-sha\n';
    if (args.includes('ls-tree')) return `100644 blob ${args.includes('resolved-sha') ? 'a'.repeat(40) : 'b'.repeat(40)}\t${args.at(-1)}\0`;
    if (args.includes('cat-file')) return 'code\n';
    throw new Error(`unexpected git read: ${args}`);
  });
  const read = sizeAdmission.createPrDiffStatReader({ git });
  expect(read, 'shared reader factory must provide an evidence reader').toBeTypeOf('function');
  return { git, read: (extra = {}) => read({ base: 'main', sha: 'HEAD', ...extra }) };
}

describe('shared reader — retained sha, rename, binary and timeout audits', () => {
  it.each(['origin/main', 'origin/release/stable', 'upstream/main', 'refs/remotes/origin/main', 'refs/heads/main', 'refs/tags/base'])(
    'preserves qualified base %s despite an origin-prefixed shadow and escalates 301 lines', async (base) => {
      const { git, read } = readerFixture({ read: (args) => {
        if (args[0] === 'remote') return 'origin\nupstream\n';
        if (args.includes('diff')) return args.at(-1) === `${base}...resolved-sha` ? '301\t0\tREADME.md\0' : '';
      } });
      const io = effects({ diffStat: read });
      const result = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, base });
      expect(result).toMatchObject({ status: 'over', lines: 301, reviewLabel: 'review:pending' });
      expect(io.fileItem).toHaveBeenCalledTimes(1);
      expect(io.publishSplitCard).toHaveBeenCalledTimes(1);
      expect(result.body).toContain('split card 9001 filed');
      expect(git.mock.calls.some(([args]) => args.includes(`origin/${base}`))).toBe(false);
    });

  it('keeps a missing qualified base unknown instead of using its origin-prefixed shadow', async () => {
    const { read } = readerFixture({ read: (args) => {
      if (args.includes('diff')) {
        if (args.at(-1) === 'origin/missing...resolved-sha') throw new Error('unknown revision');
        return '';
      }
    } });
    const result = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: read }))({ ...request, base: 'origin/missing' });
    expect(result).toMatchObject({ status: 'unknown', lines: null, reviewLabel: 'review:pending' });
  });

  it.each([true, false])('retains remote-first resolution of an unqualified slash branch (remote exists: %s)', (exists) => {
    const { git, read } = readerFixture({ read: (args) => {
      if (args[0] === 'remote') return 'origin\nupstream\n';
      if (args.includes('--quiet') && !exists) throw new Error('no remote branch');
    } });
    read({ base: 'release/stable' });
    expect(git.mock.calls.find(([args]) => args.includes('diff'))[0].at(-1))
      .toBe(`${exists ? 'origin/' : ''}release/stable...resolved-sha`);
  });

  it('escalates unknown size when configured remotes cannot be read', async () => {
    const { git, read } = readerFixture({ read: (args) => {
      if (args[0] === 'remote') throw new Error('remote read failed');
    } });
    const result = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: read }))({ ...request, base: 'upstream/main' });
    expect(result).toMatchObject({ status: 'unknown', lines: null, reviewLabel: 'review:pending' });
    expect(git.mock.calls.some(([args]) => args.includes('diff'))).toBe(false);
  });

  it('pins the measured SHA, roots the diff, clears attributes and disables external diff/textconv', () => {
    const { git, read } = readerFixture();
    expect(read({ base: 'release', sha: 'moving-ref' })).toEqual({ text: '301\t0\tscripts/a.mjs\0', sha: 'resolved-sha' });
    expect(git.mock.calls).toEqual([
      [['rev-parse', '--verify', 'moving-ref^{commit}']],
      [['rev-parse', '--verify', '--quiet', 'origin/release']],
      [['rev-parse', '--show-toplevel']],
      [['-C', 'repo-top', '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', 'origin/release...resolved-sha'], { timeout: 60_000 }],
    ]);
  });

  it('rejects an unresolved commit before reading a diff', () => {
    const { git, read } = readerFixture({ read: () => { throw new Error('not a commit'); } });
    expect(() => read({ sha: 'missing' })).toThrow('not a commit');
    expect(git.mock.calls).toEqual([[['rev-parse', '--verify', 'missing^{commit}']]]);
  });

  it.each([' ', '\t', '\r', '\n'])('preserves repository trailing whitespace %j', (suffix) => {
    const root = `repo${suffix}`;
    const { git, read } = readerFixture({ root: `${root}\n` });
    expect(read().sha).toBe('resolved-sha');
    expect(git.mock.calls.find(([args]) => args.includes('diff'))[0].slice(0, 2)).toEqual(['-C', root]);
  });

  it('counts both binary blobs at the pinned SHA and merge base, preserving arbitrary bytes', () => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args, options) => {
      if (args.includes('cat-file')) {
        expect(options.encoding).toBe('latin1');
        return args.includes('a'.repeat(40)) ? '\xff\0\n'.repeat(301) : 'old\n';
      }
    } });
    const result = read();
    expect(result).toEqual({ text: '301\t1\tscripts/a.mjs\0', sha: 'resolved-sha' });
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree')).map(([args]) => args))
      .toEqual([
        ['-C', 'repo-top', 'ls-tree', '-z', '--full-tree', 'resolved-sha', '--', 'scripts/a.mjs'],
        ['-C', 'repo-top', 'ls-tree', '-z', '--full-tree', 'base-sha', '--', 'scripts/a.mjs'],
      ]);
  });

  it('binary rename reads the destination at head and source at base, without discarding either path', () => {
    const { git, read } = readerFixture({ numstat: '-\t-\t\0scripts/old.mjs\0scripts/new.mjs\0' });
    expect(read().text).toBe('1\t1\t\0scripts/old.mjs\0scripts/new.mjs\0');
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree')).map(([args]) => [args[5], args.at(-1)]))
      .toEqual([['resolved-sha', 'scripts/new.mjs'], ['base-sha', 'scripts/old.mjs']]);
  });

  it.each(['resolved-sha', 'base-sha'])('rejects failed binary tree reads at %s', (revision) => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('ls-tree') && args.includes(revision)) throw new Error('tree unavailable');
    } });
    expect(() => read()).toThrow('tree unavailable');
    expect(git).toHaveBeenCalledWith(expect.arrayContaining(['ls-tree', revision]), expect.any(Object));
  });

  it.each(['a'.repeat(40), 'b'.repeat(40)])('rejects failed binary blob reads for %s', (blob) => {
    const { read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('cat-file') && args.includes(blob)) throw new Error('blob unavailable');
    } });
    expect(() => read()).toThrow('blob unavailable');
  });

  it.each(['resolved-sha', 'base-sha'])('accepts a binary addition/deletion only after an empty tree proves the absent side at %s', (revision) => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('ls-tree') && args.includes(revision)) return '';
    } });
    expect(read().text).toBe(revision === 'resolved-sha' ? '0\t1\tscripts/a.mjs\0' : '1\t0\tscripts/a.mjs\0');
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree'))).toHaveLength(2);
    expect(git.mock.calls.filter(([args]) => args.includes('cat-file'))).toHaveLength(1);
  });

  it('bounds all binary fallback rows by one shared 60-second budget', () => {
    let elapsed = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0-\t-\tscripts/b.mjs\0', read: (args) => {
      if (args.includes('merge-base') || args.includes('ls-tree') || args.includes('cat-file')) elapsed += 10_000;
    } });
    expect(() => read()).toThrow(/timed out/);
    const fallback = git.mock.calls.filter(([args]) => args.includes('merge-base') || args.includes('ls-tree') || args.includes('cat-file'));
    expect(fallback.map(([, options]) => options.timeout)).toEqual([60_000, 50_000, 40_000, 30_000, 20_000, 10_000]);
    expect(fallback.at(-1)[0]).toEqual(expect.arrayContaining(['ls-tree', 'scripts/b.mjs']));
    expect(git.mock.calls.filter(([args]) => args.includes('cat-file'))).toHaveLength(2);
    expect(elapsed).toBe(60_000);
  });

  it('bounds the initial diff to 60 seconds and 64 MB without timing out unrelated git calls', () => {
    const exec = vi.fn((_command, args) => {
      if (args.includes('diff')) throw Object.assign(new Error('git timed out'), { code: 'ETIMEDOUT' });
      return Buffer.from(args.includes('--show-toplevel') ? 'repo-top\n' : 'resolved-sha\n');
    });
    const read = sizeAdmission.createPrDiffStatReader({ exec, cwd: '.' });
    expect(() => read({ base: 'main', sha: 'HEAD' })).toThrow('git timed out');
    expect(exec).toHaveBeenCalledTimes(4);
    for (const [command, args, options] of exec.mock.calls) {
      expect(command).toBe('git');
      expect(options.maxBuffer).toBe(64 * 1024 * 1024);
      if (args.includes('diff')) expect(options.timeout).toBe(60_000);
      else expect(options).not.toHaveProperty('timeout');
    }
  });
});

function encodedReader({ numstat, root = Buffer.from('repo\n'), entry, blob = Buffer.from('code\n') }) {
  const exec = vi.fn((_command, args, options) => {
    const output = args.includes('--show-toplevel') ? root
      : args.includes('rev-parse') ? Buffer.from('resolved-sha\n')
      : args.includes('diff') ? numstat
      : args.includes('merge-base') ? Buffer.from('base-sha\n')
      : args.includes('ls-tree') ? entry ?? Buffer.alloc(0)
      : args.includes('cat-file') ? blob : undefined;
    if (output === undefined) throw new Error(`unexpected git call: ${args}`);
    return options.encoding ? output.toString(options.encoding) : output;
  });
  const read = sizeAdmission.createPrDiffStatReader({ cwd: '.', exec });
  expect(read, 'shared reader factory must provide a lossless evidence reader').toBeTypeOf('function');
  return { exec, read: () => read({ base: 'main', sha: 'HEAD' }) };
}

describe('shared reader — lossless filename metadata', () => {
  it.each([
    ['truncated', [0xe2, 0x82]], ['overlong', [0xc0, 0xaf]],
    ['surrogate', [0xed, 0xa0, 0x80]], ['out-of-range', [0xf4, 0x90, 0x80, 0x80]],
  ])('rejects %s UTF-8 in numeric and binary paths before blob lookup', (_kind, bytes) => {
    for (const counts of ['301\t0\t', '-\t-\t']) {
      const { read, exec } = encodedReader({ numstat: Buffer.concat([Buffer.from(`${counts}production-`), Buffer.from(bytes), Buffer.from('.mjs\0')]) });
      expect(() => read()).toThrow();
      expect(exec.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(false);
    }
  });

  it.each([
    ['ordinary path', 'production-', '.mjs'],
    ['rename source', '\0production-', '.mjs\0replacement.mjs'],
    ['rename destination', '\0original.mjs\0production-', '.mjs'],
  ])('rejects lossy binary %s decoding before blob lookup', (_kind, prefix, suffix) => {
    const { read, exec } = encodedReader({ numstat: Buffer.concat([Buffer.from(`-\t-\t${prefix}`), Buffer.from([0xff]), Buffer.from(`${suffix}\0`)]) });
    expect(() => read()).toThrow();
    expect(exec.mock.calls.some(([, args]) => args.includes('ls-tree'))).toBe(false);
  });

  it('rejects invalid repository UTF-8 before using it as cwd', () => {
    const { read, exec } = encodedReader({ numstat: Buffer.from('1\t0\ta.mjs\0'), root: Buffer.concat([Buffer.from('repo-'), Buffer.from([0xff]), Buffer.from('\n')]) });
    expect(() => read()).toThrow();
    expect(exec.mock.calls.some(([, args]) => args.includes('diff'))).toBe(false);
  });

  it('rejects invalid tree metadata instead of accepting a substituted filename', () => {
    const { read } = encodedReader({ numstat: Buffer.from('-\t-\tproduction-\ufffd.mjs\0'),
      entry: Buffer.concat([Buffer.from(`100644 blob ${'a'.repeat(40)}\tproduction-`), Buffer.from([0xff]), Buffer.from('.mjs\0')]) });
    expect(() => read()).toThrow();
  });

  it.each(['production-\ufffd.mjs', '\ufeffproduction-é.mjs'])('preserves valid UTF-8 %j and arbitrary binary bytes', (path) => {
    const { read, exec } = encodedReader({ numstat: Buffer.from(`-\t-\t${path}\0`),
      entry: Buffer.from(`100644 blob ${'a'.repeat(40)}\t${path}\0`), blob: Buffer.concat([Buffer.from([0xff]), Buffer.from('\n'.repeat(301))]) });
    expect(read().text).toBe(`301\t301\t${path}\0`);
    expect(exec.mock.calls.filter(([, args]) => args.includes('ls-tree')).map(([, args]) => args.at(-1))).toEqual([path, path]);
  });
});

describe('shared reader — real git evidence', () => {
  function repo(probe) {
    const cwd = mkdtempSync(join(tmpdir(), 'size-admission-git-'));
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    const commit = (message) => {
      git(['add', '.']);
      git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', message]);
    };
    try {
      git(['init', '--quiet', '--initial-branch=main']);
      commit('base');
      git(['update-ref', 'refs/remotes/origin/main', 'main']);
      git(['checkout', '--quiet', '-b', 'lane/size-admission']);
      probe({ cwd, git, commit });
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  }

  it('counts production outside the cwd and roots backlog paths despite diff.relative=true', () => repo(({ cwd, git, commit }) => {
    git(['config', 'diff.relative', 'true']);
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'production.mjs'), 'code\n'.repeat(301));
    writeFileSync(join(cwd, 'backlog/card.md'), 'card\n'.repeat(400));
    commit('oversized');
    expect(git(['-C', join(cwd, 'backlog'), 'diff', '--numstat', '-z', 'main...HEAD'])).toBe('400\t0\tcard.md\0');
    const read = sizeAdmission.createPrDiffStatReader({ cwd: join(cwd, 'backlog') });
    expect(read).toBeTypeOf('function');
    const result = read({ base: 'main', sha: 'HEAD' });
    expect(sizeAdmission.measureNonTestLines(result.text)).toEqual({ lines: 701, exempt: false });
    expect(result.sha).toBe(git(['rev-parse', 'HEAD']).trim());
    git(['rm', '--quiet', 'production.mjs']);
    commit('backlog only');
    expect(sizeAdmission.measureNonTestLines(read({ base: 'main', sha: 'HEAD' }).text)).toEqual({ lines: 400, exempt: true });
  }));

  it.each(['worktree -diff', 'worktree binary', 'info -diff', 'global -diff', 'NUL bytes'])(
    'binary fallback counts hidden production content despite %s', (kind) => repo(({ cwd, git, commit }) => {
      if (kind.startsWith('worktree')) writeFileSync(join(cwd, '.gitattributes'), `production.mjs ${kind === 'worktree binary' ? 'binary' : '-diff'}\n`);
      if (kind === 'info -diff') writeFileSync(join(cwd, '.git/info/attributes'), 'production.mjs -diff\n');
      if (kind === 'global -diff') {
        writeFileSync(join(cwd, 'global-attributes'), 'production.mjs -diff\n');
        git(['config', 'core.attributesFile', join(cwd, 'global-attributes')]);
      }
      writeFileSync(join(cwd, 'production.mjs'), `${kind === 'NUL bytes' ? '\0' : ''}${'code\n'.repeat(301)}`);
      commit('oversized');
      expect(git(['diff', '--numstat', '-z', 'main...HEAD'])).toContain('-\t-\tproduction.mjs\0');
      const read = sizeAdmission.createPrDiffStatReader({ cwd });
      expect(read).toBeTypeOf('function');
      const measured = sizeAdmission.measureNonTestLines(read({ base: 'main', sha: 'HEAD' }).text);
      // Attribute files can contribute additional lines; the production count itself must survive.
      expect(measured.lines).toBeGreaterThanOrEqual(301);
      expect(measured.exempt).toBe(false);
    }),
  );

  it('preserves a non-ASCII backlog path and counts a 400-line production rename with two changed lines as two', () => repo(({ cwd, git, commit }) => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}\n`);
    writeFileSync(join(cwd, 'old.mjs'), lines.join(''));
    commit('production base');
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'backlog/é.md'), 'card\n'.repeat(400));
    commit('card');
    const read = sizeAdmission.createPrDiffStatReader({ cwd });
    expect(read).toBeTypeOf('function');
    expect(sizeAdmission.measureNonTestLines(read({ base: 'main', sha: 'HEAD' }).text)).toEqual({ lines: 400, exempt: true });
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    renameSync(join(cwd, 'old.mjs'), join(cwd, 'new.mjs'));
    lines[200] = 'changed\n';
    writeFileSync(join(cwd, 'new.mjs'), lines.join(''));
    commit('rename');
    const result = read({ base: 'main', sha: 'HEAD' });
    expect(result.text).toBe('1\t1\t\0old.mjs\0new.mjs\0');
    expect(sizeAdmission.measureNonTestLines(result.text)).toEqual({ lines: 2, exempt: false });
  }));
});
