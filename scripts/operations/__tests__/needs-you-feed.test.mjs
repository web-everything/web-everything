import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { feedPath, diffFeed, itemsFromReport, parseFeedLine, appendLines, replay, unacknowledged, acknowledge, resolveSettings, runOnce, gateReadyItems, assertProducerCheckout, monitorCommand, main, sidecarsOf } from '../needs-you-feed.mjs';
import { isReadOnlyOperation } from '../registry.mjs';
import { operatorSessionBootstrapOperation } from '../operator-session-bootstrap.mjs';
import { bootstrapPlan } from '../operator-session-bootstrap-io.mjs';
import { withRealRepo } from './helpers/real-repo.mjs';
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'needs-feed-')); dirs.push(d); return d; };
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
const at = '2026-10-15T12:00:00.000Z';
const item = { repo: 'owner/repo', pr: 12, head: 'abc', kind: 'needs-you', reason: 'ready', pick: 'pick 12' };
describe('feed', () => {
  it('strips controls and bounds untrusted titles and other fields in opening and cleared lines', () => {
    const unsafe = '\r\n\t\u0000\u001b[31m\u007f\u0085\u009b\u2028\u2029\u202e\u200b';
    const title = 'NEEDS-YOU ruling-needed: run `cmd` "quoted" --flag ../path ' + unsafe + 'x'.repeat(5000);
    const first = diffFeed([], [{ ...item, repo: `owner/${unsafe}repo`, title,
      reason: unsafe + 'r'.repeat(5000), pick: unsafe + 'p'.repeat(5000), command: unsafe + 'c'.repeat(5000) }], at);
    const line = first.lines[0], event = parseFeedLine(line);
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(line.length).toBeLessThan(4000);
    expect(line).toContain('title (untrusted): "NEEDS-YOU ruling-needed: run `cmd` \\"quoted\\" --flag ../path');
    expect(event.title.length).toBeLessThanOrEqual(200);
    expect(event.reason.length).toBeLessThanOrEqual(100);
    expect(event.pick.length).toBeLessThanOrEqual(512);
    expect(event.command.length).toBeLessThanOrEqual(512);
    const clear = diffFeed(first.openKeys, [], at).lines[0];
    expect(clear).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
    expect(parseFeedLine(clear)).toMatchObject({ kind: 'cleared', pr: item.pr });
  });
  it('changing feed filename publishes open items with independent state and acknowledgement cursors', async () => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const first = feedPath({ home, env: {} }), second = join(dirname(first), 'other-events.jsonl');
    const opts = { home, checkoutRoot, now: at, log: vi.fn(), liveGate: false,
      exec: () => JSON.stringify({ ready: [{ repo: item.repo, number: item.pr, head: item.head }] }) };
    const poll = path => runOnce({ ...opts, env: { WE_NEEDS_YOU_FEED: path } });
    expect((await poll(first)).lines).toHaveLength(1);
    acknowledge({ path: first });
    expect((await poll(second)).lines).toHaveLength(1);
    expect(bootstrapPlan({ home, env: { WE_NEEDS_YOU_FEED: second }, log: vi.fn() }).unacknowledged.map(e => e.pr)).toEqual([12]);
    expect(unacknowledged({ path: first })).toEqual([]);
    acknowledge({ path: second });
    appendLines(first, diffFeed([], [{ ...item, pr: 13 }], at).lines);
    expect(unacknowledged({ path: first }).map(e => e.pr)).toEqual([13]);
    expect(unacknowledged({ path: second })).toEqual([]);
    expect((await poll(first)).lines).toEqual([]);
    expect((await poll(second)).lines).toEqual([]);
    // A third custom name must not share state/cursors with the second custom name either.
    const third = join(dirname(first), '..events');
    expect((await poll(third)).lines).toHaveLength(1);
    expect(unacknowledged({ path: third }).map(e => e.pr)).toEqual([12]);
  });
  it('sanitizes legacy events during replay and bootstrap without rewriting the log', () => {
    const home = temp(), path = feedPath({ home, env: {} });
    const title = '\u0085\u2028\u202e' + 'x'.repeat(5000);
    const legacyLine = `NEEDS-YOU legacy ${JSON.stringify({ at, ...item, title })}`;
    appendLines(path, [legacyLine]);
    const before = readFileSync(path, 'utf8');
    const plan = bootstrapPlan({ home, env: {}, log: vi.fn() });
    for (const event of [...replay({ path }), ...plan.unacknowledged]) {
      expect(event.title).not.toMatch(/[\p{Cc}\p{Cf}\u2028\u2029]/u);
      expect(event.title.length).toBeLessThanOrEqual(200);
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it.each(['needs-you-ack', 'needs-you-ack.123.tmp', 'needs-you-feed-state.json',
    'needs-you-feed-state.json.lock', '.needs-you-feed/hash/state.json', '.needs-you-feed/hash/ack'])
  ('rejects metadata path %s before it can overwrite another stream', async name => {
    const home = temp(), path = join(home, name);
    expect(() => feedPath({ home, env: { WE_NEEDS_YOU_FEED: path } })).toThrow(/reserved/);
    expect(() => appendLines(path, diffFeed([], [item], at).lines)).toThrow(/reserved/);
    expect(() => replay({ path })).toThrow(/reserved/);
    expect(() => acknowledge({ path })).toThrow(/reserved/);
    expect(() => unacknowledged({ path })).toThrow(/reserved/);
    expect(() => monitorCommand(path)).toThrow(/reserved/);
    const settings = resolveSettings({ env: {}, file: {}, home });
    settings.path.value = path; // A pinned job can supply settings directly rather than via resolveSettings.
    await expect(runOnce({ settings, checkoutRoot: join(home, 'workspace/.lanes/we/lane-1'),
      exec: () => JSON.stringify({ ready: [] }), log: vi.fn() })).rejects.toThrow(/reserved/);
  });
  it('opens, dedupes, clears and keeps previous keys on incomplete reports', () => {
    const first = diffFeed([], [item], at);
    expect(first.lines[0]).toMatch(/^NEEDS-YOU owner\/repo#12 needs-you: ready \| pick: pick 12 /);
    expect(parseFeedLine(first.lines[0])).toMatchObject({ ...item, at });
    expect(diffFeed(first.openKeys, [item], at).lines).toEqual([]);
    const partial = []; partial.incomplete = true;
    expect(diffFeed(first.openKeys, partial, at)).toEqual({ lines: [], openKeys: first.openKeys });
    const cleared = diffFeed(first.openKeys, [], at);
    expect(cleared.openKeys).toEqual([]);
    expect(cleared.lines[0]).toMatch(/^NEEDS-YOU-CLEARED /);
    expect(parseFeedLine(cleared.lines[0])).toMatchObject({ kind: 'cleared', was: 'needs-you', head: 'abc', pr: 12 });
    expect(diffFeed(first.openKeys, [{ ...item, head: 'def' }], at).lines).toHaveLength(2);
  });
  it('maps real queue row shapes and incomplete flag', () => {
    const row = { repo: item.repo, number: 12, head: 'abc' };
    const items = itemsFromReport({ incomplete: true, ready: [{ ...row, pick: 'pick' }], needsYourMerge: [{ ...row, command: 'merge' }], rulingNeeded: [{ ...row, findings: [{ reason: 'red-team-round-cap', summary: 'cap' }], redTeam: true }, { ...row, findings: [{ reason: 'dispute' }] }, row], stoodDown: [row] });
    expect(items.map(i => i.kind)).toEqual(['needs-you', 'needs-you', 'at-round-limit', 'escalated', 'ruling-needed', 'stood-down']);
    expect(items[1].command).toBe('merge'); expect(items.incomplete).toBe(true);
  });
  it('uses section reasons, preserves row reasons and commands, and shows the title separately', () => {
    const row = { repo: 'owner/repo', number: 12, title: 'A PR title' };
    const items = itemsFromReport({ ready: [row, { ...row, reason: 'Specific reason', command: 'custom review' }],
      needsYourMerge: [{ ...row, command: 'human merge' }], rulingNeeded: [row], stoodDown: [row] });
    expect(items.map(i => i.reason)).toEqual([
      'review:human + advisory:accepted, all gates pass — your review', 'Specific reason',
      'approved, only a person may enqueue',
      'review parked with confirmed findings — your block/card/not-real ruling',
      'fix agent asked a question — your judgment; no label changed',
    ]);
    const review = `node scripts/operations/run.mjs review-pr --pr=12 --repo=owner/repo`;
    for (const i of [items[0], items[3]]) {
      expect(i.command).toBe(review);
      expect(i.command).not.toContain('--cwd=');
      expect(i.command).not.toMatch(/(?:^|[\s='"])(?:\/|[A-Za-z]:[\\/])/);
    }
    expect(items[1].command).toBe('custom review');
    expect(items[2].command).toBe('human merge');
    expect(items[4].command).toBeUndefined();
    expect(items.every(i => i.title === row.title)).toBe(true);
    const line = diffFeed([], [items[0]], at).lines[0];
    expect(line.slice(0, line.indexOf(' {"at":'))).toContain(row.title);
    expect(line).toContain(`| pick: ${review}`);
    expect(parseFeedLine(line)).toMatchObject({ title: row.title, reason: items[0].reason });
  });
  it('resolves missing heads once per item before deduping and keeps supplied heads', async () => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = vi.fn(() => JSON.stringify({ ready: [
      { repo: 'r', number: 1, title: 'Lookup' }, { repo: 'r', number: 2, head: 'supplied' },
    ] }));
    const gh = vi.fn(() => JSON.stringify({ headRefOid: 'resolved' }));
    const opts = { exec, gh, home, checkoutRoot, env: {}, now: at, log: vi.fn(), liveGate: false };
    const first = await runOnce(opts);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledWith('gh', ['pr', 'view', '1', '--repo', 'r', '--json', 'headRefOid'],
      expect.objectContaining({ cwd: checkoutRoot, encoding: 'utf8', maxBuffer: expect.any(Number), timeout: expect.any(Number) }));
    expect(first.openKeys).toEqual(['r#1@resolved:needs-you', 'r#2@supplied:needs-you']);
    expect(parseFeedLine(first.lines[0]).head).toBe('resolved');
    expect((await runOnce(opts)).lines).toEqual([]);
    gh.mockReturnValue(JSON.stringify({ headRefOid: 'new-head' }));
    expect((await runOnce(opts)).lines).toHaveLength(2);
  });
  it.each(['throws', 'invalid JSON', 'missing head'])('logs head lookup failure (%s) and continues the pass', async failure => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = () => JSON.stringify({ ready: [{ repo: 'r', number: 1 }, { repo: 'r', number: 2 }] });
    const gh = vi.fn().mockImplementationOnce(() => {
      if (failure === 'throws') throw Error('lookup failed');
      return failure === 'invalid JSON' ? 'invalid' : '{}';
    }).mockReturnValue(JSON.stringify({ headRefOid: 'second' }));
    const log = vi.fn();
    const result = await runOnce({ exec, gh, home, checkoutRoot, env: {}, now: at, log, liveGate: false });
    expect(result.openKeys).toEqual(['r#1@:needs-you', 'r#2@second:needs-you']);
    expect(parseFeedLine(result.lines[0]).head).toBe('');
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/r#1.*head lookup failed/));
    expect(gh).toHaveBeenCalledTimes(2);
  });
  it('appends without replacing bytes and replays and acknowledges open events', () => {
    const path = join(temp(), 'events'); writeFileSync(path, 'existing\n');
    appendLines(path, diffFeed([], [item], at).lines);
    expect(readFileSync(path, 'utf8')).toMatch(/^existing\nNEEDS-YOU /);
    expect(replay({ path, since: at })).toHaveLength(1);
    expect(replay({ path, since: '2026-10-16' })).toEqual([]);
    const ackPath = join(dirname(path), 'ack');
    expect(unacknowledged({ path, ackPath })).toHaveLength(1);
    writeFileSync(ackPath, at); expect(unacknowledged({ path, ackPath })).toEqual([]);
    writeFileSync(ackPath, '2026-10-14');
    appendLines(path, diffFeed([`${item.repo}#12@abc:needs-you`], [], '2026-10-15T13:00:00Z').lines);
    expect(unacknowledged({ path, ackPath })).toEqual([]);
  });
  it.each([
    ['queue read', at], ['head lookup', at],
    ['queue read', '2026-10-15T12:01:00.000Z'], ['head lookup', '2026-10-15T12:01:00.000Z'],
  ])('ack during an in-flight %s preserves subsequently published events (ack at %s)', async (phase, ackAt) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const path = feedPath({ home, env: {} });
    vi.stubEnv('WE_NEEDS_YOU_FEED', path);
    const existing = { repo: item.repo, number: item.pr, head: item.head };
    const opts = { home, checkoutRoot, env: {}, now: at, log: vi.fn(), liveGate: false };
    await runOnce({ ...opts, exec: () => JSON.stringify({ ready: [existing] }) });
    let resume, entered;
    const paused = new Promise(resolve => { resume = resolve; });
    const collecting = new Promise(resolve => { entered = resolve; });
    const report = JSON.stringify({ ready: [existing, { repo: item.repo, number: 13, ...(phase === 'queue read' ? { head: 'new' } : {}) }] });
    const pause = async result => { entered(); await paused; return result; };
    const poll = runOnce({ ...opts,
      exec: () => phase === 'queue read' ? pause(report) : report,
      gh: () => pause(JSON.stringify({ headRefOid: 'new' })),
    });
    await collecting;
    vi.setSystemTime(new Date(ackAt));
    await main(['ack']);
    expect(unacknowledged({ path })).toEqual([]);
    resume(); await poll;
    expect(unacknowledged({ path }).map(event => event.pr)).toEqual([13]);
    expect(bootstrapPlan({ home, env: { WE_NEEDS_YOU_FEED: path }, log: vi.fn() }).unacknowledged.map(event => event.pr)).toEqual([13]);
    await main(['ack']);
    expect(unacknowledged({ path })).toEqual([]);
  });
  it('acknowledges an empty feed and counts clears and reopens independently of event timestamps', () => {
    const path = join(temp(), 'events');
    expect(acknowledge({ path })).toEqual({ publishedEvents: 0 });
    const first = diffFeed([], [item], at);
    appendLines(path, first.lines);
    expect(unacknowledged({ path })).toEqual([{ at, ...item }]);
    expect(acknowledge({ path })).toEqual({ publishedEvents: 1 });
    appendLines(path, diffFeed(first.openKeys, [], at).lines);
    appendLines(path, first.lines);
    expect(unacknowledged({ path })).toEqual([{ at, ...item }]);
    expect(acknowledge({ path })).toEqual({ publishedEvents: 3 });
    expect(unacknowledged({ path })).toEqual([]);
    // A later publication can have an older timestamp after a clock correction or a slow poll.
    appendLines(path, diffFeed([], [{ ...item, pr: 13 }], '2026-10-14').lines);
    expect(unacknowledged({ path }).map(event => event.pr)).toEqual([13]);
  });
  it('upgrades a legacy timestamp acknowledgement without replaying already acknowledged items', () => {
    const path = join(temp(), 'events'), ackPath = join(dirname(path), 'ack');
    appendLines(path, diffFeed([], [item], at).lines);
    writeFileSync(ackPath, at);
    expect(unacknowledged({ path, ackPath })).toEqual([]);
    expect(acknowledge({ path, ackPath })).toEqual({ publishedEvents: 1 });
    appendLines(path, diffFeed([], [{ ...item, pr: 13 }], at).lines);
    expect(unacknowledged({ path, ackPath }).map(event => event.pr)).toEqual([13]);
  });
  it('resolves settings env > file > defaults with source', () => {
    expect(resolveSettings({ env: {}, file: {} }).intervalMinutes).toEqual({ value: 2, source: 'default' });
    const s = resolveSettings({ env: { WE_NEEDS_YOU_FEED_INTERVAL_MINUTES: '3', WE_NEEDS_YOU_FEED_ENABLED: 'false' }, file: { intervalMinutes: 5, enabled: true } });
    expect(s.intervalMinutes).toEqual({ value: 3, source: 'env' }); expect(s.enabled.value).toBe(false);
    expect(resolveSettings({ env: {}, file: { intervalMinutes: 5 } }).intervalMinutes.source).toBe('settings');
  });
  it('refuses primary and accepts lane, registered daemon, pinned snapshot and override', () => {
    const home = temp(); const primary = join(home, 'workspace', 'web-everything');
    expect(() => assertProducerCheckout(primary, { env: {} })).toThrow(/primary/i);
    for (const root of [join(home, 'workspace/.lanes/web-everything/lane-1'), join(home, 'workspace/wev-health-watch')]) {
      expect(() => assertProducerCheckout(root, { env: {} })).not.toThrow();
    }
    expect(() => assertProducerCheckout(primary, { env: { WE_NEEDS_YOU_FEED_ALLOW_PRIMARY: '1' } })).not.toThrow();
    const snap = join(home, '.snapshots/code', 'a'.repeat(40)); mkdirSync(snap, { recursive: true }); writeFileSync(join(snap, '.snapshot-complete'), 'ok');
    expect(() => assertProducerCheckout(snap, { env: {} })).not.toThrow();
  });
  it('runs queue from producer checkout, consumes exit-1 JSON and persists partial state', async () => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = vi.fn(() => JSON.stringify({ ready: [{ repo: 'r', number: 1, head: 'h' }] }));
    const opts = { exec, home, checkoutRoot, env: {}, now: at, log: vi.fn(), liveGate: false };
    await runOnce(opts);
    expect(exec.mock.calls[0][1]).toEqual([join(checkoutRoot, 'scripts/operations/operator-queue.mjs'), '--json']);
    expect(exec.mock.calls[0][2].cwd).toBe(checkoutRoot);
    exec.mockImplementation(() => { throw Object.assign(Error('partial'), { status: 1, stdout: JSON.stringify({ incomplete: true, ready: [] }) }); });
    await runOnce(opts);
    expect(replay({ path: feedPath({ home, env: {} }) })).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dirname(feedPath({ home, env: {} })), 'needs-you-feed-state.json'))).openKeys).toHaveLength(1);
    exec.mockImplementation(() => { throw Object.assign(Error('async partial'), { code: 1, stdout: JSON.stringify({ ready: [] }) }); });
    await runOnce(opts);
    expect(replay({ path: feedPath({ home, env: {} }) })).toHaveLength(1);
    expect(opts.log).toHaveBeenCalledWith(expect.stringContaining('intervalMinutes=2 source=default'));
    expect(opts.log).toHaveBeenCalledTimes(12);
  });
  it('bootstrap reads canonical prompt, quiet rules, monitor and pending events without changing the checkout', async () => {
    await withRealRepo(({ root: home, git }) => {
      const path = feedPath({ home, env: {} }); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(join(dirname(path), 'handoff-webeverything-rules.md'), 'ordinary\nQUIET after ten\nquiet before seven\n');
      appendLines(path, diffFeed([], [item], at).lines);
      git(['add', '.']); // Track snapshot bytes so status also detects content changes.
      const before = git(['status', '--porcelain', '--untracked-files=all']);
      expect(isReadOnlyOperation(operatorSessionBootstrapOperation({ collect: () => bootstrapPlan({ home, env: {}, log: () => {} }) }))).toBe(true);
      const plan = bootstrapPlan({ home, env: {}, log: () => {} });
      expect(plan.cron.schedule).toBe('*/30 * * * *');
      expect(plan.cron.prompt).toContain(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../operator-session/pr-movement-sweep.prompt.md'), 'utf8').trim());
      expect(plan.cron.prompt).toContain('Quiet-hours rules (from handoff rules)');
      expect(plan.cron.prompt).toContain('QUIET after ten'); expect(plan.cron.prompt).not.toContain('ordinary');
      expect(plan.monitorCommand).toContain(path); expect(plan.monitorCommand).toContain('grep --line-buffered NEEDS-YOU');
      expect(plan.unacknowledged).toHaveLength(1); expect(plan.ackCommand).toContain('ack');
      expect(git(['status', '--porcelain', '--untracked-files=all'])).toBe(before);
    });
  });
});

