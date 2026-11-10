import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync, symlinkSync, linkSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { qualifyBareBasenames } from '../file-held-cards.mjs';
import { sizeRefusal } from '../../backlog/scaffold.mjs';
import { assertPublishableContent } from '../../backlog/guarded-write.mjs';
import * as heldCards from '../file-held-cards.mjs';
import { finishFileHeldCards, createFileHeldCardsSinks, fileInCheckout, parseCards, hashLine, selectUnfiled, composeFileItemInput, runFileHeldCards } from '../file-held-cards.mjs';
import { operatorControlCliPolicy, resolveOperation } from '../run.mjs';
import { createMemoryRunStore } from '../run-store.mjs';
import { runOperationCli } from '../cli-adapter.mjs';

let temp, root, source, ledger, fileItem, log;
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'file-held-cards-'));
  root = join(temp, 'repo');
  mkdirSync(root);
  mkdirSync(join(root, 'backlog'));
  source = join(temp, 'cards-to-file.md');
  ledger = join(temp, 'cards-filed.jsonl');
  fileItem = vi.fn(async input => {
    assertPublishableContent('backlog/xtest.md', `# ${input.title}\n\n${input.digest}`);
    writeFileSync(join(root, 'backlog', 'xtest.md'), 'filed\n');
    return { code: 0, lines: [JSON.stringify({ verdict: { num: 'xtest', rel: 'backlog/xtest.md' } })] };
  });
  log = vi.fn();
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));
const run = options => runFileHeldCards({ source, ...options, deps: { root, fileItem, log, now: () => '2026-11-09T12:00:00Z' } });
const seed = text => writeFileSync(source, text);

it('parses tags, dates, optional ET time and text; ignores non-card lines', () => {
  const cards = parseCards('# Held\n- [R763] 2026-11-08: First card\n- [R762, R764] 2026-11-08 16:17 ET: Second card\n- [R765] [R766] 2026-11-09: Third');
  expect(cards.map(({ tag, date, text }) => ({ tag, date, text }))).toEqual([
    { tag: 'R763', date: '2026-11-08', text: 'First card' },
    { tag: 'R762,R764', date: '2026-11-08', text: 'Second card' },
    { tag: 'R765,R766', date: '2026-11-09', text: 'Third' },
  ]);
  expect(hashLine('  one \t two ')).toBe(hashLine('one two'));
  expect(hashLine('one two')).toMatch(/^[a-f0-9]{64}$/);
});

it('selects unfiled hashes using raw-line regex and since date', () => {
  const cards = parseCards('- [R1] 2026-11-07: Old\n- [R2] 2026-11-08: Filed\n- [R3] 2026-11-09: Fresh');
  expect(selectUnfiled(cards, [{ hash: cards[1].hash }], { since: '2026-11-08', select: 'R[23]' })).toEqual([cards[2]]);
});

it('composes a bounded title, full digest and only explicit WE scope', () => {
  expect(composeFileItemInput({ text: 'Repair behavior; details in `we:scripts/a.mjs` and we:scripts/b.mjs.' })).toMatchObject({
    title: 'Repair behavior; details in `we:scripts/a.mjs` and we:scripts/b.mjs.', digest: 'Repair behavior; details in `we:scripts/a.mjs` and we:scripts/b.mjs.', scope: 'we:scripts/a.mjs,we:scripts/b.mjs',
  });
  // file-item defaults size to '' — handing one in trips the unsized-kind guard (#x0h3pe4).
  expect(composeFileItemInput({ text: 'x' })).not.toHaveProperty('size');
  expect(sizeRefusal(composeFileItemInput({ text: 'x' }).kind, '')).toBeNull();
  expect(composeFileItemInput({ text: 'a'.repeat(150) }).title).toHaveLength(111);
  expect(composeFileItemInput({ text: 'No scope' })).not.toHaveProperty('scope');
});

it('appends successful ledger rows, skips on rerun and preserves source bytes', async () => {
  seed('# Keep me\r\n- [R1] 2026-11-08: Repair behavior\r\n');
  const before = readFileSync(source);
  expect((await run()).filed).toHaveLength(1);
  expect(JSON.parse(readFileSync(ledger, 'utf8'))).toMatchObject({ tag: 'R1', date: '2026-11-08', card: 'xtest', title: 'Repair behavior', filedAt: '2026-11-09T12:00:00Z' });
  expect((await run()).filed).toEqual([]);
  expect(fileItem).toHaveBeenCalledTimes(1);
  expect(readFileSync(source)).toEqual(before);
});

it('dry-run lists tag date title scope without any writes or filing calls', async () => {
  seed('- [R1] 2026-11-08: Repair we:scripts/a.mjs');
  const before = readFileSync(source);
  const result = await run({ dryRun: true });
  expect(result.planned[0]).toMatchObject({ tag: 'R1', date: '2026-11-08', title: 'Repair we:scripts/a.mjs', scope: 'we:scripts/a.mjs' });
  expect(existsSync(ledger)).toBe(false);
  expect(readFileSync(source)).toEqual(before);
  expect(fileItem).not.toHaveBeenCalled();
});

