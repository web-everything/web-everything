// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { join } from 'node:path';
import { humanReviewHold } from '../../operations/pr-sweep-core.mjs';
import { redTeamGateMarker } from '../../lib/red-team-gate.mjs';

// Only the not-yet-shipped tool settings file is virtual. State and platform
// preferences use real temporary files. No production settings are edited.
const io = vi.hoisted(() => ({ tool: {}, append: vi.fn(), reads: [] }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  const readFileSync = (file, ...args) => {
    if (String(file).replaceAll('\\', '/').endsWith('/scripts/settings/pr-merge-watch.json')) {
      io.reads.push(String(file));
      return JSON.stringify({ prMergeWatch: io.tool });
    }
    return actual.readFileSync(file, ...args);
  };
  return { ...actual, readFileSync, default: { ...actual.default, readFileSync } };
});
vi.mock('../../lib/daemon-events.mjs', () => ({ appendDaemonEvent: io.append }));
// An accidentally uninjected GitHub call must fail locally, never hit GitHub.
vi.mock('../../lib/gh-throttle.mjs', async importOriginal => ({
  ...await importOriginal(),
  execFileSyncThrottled: () => { throw Error('test forbids real gh'); },
  execFileThrottled: () => { throw Error('test forbids real gh'); },
}));

const REPO = 'example/widgets';
const OTHER_REPO = 'example/other';
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const at = minutes => new Date(Date.UTC(2026, 9, 25, 0, minutes)).toISOString();
const labels = (...names) => names.map(name => ({ name }));
const comment = body => ({ body, author: { login: 'web-everything' }, createdAt: at(-1) });
const readyPr = (overrides = {}) => ({
  number: 17, state: 'OPEN', isDraft: false, headRefOid: HEAD,
  labels: labels('review:accepted', 'red-team:clear'), comments: [],
  mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', statusCheckRollup: [],
  createdAt: at(-1440), updatedAt: at(-100), merged_at: null,
  ...overrides,
});

// Named predicate: acceptedRedTeamClearAndClean. It reuses the needs-you-feed
// humanReviewHold gate, with positive clearance and CLEAN required as well.
// operator-queue's advisory:accepted + review:human is an earlier human-review
// stage; it must not be substituted for final review:accepted here.
function acceptedRedTeamClearAndClean(pr, now) {
  const names = pr.labels.map(l => l.name);
  return names.includes('review:accepted') && names.includes('red-team:clear')
    && pr.mergeStateStatus === 'CLEAN' && humanReviewHold(pr, Date.parse(now)).length === 0;
}

let root, stateDir, prs, gh, emitEvent, log;
const modulePath = join(process.cwd(), 'scripts/conveyor/pass-daemons/pr-merge-watch-pass.mjs');
const loadPass = () => import(/* @vite-ignore */ modulePath);
const alert = (head = HEAD, minutes = 61, repo = REPO) => ({
  kind: 'pr-ready-not-merging', repo, pr: 17, detail: { minutes, head },
});

