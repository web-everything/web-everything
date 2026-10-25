import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { handoffHome } from '../../operations/handoff-home.mjs';
import { appendDaemonEvent, daemonEventsPath } from '../daemon-events.mjs';

let home;
const at = '2026-10-25T12:34:56.000Z';
const now = () => new Date(at);

beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'we-daemon-events-')); });
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('daemonEventsPath', () => {
  it('defaults to the shared handoff home for an injected home', () => {
    expect(daemonEventsPath({ env: {}, home }))
      .toBe(join(handoffHome({ home }), 'daemon-events.jsonl'));
  });

  it.each(['', '   ', undefined, null, 42])('ignores an empty or non-string override (%j)', (value) => {
    expect(daemonEventsPath({ env: { WE_DAEMON_EVENTS: value }, home }))
      .toBe(join(handoffHome({ home }), 'daemon-events.jsonl'));
  });

  it.each(['relative/events.jsonl', 'absolute'])('resolves a non-empty override (%s)', (value) => {
    const path = value === 'absolute' ? join(home, 'events.jsonl') : value;
    expect(daemonEventsPath({ env: { WE_DAEMON_EVENTS: path }, home })).toBe(resolve(path));
  });

  it('uses process.env when env is omitted', () => {
    const path = join(home, 'from-process.jsonl');
    vi.stubEnv('WE_DAEMON_EVENTS', path);
    expect(daemonEventsPath({ home })).toBe(path);
  });
});

describe('appendDaemonEvent', () => {
  it('creates missing parents and appends exactly one JSON line per event without overwriting', async () => {
    const path = daemonEventsPath({ env: {}, home });
    expect(existsSync(dirname(path))).toBe(false);
    const first = { kind: 'rebuild-adopted', repo: 'frontierui', pr: 123, daemon: 'review-daemon', detail: { sha: 'abc123' } };
    const second = { kind: 'rebuild-failed', detail: 'smoke failed\nwith diagnostics' };
    await appendDaemonEvent(first, { env: {}, home, now });
    await appendDaemonEvent(second, { env: {}, home, now });

    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0])).toEqual({ at, ...first });
    // Exact equality also proves optional fields are absent, rather than null.
    expect(JSON.parse(lines[1])).toEqual({ at, kind: second.kind, repo: 'web-everything', detail: second.detail });
  });

  it.each([
    { pr: 0 },
    { daemon: 'build-daemon' },
    { pr: undefined, daemon: undefined },
  ])('omits pr and daemon independently only when undefined (%j)', async (optional) => {
    const path = join(home, 'events.jsonl');
    await appendDaemonEvent({ kind: 'rebuild-failed', detail: { reason: 'held' }, ...optional }, {
      env: { WE_DAEMON_EVENTS: path }, home, now,
    });
    const expected = { at, kind: 'rebuild-failed', repo: 'web-everything', detail: { reason: 'held' } };
    if (optional.pr !== undefined) expected.pr = optional.pr;
    if (optional.daemon !== undefined) expected.daemon = optional.daemon;
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
  });

  it('uses the injected appendFile exactly once with one complete JSON line', async () => {
    const path = join(home, 'injected', 'events.jsonl');
    const appendFile = vi.fn((file, line) => appendFileSync(file, line));
    await appendDaemonEvent({ kind: 'rebuild-failed', detail: 'held' }, {
      env: { WE_DAEMON_EVENTS: path }, home, now, appendFile,
    });
    expect(appendFile).toHaveBeenCalledTimes(1);
    expect(appendFile.mock.calls[0][0]).toBe(path);
    expect(appendFile.mock.calls[0][1]).toBe(`${JSON.stringify({ at, kind: 'rebuild-failed', repo: 'web-everything', detail: 'held' })}\n`);
  });

  it('returns false without throwing when the parent path cannot be created', async () => {
    // A regular file as parent is deterministic even when tests run as root.
    const blocker = join(home, 'not-a-directory');
    writeFileSync(blocker, 'blocker');
    const result = await appendDaemonEvent({ kind: 'rebuild-failed', detail: 'held' }, {
      env: { WE_DAEMON_EVENTS: join(blocker, 'events.jsonl') }, home, now,
    });
    expect(result).toBe(false);
    expect(readFileSync(blocker, 'utf8')).toBe('blocker');
  });

  it('returns false without throwing when appendFile denies the write', async () => {
    const appendFile = vi.fn(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    expect(await appendDaemonEvent({ kind: 'rebuild-failed', detail: 'held' }, {
      env: {}, home, now, appendFile,
    })).toBe(false);
    expect(appendFile).toHaveBeenCalledTimes(1);
  });
});