it('leaves guard refusals unledgered and continues with explicit WE paths', async () => {
  seed('- [R1] 2026-11-08: Repair scripts/a.mjs\n- [R2] 2026-11-08: Repair we:scripts/a.mjs');
  const result = await run();
  expect(result.refused).toHaveLength(1);
  expect(result.filed).toHaveLength(1);
  expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('refused'));
});

it.each(['Read ~/.secrets/key', 'Read /config', 'Read /private/config', 'Repair scripts/extensionless', 'Use token ghp_012345678901234567890123456789012345'])('refuses secret-looking text or local paths: %s', async text => {
  seed(`- [R1] 2026-11-08: ${text}`);
  expect((await run()).refused).toHaveLength(1);
  expect(existsSync(ledger)).toBe(false);
});

it('caps batches at ten by default, supports max and leaves overflow for the next run', async () => {
  seed(Array.from({ length: 12 }, (_, i) => `- [R${i}] 2026-11-08: Repair behavior ${i}`).join('\n'));
  expect((await run()).filed).toHaveLength(10);
  expect((await run({ max: 1 })).filed).toHaveLength(1);
  expect((await run()).filed).toHaveLength(1);
});

it('logs normalized duplicate titles without filing them or writing the ledger', async () => {
  seed('- [R1] 2026-11-08: Repair behavior; extra details');
  writeFileSync(join(root, 'backlog', '123-old.md'), '---\ntitle: other\n---\n# REPAIR   behavior; extra  details\n');
  expect((await run()).duplicates).toHaveLength(1);
  expect(existsSync(ledger)).toBe(false);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('duplicate'));
  expect((await run()).duplicates).toHaveLength(1);
  expect(fileItem).not.toHaveBeenCalled();
});

it('ignores legacy untitled backlog cards instead of halting', async () => {
  seed('- [R1] 2026-11-08: Fresh card');
  writeFileSync(join(root, 'backlog', '001-legacy.md'), '---\nkind: task\n---\nno heading\n');
  expect((await run()).filed).toHaveLength(1);
});

it('fails closed on malformed ledger or missing backlog evidence before filing', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  writeFileSync(ledger, '{broken}\n');
  await expect(run()).rejects.toThrow(/ledger/i);
  rmSync(ledger);
  rmSync(join(root, 'backlog'), { recursive: true });
  await expect(run()).rejects.toThrow();
  expect(fileItem).not.toHaveBeenCalled();
});

it('does not ledger a failed or incomplete file-item response', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  fileItem.mockResolvedValue({ code: 1, lines: ['refused'] });
  expect((await run()).failed).toHaveLength(1);
  fileItem.mockResolvedValue({ code: 0, lines: ['{}'] });
  expect((await run()).failed).toHaveLength(1);
  expect(existsSync(ledger)).toBe(false);
});

it('has no standalone entry point: the only way in is run.mjs file-held-cards', () => {
  expect(heldCards).not.toHaveProperty('main');
});

it('run.mjs validates bounds and unknown flags with operator guidance', async () => {
  const { declaration, registry, sinks } = resolveOperation('file-held-cards', {});
  for (const argv of [['--max=-1'], ['--unknown']]) {
    const outcome = await runOperationCli({ declaration, registry, argv, store: createMemoryRunStore(), newRunId: () => 'held-bad', sinks });
    expect(outcome.code).not.toBe(0);
  }
});

it('run.mjs JSON dry-run uses declared flags and does not file or touch the ledger', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const { declaration, registry, finish } = resolveOperation('file-held-cards', { json: true });
  const sinks = createFileHeldCardsSinks({ root, fileItem });
  const outcome = await runOperationCli({ declaration, registry, argv: [`--source=${source}`, '--dry-run', '--json'],
    store: createMemoryRunStore(), newRunId: () => 'held-dry', sinks });
  expect(outcome.code).toBe(0);
  expect(JSON.parse(finish(outcome).lines.join('\n')).planned).toHaveLength(1);
  expect(fileItem).not.toHaveBeenCalled();
  expect(existsSync(ledger)).toBe(false);
  expect(operatorControlCliPolicy('file-held-cards', ['--dry-run'])).toEqual({ zeroWrites: true, memoryStore: true });
});

it('registers the declaration and finishes its effect result as JSON', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const { declaration, registry, sinks, finish } = resolveOperation('file-held-cards', { json: true });
  // The real binding is registered; substitute only its filesystem effect for this private fixture.
  expect(Object.keys(sinks)).toEqual(['file-held-cards.file']);
  const outcome = await runOperationCli({ declaration, registry, argv: ['--json'], store: createMemoryRunStore(),
    newRunId: () => 'held-test', sinks: { 'file-held-cards.file': () => run({ dryRun: true }) } });
  expect(outcome.code).toBe(0);
  expect(JSON.parse(finish(outcome).lines.join('\n')).planned).toHaveLength(1);
});

