/**
 * @file scripts/operations/__tests__/live-state-io.test.mjs
 * @description Card xvz55jf (epic #3931) — `live-state-io.mjs` proof, split the same way `daemon-status-io.
 *   test.mjs` / `daemon-status-io-real.test.mjs` are: injected-fakes shape proof here (no real subprocess/fs —
 *   every seam overridden), a REAL fidelity check in `live-state-io-real.test.mjs` (a real `lane-pool.mjs
 *   status --json` subprocess against this actual checkout, a real jsonl file on real disk, real `os.loadavg`).
 */
import { describe, it, expect } from 'vitest';
import {
  expandHome, defaultDrainHistoryPath, readOneLanePool, readAllLanePools, readDrainLastPass, readMachineLoad,
  collectLiveState, countLanePool,
} from '../live-state-io.mjs';
import { RECENT_MS } from '../agent-activity-io.mjs';

describe('expandHome', () => {
  it('expands a leading $HOME to the real home dir', () => expect(expandHome('$HOME/workspace/frontierui', '/Users/x')).toBe('/Users/x/workspace/frontierui'));
  it('leaves a path with no $HOME untouched', () => expect(expandHome('', '/Users/x')).toBe(''));
});

describe('defaultDrainHistoryPath', () => {
  it('is the card\'s own pinned path when no env override is set', () => {
    expect(defaultDrainHistoryPath({}, '/Users/nicolasgilbert')).toBe('/Users/nicolasgilbert/workspace/plateau-app/.drain-daemon/history.jsonl');
  });
  it('honours WE_LIVE_STATE_DRAIN_HISTORY when set', () => {
    expect(defaultDrainHistoryPath({ WE_LIVE_STATE_DRAIN_HISTORY: '/tmp/x.jsonl' }, '/home')).toBe('/tmp/x.jsonl');
  });
});

describe('readOneLanePool — counts free/leased/dirty from injected lane-pool.mjs --json output', () => {
  it('splits existing lanes into free / leased / dirty', () => {
    const out = readOneLanePool('we', {
      execFn: () => JSON.stringify({
        repo: 'web-everything',
        lanes: [
          { lane: 1, exists: true, clean: true, leased: false },
          { lane: 2, exists: true, clean: false, leased: false }, // dirty
          { lane: 3, exists: true, clean: true, leased: true }, // leased
          { lane: 4, exists: false }, // not provisioned — excluded from every count
        ],
      }),
    });
    expect(out).toEqual({ repoKey: 'we', total: 3, free: 1, leased: 1, dirty: 1 });
  });

  it('degrades to an error row rather than throwing when the subprocess fails', () => {
    const out = readOneLanePool('frontierui', { execFn: () => { throw new Error('boom: no such file'); } });
    expect(out.repoKey).toBe('frontierui');
    expect(out.free).toBe(0);
    expect(out.error).toMatch(/boom/);
  });

  it('degrades to an error row on unparseable output rather than throwing', () => {
    const out = readOneLanePool('we', { execFn: () => 'not json' });
    expect(out.error).toBeTruthy();
  });

  it('passes --repo=<path> only for a sibling (non-we) pool', () => {
    const calls = [];
    readOneLanePool('plateau-app', {
      execFn: (cmd, args) => { calls.push(args); return JSON.stringify({ lanes: [] }); },
      repoPathArg: '/Users/x/workspace/plateau-app',
    });
    expect(calls[0]).toContain('--repo=/Users/x/workspace/plateau-app');
  });
});

describe('readAllLanePools', () => {
  it('reads every constellation repo, we with no --repo, siblings with an expanded --repo path', () => {
    const calls = [];
    const out = readAllLanePools({
      execFn: (cmd, args) => { calls.push(args); return JSON.stringify({ lanes: [{ exists: true, clean: true, leased: false }] }); },
      home: '/Users/x',
    });
    expect(out.map((p) => p.repoKey)).toEqual(['we', 'frontierui', 'plateau-app']);
    expect(calls[0].some((a) => a.startsWith('--repo='))).toBe(false); // we: cwd-derived, no --repo
    expect(calls[1]).toContain('--repo=/Users/x/workspace/frontierui');
    expect(calls[2]).toContain('--repo=/Users/x/workspace/plateau-app');
  });
});

/** A fake `fs` bag for `readJsonlTail` (`./land-advance-io.mjs`): `statSync`/`openSync`/`readSync`/`closeSync`
 *  over one in-memory string, mirroring the real Buffer-fill contract (`readSync(fd, buffer, 0, len, start)`
 *  fills `buffer` and returns bytes read) closely enough that the real reader's own slicing math works unmodified. */
function fakeJsonlFs(text) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    statSync: () => ({ size: bytes.length }),
    openSync: () => 1,
    readSync: (fd, buffer, offset, length, position) => {
      const slice = bytes.subarray(position, position + length);
      slice.copy(buffer, offset);
      return slice.length;
    },
    closeSync: () => {},
  };
}

