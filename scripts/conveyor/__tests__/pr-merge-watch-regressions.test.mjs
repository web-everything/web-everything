// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { runMergeWatch, resolveMergeWatchSettings } from '../pass-daemons/pr-merge-watch-pass.mjs';

const config = vi.hoisted(() => ({ tool: undefined }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const readFileSync = (file, ...args) => {
    if (config.tool !== undefined && String(file).replaceAll('\\', '/').endsWith('/scripts/settings/pr-merge-watch.json')) {
      return JSON.stringify({ prMergeWatch: config.tool });
    }
    return actual.readFileSync(file, ...args);
  };
  return { ...actual, readFileSync, default: { ...actual.default, readFileSync } };
});

// All GitHub IO must use the injected fixture, including transitive helpers.
vi.mock('../../lib/gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(),
  execFileSyncThrottled: () => { throw Error('test forbids real gh'); },
  execFileThrottled: () => { throw Error('test forbids real gh'); },
}));
vi.mock('../../lib/daemon-events.mjs', () => ({
  appendDaemonEvent: () => { throw Error('test requires an injected event sink'); },
}));

const repo = 'example/widgets';
const head = 'a'.repeat(40);
const at = minute => new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString();
const threshold = JSON.parse(fs.readFileSync(new URL('../../settings/pr-merge-watch.json', import.meta.url), 'utf8'))
  .prMergeWatch.readyNotMergingMinutes;
const ready = number => ({
  number, state: 'OPEN', isDraft: false, headRefOid: head,
  labels: [{ name: 'review:accepted' }, { name: 'red-team:clear' }],
  comments: [], mergeStateStatus: 'CLEAN',
  createdAt: at(-10_000), updatedAt: at(-1000),
});
let root, stateDir, prs, gh, emitEvent, log, fullCommentPages, headTime;
beforeEach(() => {
  if (!process.env.TMPDIR) throw Error('TMPDIR must be set for this hermetic fixture');
  root = fs.mkdtempSync(join(process.env.TMPDIR, 'merge-watch-regression-'));
  stateDir = join(root, 'state');
  config.tool = {};
  prs = [ready(17)];
  headTime = at(0);
  fullCommentPages = 0;
  emitEvent = vi.fn().mockResolvedValue(true);
  log = vi.fn();
  gh = vi.fn(args => {
    if (args[0] === 'pr' && args[1] === 'view') {
      return structuredClone(prs.find(p => p.number === Number(args[2])));
    }
    if (args[0] !== 'api' || args.length !== 2) throw Error('unexpected or mutating GitHub call');
    const [path, query] = args[1].split('?');
    const params = new URLSearchParams(query);
    if (path.endsWith('/check-runs')) return { check_runs: [] };
    if (path.includes('/commits/')) return { sha: path.split('/').at(-1), commit: { committer: { date: headTime } } };
    if (path.endsWith('/timeline')) return [];
    if (path === `repos/${repo}/pulls` && params.get('state') === 'open') {
      const offset = (Number(params.get('page')) - 1) * 100;
      return prs.filter(p => p.state === 'OPEN').slice(offset, offset + 100)
        .map(p => ({ ...p, state: 'open', head: { sha: p.headRefOid } }));
    }
    if (path === `repos/${repo}/pulls/17`) return { ...prs[0], state: prs[0].state.toLowerCase() };
    if (/\/issues\/\d+\/comments$/.test(path)) {
      return Number(params.get('page')) <= fullCommentPages ? Array.from({ length: 100 }, () => ({
        body: 'ordinary comment', created_at: at(-1), user: { login: 'reader' },
      })) : [];
    }
    throw Error('unexpected GitHub endpoint');
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const tick = minute => { headTime = at(minute); return runMergeWatch({ repos: [repo], gh, now: at(minute), stateDir,
  settings: { readyNotMergingMinutes: threshold }, emitEvent, log, signalLogs: () => [] }); };
const receipt = () => JSON.parse(fs.readFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), 'utf8'))
  .prs[17].heads[head];
const mergedReceipt = () => JSON.parse(fs.readFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), 'utf8'))
  .prs[17].merged;