it('appends safely to a valid ledger lacking its final newline', async () => {
  seed('- [R1] 2026-11-08: First behavior');
  await run();
  writeFileSync(ledger, readFileSync(ledger, 'utf8').trimEnd());
  seed('- [R2] 2026-11-08: Second behavior');
  await run();
  expect(readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse)).toHaveLength(2);
});

it('refuses a ledger inside the checkout or aliasing the source', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  // The ledger is fixed beside the source, so a source inside the checkout puts the ledger inside it.
  const inside = join(root, 'cards-to-file.md');
  writeFileSync(inside, '- [R1] 2026-11-08: Repair behavior');
  await expect(run({ source: inside })).rejects.toThrow(/outside/);
  expect(fileItem).not.toHaveBeenCalled();
  expect('ledger' in resolveOperation('file-held-cards', {}).declaration.input).toBe(false);
});

it('rejects an external symlink to an in-repository ledger without changing its bytes', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const target = join(root, 'cards-filed.jsonl');
  const original = JSON.stringify({ hash: hashLine('previous card'), tag: 'R0', date: '2026-11-07',
    card: 'xprevious', title: 'Previous behavior', filedAt: '2026-11-08T12:00:00Z' }) + '\n';
  writeFileSync(target, original);
  symlinkSync(target, ledger);
  const before = readFileSync(source);
  await expect(run()).rejects.toThrow(/outside/);
  expect(readFileSync(target, 'utf8')).toBe(original);
  expect(readFileSync(source)).toEqual(before);
  expect(fileItem).not.toHaveBeenCalled();
});

it('rejects a new ledger reached through a symlinked repository directory', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const alias = join(temp, 'repo-alias');
  symlinkSync(root, alias, 'dir');
  const aliased = join(alias, 'cards-to-file.md');
  writeFileSync(aliased, '- [R1] 2026-11-08: Repair behavior');
  await expect(run({ source: aliased })).rejects.toThrow(/outside/);
  expect(existsSync(join(root, 'cards-filed.jsonl'))).toBe(false);
  expect(fileItem).not.toHaveBeenCalled();
});

it('fails closed on a dangling ledger symlink without filing or creating its target', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const target = join(root, 'new-ledger.jsonl');
  symlinkSync(target, ledger);
  await expect(run()).rejects.toThrow();
  expect(existsSync(target)).toBe(false);
  expect(fileItem).not.toHaveBeenCalled();
});

it('rejects a ledger symlink to the source without changing its bytes', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  symlinkSync(source, ledger);
  const before = readFileSync(source);
  await expect(run()).rejects.toThrow(/distinct/);
  expect(readFileSync(source)).toEqual(before);
  expect(fileItem).not.toHaveBeenCalled();
});

it('keeps truncated-title cards distinct and refuses an overlapping run via the ledger lock', async () => {
  const long = 'z'.repeat(130);
  seed(`- [R1] 2026-11-08: ${long} one\n- [R1] 2026-11-08: ${long} two`);
  expect((await run()).filed).toHaveLength(2);
  seed('- [R2] 2026-11-08: Lock probe');
  const id = createHash('sha256').update(join(realpathSync(temp), 'cards-filed.jsonl')).digest('hex').slice(0, 24);
  const lockFile = join(tmpdir(), `file-held-cards-${id}.lock`);
  writeFileSync(lockFile, '1');
  try { await expect(run()).rejects.toThrow(/ledger lock/); } finally { rmSync(lockFile, { force: true }); }
  expect(fileItem).toHaveBeenCalledTimes(2);
});

it('refused cards do not consume the batch budget', async () => {
  seed('- [R1] 2026-11-08: bad /Users/x/y\n- [R1] 2026-11-08: bad2 /Users/x/z\n- [R1] 2026-11-08: good one');
  const result = await run({ max: 1 });
  expect(result.refused).toHaveLength(2);
  expect(result.filed).toHaveLength(1);
});

it('dry-run validates first and never echoes a refused card text', async () => {
  seed('- [R1] 2026-11-08: leak ghp_abcdefghijklmnopqrstuvwxyz0123456789 end\n- [R1] 2026-11-08: fine');
  const result = await run({ dryRun: true });
  expect(JSON.stringify(result)).not.toContain('ghp_');
  expect(result.refused).toHaveLength(1);
  expect(result.planned).toHaveLength(1);
});