beforeEach(() => {
  vi.resetModules();
  io.tool = {};
  io.reads = [];
  io.append.mockReset().mockResolvedValue(true);
  if (!process.env.TMPDIR) throw Error('TMPDIR must be set for this hermetic fixture');
  root = fs.mkdtempSync(join(process.env.TMPDIR, 'pr-merge-watch-'));
  stateDir = join(root, 'state');
  const platform = join(root, 'platform.json');
  fs.writeFileSync(platform, '{}');
  vi.stubEnv('WE_PLATFORM_PREFERENCES_FILE', platform);
  vi.stubEnv('WE_PR_MERGE_WATCH_READY_MINUTES', undefined);
  vi.stubEnv('WE_POLICY_CASCADE_LOG', '1');
  prs = new Map([[REPO, [readyPr()]]]);
  emitEvent = vi.fn().mockResolvedValue(true);
  log = vi.fn();
  // The gh seam matches pr-postmortem-pass: argv in, parsed JSON out.
  // Accept only reads, and provide both REST and gh-pr-view representations.
  gh = vi.fn(args => {
    if (args[0] === 'pr' && args[1] === 'view') {
      const repo = args[args.indexOf('--repo') + 1];
      const pr = prs.get(repo)?.find(p => p.number === Number(args[2]));
      if (!pr) throw Error('PR unavailable');
      return structuredClone(pr);
    }
    if (args[0] !== 'api' || args.some(a => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(a))) {
      throw Error(`unexpected gh call: ${JSON.stringify(args)}`);
    }
    const endpoint = args.find(a => /^repos\//.test(a));
    const m = /^repos\/([^/]+\/[^/]+)\/(pulls|issues)(?:\/(\d+))?(\/comments)?(?:\?(.*))?$/.exec(endpoint ?? '');
    if (!m) throw Error(`unexpected gh endpoint: ${endpoint}`);
    const [, repo, resource, number, comments, query] = m;
    const rows = prs.get(repo) ?? [];
    if (!number && resource === 'pulls') {
      const q = new URLSearchParams(query);
      if (q.get('state') !== 'open') throw Error('discovery must use the open listing');
      const page = Number(q.get('page') ?? 1);
      return rows.filter(p => p.state === 'OPEN').slice((page - 1) * 100, page * 100)
        .map(p => ({ ...structuredClone(p), state: 'open', head: { sha: p.headRefOid } }));
    }
    const pr = rows.find(p => p.number === Number(number));
    if (!pr) throw Error('PR unavailable');
    if (comments) {
      const rows = pr.comments.map(c => ({ ...c, user: c.author, created_at: c.createdAt }));
      return args.includes('--slurp') ? [rows] : rows;
    }
    return { ...structuredClone(pr), state: pr.state.toLowerCase(), head: { sha: pr.headRefOid } };
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

async function tick(minutes, overrides = {}) {
  const { runMergeWatch } = await loadPass();
  return runMergeWatch({ repos: [REPO], gh, now: at(minutes), stateDir,
    settings: { readyNotMergingMinutes: 60 }, emitEvent, log, ...overrides });
}

describe('runMergeWatch — acceptedRedTeamClearAndClean (humanReviewHold + final acceptance + CLEAN)', () => {
  it('persists first-seen-ready per PR/head instead of aging from createdAt or updatedAt', async () => {
    expect(acceptedRedTeamClearAndClean(readyPr(), at(0))).toBe(true);
    await tick(0);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(fs.readdirSync(stateDir).length).toBeGreaterThan(0);
    vi.resetModules(); // A new pass instance must recover the timer from disk.
    await tick(61);
    expect(emitEvent.mock.calls).toEqual([[alert()]]);
  });

  it('below threshold and exactly at threshold emit nothing; strictly more than 60 minutes emits', async () => {
    await tick(0);
    await tick(59);
    await tick(60);
    expect(emitEvent).not.toHaveBeenCalled();
    await tick(61);
    expect(emitEvent.mock.calls).toEqual([[alert()]]);
  });

  it.each([
    ['not accepted', { labels: labels('advisory:accepted', 'review:human', 'red-team:clear') }],
    ['no red-team clearance', { labels: labels('review:accepted') }],
    ['red-team pending despite clear label', { labels: labels('review:accepted', 'red-team:clear', 'red-team:pending') }],
    ['red-team blocked', { labels: labels('review:accepted', 'red-team:clear', 'red-team:blocked') }],
    ['review changes', { labels: labels('review:accepted', 'red-team:clear', 'review:changes') }],
    ['sent back', { labels: labels('review:accepted', 'red-team:clear', 'status:sent-back-red-team') }],
    ['fixing', { labels: labels('review:accepted', 'red-team:clear', 'status:fixing') }],
    ['unanswered trusted live-head send-back', { comments: [comment(redTeamGateMarker(17, HEAD, 'sent-back'))] }],
    ['not CLEAN', { mergeStateStatus: 'BLOCKED' }],
    ['unknown mergeability', { mergeStateStatus: 'UNKNOWN' }],
  ])('not-ready: %s never starts the ready timer', async (_name, patch) => {
    prs.set(REPO, [readyPr(patch)]);
    expect(acceptedRedTeamClearAndClean(prs.get(REPO)[0], at(0))).toBe(false);
    await tick(0);
    await tick(120);
    expect(emitEvent).not.toHaveBeenCalled();
    prs.set(REPO, [readyPr()]);
    await tick(121);
    expect(emitEvent).not.toHaveBeenCalled();
    await tick(182);
    expect(emitEvent.mock.calls).toEqual([[alert()]]);
  });

  it.each([
    ['stale head', comment(redTeamGateMarker(17, NEXT_HEAD, 'sent-back'))],
    ['untrusted author', { ...comment(redTeamGateMarker(17, HEAD, 'sent-back')), author: { login: 'mallory' } }],
  ])('humanReviewHold ignores a %s send-back rather than blocking a clear live head', async (_name, marker) => {
    prs.set(REPO, [readyPr({ comments: [marker] })]);
    expect(acceptedRedTeamClearAndClean(prs.get(REPO)[0], at(0))).toBe(true);
    await tick(0);
    await tick(61);
    expect(emitEvent.mock.calls).toEqual([[alert()]]);
  });

  it('a second run and a restarted pass do not duplicate a delivered alert', async () => {
    await tick(0);
    await tick(61);
    await tick(62);
    vi.resetModules();
    await tick(180);
    expect(emitEvent.mock.calls).toEqual([[alert()]]);
  });

  it('a new head re-arms with its own first-seen-ready time and delivery receipt', async () => {
    await tick(0);
    await tick(61);
    prs.set(REPO, [readyPr({ headRefOid: NEXT_HEAD })]);
    await tick(120);
    await tick(180);
    expect(emitEvent.mock.calls).toEqual([[alert()]]);
    await tick(181);
    await tick(182);
    expect(emitEvent.mock.calls).toEqual([[alert()], [alert(NEXT_HEAD)]]);
  });

  it('isolates the same PR number/head in different repos', async () => {
    prs.set(OTHER_REPO, [readyPr()]);
    await tick(0, { repos: [REPO, OTHER_REPO] });
    await tick(61, { repos: [REPO, OTHER_REPO] });
    expect(emitEvent.mock.calls.map(([event]) => event)).toEqual(expect.arrayContaining([alert(), alert(HEAD, 61, OTHER_REPO)]));
    expect(emitEvent).toHaveBeenCalledTimes(2);
  });

  it('a previously tracked PR now absent from open discovery emits pr-merged once using GitHub merged_at', async () => {
    await tick(0);
    prs.set(REPO, [readyPr({ state: 'CLOSED', merged_at: at(10) })]);
    await tick(11);
    vi.resetModules();
    await tick(12);
    expect(emitEvent.mock.calls).toEqual([[{ kind: 'pr-merged', repo: REPO, pr: 17 }]]);
  });

  it('closed without merged_at is not proof of a merge', async () => {
    await tick(0);
    prs.set(REPO, [readyPr({ state: 'CLOSED', merged_at: null })]);
    await tick(120);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it.each(['listing', 'labels', 'comments', 'head', 'mergeStateStatus'])('unreadable %s evidence fails closed and logs the failure', async missing => {
    await tick(0);
    log.mockClear();
    if (missing === 'listing') gh.mockImplementation(() => { throw Error('evidence unavailable'); });
    else prs.get(REPO)[0][missing === 'head' ? 'headRefOid' : missing] = null;
    await tick(61);
    expect(emitEvent).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join(' ')).toMatch(/unreadable|incomplete|unavailable|invalid|evidence/i);
  });

  it('oversized open discovery fails closed within the shared listOpenPrs page cap and logs operator inspection', async () => {
    prs.set(REPO, Array.from({ length: 1001 }, (_, i) => readyPr({ number: i + 1 })));
    await tick(0);
    await tick(61);
    expect(emitEvent).not.toHaveBeenCalled();
    const listingCalls = gh.mock.calls.filter(([args]) => args.some(a => /pulls\?state=open/.test(a)));
    expect(listingCalls.length).toBeGreaterThan(0);
    expect(listingCalls.length).toBeLessThanOrEqual(20); // ten pages per tick
    expect(log.mock.calls.flat().join(' ')).toMatch(/operator.*inspect/i);
  });

  it.each(['pr-ready-not-merging', 'pr-merged'])('emitEvent throwing retries %s next run; only delivered events advance the receipt', async kind => {
    await tick(0);
    if (kind === 'pr-merged') prs.set(REPO, [readyPr({ state: 'CLOSED', merged_at: at(10) })]);
    emitEvent.mockRejectedValueOnce(Error('event sink unavailable'));
    // A pass may surface or log delivery errors; either way it must retain the receipt for retry.
    await tick(61).catch(() => {});
    expect(emitEvent).toHaveBeenCalledTimes(1);
    vi.resetModules();
    await tick(62);
    await tick(63);
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(emitEvent.mock.calls[1]).toEqual([kind === 'pr-merged'
      ? { kind, repo: REPO, pr: 17 } : alert(HEAD, 62)]);
  });

  it('uses appendDaemonEvent by default when emitEvent is omitted', async () => {
    await tick(0, { emitEvent: undefined });
    await tick(61, { emitEvent: undefined });
    expect(io.append.mock.calls).toEqual([[alert()]]);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('an undelivered false result from default appendDaemonEvent remains retryable', async () => {
    await tick(0, { emitEvent: undefined });
    io.append.mockResolvedValueOnce(false);
    await tick(61, { emitEvent: undefined });
    await tick(62, { emitEvent: undefined });
    await tick(63, { emitEvent: undefined });
    expect(io.append.mock.calls).toEqual([[alert()], [alert(HEAD, 62)]]);
  });
});

describe('merge-watch settings cascade and provenance', () => {
  it.each([
    ['standard', {}, {}, undefined, 60],
    ['platform', { readyNotMergingMinutes: 40 }, {}, undefined, 40],
    ['tool', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: 20 }, undefined, 20],
    ['env', { readyNotMergingMinutes: 40 }, { readyNotMergingMinutes: 20 }, '5', 5],
  ])('resolves readyNotMergingMinutes from %s and logs effective value plus source', async (source, platform, tool, env, minutes) => {
    fs.writeFileSync(process.env.WE_PLATFORM_PREFERENCES_FILE, JSON.stringify({ prMergeWatch: platform }));
    io.tool = tool;
    vi.stubEnv('WE_PR_MERGE_WATCH_READY_MINUTES', env);
    await tick(0, { settings: undefined });
    await tick(minutes, { settings: undefined });
    expect(emitEvent).not.toHaveBeenCalled();
    await tick(minutes + 1, { settings: undefined });
    expect(emitEvent.mock.calls).toEqual([[alert(HEAD, minutes + 1)]]);
    expect(io.reads.length).toBeGreaterThan(0);
    expect(log.mock.calls.flat().join(' ')).toContain(`readyNotMergingMinutes=${minutes} (${source})`);
  });
});

// Proposed CLI seam mirrors runPostmortemCli: no spawned daemon or wall-clock sleeps.
describe('standalone merge-watch one-shot and --watch', () => {
  it('one-shot runs once and never sleeps', async () => {
    const { runMergeWatchCli } = await loadPass();
    const runPass = vi.fn().mockResolvedValue({});
    const sleep = vi.fn();
    await runMergeWatchCli({ repos: [REPO], watch: false }, { runPass, sleep, log });
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('--watch polls again after the target changes and stops on abort', async () => {
    const { runMergeWatchCli, runMergeWatch } = await loadPass();
    const abort = new AbortController();
    let minute = 0;
    const runPass = vi.fn(() => runMergeWatch({ repos: [REPO], gh, stateDir, now: at(minute),
      settings: { readyNotMergingMinutes: 60 }, emitEvent, log }));
    const sleep = vi.fn(async () => {
      if (minute === 0) {
        prs.set(REPO, [readyPr({ state: 'CLOSED', merged_at: at(1) })]);
        minute = 2;
      } else abort.abort();
    });
    await runMergeWatchCli({ repos: [REPO], watch: true }, { runPass, sleep, signal: abort.signal, log });
    expect(runPass).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBe(60_000);
    expect(emitEvent.mock.calls).toEqual([[{ kind: 'pr-merged', repo: REPO, pr: 17 }]]);
  });
});
