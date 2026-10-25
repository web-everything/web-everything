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
let root, stateDir, prs, gh, emitEvent, log, fullCommentPages;
beforeEach(() => {
  if (!process.env.TMPDIR) throw Error('TMPDIR must be set for this hermetic fixture');
  root = fs.mkdtempSync(join(process.env.TMPDIR, 'merge-watch-regression-'));
  stateDir = join(root, 'state');
  config.tool = {};
  prs = [ready(17)];
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
const tick = minute => runMergeWatch({ repos: [repo], gh, now: at(minute), stateDir,
  settings: { readyNotMergingMinutes: threshold }, emitEvent, log });
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
    expect(resolve(platform, tool, env)).toEqual({ readyNotMergingMinutes: value });
    expect(log).toHaveBeenCalledWith(`policy-cascade · prMergeWatch: readyNotMergingMinutes=${value} (${source})`);
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
    expect(resolve(platform, tool, env)).toEqual({ readyNotMergingMinutes: value });
    expect(log.mock.calls.flat().join(' ')).toContain(`readyNotMergingMinutes=${value} (${source})`);
  });

  it.each(['', '   '])('an empty environment override (%j) preserves tool provenance', env => {
    expect(resolve({}, { readyNotMergingMinutes: 20 }, env)).toEqual({ readyNotMergingMinutes: 20 });
    expect(log).toHaveBeenCalledWith('policy-cascade · prMergeWatch: readyNotMergingMinutes=20 (tool)');
  });

  it('accepts zero as a valid environment threshold and logs env provenance', () => {
    expect(resolve({}, { readyNotMergingMinutes: 20 }, '0')).toEqual({ readyNotMergingMinutes: 0 });
    expect(log).toHaveBeenCalledWith('policy-cascade · prMergeWatch: readyNotMergingMinutes=0 (env)');
  });
});