it('qualifies a bare basename only when exactly one tracked file matches', () => {
  const tracked = ['scripts/a/audit-settings.mjs', 'x/dup.mjs', 'y/dup.mjs'];
  expect(qualifyBareBasenames('fix audit-settings.mjs now', tracked).text).toBe('fix we:scripts/a/audit-settings.mjs now');
  expect(qualifyBareBasenames('fix we:scripts/a/audit-settings.mjs', tracked).text).toBe('fix we:scripts/a/audit-settings.mjs');
  const several = qualifyBareBasenames('see dup.mjs and none.mjs', tracked);
  expect(several.text).toBe('see dup.mjs and none.mjs');
  expect(several.ambiguous).toEqual({ 'dup.mjs': ['x/dup.mjs', 'y/dup.mjs'] });
});

it('files a card with a unique bare basename and refuses an ambiguous one, listing candidates', async () => {
  seed('- [R1] 2026-11-08: fix audit-settings.mjs\n- [R1] 2026-11-08: fix dup.mjs');
  const result = await runFileHeldCards({ source, deps: { root, fileItem, log, now: () => '2026-11-09T12:00:00Z',
    trackedFiles: () => ['scripts/audit-settings.mjs', 'a/dup.mjs', 'b/dup.mjs'] } });
  expect(result.filed).toHaveLength(1);
  expect(fileItem.mock.calls[0][0].scope).toBe('we:scripts/audit-settings.mjs');
  expect(result.refused).toHaveLength(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('we:a/dup.mjs'));
});

it('a closed card with the same title does not suppress a fresh handoff', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  writeFileSync(join(root, 'backlog', '9-old.md'), '---\nstatus: resolved\n---\n# Repair behavior\n');
  const result = await run();
  expect(result.duplicates).toHaveLength(0);
  expect(result.filed).toHaveLength(1);
  // file-item's own duplicate search sees closed cards, so the filing declares the vetted closed twin (preflight and filing agree).
  expect(fileItem.mock.calls[0][0].notDuplicateReason).toBe('9-old.md is closed and does not cover this fresh handoff');
});

const LONG = 'Rebuild the conveyor dispatch state after a runner restart while preserving every pending lane lease and review assignment across the entire machine';

it('a long (truncated-title) card gets the closed-twin declaration too, in dry run and filing', async () => {
  seed(`- [R3] 2026-11-10: ${LONG}`);
  const title = composeFileItemInput({ text: LONG }).title;
  expect(title.endsWith('…')).toBe(true);
  writeFileSync(join(root, 'backlog', '9-old.md'), `---\nstatus: resolved\n---\n# ${title}\n`);
  expect((await run({ dryRun: true })).planned).toHaveLength(1);
  const result = await run();
  expect(result.filed).toHaveLength(1);
  expect(fileItem.mock.calls[0][0].notDuplicateReason).toBe('9-old.md is closed and does not cover this fresh handoff');
});

it('a truncated title with a live twin as well as a closed one is never declared not-duplicate', async () => {
  seed(`- [R3] 2026-11-10: ${LONG}`);
  const title = composeFileItemInput({ text: LONG }).title;
  writeFileSync(join(root, 'backlog', '9-old.md'), `---\nstatus: resolved\n---\n# ${title}\n`);
  writeFileSync(join(root, 'backlog', '8-live.md'), `---\nstatus: open\n---\n# ${title}\n`);
  await run();
  expect(fileItem.mock.calls[0][0]).not.toHaveProperty('notDuplicateReason');
});

it('a card with no closed twin carries no duplicate declaration, and the binding passes one through only when present', async () => {
  seed('- [R1] 2026-11-08: Fresh unrelated card');
  await run();
  expect(fileItem.mock.calls[0][0]).not.toHaveProperty('notDuplicateReason');
  const spy = vi.fn(async () => ({ code: 0, lines: ['{}'] }));
  await fileInCheckout({ title: 't', kind: 'task', digest: 'd', queue: 'false' }, spy);
  await fileInCheckout({ title: 't', kind: 'task', digest: 'd', queue: 'false', notDuplicateReason: 'old.md is closed' }, spy);
  expect(spy.mock.calls[0][0].argv.some(arg => arg.startsWith('--notDuplicateReason'))).toBe(false);
  expect(spy.mock.calls[1][0].argv).toContain('--notDuplicateReason=old.md is closed');
});

it('body status examples do not suppress live-card duplicate detection', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  // Open front matter; the resolved status appears only as a quoted example in the body (LF and CRLF files).
  writeFileSync(join(root, 'backlog', '9-live.md'), '---\nstatus: open\n---\n# Repair behavior\n\nExample:\n\nstatus: resolved\n');
  writeFileSync(join(root, 'backlog', '8-live-crlf.md'), '---\r\nstatus: open\r\n---\r\n# Other thing\r\n\r\nstatus: closed\r\n');
  // A card with no front matter at all is live, even with a status-looking body line.
  writeFileSync(join(root, 'backlog', '7-bare.md'), '# Bare card\n\nstatus: dropped\n');
  seed('- [R1] 2026-11-08: Repair behavior\n- [R2] 2026-11-08: Other thing\n- [R3] 2026-11-08: Bare card');
  const result = await run();
  expect(fileItem).not.toHaveBeenCalled();
  expect(result.filed).toHaveLength(0);
  expect(result.duplicates.map(entry => entry.tag).sort()).toEqual(['R1', 'R2', 'R3']);
});