describe('merge-watch durable readiness and delivery guarantees', () => {
  it('an old PR starts its persisted timer at first observed readiness', async () => {
    await tick(0);
    expect(receipt()).toEqual({ since: Date.parse(at(0)), alerted: false });
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('loss of readiness resets the timer before the same head becomes ready again', async () => {
    await tick(0);
    prs[0].mergeStateStatus = 'BLOCKED';
    await tick(30);
    expect(receipt().since).toBeNull();
    prs[0].mergeStateStatus = 'CLEAN';
    await tick(100);
    await tick(100 + threshold);
    expect(emitEvent).not.toHaveBeenCalled();
    await tick(101 + threshold);
    expect(emitEvent).toHaveBeenCalledWith({ kind: 'pr-ready-not-merging', repo, pr: 17,
      detail: { minutes: threshold + 1, head } });
  });

  it('the shipped 60-minute threshold is strict: below and equal are silent, above alerts once', async () => {
    expect(threshold).toBe(60);
    await tick(0);
    await tick(threshold - 1);
    await tick(threshold);
    expect(emitEvent).not.toHaveBeenCalled();
    await tick(threshold + 1);
    await tick(threshold + 2);
    expect(emitEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['pr-ready-not-merging', 'throw'], ['pr-ready-not-merging', 'false'],
    ['pr-merged', 'throw'], ['pr-merged', 'false'],
  ])('%s delivery (%s) leaves the disk receipt retryable and publishes before advancing it', async (kind, mode) => {
    await tick(0);
    const delivered = kind === 'pr-merged' ? mergedReceipt : () => receipt().alerted;
    if (kind === 'pr-merged') Object.assign(prs[0], { state: 'CLOSED', merged_at: at(10) });
    if (mode === 'throw') emitEvent.mockRejectedValueOnce(Error('sink unavailable'));
    else emitEvent.mockResolvedValueOnce(false);
    await tick(threshold + 1);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent.mock.calls[0][0].kind).toBe(kind);
    expect(delivered()).toBe(false);
    const receiptsAtPublication = [];
    emitEvent.mockImplementationOnce(async () => {
      // Publication must happen before the persistent receipt is advanced.
      receiptsAtPublication.push(delivered());
      return true;
    });
    await tick(threshold + 2);
    expect(receiptsAtPublication).toEqual([false]);
    expect(delivered()).toBe(true);
    await tick(threshold + 3);
    expect(emitEvent).toHaveBeenCalledTimes(2);
    if (kind === 'pr-merged') expect(emitEvent.mock.calls[1]).toEqual([{ kind, repo, pr: 17 }]);
  });

  it('comment pagination shares the 128-request tick budget with discovery and PR reads', async () => {
    prs = Array.from({ length: 60 }, (_, i) => ready(i + 1));
    fullCommentPages = 1; // Two comment pages per PR, plus its view and shared discovery.
    const result = await tick(0);
    expect(gh).toHaveBeenCalledTimes(128);
    expect(gh.mock.calls.some(([args]) => args[1]?.includes('state=open'))).toBe(true);
    expect(gh.mock.calls.filter(([args]) => args[0] === 'pr').length).toBeGreaterThan(0);
    expect(gh.mock.calls.some(([args]) => args[1]?.includes('/comments?per_page=100&page=2'))).toBe(true);
    expect(result.incomplete).toBe(true);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator must inspect/);
  });

  it('budget exhaustion resumes remaining PRs and merge checks on subsequent ticks', async () => {
    prs = Array.from({ length: 60 }, (_, i) => ready(i + 1));
    fs.mkdirSync(stateDir);
    fs.writeFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), JSON.stringify({ prs: {
      999: { merged: false, heads: { [head]: { since: null, alerted: false } } },
    } }));
    const previous = gh.getMockImplementation();
    gh.mockImplementation(args => args[1] === `repos/${repo}/pulls/999`
      ? { number: 999, state: 'closed', merged_at: at(0) } : previous(args));
    for (let i = 0; i < 10; i++) {
      gh.mockClear();
      await tick(i * (threshold + 1));
      expect(gh.mock.calls.length).toBeLessThanOrEqual(128);
    }
    const events = emitEvent.mock.calls.map(([event]) => event);
    expect(events.filter(e => e.kind === 'pr-merged')).toEqual([{ kind: 'pr-merged', repo, pr: 999 }]);
    expect(new Set(events.filter(e => e.kind === 'pr-ready-not-merging').map(e => e.pr)))
      .toEqual(new Set(prs.map(p => p.number)));
    expect(events.filter(e => e.kind === 'pr-ready-not-merging')).toHaveLength(60);
  });

  it('retires a long-lived closed-unmerged set so later ticks spend no requests on it', async () => {
    prs = [];
    fs.mkdirSync(stateDir);
    fs.writeFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), JSON.stringify({
      prs: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [i + 1,
        { merged: false, heads: { [head]: { since: null, alerted: false } } }])),
    }));
    const previous = gh.getMockImplementation();
    gh.mockImplementation(args => /\/pulls\/\d+$/.test(args[1])
      ? { number: Number(args[1].split('/').at(-1)), state: 'closed', merged_at: null } : previous(args));
    for (let i = 0; i < 3; i++) await tick(i);
    const state = JSON.parse(fs.readFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), 'utf8'));
    expect(state.prs).toEqual({});
    gh.mockClear();
    expect((await tick(4)).incomplete).toBe(false);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('retires unpublished superseded head receipts instead of growing state on every push', async () => {
    for (let i = 0; i < 20; i++) {
      prs[0].headRefOid = i.toString(16).padStart(40, '0');
      await tick(i);
    }
    const state = JSON.parse(fs.readFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), 'utf8'));
    expect(Object.keys(state.prs[17].heads)).toEqual([prs[0].headRefOid]);
  });

  it('keeps delivered head identities when pruning so returning to an old head never alerts twice', async () => {
    await tick(0);
    await tick(threshold + 1);
    prs[0].headRefOid = 'b'.repeat(40);
    await tick(threshold + 2);
    prs[0].headRefOid = head;
    await tick(threshold + 3);
    await tick(3 * threshold);
    expect(emitEvent.mock.calls.filter(([e]) => e.kind === 'pr-ready-not-merging')).toHaveLength(1);
  });

  it('retires polling for an alerted unmerged close and preserves deduplication when it reopens', async () => {
    await tick(0);
    await tick(threshold + 1);
    Object.assign(prs[0], { state: 'CLOSED', merged_at: null });
    await tick(threshold + 2);
    gh.mockClear();
    await tick(threshold + 3);
    expect(gh).toHaveBeenCalledTimes(1); // Discovery only; no closed PR lookup.
    prs[0].state = 'OPEN';
    await tick(threshold + 4);
    await tick(3 * threshold);
    expect(emitEvent.mock.calls.filter(([e]) => e.kind === 'pr-ready-not-merging')).toHaveLength(1);
  });

  it.each([{}, { repo, number: -1 }, { repo, number: '17' }, { repo: 17, number: null }])(
    'rejects malformed persisted scheduling evidence %j before any GitHub reads', async cursor => {
      fs.mkdirSync(stateDir);
      fs.writeFileSync(join(stateDir, 'cursor.json'), JSON.stringify(cursor));
      expect((await tick(0)).incomplete).toBe(true);
      expect(gh).not.toHaveBeenCalled();
      expect(emitEvent).not.toHaveBeenCalled();
      expect(log.mock.calls.flat().join(' ')).toMatch(/operator must inspect/);
    });

  it('compacts historical merged receipts without reading their PRs again', async () => {
    prs = [];
    fs.mkdirSync(stateDir);
    fs.writeFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), JSON.stringify({ prs: {
      17: { merged: true, heads: { [head]: { since: null, alerted: true } } },
    } }));
    await tick(0);
    expect(gh).toHaveBeenCalledTimes(1);
    const state = JSON.parse(fs.readFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), 'utf8'));
    expect(state.prs[17]).toEqual({ merged: true, heads: {} });
  });

  it('rejects a non-boolean retirement marker before any GitHub reads', async () => {
    fs.mkdirSync(stateDir);
    fs.writeFileSync(join(stateDir, `${encodeURIComponent(repo)}.json`), JSON.stringify({ prs: {
      17: { merged: false, closed: 'yes', heads: {} },
    } }));
    expect((await tick(0)).incomplete).toBe(true);
    expect(gh).not.toHaveBeenCalled();
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('an oversized comment thread stops at ten pages and requires operator inspection', async () => {
    fullCommentPages = 11;
    const result = await tick(0);
    expect(gh.mock.calls.filter(([args]) => args[1]?.includes('/comments?')).length).toBe(10);
    expect(result.incomplete).toBe(true);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(fs.existsSync(stateDir)).toBe(false);
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator must inspect/);
  });
});

