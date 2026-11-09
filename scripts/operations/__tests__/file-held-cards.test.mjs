import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qualifyBareBasenames } from '../file-held-cards.mjs';
import { sizeRefusal } from '../../backlog/scaffold.mjs';
import { assertPublishableContent } from '../../backlog/guarded-write.mjs';
import { finishFileHeldCards, parseCards, hashLine, selectUnfiled, composeFileItemInput, runFileHeldCards, main } from '../file-held-cards.mjs';
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
  expect(composeFileItemInput({ text: 'x' })).toHaveProperty('size', '');
  expect(sizeRefusal(composeFileItemInput({ text: 'x' }).kind, composeFileItemInput({ text: 'x' }).size)).toBeNull();
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

it('logs and ledgers normalized duplicate titles without filing or retrying them', async () => {
  seed('- [R1] 2026-11-08: Repair behavior; extra details');
  writeFileSync(join(root, 'backlog', '123-old.md'), '---\ntitle: other\n---\n# REPAIR   behavior; extra  details\n');
  expect((await run()).duplicates).toHaveLength(1);
  expect(JSON.parse(readFileSync(ledger, 'utf8'))).toMatchObject({ status: 'duplicate', card: '123-old.md' });
  expect(log).toHaveBeenCalledWith(expect.stringContaining('duplicate'));
  expect((await run()).duplicates).toEqual([]);
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

it('CLI validates bounds and unknown flags with operator guidance', async () => {
  const stderr = { write: vi.fn() };
  expect(await main(['--max=-1'], { stderr })).toBe(2);
  expect(await main(['--unknown'], { stderr })).toBe(2);
  expect(stderr.write).toHaveBeenCalledWith(expect.stringContaining('--max'));
});

it('CLI JSON dry-run uses declared flags and does not file or touch the ledger', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const stdout = { write: vi.fn() };
  const stderr = { write: vi.fn() };
  expect(await main([`--source=${source}`, '--dry-run', '--json'], { root, fileItem, stdout, stderr })).toBe(0);
  const result = JSON.parse(stdout.write.mock.calls.map(([text]) => text).join(''));
  expect(result.planned).toHaveLength(1);
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
  await expect(run({ ledger: source })).rejects.toThrow(/outside/);
  await expect(run({ ledger: join(root, 'cards-filed.jsonl') })).rejects.toThrow(/outside/);
  expect(fileItem).not.toHaveBeenCalled();
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
  await expect(run({ ledger: join(alias, 'new-ledger.jsonl') })).rejects.toThrow(/outside/);
  expect(existsSync(join(root, 'new-ledger.jsonl'))).toBe(false);
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

it('rejects an external hard link to a repository ledger without changing bytes or calling fileItem', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const target = join(root, 'backlog', 'cards-filed.jsonl');
  const original = JSON.stringify({ hash: hashLine('previous card'), tag: 'R0', date: '2026-11-07',
    card: 'xprevious', title: 'Previous behavior', filedAt: '2026-11-08T12:00:00Z' }) + '\n';
  writeFileSync(target, original);
  linkSync(target, ledger);
  const before = readFileSync(source);
  await expect(run()).rejects.toThrow(/outside/);
  expect(readFileSync(target, 'utf8')).toBe(original);
  expect(readFileSync(ledger, 'utf8')).toBe(original);
  expect(readFileSync(source)).toEqual(before);
  expect(fileItem).not.toHaveBeenCalled();
});

it('allows a hard-linked ledger when all file identities are outside the repository', async () => {
  seed('- [R1] 2026-11-08: Repair behavior');
  const external = join(temp, 'other-ledger.jsonl');
  writeFileSync(external, '');
  linkSync(external, ledger);
  expect((await run()).filed).toHaveLength(1);
  expect(fileItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(readFileSync(ledger, 'utf8')).card).toBe('xtest');
});

it('keeps truncated-title cards distinct and refuses an overlapping run via the ledger lock', async () => {
  const long = 'z'.repeat(130);
  seed(`- [R1] 2026-11-08: ${long} one\n- [R1] 2026-11-08: ${long} two`);
  expect((await run()).filed).toHaveLength(2);
  seed('- [R2] 2026-11-08: Lock probe');
  const st = statSync(ledger);
  const lockFile = join(tmpdir(), `file-held-cards-${st.dev}-${st.ino}.lock`);
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
});

it('a file-item failure makes the finished outcome exit non-zero', () => {
  const outcome = { code: 0, run: { effects: [{ type: 'file-held-cards.file', result: { failed: [{ tag: 'R1', date: 'd', title: 't' }] } }] } };
  expect(finishFileHeldCards(outcome).code).toBe(1);
});