it('a comment line inside front matter is not read as the card title', async () => {
  writeFileSync(join(root, 'backlog', '9-live.md'), '---\nstatus: open\n# note: not a title\n---\n# Repair behavior\n');
  seed('- [R1] 2026-11-08: Repair behavior\n- [R2] 2026-11-08: note: not a title');
  const result = await run();
  expect(result.duplicates.map(entry => entry.tag)).toEqual(['R1']);
  expect(result.filed.map(entry => entry.tag)).toEqual(['R2']);
});

it('files every card of a batch through the same file-item binding with no per-card destination', async () => {
  const calls = [];
  const spy = vi.fn(async args => { calls.push(args); return { code: 0, lines: ['{}'] }; });
  await fileInCheckout({ title: 'a', kind: 'task', digest: 'd1', queue: 'false' }, spy);
  await fileInCheckout({ title: 'b', kind: 'task', digest: 'd2', queue: 'false', scope: 'we:scripts/x.mjs' }, spy);
  const flags = argv => argv.map(arg => arg.split('=')[0]);
  expect(calls.map(call => call.declaration.name)).toEqual(['file-item', 'file-item']);
  for (const { argv } of calls) {
    expect(flags(argv).filter(flag => /^--(pr|branch|lane|repo|checkout)$/.test(flag))).toEqual([]);
  }
  // This checkout is the one place every card lands, so the batch rides this lane's single PR.
  expect(flags(calls[0].argv)).toEqual(expect.arrayContaining(['--title', '--kind', '--digest', '--queue']));
});

it('stops before filing the next card when the ledger append fails', async () => {
  seed('- [R1] 2026-11-08: one\n- [R2] 2026-11-08: two\n- [R3] 2026-11-08: three');
  // Fault injection (no filesystem permissions, so it also runs as root): the first append fails after card one is filed.
  const appendFile = vi.fn(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  await expect(runFileHeldCards({ source, deps: { root, fileItem, log, appendFile, now: () => '2026-11-09T12:00:00Z' } }))
    .rejects.toThrow(/ledger append failed \(ENOSPC\); filed but not ledgered: xtest \(R1\)/);
  expect(appendFile).toHaveBeenCalledTimes(1);
  expect(fileItem).toHaveBeenCalledTimes(1);
  expect(existsSync(ledger)).toBe(false);
});

it('resolves a ledgered birth hash through bornAs only on origin/main, and refuses an unrelated remote bornAs', async () => {
  seed('- [R1] 2026-11-08: one');
  await run();
  rmSync(join(root, 'backlog', 'xtest.md'));
  writeFileSync(ledger, JSON.stringify({ ...JSON.parse(readFileSync(ledger, 'utf8').trim()), card: 'x56mcj7' }) + '\n');
  seed('- [R1] 2026-11-08: one\n- [R1] 2026-11-08: two');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(root, 'backlog', '4413-other.md'), '---\nbornAs: xabcdef\n---\n\n# Other\n');
  git('add', 'backlog/4413-other.md');
  git('commit', '-q', '-m', 'unrelated');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  rmSync(join(root, 'backlog', '4413-other.md')); // committed on origin/main only, not in the checkout
  await expect(run()).rejects.toThrow(/ledgered card/);
  writeFileSync(join(root, 'backlog', '4414-real.md'), '---\nbornAs: x56mcj7\n---\n\n# Real\n');
  git('add', 'backlog/4414-real.md');
  git('commit', '-q', '-m', 'renumbered');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  rmSync(join(root, 'backlog', '4414-real.md'));
  await expect(run({ dryRun: true })).resolves.toBeDefined();
});

it('one filed plus one refused card exits non-zero', () => {
  const outcome = { code: 0, run: { effects: [{ type: 'file-held-cards.file', result: { filed: [{ tag: 'R1', date: 'd', title: 't' }], refused: [{ tag: 'R2', date: 'd' }], duplicates: [], planned: [], failed: [] } }] } };
  expect(finishFileHeldCards(outcome).code).toBe(1);
});

it('a duplicate is never ledgered and gets filed on the next run once its twin closes', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  writeFileSync(join(root, 'backlog', '9-live.md'), '---\nstatus: open\n---\n# Repair behavior\n');
  const first = await run();
  expect(first.duplicates).toHaveLength(1);
  expect(fileItem).not.toHaveBeenCalled();
  expect(existsSync(ledger)).toBe(false);
  writeFileSync(join(root, 'backlog', '9-live.md'), '---\nstatus: resolved\n---\n# Repair behavior\n');
  const second = await run();
  expect(second.filed).toHaveLength(1);
  expect(fileItem).toHaveBeenCalledTimes(1);
});