it('keeps round-cap operator notes in the feed while the cap still needs a person', () => {
  expect(Array.from(itemsFromReport({ needsPerson: [{ repo: 'o/r', number: 5403, kind: 'round-cap-exhausted', detail: 'round cap exhausted' }] })))
    .toEqual([expect.objectContaining({ pr: 5403, kind: 'at-round-limit', reason: 'round cap exhausted' })]);
});

describe('gateReadyItems: "your review" is re-checked against the live PR (#5768)', () => {
  const repo = 'o/r';
  const head = '18088fcad0000000000000000000000000000000';
  const report = { ready: [{ repo, number: 5768, title: 't' }], needsYourMerge: [{ repo, number: 9, title: 'm' }] };
  const gate = (view, comments) => async (_f, args) => (args[0] === 'api' ? JSON.stringify([comments]) : JSON.stringify(view));
  const items = () => itemsFromReport(report);

  it('drops a ready item whose live PR is red-team:blocked + review:changes, and says why', async () => {
    const gh = gate({ headRefOid: head, labels: [{ name: 'review:changes' }, { name: 'red-team:blocked' }] }, []);
    const { kept, held } = await gateReadyItems(items(), report, { gh, log: () => {} });
    expect(kept.map((i) => i.pr)).toEqual([9]);
    expect(held[0].reasons).toEqual(expect.arrayContaining(['the red team blocked the live head', 'it was sent back (review:changes)']));
  });
  it('keeps a ready item whose live PR is clean, and never judges needs-your-merge rows', async () => {
    const gh = gate({ headRefOid: head, labels: [{ name: 'red-team:clear' }] }, []);
    const { kept, held } = await gateReadyItems(items(), report, { gh, log: () => {} });
    expect(kept.map((i) => i.pr).sort((a, b) => a - b)).toEqual([9, 5768]);
    expect(held).toEqual([]);
  });
  it('keeps the item (never suppresses an alert) when the live PR cannot be read, and logs it', async () => {
    const logs = [];
    const { kept } = await gateReadyItems(items(), report, { gh: async () => { throw new Error('rate limited'); }, log: (l) => logs.push(l) });
    expect(kept.map((i) => i.pr).sort((a, b) => a - b)).toEqual([9, 5768]);
    expect(logs.join()).toMatch(/live gate unreadable, keeping: rate limited/);
  });
  it('runOnce applies the gate by default and logs what it held back', async () => {
    const home = temp(), checkoutRoot = join(home, 'workspace/.lanes/we/lane-1');
    const exec = () => JSON.stringify({ ready: [{ repo: 'r', number: 5768, head, title: 't' }] });
    const gh = async (_f, args) => (args[0] === 'api' ? '[[]]' : JSON.stringify({ headRefOid: head, labels: [{ name: 'red-team:blocked' }] }));
    const log = vi.fn();
    const result = await runOnce({ exec, gh, home, checkoutRoot, env: {}, now: at, log });
    expect(result.openKeys).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('r#5768 held back from your review: the red team blocked the live head'));
  });
  it('publishes the head it CHECKED, not a stale one from the report or a later lookup', async () => {
    const stale = [{ repo, number: 5768, head: 'stale' }];
    const r2 = { ready: stale };
    const { kept } = await gateReadyItems(itemsFromReport(r2), r2, { gh: gate({ headRefOid: head, labels: [] }, []), log: () => {} });
    expect(kept[0].head).toBe(head);
  });
  it('the real fix-claim lease overrides the comment heuristic (expired lease = not claimed; live lease = claimed)', async () => {
    const created_at = new Date(Date.now() - 600000).toISOString();
    const body = '🔒 conveyor fix-begin — fix claim held';
    const gh = async (_f, args) => (args[0] === 'api' ? JSON.stringify([[{ user: { login: 'plateau-worker[bot]' }, body, created_at }]]) : JSON.stringify({ headRefOid: head, labels: [] }));
    const live = await gateReadyItems(items(), report, { gh, log: () => {}, fixClaimLive: () => true });
    expect(live.held[0].reasons).toEqual(['a fix claim is open']);
    const expired = await gateReadyItems(items(), report, { gh, log: () => {}, fixClaimLive: () => false });
    expect(expired.held).toEqual([]);
  });
  it('a pass-wide deadline keeps (never drops) the items it could not judge in time', async () => {
    const logs = [];
    const gh = async () => JSON.stringify({ headRefOid: head, labels: [{ name: 'red-team:blocked' }] });
    const { kept, held } = await gateReadyItems(items(), report, { gh, log: (l) => logs.push(l), deadlineMs: -1 });
    expect(held).toEqual([]);
    expect(kept.map((i) => i.pr).sort((a, b) => a - b)).toEqual([9, 5768]);
    expect(logs.join()).toMatch(/gate deadline/);
  });
  it('keeps the incomplete flag the diff uses', async () => {
    const withFlag = Object.assign(items(), { incomplete: true });
    const { kept } = await gateReadyItems(withFlag, report, { gh: gate({ headRefOid: head, labels: [] }, []), log: () => {} });
    expect(kept.incomplete).toBe(true);
  });
});

