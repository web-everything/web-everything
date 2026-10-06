import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const matter = require('gray-matter');
const { createBacklogIndex } = require('../lib/backlog-index.cjs');
const loaderPath = require.resolve('../../src/_data/backlog.js');
const root = resolve(dirname(loaderPath), '../..');
let temp, backlogDir, indexDir, reads, warnings;
const card = (name, text) => writeFileSync(join(backlogDir, name), text);
const good = (title, extra = '') => `---\nstatus: open\ntype: issue\n${extra}---\n# ${title}\n\nA summary.\n`;

function load(version = 'v1') {
  const index = createBacklogIndex({ backlogDir, indexDir, loaderVersion: version,
    readCard(name, { skipCache }) {
      reads++;
      let parsed;
      try { parsed = matter(readFileSync(join(backlogDir, name), 'utf8'), {}); }
      catch { warnings.push(name); return null; }
      const { data, content } = parsed;
      let body = content;
      if (!content.trim() && typeof data.relatedReport === 'string') {
        skipCache();
        body = readFileSync(join(temp, data.relatedReport), 'utf8');
      }
      return { ...data, body, absent: undefined };
    },
  });
  const output = index.load(readdirSync(backlogDir));
  return { output, stats: index.stats };
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'backlog-index-test-'));
  backlogDir = join(temp, 'backlog');
  indexDir = join(temp, 'index');
  mkdirSync(backlogDir);
  reads = 0;
  warnings = [];
  vi.stubEnv('WE_BACKLOG_INDEX', '1');
  card('001-first.md', good('First', 'customDate: 2026-01-01\n'));
  card('002-second.md', good('Second'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete require.cache[loaderPath];
  rmSync(temp, { recursive: true, force: true });
});

describe('per-file backlog index', () => {
  it('reads zero unchanged cards, preserves dates/undefined, and does not rewrite the index', () => {
    const first = load();
    const path = join(indexDir, readdirSync(indexDir)[0]);
    const before = statSync(path);
    reads = 0;
    const second = load();
    expect(reads).toBe(0);
    expect(second.stats).toEqual({ hits: 2, misses: 0 });
    expect(second.output).toStrictEqual(first.output);
    expect(second.output[0].customDate).toBeInstanceOf(Date);
    expect(Object.hasOwn(second.output[0], 'absent')).toBe(true);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(path).ino).toBe(before.ino);
  });
  it('re-parses exactly one rewritten card', () => {
    load(); reads = 0;
    card('001-first.md', good('Changed and longer'));
    expect(load().stats).toEqual({ hits: 1, misses: 1 });
    expect(reads).toBe(1);
  });
  it('invalidates all entries when the loader version changes', () => {
    load(); reads = 0;
    expect(load('v2').stats).toEqual({ hits: 0, misses: 2 });
    expect(reads).toBe(2);
  });
  it('matches an index-off parse', () => {
    load();
    const cached = load().output;
    vi.stubEnv('WE_BACKLOG_INDEX', '0');
    reads = 0;
    expect(load().output).toStrictEqual(cached);
    expect(reads).toBe(2);
  });
  it('never caches malformed cards and reports them every time', () => {
    card('003-bad.md', '---\nbroken: [\n---\n');
    load(); reads = 0;
    expect(load().stats).toEqual({ hits: 2, misses: 1 });
    expect(reads).toBe(1);
    expect(warnings).toEqual(['003-bad.md', '003-bad.md']);
  });
  it('re-parses report pointers when their report changes', () => {
    card('003-pointer.md', '---\nrelatedReport: report.md\n---\n');
    writeFileSync(join(temp, 'report.md'), '# Original');
    load(); reads = 0;
    writeFileSync(join(temp, 'report.md'), '# Updated report');
    const next = load();
    expect(reads).toBe(1);
    expect(next.output[2].body).toBe('# Updated report');
  });
  it('drops deleted cards and recovers from corrupt index data', () => {
    load();
    unlinkSync(join(backlogDir, '002-second.md'));
    expect(load().output).toHaveLength(1);
    const path = join(indexDir, readdirSync(indexDir)[0]);
    const { deserialize } = require('node:v8');
    expect(deserialize(readFileSync(path)).entries.size).toBe(1);
    writeFileSync(path, 'corrupt');
    expect(load().stats.misses).toBe(1);
  });
  it('disables itself under Vitest without an explicit directory', () => {
    vi.stubEnv('WE_BACKLOG_INDEX_DIR', '');
    const readCard = vi.fn(() => ({ title: 'Card' }));
    const index = createBacklogIndex({ backlogDir, loaderVersion: 'test', readCard });
    index.load(['001-first.md']); index.load(['001-first.md']);
    expect(readCard).toHaveBeenCalledTimes(2);
  });
  it('keeps default/scoped loader output identical and recomputes graph fields', () => {
    vi.stubEnv('WE_BACKLOG_DIR', backlogDir);
    vi.stubEnv('WE_BACKLOG_INDEX_DIR', indexDir);
    card('002-second.md', good('Second', 'blockedBy: ["001"]\n'));
    const report = join(temp, 'report.md');
    writeFileSync(report, '# Report title\n\nReport summary.');
    card('003-pointer.md', `---\nrelatedReport: ${relative(root, report)}\n---\n`);
    card('004-bad.md', '---\nbroken: [\n---\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = vi.spyOn(fs, 'readFileSync');
    delete require.cache[loaderPath];
    const loader = require(loaderPath);
    const first = loader();
    read.mockClear();
    const cached = loader();
    expect(cached).toStrictEqual(first);
    const cardReads = read.mock.calls.filter(([path]) => dirname(String(path)) === backlogDir);
    expect(cardReads.map(([path]) => String(path).split('/').pop()).sort()).toEqual(['003-pointer.md', '004-bad.md']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(loader.loadBacklogScoped(['002-second.md'])[0].blockers[0].status).not.toBe('open');
    expect(loader()).toStrictEqual(first);
    card('001-first.md', good('Resolved first', 'customDate: 2026-01-01\n').replace('status: open', 'status: resolved'));
    writeFileSync(report, '# Updated title\n\nChanged report.');
    const changed = loader();
    expect(changed.find(it => it.num === '002').blockers[0].status).toBe('resolved');
    expect(changed.find(it => it.num === '003').title).toBe('Updated title');
    vi.stubEnv('WE_BACKLOG_INDEX', '0');
    expect(loader()).toStrictEqual(changed);
    const names = ['001-first.md', '002-second.md'];
    const uncachedScope = loader.loadBacklogScoped(names);
    vi.stubEnv('WE_BACKLOG_INDEX', '1');
    expect(loader.loadBacklogScoped(names)).toStrictEqual(uncachedScope);
  });
});