it('duplicates do not count against the batch budget', async () => {
  seed('- [R1] 2026-11-08: Repair behavior\n- [R1] 2026-11-08: Fresh card');
  writeFileSync(join(root, 'backlog', '9-live.md'), '---\nstatus: open\n---\n# Repair behavior\n');
  const result = await run({ max: 1 });
  expect(result.duplicates).toHaveLength(1);
  expect(result.filed).toHaveLength(1);
});

it('a status-marked ledger row whose card exists nowhere throws', async () => {
  seed('- [R2] 2026-11-08: Fresh card');
  writeFileSync(ledger, JSON.stringify({ hash: hashLine('other'), tag: 'R0', date: '2026-11-07', title: 'Old', card: '8999',
    status: 'filed-elsewhere', filedAt: '2026-11-08T12:00:00Z' }) + '\n');
  await expect(run()).rejects.toThrow(/ledgered card/);
  expect(fileItem).not.toHaveBeenCalled();
});

it('a file-item failure makes the finished outcome exit non-zero', () => {
  const outcome = { code: 0, run: { effects: [{ type: 'file-held-cards.file', result: { failed: [{ tag: 'R1', date: 'd', title: 't' }] } }] } };
  expect(finishFileHeldCards(outcome).code).toBe(1);
});

it('an all-refused batch exits non-zero', () => {
  const outcome = { code: 0, run: { effects: [{ type: 'file-held-cards.file', result: { refused: [{ tag: 'R1', date: 'd' }], filed: [], duplicates: [], planned: [], failed: [] } }] } };
  expect(finishFileHeldCards(outcome).code).toBe(1);
});

it('refuses to proceed while a ledgered card exists nowhere (discarded lane)', async () => {
  seed('- [R1] 2026-11-08: one');
  await run();
  rmSync(join(root, 'backlog', 'xtest.md'));
  seed('- [R1] 2026-11-08: one\n- [R1] 2026-11-08: two');
  await expect(run()).rejects.toThrow(/ledgered card/);
});

it('resolves a ledgered birth hash to the numbered card that preserves it as bornAs', async () => {
  seed('- [R1] 2026-11-08: one');
  await run();
  rmSync(join(root, 'backlog', 'xtest.md'));
  writeFileSync(join(root, 'backlog', '4413-renumbered.md'), '---\nbornAs: x56mcj7\nkind: story\n---\n\n# Some other title\n');
  writeFileSync(ledger, JSON.stringify({ ...JSON.parse(readFileSync(ledger, 'utf8').trim()), card: 'x56mcj7' }) + '\n');
  seed('- [R1] 2026-11-08: one\n- [R1] 2026-11-08: two');
  await expect(run({ dryRun: true })).resolves.toBeDefined();
  await expect(run()).resolves.toBeDefined();
});

it('still refuses a ledgered hash when only an unrelated bornAs exists', async () => {
  seed('- [R1] 2026-11-08: one');
  await run();
  rmSync(join(root, 'backlog', 'xtest.md'));
  writeFileSync(ledger, JSON.stringify({ ...JSON.parse(readFileSync(ledger, 'utf8').trim()), card: 'x56mcj7' }) + '\n');
  writeFileSync(join(root, 'backlog', '4413-other.md'), '---\nbornAs: xabcdef\n---\n\n# Other\n');
  seed('- [R1] 2026-11-08: one\n- [R1] 2026-11-08: two');
  await expect(run()).rejects.toThrow(/ledgered card/);
});

it('a body line quoting bornAs does not count as the ledgered card; a quoted CRLF front-matter value does', async () => {
  seed('- [R1] 2026-11-08: one');
  await run();
  rmSync(join(root, 'backlog', 'xtest.md'));
  writeFileSync(ledger, JSON.stringify({ ...JSON.parse(readFileSync(ledger, 'utf8').trim()), card: 'x56mcj7' }) + '\n');
  seed('- [R1] 2026-11-08: one\n- [R1] 2026-11-08: two');
  writeFileSync(join(root, 'backlog', '4413-quote.md'), '---\nkind: story\n---\n\n# Quote\n\nbornAs: x56mcj7\n');
  await expect(run()).rejects.toThrow(/ledgered card/);
  writeFileSync(join(root, 'backlog', '4414-real.md'), '---\r\nbornAs: "x56mcj7"\r\nkind: story\r\n---\r\n\r\n# Real\r\n');
  await expect(run({ dryRun: true })).resolves.toBeDefined();
});