describe('stall sweep coexistence', () => {
  it.each([
    { WE_PR_STALL_SWEEP_MODE: 'off' },
    { WE_PR_STALL_SWEEP_MODE: 'shadow', WE_PR_STALL_SWEEP_DIGEST: 'false' },
  ])('ignores stale stalled keys before cleanup when the producer is disabled: %j', async env => {
    const path = join(temp(), 'needs-you-events.jsonl');
    const repo = 'web-everything/web-everything', head = 'a'.repeat(40);
    writeFileSync(sidecarsOf(path).state, JSON.stringify({ openKeys: [`${repo}#5@${head}:stalled`] }));
    const settings = { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: path }, allowPrimary: { value: true } };
    const result = await runOnce({ env, settings, liveGate: false, log: () => {},
      exec: () => JSON.stringify({ ready: [{ repo, number: 5, head }] }) });
    expect(result.lines).toHaveLength(1);
    expect(replay({ path })[0]).toMatchObject({ pr: 5, kind: 'needs-you' });
  });
  it.each([
    { name: 'a new queue item for a head with an open stalled item is not published twice', queueOpen: false },
    { name: 'an already-open queue item is retained when the same head also has an open stalled item', queueOpen: true },
  ])('$name', async ({ queueOpen }) => {
    const path = join(temp(), 'needs-you-events.jsonl');
    const head = 'a'.repeat(40); const repo = 'web-everything/web-everything';
    const stalledKey = `${repo}#5@${head}:stalled`;
    const queueKey = `${repo}#5@${head}:ruling-needed`;
    const openKeys = [stalledKey, ...(queueOpen ? [queueKey] : [])];
    writeFileSync(sidecarsOf(path).state, JSON.stringify({ openKeys }));
    const report = { ready: [], rulingNeeded: [{ repo, number: 5, head, reason: 'parked' }] };
    const settings = { enabled: { value: true }, intervalMinutes: { value: 2 }, path: { value: path }, allowPrimary: { value: true } };
    const result = await runOnce({ exec: async () => JSON.stringify(report), settings,
      env: { WE_PR_STALL_SWEEP_MODE: 'shadow', WE_PR_STALL_SWEEP_DIGEST: 'true' }, liveGate: false, log: () => {} });
    expect(result.lines).toEqual([]);
    expect(result.openKeys).toEqual(openKeys);
    expect(JSON.parse(readFileSync(sidecarsOf(path).state, 'utf8')).openKeys).toEqual(openKeys);
    expect(replay({ path })).toEqual([]);
  });
});