describe('readDrainLastPass', () => {
  it('returns the LAST line of an injected fake fs as lastPass', () => {
    const text = '{"at":"2026-09-26T15:00:00.000Z","exit":0,"considered":1,"merged":1}\n'
      + '{"at":"2026-09-26T15:01:00.000Z","exit":0,"considered":2,"merged":0}\n';
    const out = readDrainLastPass({ path: '/fake/history.jsonl', fs: fakeJsonlFs(text) });
    expect(out.lastPass).toEqual({ at: '2026-09-26T15:01:00.000Z', exit: 0, considered: 2, merged: 0 });
  });

  it('reports {lastPass: null} rather than throwing on a missing file', () => {
    const fakeFs = { statSync: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; }, openSync: () => 1, readSync: () => 0, closeSync: () => {} };
    expect(readDrainLastPass({ path: '/nope.jsonl', fs: fakeFs })).toEqual({ lastPass: null });
  });

  it('degrades to {lastPass: null, error} rather than throwing on a corrupt last line', () => {
    const out = readDrainLastPass({ path: '/fake/history.jsonl', fs: fakeJsonlFs('not json\n') });
    expect(out.lastPass).toBeNull();
    expect(out.error).toBeTruthy();
  });
});

describe('readMachineLoad', () => {
  it('reads loadavg + cpu count through the injected seams', () => {
    expect(readMachineLoad({ readLoadavg: () => [1.5, 1.2, 1.0], readCpus: () => new Array(8).fill({}) }))
      .toEqual({ loadavg: [1.5, 1.2, 1.0], cores: 8 });
  });
  it('never reports 0 cores (would make every load ratio infinite)', () => {
    expect(readMachineLoad({ readLoadavg: () => [0, 0, 0], readCpus: () => [] }).cores).toBe(1);
  });
});

describe('collectLiveState — joins every sub-read into one snapshot, each seam independently injectable', () => {
  it('calls every collector exactly once and stamps observedAt from the injected clock', () => {
    const calls = [];
    const out = collectLiveState({
      readWeLaneStatus: () => ({ parsed: { lanes: [] } }),
      now: () => Date.parse('2026-09-26T12:00:00.000Z'),
      collectDaemons: () => { calls.push('daemons'); return { daemons: [] }; },
      collectQueue: () => { calls.push('queue'); return { held: [], waiting: [] }; },
      readHealth: () => { calls.push('health'); return { running: false, lastTick: null, episodes: [] }; },
      readLanes: () => { calls.push('lanes'); return []; },
      readDrain: () => { calls.push('drain'); return { lastPass: null }; },
      readGithub: () => { calls.push('github'); return null; },
      readLoad: () => { calls.push('load'); return { loadavg: [0], cores: 1 }; },
      readActivity: () => { calls.push('activity'); return { rows: [] }; },
    });
    expect(calls).toEqual(['daemons', 'queue', 'health', 'lanes', 'drain', 'github', 'load', 'activity']);
    expect(out.observedAt).toBe('2026-09-26T12:00:00.000Z');
    // daemonStatus/heavyQueue are the ASSESSED shapes (assessDaemonStatus/assessHeavyQueue applied here), not
    // the raw collector output — this is the "reuse the existing assessment" contract the header promises.
    expect(out.daemonStatus).toHaveProperty('anyRefusing');
    expect(out.heavyQueue).toHaveProperty('headline');
    // Card x20lkf6 — `runningRows` carries the RUNNING section's raw input, already enriched (empty here since
    // the injected `readActivity` returns no rows).
    expect(out.runningRows).toEqual([]);
  });
});

// #4956: one shared status must supply both consumers, including failures.
it('counts a pre-read status and reuses it without spawning WE', () => {
  const parsed = { lanes: [
    { exists: true, clean: true, leased: false },
    { exists: true, clean: false, leased: false },
    { exists: true, clean: true, leased: true },
    { exists: false },
  ] };
  const expected = { repoKey: 'we', total: 3, free: 1, leased: 1, dirty: 1 };
  expect(countLanePool('we', { parsed })).toEqual(expected);
  expect(readOneLanePool('we', { execFn: () => JSON.stringify(parsed) })).toEqual(expected);
  expect(countLanePool('we', { error: 'boom' })).toEqual({ repoKey: 'we', total: 0, free: 0, leased: 0, dirty: 0, error: 'boom' });
  for (const status of [{ parsed }, { error: 'boom' }]) {
    const calls = [];
    const rows = readAllLanePools({ statusFor: { we: status }, execFn: (cmd, args) => {
      calls.push(args); return '{"lanes":[]}';
    } });
    expect(calls).toHaveLength(2);
    expect(calls.every(args => args.some(arg => arg.startsWith('--repo=')))).toBe(true);
    expect(rows[0]).toEqual(countLanePool('we', status));
  }
});

it('shares exactly one WE status with lane counts and activity leases across repeated reads', () => {
  for (const status of [
    { parsed: { lanes: [{ exists: true, clean: true, leased: true, lease: { purpose: 'build-1', ownerSession: 's1' } }] } },
    { error: 'timed out' },
  ]) {
    let reads = 0;
    let readers = 0;
    for (let i = 0; i < 20; i++) {
      collectLiveState({
        readWeLaneStatus: () => { reads++; return status; },
        collectDaemons: () => ({ daemons: [] }), collectQueue: () => ({ held: [], waiting: [] }),
        readHealth: () => ({}), readDrain: () => ({}), readGithub: () => null,
        readLoad: () => ({ loadavg: [0], cores: 1 }),
        readLanes: options => { expect(options).toEqual({ statusFor: { we: status } }); return []; },
        createActivityReader: options => {
          readers++;
          expect(options.subagentRecentMs).toBe(RECENT_MS);
          expect(options.readLeases()).toEqual(status.parsed ? [{ purpose: 'build-1', ownerSession: 's1' }] : []);
          return () => ({ rows: [] });
        },
      });
    }
    expect(reads).toBe(20);
    expect(readers).toBe(20);
  }
});