it('the production filing binding never sends an undefined or empty size or scope flag', async () => {
  const run = vi.fn(async () => ({ code: 0, lines: ['{}'] }));
  await fileInCheckout({ title: 't', kind: 'task', digest: 'd', queue: 'q' }, run);
  const argv = run.mock.calls[0][0].argv;
  expect(argv.join(' ')).not.toMatch(/undefined/);
  expect(argv).not.toContain('--size=');
  expect(argv).not.toContain('--scope=');
});

it('a failed or refused card fails the run itself, not only the CLI finisher', async () => {
  seed('- [R1] 2026-11-08: bad /Users/x/y\n- [R1] 2026-11-08: good one');
  const sink = createFileHeldCardsSinks({ root, fileItem })['file-held-cards.file'];
  await expect(sink({ source, max: 10, 'dry-run': false })).rejects.toThrow(/1 refused/);
  expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
  seed('- [R2] 2026-11-08: Next one');
  fileItem.mockResolvedValue({ code: 1, lines: ['refused'] });
  await expect(sink({ source, max: 10, 'dry-run': false })).rejects.toThrow(/1 failed/);
});

it('refuses a hard-linked ledger without changing the linked file or calling fileItem', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const target = join(root, 'backlog', 'cards-filed.jsonl');
  writeFileSync(target, '');
  linkSync(target, ledger);
  await expect(run()).rejects.toThrow(/hard link/);
  expect(readFileSync(target, 'utf8')).toBe('');
  expect(fileItem).not.toHaveBeenCalled();
});

const lockPath = () => join(tmpdir(), `file-held-cards-${createHash('sha256').update(join(realpathSync(temp), 'cards-filed.jsonl')).digest('hex').slice(0, 24)}.lock`);

it('sink dry-run with a refused card returns the plan and the refusal instead of throwing, and writes nothing', async () => {
  seed('- [R1] 2026-11-08: bad /Users/x/y\n- [R2] 2026-11-08: good one');
  const sink = createFileHeldCardsSinks({ root, fileItem })['file-held-cards.file'];
  const result = await sink({ source, max: 10, 'dry-run': true });
  expect(result.planned.map(card => card.tag)).toEqual(['R2']);
  expect(result.refused.map(card => card.tag)).toEqual(['R1']);
  expect(fileItem).not.toHaveBeenCalled();
  expect(existsSync(ledger)).toBe(false);
  // The finisher still exits non-zero on the refusal while keeping the planned line visible.
  const outcome = finishFileHeldCards({ code: 0, run: { effects: [{ type: 'file-held-cards.file', result }] } });
  expect(outcome.code).toBe(1);
  expect(outcome.lines.join('\n')).toContain('planned R2');
  expect(outcome.lines.join('\n')).toContain('refused R1 2026-11-08: (withheld)');
  expect(outcome.lines.join('\n')).not.toContain('undefined');
});

it('sink real run with a refused card throws after ledgering and names the filed card', async () => {
  seed('- [R1] 2026-11-08: bad /Users/x/y\n- [R2] 2026-11-08: good one');
  const sink = createFileHeldCardsSinks({ root, fileItem })['file-held-cards.file'];
  await expect(sink({ source, max: 10, 'dry-run': false })).rejects.toThrow(/1 filed: xtest \(R2\)/);
  expect(readFileSync(ledger, 'utf8').trim().split('\n')).toHaveLength(1);
});

it('dry-run reports a live-twin duplicate instead of planning it', async () => {
  writeFileSync(join(root, 'backlog', '9-live.md'), '---\nstatus: open\n---\n# Repair behavior\n');
  seed('- [R1] 2026-11-08: Repair behavior\n- [R2] 2026-11-08: Fresh card');
  const result = await run({ dryRun: true });
  expect(result.planned.map(card => card.tag)).toEqual(['R2']);
  expect(result.duplicates.map(card => card.tag)).toEqual(['R1']);
  expect(fileItem).not.toHaveBeenCalled();
});

it('reclaims a ledger lock whose recorded owner process is dead', async () => {
  seed('- [R1] 2026-11-08: Stale lock probe');
  const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(lockPath(), dead);
  try {
    expect((await run()).filed).toHaveLength(1);
    expect(existsSync(lockPath())).toBe(false);
  } finally { rmSync(lockPath(), { force: true }); }
});

it('refuses a lock held by a live process, or with an unreadable owner, and names the lock file', async () => {
  seed('- [R1] 2026-11-08: Live lock probe');
  try {
    for (const owner of [String(process.pid), 'not-a-pid', '']) {
      writeFileSync(lockPath(), owner);
      await expect(run()).rejects.toThrow(lockPath());
      expect(readFileSync(lockPath(), 'utf8')).toBe(owner);
    }
  } finally { rmSync(lockPath(), { force: true }); }
  expect(fileItem).not.toHaveBeenCalled();
});

