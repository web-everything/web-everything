/** Phase 1 RED contracts: the shared size home is intentionally a behavior-free stub. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { createHash } from 'node:crypto';
import { planFileItem } from '../../operations/file-item.mjs';
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
const HEAD_SHA = '1'.repeat(40), BASE_SHA = '2'.repeat(40);
const cardKey = (sha = HEAD_SHA, repo = 'web-everything/web-everything') => createHash('sha256').update(JSON.stringify([repo, sha])).digest('hex');
const KEY = cardKey();
// The written marker binds the key to a digest of the exact Size section it closes.
const MARKER = new RegExp(`<!-- size-admission:${KEY} [a-f0-9]{64} -->`);
const request = { ref: 'lane/size-admission', pr: 5854, base: 'main', sha: HEAD_SHA, body: 'Existing PR description.', repo: 'web-everything/web-everything' };
const cardResult = { verdict: { num: 9001, id: 'xsplit1', rel: 'backlog/xsplit1-split.md' } };
function effects(overrides = {}) {
  // The real producer always supplies frozen evidence and a durable card store.
  // Keep those contracts in retry fixtures rather than treating an editable body as storage.
  const cards = new Map();
  const reader = overrides.diffStat || (() => ({ text: evidence, sha: HEAD_SHA, baseSha: BASE_SHA }));
  return {
    ...overrides,
    diffStat: vi.fn((input) => {
      const result = reader(input);
      return typeof result === 'string' ? { text: result, sha: HEAD_SHA, baseSha: BASE_SHA } : result;
    }),
    fileItem: overrides.fileItem || vi.fn((fields) => {
      const key = /^size-split-key:([a-f0-9]{64})\. /.exec(fields.digest)?.[1];
      cards.set(key, cardResult.verdict);
      return cardResult;
    }),
    lookupSplitCard: overrides.lookupSplitCard || vi.fn(({ key }) => cards.get(key) || null),
    publishSplitCard: overrides.publishSplitCard || vi.fn(async () => ({ batched: true, batchRef: 'lane/card-batch-filing-1' })),
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
    expect(result.body).toMatch(MARKER);
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
    expect(result.body).toMatch(MARKER);
    io.publishSplitCard.mockResolvedValue({ batched: true, batchRef: 'lane/card-batch-filing-1' });
    expectSizeNote((await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: result.body })).body);
    expect(io.fileItem).not.toHaveBeenCalled();
  });

  it('reports the durably published member when concurrent filers created different local card ids', async () => {
    const io = effects({ publishSplitCard: async () => ({ batched: true, deduped: true,
      member: { cardId: 'xwinner' }, batchRef: 'lane/card-batch-filing-1' }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.body).toContain('split card xwinner filed via lane/card-batch-filing-1');
    expect(result.body).toMatch(MARKER);
    expect(result.body).not.toContain('split card 9001 filed');
  });

  it.each([undefined, { cardId: 'bad\nidentity' }])('does not claim publication when a deduplicated member lacks a safe identity (%j)', async (member) => {
    const io = effects({ publishSplitCard: async () => ({ batched: true, deduped: true, member }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(result.body).toMatch(MARKER);
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
    writeFileSync(join(cwd, cardResult.verdict.rel), `size-split-key:${KEY}. File groups: we:scripts: 301`);
    vi.mocked(execFileSync).mockReturnValue(''); // absent from the canonical remote base
    vi.mocked(fileIntoBatch).mockImplementation(async () => {
      if (mode === 'exception') throw new Error('publication failed');
      return { batched: false, reason: 'batch unavailable' };
    });
    const fileItem = vi.fn();
    try {
      const result = await sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => ({ text: evidence, sha: HEAD_SHA, baseSha: BASE_SHA }), fileItem })(request);
      expect(result).toMatchObject({ status: 'over', reviewLabel: 'review:pending' });
      expect(result.body).toContain('split card not filed (file-item failed)');
      expect(result.body).toMatch(MARKER);
      expect(fileItem).not.toHaveBeenCalled();
      vi.mocked(fileIntoBatch).mockResolvedValue({ batched: true, batchRef: 'lane/card-batch-filing-1' });
      expectSizeNote((await sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => ({ text: evidence, sha: HEAD_SHA, baseSha: BASE_SHA }), fileItem })({ ...request, body: result.body })).body);
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
        expect(args).toEqual(['ls-tree', '-z', '--full-tree', BASE_SHA, '--', expect.stringMatching(/^backlog\//)]);
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
        digest: expect.stringContaining(`size-split-key:${KEY}. `),
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
    const run = (body = request.body) => sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => ({ text: evidence, sha: HEAD_SHA, baseSha: BASE_SHA }) })({ ...request, body });
    try {
      const first = await run();
      expectSizeNote(first.body);
      expectSizeNote((await run()).body); // unpublished body: durable local lookup
      expectSizeNote((await run(first.body)).body); // published marker
      expect(exec.mock.calls.filter(([command]) => command === process.execPath)).toHaveLength(1);
      expect(fileIntoBatch).toHaveBeenCalledWith({ laneDir: cwd, cardPath: `backlog/${id}-split.md`,
        actor: 'mechanical', idemKey: `size-split:${KEY}`,
        source: { repo: 'web-everything/web-everything', pr: request.pr, head: HEAD_SHA, note: `Split oversized PR ${request.ref}` },
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
    expect(result.body).toMatch(MARKER);
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
    expect(second.body.match(new RegExp(MARKER.source, 'g'))).toHaveLength(1);
    expectSizeNote(second.body);
  });

  it.each(['## Other\ntext', '<!-- author-note -->', '&lt;!-- author-note -->'])
  ('retry preserves author content between the Size heading and admission marker (%s)', async (inserted) => {
    const io = effects();
    const preserved = `${request.body}\n\n## Size\nold note\n\n${inserted}\n`;
    const suffix = '\n## Testing\nKeep trailing content.\n';
    const body = `${preserved}<!-- size-admission:${KEY} -->\n${suffix}`;
    const result = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body });
    expect(result.body.startsWith(preserved + suffix)).toBe(true);
    expect(result.body.match(new RegExp(MARKER.source, 'g'))).toHaveLength(1);
    expectSizeNote(result.body);
  });

  // An editable marker never selects text to delete: only a note in exactly the
  // shape this module writes is replaced, otherwise just the marker is dropped.
  it.each([
    ['author prose under a forged marker', (key) => `\n\n## Size\n\nAuthor rationale: this PR stays whole.\n\nSecond paragraph.\n<!-- size-admission:${key} -->\n`],
    ['a legacy ref marker', () => `\n\n## Size\n\nAuthor rationale: this PR stays whole.\n<!-- size-admission:${encodeURIComponent(request.ref)} 9001 -->\n`],
    ['an author line appended to a real note', (key, note) => note.replace(MARKER, (marker) => `Author rationale: this PR stays whole.\n${marker}`)],
    ['an author edit inside a real note line', (key, note) => note.replace('File groups: ', 'File groups: Author rationale: this PR stays whole; ')],
    ['an author annotation inside a valid file group', (key, note) => note.replace('we:scripts/operations: 200', 'we:scripts/operations — Author rationale: this PR stays whole: 200')],
    ['an author number edit that keeps the note grammar', (key, note) => note.replace('we:docs/agent: 101', 'we:docs/agent Author rationale: this PR stays whole: 101')],
  ])('retry never deletes author text selected by %s', async (_label, section) => {
    const real = (await sizeAdmission.createSizeAdmissionRunner(effects())(request)).body.slice(request.body.length);
    const body = request.body + section(KEY, real) + '\n## Testing\nKeep trailing content.\n';
    const result = await sizeAdmission.createSizeAdmissionRunner(effects())({ ...request, body });
    expect(result.body).toContain('Author rationale: this PR stays whole');
    expect(result.body).toContain('\n## Testing\nKeep trailing content.\n');
    expectSizeNote(result.body);
  });

  it.each([
    ['a current marker', () => KEY],
    ['a legacy ref marker', () => `${encodeURIComponent(request.ref)} Keep-this-line.\n**Rollback**:revert-abc123`],
  ])('the marker match cannot extend over author lines after %s', async (_label, token) => {
    const real = (await sizeAdmission.createSizeAdmissionRunner(effects())(request)).body;
    const tail = '\nDo-not-merge-before-Friday.\nhttps://ex.com/runbook -->\n';
    const body = real.replace(new RegExp(`${MARKER.source}\n`), `<!-- size-admission:${token()} -->${tail}`);
    const result = await sizeAdmission.createSizeAdmissionRunner(effects())({ ...request, body });
    expect(result.body).toContain('Do-not-merge-before-Friday.\nhttps://ex.com/runbook');
    if (token() !== KEY) expect(result.body).toContain('**Rollback**:revert-abc123');
    expectSizeNote(result.body);
  });

  it('drops a legacy marker whose encoded ref is far longer than the ref itself', async () => {
    const ref = `lane/${'ü'.repeat(120)}`;
    const body = `${request.body}\n\n## Size\n\nstale\n<!-- size-admission:${encodeURIComponent(ref)} 9001 -->\n`;
    const result = await sizeAdmission.createSizeAdmissionRunner(effects())({ ...request, ref, body });
    expect(result.body).not.toContain(encodeURIComponent(ref));
    expect(result.body).toContain('stale');
  });

  it.each([
    ['CRLF line endings from a web edit', (body) => body.replace(/\n/g, '\r\n')],
    ['a forge-trimmed empty description', (body) => body.replace(/^\n+/, '')],
  ])('retry replaces its own note after %s instead of stacking another', async (_label, edit) => {
    const base = { ...request, body: _label.includes('empty') ? '' : request.body };
    const first = await sizeAdmission.createSizeAdmissionRunner(effects())(base);
    const second = await sizeAdmission.createSizeAdmissionRunner(effects())({ ...base, body: edit(first.body) });
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
    expect(second.body).not.toContain('\r');
  });

  it('retry replaces its own note when the only file group is over the summary budget', async () => {
    const name = '_'.repeat(700);
    const io = effects({ diffStat: () => `400\t0\t${name}/${name}/f\0` });
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(first.body).toContain('File groups: ; and 1 more (1 group omitted; summary budget)');
    const second = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: first.body });
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
  });

  it('a copied marker earlier in the body cannot redirect the replacement away from the real note', async () => {
    const first = await sizeAdmission.createSizeAdmissionRunner(effects())(request);
    const quote = `\n\n## Size\n\nQuoted for reviewers:\n<!-- size-admission:${KEY} -->\n`;
    const body = request.body + quote + first.body.slice(request.body.length);
    const result = await sizeAdmission.createSizeAdmissionRunner(effects())({ ...request, body });
    expect(result.body).toContain(quote);
    expect(result.body.match(/301 non-test lines/g)).toHaveLength(1);
    expectSizeNote(result.body);
  });

  it('301 non-test lines proceed with one split card naming PR and file groups, reviewers escalated and body noting both', async () => {
    const io = effects();
    const run = sizeAdmission.createSizeAdmissionRunner(io);
    const result = await run(request);
    expect(result).toMatchObject({ status: 'over', lines: 301, reviewLabel: 'review:pending', sha: '1111111111111111111111111111111111111111' });
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
  ])('unreadable diff (%s) proceeds, says size unknown, escalates reviewers and files conservatively', async (_name, diffStat) => {
    const io = effects({ diffStat: vi.fn(diffStat) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(result).toMatchObject({ status: 'unknown', lines: null, reviewLabel: 'review:pending' });
    expect(result.body).toContain('size unknown: extra reviewers requested');
    expect(result.body).toMatch(/file groups/i);
    expect(result.body).toContain(request.body);
    expect(io.fileItem).toHaveBeenCalledOnce();
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

  it.each([false, true])('first run with pr=null then re-run with pr=N on the same head files exactly ONE card (saved body: %s)', async (savedBody) => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, pr: null });
    const second = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request,
      body: savedBody ? first.body : request.body });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(io.publishSplitCard).toHaveBeenCalledTimes(2);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
    expectSizeNote(second.body);
  });

  it('same-head retries reuse the card store across fresh runners: one card and one Size section', async () => {
    const io = effects();
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    const second = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: first.body });
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(io.publishSplitCard).toHaveBeenCalledTimes(2);
    expect(second.body.match(/^## Size$/gm)).toHaveLength(1);
    expectSizeNote(second.body);
  });

  it('retains confirmed publication through unknown-size retries after the original batch has sealed', async () => {
    const io = effects();
    delete io.publishSplitCard;
    vi.mocked(execFileSync).mockReturnValue(`100644 blob ${'a'.repeat(40)}\t${cardResult.verdict.rel}\0`);
    vi.mocked(fileIntoBatch).mockClear();
    vi.mocked(fileIntoBatch).mockRejectedValue(new Error('original batch sealed'));
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    expect(first.body).toContain(`<!-- size-published:${KEY} -->`);
    const unknown = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: () => { throw new Error('unknown'); } }))({ ...request, body: first.body });
    const retry = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, body: unknown.body });
    expectSizeNote(retry.body);
    expect(io.fileItem).toHaveBeenCalledTimes(1);
    expect(fileIntoBatch).not.toHaveBeenCalled();
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
    const run = (ref) => sizeAdmission.createSizeAdmissionRunner({ cwd, diffStat: () => ({ text: evidence, sha: ref === 'lane/foo' ? BASE_SHA : HEAD_SHA, baseSha: BASE_SHA }), fileItem,
      publishSplitCard: effects().publishSplitCard })({ ...request, ref, pr: null, sha: ref === 'lane/foo' ? BASE_SHA : HEAD_SHA });
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

  it('a different head cannot inherit another head’s split-card marker', async () => {
    const io = effects({ diffStat: ({ sha }) => ({ text: evidence, sha, baseSha: BASE_SHA }) });
    const first = await sizeAdmission.createSizeAdmissionRunner(io)(request);
    await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, ref: 'lane/other', pr: 5855, sha: '3'.repeat(40), body: first.body });
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
    if (args.includes('rev-parse')) return args.some((a) => /refs\/(remotes|tags)\/|refs\/heads\/main/.test(a)) ? `${BASE_SHA}\n` : `${HEAD_SHA}\n`;
    if (args.includes('diff')) return numstat;
    if (args.includes('merge-base')) return '2222222222222222222222222222222222222222\n';
    if (args.includes('ls-tree')) return `100644 blob ${args.includes('1111111111111111111111111111111111111111') ? 'a'.repeat(40) : 'b'.repeat(40)}\t${args.at(-1)}\0`;
    if (args.includes('cat-file')) return 'code\n';
    throw new Error(`unexpected git read: ${args}`);
  });
  const read = sizeAdmission.createPrDiffStatReader({ git });
  expect(read, 'shared reader factory must provide an evidence reader').toBeTypeOf('function');
  return { git, read: (extra = {}) => read({ base: 'main', sha: 'HEAD', ...extra }) };
}

describe('shared reader — retained sha, rename, binary and timeout audits', () => {
  it.each(['origin/main', 'origin/release/stable', 'upstream/main', 'refs/remotes/origin/main', 'refs/heads/main', 'refs/tags/base'])(
    'qualifies remote base %s despite a shadow, or escalates unknown for a nonremote base', async (base) => {
      const { git, read } = readerFixture({ read: (args) => {
        if (args[0] === 'remote') return 'origin\nupstream\n';
        if (args.includes('diff')) return args.includes(`${BASE_SHA}...${HEAD_SHA}`) ? '301\t0\tREADME.md\0' : '';
      } });
      const io = effects({ diffStat: read });
      const result = await sizeAdmission.createSizeAdmissionRunner(io)({ ...request, base });
      expect(result).toMatchObject({
        status: /^refs\/(heads|tags)\//.test(base) ? 'unknown' : 'over',
        lines: /^refs\/(heads|tags)\//.test(base) ? null : 301, reviewLabel: 'review:pending',
      });
      expect(io.fileItem).toHaveBeenCalledTimes(1);
      expect(io.publishSplitCard).toHaveBeenCalledTimes(1);
      expect(result.body).toContain('split card 9001 filed');
      expect(git.mock.calls.some(([args]) => args.includes(`origin/${base}`))).toBe(false);
    });

  it('keeps a missing qualified base unknown instead of using its origin-prefixed shadow', async () => {
    const { read } = readerFixture({ read: (args) => {
      if (args.some((a) => a.includes('refs/remotes/origin/missing'))) throw new Error('unknown revision');
    } });
    const result = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: read }))({ ...request, base: 'origin/missing' });
    expect(result).toMatchObject({ status: 'unknown', lines: null, reviewLabel: 'review:pending' });
  });

  it.each([true, false])('resolves the real remote for an unqualified slash branch, failing closed if absent (remote exists: %s)', (exists) => {
    const { git, read } = readerFixture({ read: (args) => {
      if (args[0] === 'remote') return 'origin\nupstream\n';
      if (args.some((a) => a.includes('refs/remotes/origin/release/stable')) && !exists) throw new Error('no remote branch');
    } });
    if (exists) {
      read({ base: 'release/stable' });
      expect(git.mock.calls.find(([args]) => args.includes('diff'))[0]).toContain(`${BASE_SHA}...${HEAD_SHA}`);
    } else {
      expect(() => read({ base: 'release/stable' })).toThrow('no remote branch');
      expect(git.mock.calls.some(([args]) => args.includes('diff'))).toBe(false);
    }
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
    expect(read({ base: 'release', sha: 'moving-ref' })).toEqual({ text: '301\t0\tscripts/a.mjs\0', sha: HEAD_SHA, baseSha: BASE_SHA });
    expect(git.mock.calls).toEqual([
      [['rev-parse', '--verify', '--end-of-options', 'refs/heads/moving-ref^{commit}']],
      [['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/release^{commit}']],
      [['rev-parse', '--show-toplevel']],
      [['-C', 'repo-top', '-c', 'core.attributesFile=', 'diff', '--no-relative', '--text', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', `${BASE_SHA}...${HEAD_SHA}`, '--'], { timeout: 60_000 }],
    ]);
  });

  it('rejects an unresolved commit before reading a diff', () => {
    const { git, read } = readerFixture({ read: () => { throw new Error('not a commit'); } });
    expect(() => read({ sha: 'missing' })).toThrow('not a commit');
    expect(git.mock.calls).toEqual([[['rev-parse', '--verify', '--end-of-options', 'refs/heads/missing^{commit}']]]);
  });

  it.each([' ', '\t', '\r', '\n'])('preserves repository trailing whitespace %j', (suffix) => {
    const root = `repo${suffix}`;
    const { git, read } = readerFixture({ root: `${root}\n` });
    expect(read().sha).toBe('1111111111111111111111111111111111111111');
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
    expect(result).toEqual({ text: '301\t1\tscripts/a.mjs\0', sha: HEAD_SHA, baseSha: BASE_SHA });
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree')).map(([args]) => args))
      .toEqual([
        ['--literal-pathspecs', '-C', 'repo-top', 'ls-tree', '-z', '--full-tree', '1111111111111111111111111111111111111111', '--', 'scripts/a.mjs'],
        ['--literal-pathspecs', '-C', 'repo-top', 'ls-tree', '-z', '--full-tree', '2222222222222222222222222222222222222222', '--', 'scripts/a.mjs'],
      ]);
  });

  it('binary rename reads the destination at head and source at base, without discarding either path', () => {
    const { git, read } = readerFixture({ numstat: '-\t-\t\0scripts/old.mjs\0scripts/new.mjs\0' });
    expect(read().text).toBe('1\t1\t\0scripts/old.mjs\0scripts/new.mjs\0');
    expect(git.mock.calls.filter(([args]) => args.includes('ls-tree')).map(([args]) => [args.find((a) => /^[a-f0-9]{40}$/.test(a)), args.at(-1)]))
      .toEqual([['1111111111111111111111111111111111111111', 'scripts/new.mjs'], ['2222222222222222222222222222222222222222', 'scripts/old.mjs']]);
  });

  it.each(['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222'])('rejects failed binary tree reads at %s', (revision) => {
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

  it.each(['1111111111111111111111111111111111111111', '2222222222222222222222222222222222222222'])('accepts a binary addition/deletion only after an empty tree proves the absent side at %s', (revision) => {
    const { git, read } = readerFixture({ numstat: '-\t-\tscripts/a.mjs\0', read: (args) => {
      if (args.includes('ls-tree') && args.includes(revision)) return '';
    } });
    expect(read().text).toBe(revision === '1111111111111111111111111111111111111111' ? '0\t1\tscripts/a.mjs\0' : '1\t0\tscripts/a.mjs\0');
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
      return Buffer.from(args.includes('--show-toplevel') ? 'repo-top\n' : '1111111111111111111111111111111111111111\n');
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
      : args.includes('rev-parse') ? Buffer.from('1111111111111111111111111111111111111111\n')
      : args.includes('diff') ? numstat
      : args.includes('merge-base') ? Buffer.from('2222222222222222222222222222222222222222\n')
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


describe('size admission trust boundaries', () => {
  const head = '1'.repeat(40), baseSha = '2'.repeat(40);
  const frozen = { ...request, sha: head, repo: 'owner/repository' };
  const over = { text: evidence, sha: head, baseSha };

  it('hostile branch names stay inert and bounded at card and PR-body sinks', async () => {
    const ref = 'lane/`$(touch-pwn)`<img>-->' + '界'.repeat(20_000);
    const io = effects({ diffStat: () => over });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)({ ...frozen, pr: null, ref });
    expect(result.reviewLabel).toBe('review:pending');
    for (const field of Object.values(io.fileItem.mock.calls[0][0])) {
      expect(Buffer.byteLength(String(field))).toBeLessThan(16_384);
      expect(String(field)).not.toMatch(/<img>|`|\$\(/);
    }
    expect(Buffer.byteLength(result.body)).toBeLessThan(16_384);
    expect(result.body).not.toContain('<img>');
  });

  it.each(['scripts/quote"\\:---\n---\n# {hostile}.mjs', 'scripts/n\u0085l\u2028p\u2029control\u0001\u007f\u009f\ufffe\uffff.mjs  '])(
    'YAML-breaking filename %j round-trips through the actual file-item renderer', async (path) => {
    let content;
    const cwd = mkdtempSync(join(tmpdir(), 'size-yaml-'));
    mkdirSync(join(cwd, 'backlog'));
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      expect(command).toBe(process.execPath);
      const fields = Object.fromEntries(args.slice(2, -1).map((arg) => {
        const at = arg.indexOf('=');
        return [arg.slice(2, at), arg.slice(at + 1)];
      }));
      const verdict = planFileItem({ existingIds: [], today: '2026-10-25' }, fields);
      content = verdict.content;
      writeFileSync(join(cwd, verdict.rel), content);
      return JSON.stringify({ verdict });
    });
    const io = effects({ cwd, diffStat: () => ({ ...over, text: `301\t0\t${path}\0` }) });
    delete io.fileItem;
    try {
      const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
      expect(result.body).toMatch(/split card \w+ filed/);
      const frontmatter = yaml.safeLoad(content.split('\n---\n')[0].slice(4));
      expect(frontmatter.scope).toEqual([`we:${path}`]);
      expect(frontmatter.kind).toBe('story');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('a trailing newline in a file-item card id cannot reach publication', async () => {
    const io = effects({ diffStat: () => over, fileItem: () => ({ verdict: { id: '9001\n' } }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
    expect(io.publishSplitCard).not.toHaveBeenCalled();
    expect(result.body).toContain('split card not filed (file-item failed)');
  });

  it('a trailing newline in a file-item card path cannot reach Git or batching', async () => {
    const io = effects({ diffStat: () => over,
      fileItem: () => ({ verdict: { id: 'xsplit1', rel: 'backlog/xsplit1-split.md\n' } }) });
    delete io.publishSplitCard;
    vi.mocked(execFileSync).mockReturnValue(`100644 blob ${'a'.repeat(40)}\tbacklog/xsplit1-split.md\n\0`);
    vi.mocked(fileIntoBatch).mockClear();
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
    expect(result.body).toContain('split card not filed (file-item failed)');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fileIntoBatch).not.toHaveBeenCalled();
  });

  it('a trailing newline in a returned batch ref cannot enter the PR note', async () => {
    const io = effects({ diffStat: () => over,
      publishSplitCard: async () => ({ batched: true, batchRef: 'lane/batch\n' }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
    expect(result.body).toContain('split card 9001 filed');
    expect(result.body).not.toContain('via lane/batch');
  });

  it.each(['\r', '\r\n', '\u2028', '\u2029', '\nextra'])(
    'trailing suffix %j is rejected for card ids, paths and batch refs', async (suffix) => {
      const idIo = effects({ diffStat: () => over,
        fileItem: () => ({ verdict: { id: `9001${suffix}` } }) });
      const idResult = await sizeAdmission.createSizeAdmissionRunner(idIo)(frozen);
      expect(idIo.publishSplitCard).not.toHaveBeenCalled();
      expect(idResult.body).toContain('split card not filed (file-item failed)');
      expect(idResult.reviewLabel).toBe('review:pending');

      const pathIo = effects({ diffStat: () => over,
        fileItem: () => ({ verdict: { id: 'xsplit1', rel: `backlog/xsplit1-split.md${suffix}` } }) });
      delete pathIo.publishSplitCard;
      vi.mocked(execFileSync).mockReturnValue(`100644 blob ${'a'.repeat(40)}\tbacklog/xsplit1-split.md${suffix}\0`);
      vi.mocked(fileIntoBatch).mockClear();
      const pathResult = await sizeAdmission.createSizeAdmissionRunner(pathIo)(frozen);
      expect(pathResult.body).toContain('split card not filed (file-item failed)');
      expect(pathResult.reviewLabel).toBe('review:pending');
      expect(execFileSync).not.toHaveBeenCalled();
      expect(fileIntoBatch).not.toHaveBeenCalled();

      const refIo = effects({ diffStat: () => over,
        publishSplitCard: async () => ({ batched: true, batchRef: `lane/batch${suffix}` }) });
      const refResult = await sizeAdmission.createSizeAdmissionRunner(refIo)(frozen);
      expect(refResult.body).toContain('split card 9001 filed');
      expect(refResult.body).not.toContain('via lane/batch');
      expect(refResult.reviewLabel).toBe('review:pending');
    });

  it('size admission preserves oversized existing descriptions', async () => {
    const section = '## Evidence\n\n* keep `this` & <that> [link](x) #1\r\n';
    const long = `${section.repeat(Math.ceil(50_000 / section.length))}\n## Testing\n\nKeep this trailing section.\n`;
    const appended = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: () => over }))({ ...frozen, body: long });
    expect(appended.body.startsWith(long)).toBe(true);
    expect(appended.body.slice(long.length)).toMatch(/^\n\n## Size\n\n301 non-test lines/);
    expect(appended.reviewLabel).toBe('review:pending');

    // Past the forge limit nothing is appended: the body is returned unchanged, so no edit is made.
    for (const status of ['over', 'unknown']) {
      const atLimit = '界'.repeat(65_536 - 100);
      const diffStat = status === 'over' ? () => over : () => { throw new Error('unavailable'); };
      const result = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat }))({ ...frozen, body: atLimit });
      expect(result.body).toBe(atLimit);
      expect(result).toMatchObject({ status, reviewLabel: 'review:pending' });
    }
  });

  it('a throw outside the inner handlers returns the original body unchanged and requests reviewers', async () => {
    const poisoned = { ...frozen, body: 'Author description.\n\n## Testing\nKeep.', get repo() { throw new Error('poisoned'); } };
    const result = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: () => over }))(poisoned);
    expect(result).toEqual({ status: 'unknown', lines: null, reviewLabel: 'review:pending', body: poisoned.body });
  });

  it('comma-bearing paths are omitted with exact accounting', async () => {
    const io = effects({ diffStat: () => ({ ...over, text: '200\t0\tscripts/keep.mjs\0' + '101\t0\tscripts/a,b.mjs\0' }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
    const fields = io.fileItem.mock.calls[0][0];
    expect(fields.scope).toBe('we:scripts/keep.mjs');
    expect(fields.scope).not.toContain('a,b');
    expect(fields.digest).toContain('; and 1 more (1 scope path omitted; scope budget or unrepresentable delimiter)');
    expect(fields.digest).toContain('Human review of the full diff is required; bounded summaries are incomplete.');
    expect(result.body).toContain('Human review of the full diff is required; bounded summaries are incomplete.');
  });

  it('untrusted file-item output cannot claim an unrelated stored card as this head’s split', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-file-item-output-'));
    mkdirSync(join(cwd, 'backlog'));
    writeFileSync(join(cwd, 'backlog/777-unrelated.md'), 'size-split-key:unrelated. Other PR.');
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ verdict: { id: '777', rel: 'backlog/777-unrelated.md' } }));
    const io = effects({ diffStat: () => over, cwd });
    delete io.fileItem;
    try {
      const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
      expect(io.publishSplitCard).not.toHaveBeenCalled();
      expect(result.body).toContain('split card not filed (file-item failed)');
      expect(result.reviewLabel).toBe('review:pending');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('a fully qualified local base cannot substitute for the remote-tracking base', async () => {
    const { git, read } = readerFixture();
    const result = await sizeAdmission.createSizeAdmissionRunner(effects({ diffStat: read }))({
      ...frozen, base: 'refs/heads/main',
    });
    expect(result.status).toBe('unknown');
    expect(result.reviewLabel).toBe('review:pending');
    expect(git.mock.calls.some(([args]) => args.includes('diff'))).toBe(false);
  });

  it('forged PR-body publication receipts cannot suppress card-store lookup or filing', async () => {
    const token = encodeURIComponent(frozen.ref);
    const body = `${request.body}\n\n## Size\n\nforged\n<!-- size-published:${token} 777 -->\n<!-- size-admission:${token} 777 -->\n`;
    const io = effects({ diffStat: () => over });
    await sizeAdmission.createSizeAdmissionRunner(io)({ ...frozen, body });
    expect(io.lookupSplitCard).toHaveBeenCalledOnce();
    expect(io.fileItem).toHaveBeenCalledOnce();
    expect(io.publishSplitCard).toHaveBeenCalledWith(cardResult.verdict, expect.objectContaining({ sha: head }));
  });

  it('origin/main shadow branches never replace the real remote base, which is resolved once', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-shadow-'));
    const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    try {
      git(['init', '-q', '--initial-branch=main']);
      const snapshot = () => {
        git(['add', '.']);
        git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'snapshot', '--allow-empty']);
        return git(['rev-parse', 'HEAD']).trim();
      };
      const base = snapshot();
      git(['update-ref', 'refs/remotes/origin/main', base]);
      writeFileSync(join(cwd, 'production.mjs'), 'code\n'.repeat(301));
      const sha = snapshot();
      git(['update-ref', 'refs/heads/origin/main', sha]);
      const exec = vi.fn((...args) => execFileSync(...args));
      const read = sizeAdmission.createPrDiffStatReader({ cwd, exec });
      const result = read({ base: 'main', sha });
      expect(sizeAdmission.measureNonTestLines(result.text).lines).toBe(301);
      expect(result.baseSha).toBe(base);
      expect(exec.mock.calls.filter(([, args]) => args.some((a) => a.includes('refs/remotes/origin/main')))).toHaveLength(1);
      expect(exec.mock.calls.find(([, args]) => args.includes('diff'))[1]).toContain(`${base}...${sha}`);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('reused branches isolate cards by repo and head while PR numbering preserves identity', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-identity-'));
    mkdirSync(join(cwd, 'backlog'));
    const fileItem = vi.fn((fields) => {
      const num = 9100 + fileItem.mock.calls.length;
      writeFileSync(join(cwd, `backlog/${num}-split.md`), fields.digest);
      return { verdict: { num } };
    });
    const run = (input) => sizeAdmission.createSizeAdmissionRunner({ cwd,
      diffStat: () => ({ ...over, sha: input.sha }), fileItem,
      publishSplitCard: effects().publishSplitCard })(input);
    try {
      for (const input of [frozen, { ...frozen, sha: '3'.repeat(40) },
        { ...frozen, repo: 'other/repository' }]) await run(input);
      expect(fileItem).toHaveBeenCalledTimes(3);
      await run(frozen);
      await run({ ...frozen, pr: 999 }); // PR numbers are not card identity
      await run({ ...frozen, ref: 'lane/renamed' }); // branch labels are not card identity
      expect(fileItem).toHaveBeenCalledTimes(3);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('oversized file-group summaries bound entry count and bytes and name a human-review fallback', async () => {
    const text = Array.from({ length: 1000 }, (_, i) => `1\t0\t${i}/a\0`).join('');
    const io = effects({ diffStat: () => ({ ...over, text }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
    const fields = io.fileItem.mock.calls[0][0];
    expect(fields.scope.split(',').length).toBeLessThanOrEqual(100);
    expect(result.body).toMatch(/and \d+ more/);
    expect(result.body).toMatch(/human review.*full diff/i);
    expect(fields.digest).toMatch(/and \d+ more/);
    expect(Buffer.byteLength(result.body)).toBeLessThan(16_384);
  });

  it.each(['unreadable', 'ambiguous'])('a %s card store files a fresh card and requests reviewers', async (mode) => {
    const cwd = mkdtempSync(join(tmpdir(), 'size-card-store-'));
    if (mode === 'ambiguous') {
      mkdirSync(join(cwd, 'backlog'));
      const key = cardKey(frozen.sha, frozen.repo);
      for (const id of ['777', '888']) writeFileSync(join(cwd, `backlog/${id}-split.md`), `size-split-key:${key}. Prior filing.`);
    }
    const io = effects({ cwd, diffStat: () => over });
    delete io.lookupSplitCard;
    try {
      const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
      expect(io.fileItem).toHaveBeenCalledOnce();
      expect(result.reviewLabel).toBe('review:pending');
      expect(result.body).toContain('split card 9001 filed');
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  it('unknown or stale size evidence files conservatively and requests human review', async () => {
    for (const diffStat of [() => { throw new Error('base unavailable'); },
      () => ({ ...over, sha: '4'.repeat(40) })]) {
      const io = effects({ diffStat });
      const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
      expect(result).toMatchObject({ status: 'unknown', reviewLabel: 'review:pending' });
      if (result.sha) expect(result.sha).toBe(frozen.sha);
      expect(io.fileItem).toHaveBeenCalledOnce();
      expect(result.body).toMatch(/human review.*full diff/i);
    }
  });

  it.each([null, { ref: '\ud800', body: null }, { ...frozen, body: 42 }])(
    'malformed admission input never throws and requests reviewers (%j)', async (input) => {
      const io = effects({ diffStat: () => { throw new Error('unknown'); } });
      await expect(sizeAdmission.createSizeAdmissionRunner(io)(input)).resolves.toMatchObject({
        status: 'unknown', reviewLabel: 'review:pending',
      });
    });

  it('PR-body file groups escape markdown, HTML, controls and comment terminators', async () => {
    const path = 'scripts/`[click](https:evil)<img>-->\n# injected\u001b.mjs';
    const io = effects({ diffStat: () => ({ ...over, text: `301\t0\t${path}\0` }) });
    const result = await sizeAdmission.createSizeAdmissionRunner(io)(frozen);
    expect(result.body).not.toMatch(/`|\[click\]|<img>|\u001b|\n# injected/);
    expect(result.body).toContain('extra reviewers requested');
  });
});