describe('merge-watch settings resolver contract', () => {
  it('discovers a non-default value from the real pr-merge-watch.json file through readSettings', () => {
    config.tool = undefined; // Use real filesystem IO, including directory discovery and JSON parsing.
    const dir = join(root, 'settings');
    fs.mkdirSync(dir);
    const shipped = JSON.parse(fs.readFileSync(new URL('../../settings/pr-merge-watch.json', import.meta.url), 'utf8'));
    shipped.prMergeWatch.readyNotMergingMinutes = 7;
    fs.writeFileSync(join(dir, 'pr-merge-watch.json'), JSON.stringify(shipped));
    const resolved = resolveMergeWatchSettings({ log, env: {
      WE_PLATFORM_PREFERENCES_FILE: join(root, 'absent-platform.json'),
    }, settingsFiles: { dir, legacyPath: null } });
    expect(resolved.readyNotMergingMinutes).toBe(7);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('readyNotMergingMinutes=7 (tool)'));
  });

  function resolve(platform, tool, override) {
    const platformFile = join(root, 'platform.json');
    fs.writeFileSync(platformFile, JSON.stringify({ prMergeWatch: platform }));
    config.tool = tool;
    return resolveMergeWatchSettings({ log, env: {
      WE_PLATFORM_PREFERENCES_FILE: platformFile, WE_PR_MERGE_WATCH_READY_MINUTES: override,
    } });
  }

  it.each([
    ['standard default when all overrides are absent', {}, {}, undefined, 60, 'standard'],
    ['platform overrides standard', { readyNotMergingMinutes: 40 }, {}, undefined, 40, 'platform'],
    ['tool overrides platform', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: 20 }, undefined, 20, 'tool'],
    ['environment overrides tool', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: 20 }, '5', 5, 'env'],
  ])('%s and logs the effective value/source', (_name, platform, tool, env, value, source) => {
    expect(resolve(platform, tool, env)).toEqual({ readyNotMergingMinutes: value, noProgressDraftMinutes: 240, noProgressMinutes: 180, ciJobOverdueFactor: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`readyNotMergingMinutes=${value} (${source})`));
  });

  it.each([
    ['negative platform value', { readyNotMergingMinutes: -1 }, {}, undefined, 60, 'standard'],
    ['string platform value', { readyNotMergingMinutes: '40' }, {}, undefined, 60, 'standard'],
    ['nested platform value', { readyNotMergingMinutes: { unexpected: 40 } }, {}, undefined, 60, 'standard'],
    ['negative tool value', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: -1 }, undefined, 40, 'platform'],
    ['array tool value', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: [20] }, undefined, 40, 'platform'],
    ['null tool value', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: null }, undefined, 40, 'platform'],
    ['nested tool value', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: { unexpected: 20 } }, undefined, 40, 'platform'],
    ['non-numeric environment value', {}, { readyNotMergingMinutes: 20 }, 'bad', 20, 'tool'],
    ['negative environment value', {}, { readyNotMergingMinutes: 20 }, '-1', 20, 'tool'],
    ['non-finite environment value', {}, { readyNotMergingMinutes: 20 }, 'Infinity', 20, 'tool'],
  ])('ignores invalid %s, retaining and logging the lower layer', (_name, platform, tool, env, value, source) => {
    expect(resolve(platform, tool, env)).toEqual({ readyNotMergingMinutes: value, noProgressDraftMinutes: 240, noProgressMinutes: 180, ciJobOverdueFactor: 2 });
    expect(log.mock.calls.flat().join(' ')).toContain(`readyNotMergingMinutes=${value} (${source})`);
  });

  it.each(['', '   '])('an empty environment override (%j) preserves tool provenance', env => {
    expect(resolve({}, { readyNotMergingMinutes: 20 }, env)).toEqual({ readyNotMergingMinutes: 20, noProgressDraftMinutes: 240, noProgressMinutes: 180, ciJobOverdueFactor: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('readyNotMergingMinutes=20 (tool)'));
  });

  it('accepts zero as a valid environment threshold and logs env provenance', () => {
    expect(resolve({}, { readyNotMergingMinutes: 20 }, '0')).toEqual({ readyNotMergingMinutes: 0, noProgressDraftMinutes: 240, noProgressMinutes: 180, ciJobOverdueFactor: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('readyNotMergingMinutes=0 (env)'));
  });
});