it('the real append failure is surfaced with the filed card named (read-only ledger directory)', async () => {
  seed('- [R1] 2026-11-08: First card\n- [R2] 2026-11-08: Second card');
  chmodSync(temp, 0o555);
  try {
    // Skipped in effect when the process can write anyway (root): then the batch simply files both cards.
    const outcome = await run().then(() => 'wrote', error => error.message);
    if (outcome !== 'wrote') expect(outcome).toMatch(/ledger append failed \(EACCES\); filed but not ledgered: xtest \(R1\)/);
  } finally { chmodSync(temp, 0o755); }
});

it('files an entire batch in one checkout and PR', async () => {
  seed('- [R1] 2026-11-08: Card one\n- [R2] 2026-11-08: Card two\n- [R3] 2026-11-08: Card three');
  const calls = [];
  const spy = vi.fn(async args => {
    calls.push(args);
    return { code: 0, lines: [JSON.stringify({ verdict: { num: `x00000${calls.length}`, rel: `backlog/x00000${calls.length}.md` }, pr: 77 })] };
  });
  const result = await runFileHeldCards({ source, deps: { root, log, now: () => '2026-11-09T12:00:00Z', fileItem: input => fileInCheckout(input, spy) } });
  expect(result.filed).toHaveLength(3);
  const rows = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows.map(row => row.pr)).toEqual([77, 77, 77]);
  expect(new Set(rows.map(row => row.card)).size).toBe(3);
  // Every filing goes through the same file-item binding in this checkout, with no per-card destination flag.
  expect(calls.map(call => call.declaration.name)).toEqual(['file-item', 'file-item', 'file-item']);
  for (const { argv } of calls) expect(argv.map(arg => arg.split('=')[0]).filter(flag => /^--(pr|branch|lane|repo|checkout)$/.test(flag))).toEqual([]);
});

it('a dry run takes no ledger lock: a held lock is neither waited on nor touched', async () => {
  seed('- [R1] 2026-11-08: Dry lock probe');
  writeFileSync(lockPath(), String(process.pid));
  try {
    const result = await run({ dryRun: true });
    expect(result.planned).toHaveLength(1);
    expect(readFileSync(lockPath(), 'utf8')).toBe(String(process.pid));
    expect(existsSync(ledger)).toBe(false);
  } finally { rmSync(lockPath(), { force: true }); }
});

it('mixed dry-run reports valid plans while refusing unsafe text', async () => {
  seed('- [R1] 2026-11-08: leak ghp_abcdefghijklmnopqrstuvwxyz0123456789 end\n- [R2] 2026-11-08: fine card');
  const { declaration, registry, finish } = resolveOperation('file-held-cards', {});
  const sinks = createFileHeldCardsSinks({ root, fileItem });
  const outcome = await runOperationCli({ declaration, registry, argv: [`--source=${source}`, '--dry-run'],
    store: createMemoryRunStore(), newRunId: () => 'held-mixed', sinks });
  const done = finish(outcome);
  const text = done.lines.join('\n');
  expect(done.code).toBe(1);
  expect(text).toContain('planned R2');
  expect(text).toContain('refused R1');
  expect(text).not.toContain('ghp_');
  expect(fileItem).not.toHaveBeenCalled();
  expect(existsSync(ledger)).toBe(false);
});

it('a reclaim in progress (guard file held) refuses without touching the stale lock', async () => {
  seed('- [R1] 2026-11-08: Guard probe');
  const dead = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(lockPath(), dead);
  writeFileSync(`${lockPath()}.reclaim`, '1');
  try {
    await expect(run()).rejects.toThrow(`${lockPath()}.reclaim`);
    expect(readFileSync(lockPath(), 'utf8')).toBe(dead);
  } finally { rmSync(lockPath(), { force: true }); rmSync(`${lockPath()}.reclaim`, { force: true }); }
  expect(fileItem).not.toHaveBeenCalled();
});

it('an out-of-range pid in the lock fails closed instead of being reclaimed', async () => {
  seed('- [R1] 2026-11-08: Huge pid probe');
  writeFileSync(lockPath(), '4294967297');
  try {
    await expect(run()).rejects.toThrow(lockPath());
    expect(readFileSync(lockPath(), 'utf8')).toBe('4294967297');
  } finally { rmSync(lockPath(), { force: true }); }
});

it('releases only a lock that still names this run, so a retaken lock survives', async () => {
  seed('- [R1] 2026-11-08: Release probe');
  fileItem.mockImplementationOnce(async () => {
    writeFileSync(lockPath(), '1'); // another run now owns the lock path
    return { code: 0, lines: [JSON.stringify({ verdict: { num: 'xtest', rel: 'backlog/xtest.md' } })] };
  });
  try {
    expect((await run()).filed).toHaveLength(1);
    expect(readFileSync(lockPath(), 'utf8')).toBe('1');
  } finally { rmSync(lockPath(), { force: true }); }
});
