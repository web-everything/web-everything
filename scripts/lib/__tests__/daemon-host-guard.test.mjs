// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { liveHolderContention, markerCreationFailure } from '../../conveyor/soak/breaks/host-handoff-cache-write-race.mjs';
import {
  FRESH_READ_MS, CACHE_MAX_AGE_MS, CLOCK_SKEW_MS, OWNER_REF, OWNER_FILE,
  defaultCachePath, getThisHost, decideHostRole, readOwnerRemote, resolveHostRole,
  readCacheFile, writeCacheFile, invalidateCacheFile, runGhApi,
} from '../daemon-host-guard.mjs';

const NOW = 1_800_000_000_000;
const ME = 'daemon-a';
const OTHER = 'daemon-b';
const cache = (extra = {}) => {
  const at = extra.writtenAt ?? NOW - 1000;
  return { host: ME, owner: ME, status: 'ok', readAt: at, writtenAt: at, ...extra };
};
const decide = (extra = {}) => decideHostRole({
  thisHost: ME, owner: null, now: NOW, cache: null, ...extra,
});

describe('daemon host guard contract', () => {
  it('exports the timing bounds, owner location and portable cache path', () => {
    expect(FRESH_READ_MS).toBe(60000);
    expect(CACHE_MAX_AGE_MS).toBe(600000);
    expect(CLOCK_SKEW_MS).toBe(5000);
    expect(OWNER_REF).toBe('daemon-host-owner');
    expect(OWNER_FILE).toBe('host');
    expect(defaultCachePath('fixture-home')).toBe(join('fixture-home', '.claude', 'daemon-host-guard', 'cache.json'));
  });

  it('fresh-me active', () => {
    expect(decide({ owner: ME, ownerReadAt: NOW, cache: cache({ owner: OTHER }) }))
      .toEqual({ role: 'active', reason: 'fresh-owner-is-this-host' });
  });

  it('fresh-other standby overrides a cache naming me', () => {
    expect(decide({ owner: OTHER, ownerReadAt: NOW, cache: cache() }))
      .toEqual({ role: 'standby', reason: 'owner-is-other-host' });
  });

  it('fresh unset standby owner-unset overrides a cache naming me', () => {
    expect(decide({ owner: '', ownerReadAt: NOW, cache: cache() }))
      .toEqual({ role: 'standby', reason: 'owner-unset' });
  });

  it('unreadable+fresh-cache-me active', () => {
    expect(decide({ cache: cache() })).toEqual({ role: 'active', reason: 'cache-owner-is-this-host' });
  });

  it('unreadable+stale-cache standby', () => {
    expect(decide({ cache: cache({ writtenAt: NOW - 600001 }) }))
      .toEqual({ role: 'standby', reason: 'cache-stale' });
  });

  it('unreadable+no cache standby', () => {
    for (const owner of [null, undefined]) {
      expect(decide({ owner })).toEqual({ role: 'standby', reason: 'owner-unreadable' });
    }
  });

  it('at-start-without-fresh standby even with fresh cache naming me', () => {
    for (const extra of [{}, { owner: ME, ownerReadAt: NOW - 60001 }]) {
      expect(decide({ atStart: true, cache: cache(), ...extra }))
        .toEqual({ role: 'standby', reason: 'start-requires-fresh-read' });
    }
  });

  it('at-start with fresh read naming me active', () => {
    expect(decide({ atStart: true, owner: ME, ownerReadAt: NOW }))
      .toEqual({ role: 'active', reason: 'fresh-owner-is-this-host' });
  });

  it('cache written by another host ignored', () => {
    expect(decide({ cache: cache({ host: OTHER }) }))
      .toEqual({ role: 'standby', reason: 'cache-foreign-host' });
  });

  it('cache naming another owner stays standby', () => {
    expect(decide({ cache: cache({ owner: OTHER }) }))
      .toEqual({ role: 'standby', reason: 'cache-owner-is-other-host' });
  });

  it('fresh read and cache age bounds are inclusive with closed fallback beyond them', () => {
    expect(decide({ owner: ME, ownerReadAt: NOW - 60000 }))
      .toEqual({ role: 'active', reason: 'fresh-owner-is-this-host' });
    expect(decide({ owner: ME, ownerReadAt: NOW - 60001 }))
      .toEqual({ role: 'standby', reason: 'owner-unreadable' });
    for (const age of [0, 600000]) {
      expect(decide({ cache: cache({ writtenAt: NOW - age }) }))
        .toEqual({ role: 'active', reason: 'cache-owner-is-this-host' });
    }
  });

  it('clock skew: read in future beyond tolerance fails closed without a usable cache', () => {
    expect(decide({ owner: ME, ownerReadAt: NOW + 5001 }))
      .toEqual({ role: 'standby', reason: 'clock-skew' });
    expect(decide({ owner: ME, ownerReadAt: NOW + 5001, cache: cache() }))
      .toEqual({ role: 'active', reason: 'cache-owner-is-this-host' });
  });

  it('clock skew: cache in future beyond tolerance fails closed', () => {
    expect(decide({ cache: cache({ writtenAt: NOW + 5001 }) }))
      .toEqual({ role: 'standby', reason: 'clock-skew' });
  });

  it('future within tolerance still fresh', () => {
    for (const offset of [1, 5000]) {
      expect(decide({ owner: ME, ownerReadAt: NOW + offset }))
        .toEqual({ role: 'active', reason: 'fresh-owner-is-this-host' });
    }
  });

  it('invalid input fails closed', () => {
    for (const thisHost of [undefined, null, '']) {
      expect(decide({ thisHost, owner: ME, ownerReadAt: NOW, cache: cache() }))
        .toEqual({ role: 'standby', reason: 'invalid-input' });
    }
    for (const now of [undefined, NaN, Infinity, -Infinity]) {
      expect(decide({ now, owner: ME, ownerReadAt: NOW, cache: cache() }))
        .toEqual({ role: 'standby', reason: 'invalid-input' });
    }
  });

  it('decideHostRole is pure and leaves frozen inputs unchanged', () => {
    const stored = Object.freeze(cache());
    const input = Object.freeze({ thisHost: ME, owner: null, now: NOW, cache: stored });
    expect(decideHostRole(input)).toEqual(decideHostRole(input));
    expect(stored).toEqual(cache());
    expect(input.cache).toBe(stored);
  });
});

function resolver(extra = {}) {
  let stored = extra.cache ?? null;
  let reads = 0;
  const writes = [];
  const options = {
    thisHost: ME, atStart: false, now: NOW,
    readCache: () => stored,
    writeCache: (value) => { writes.push(value); stored = value; },
    readRemote: () => { reads += 1; return { status: 'ok', owner: ME }; },
    ...extra,
  };
  return { options, writes, reads: () => reads };
}

describe('resolveHostRole injected IO', () => {
  it('joins the same decision while successful cache persistence is pending', async () => {
    const writing = deferred();
    const started = deferred();
    let stored = null;
    let reads = 0;
    const options = { thisHost: ME, now: NOW, state: {}, readCache: () => stored,
      readRemote: () => { reads += 1; return { status: 'ok', owner: ME }; },
      writeCache: async (value) => { started.resolve(); await writing.promise; stored = value; } };
    const first = resolveHostRole(options);
    await started.promise;
    const joined = resolveHostRole(options);
    await Promise.resolve();
    writing.resolve();
    expect(await Promise.all([first, joined])).toEqual(Array(2).fill({
      role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote',
    }));
    expect(reads).toBe(1);
  });

  it('default state shares failure throttling per reader and isolates other readers', async () => {
    const first = resolver({ readRemote: offline });
    let reads = 0;
    const readRemote = () => { reads += 1; return offline(); };
    await resolveHostRole({ ...first.options, readRemote });
    await resolveHostRole({ ...first.options, readRemote });
    await resolveHostRole({ ...resolver().options, readRemote });
    expect(reads).toBe(2);
    expect(first.writes).toEqual([]);
  });

  it('a startup joiner cannot inherit active cache fallback from a failed shared read', async () => {
    const reading = deferred();
    const started = deferred();
    let reads = 0;
    const fixture = resolver({ cache: cache({ readAt: NOW - 120000 }), readRemote: () => {
      reads += 1; started.resolve(); return reading.promise;
    } });
    const running = resolveHostRole(fixture.options);
    await started.promise;
    const startup = resolveHostRole({ ...fixture.options, atStart: true });
    await Promise.resolve();
    reading.resolve({ status: 'error' });
    expect(await running).toMatchObject({ role: 'active', reason: 'cache-owner-is-this-host' });
    expect(await startup).toMatchObject({ role: 'standby', reason: 'start-requires-fresh-read' });
    expect(reads).toBe(1);
    expect(fixture.writes).toEqual([]);
  });

  it.each([true, false])('three simultaneous empty-cache calls share one read and identical decisions (explicit state: %s)', async (explicit) => {
    const reading = deferred();
    let reads = 0;
    const fixture = resolver({ ...(explicit ? { state: {} } : {}),
      readRemote: () => { reads += 1; return reading.promise; } });
    const calls = Promise.all(Array.from({ length: 3 }, () => resolveHostRole(fixture.options)));
    await Promise.resolve();
    reading.resolve({ status: 'ok', owner: ME });
    const decisions = await calls;
    expect(reads).toBe(1);
    expect(decisions).toEqual(Array(3).fill({
      role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote',
    }));
    expect(fixture.writes).toHaveLength(1);
  });

  it.each([{ status: 'ok', owner: OTHER }, { status: 'unset' }])(
    'separate states cannot overwrite a newer confirmed $status handoff', async (handoff) => {
      let stored = null;
      const reading = deferred();
      const started = deferred();
      const writes = [];
      const options = { thisHost: ME, now: NOW, atStart: true,
        readCache: () => stored, writeCache: (value) => { writes.push(value); stored = value; } };
      const old = resolveHostRole({ ...options, state: {}, readRemote: () => {
        started.resolve(); return reading.promise;
      } });
      await started.promise;
      await resolveHostRole({ ...options, state: {}, now: NOW + 1, readRemote: () => handoff });
      reading.resolve({ status: 'ok', owner: ME });
      expect(await old).toMatchObject({ role: 'standby', reason: 'superseded-owner-read' });
      expect(writes).toHaveLength(1);
      expect(stored.owner).toBe(handoff.owner ?? '');
      expect(await resolveHostRole({ ...options, state: {}, atStart: false,
        now: NOW + FRESH_READ_MS + 2, readRemote: offline })).toMatchObject({ role: 'standby' });
    },
  );

  it('rate limit: second call within 60s does not call readRemote', async () => {
    const fixture = resolver();
    expect(await resolveHostRole(fixture.options)).toEqual({
      role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote',
    });
    expect(await resolveHostRole({ ...fixture.options, now: NOW + 60000 })).toEqual({
      role: 'active', reason: 'fresh-owner-is-this-host', source: 'cache-fresh-read',
    });
    expect(fixture.reads()).toBe(1);
    expect(fixture.writes).toHaveLength(1);
    expect((await resolveHostRole({ ...fixture.options, now: NOW + 60001 })).source).toBe('remote');
    expect(fixture.reads()).toBe(2);
  });

  it('reuses a fresh cached unset read and does not refresh its timestamps', async () => {
    const fixture = resolver({ cache: cache({ status: 'unset', owner: '', readAt: NOW - 1000 }) });
    expect(await resolveHostRole(fixture.options)).toEqual({
      role: 'standby', reason: 'owner-unset', source: 'cache-fresh-read',
    });
    expect(fixture.reads()).toBe(0);
    expect(fixture.writes).toEqual([]);
  });

  it('at start bypasses cached fresh reads and requires the remote', async () => {
    const fixture = resolver({ atStart: true, cache: cache({ status: 'ok', readAt: NOW }) });
    expect((await resolveHostRole(fixture.options)).source).toBe('remote');
    expect(fixture.reads()).toBe(1);
  });

  it('foreign cache cannot supply a fresh read or fallback ownership', async () => {
    const fixture = resolver({
      cache: cache({ host: OTHER, status: 'ok', readAt: NOW }),
      readRemote: () => ({ status: 'error', error: 'offline' }),
    });
    const result = await resolveHostRole(fixture.options);
    expect(result).toMatchObject({ role: 'standby', source: 'remote-failed' });
    expect(fixture.writes).toEqual([]);
  });

  it('cached read beyond future clock tolerance cannot bypass the remote', async () => {
    const fixture = resolver({ cache: cache({ status: 'ok', readAt: NOW + 5001 }) });
    expect((await resolveHostRole(fixture.options)).source).toBe('remote');
    expect(fixture.reads()).toBe(1);
  });

  it.each([{ status: 'ok', owner: ME }, { status: 'unset' }])(
    'writes cache only on successful remote $status', async (remote) => {
      const fixture = resolver({ readRemote: () => remote });
      const result = await resolveHostRole(fixture.options);
      expect(fixture.writes).toEqual([{
        host: ME, status: remote.status, owner: remote.owner ?? '', readAt: NOW, writtenAt: NOW,
      }]);
      expect(result).toEqual(remote.status === 'ok'
        ? { role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote' }
        : { role: 'standby', reason: 'owner-unset', source: 'remote' });
    },
  );

  it.each(['returned error', 'throw'])('remote %s never writes cache and uses fallback only after start', async (mode) => {
    const fixture = resolver({
      cache: cache({ readAt: NOW - 120000 }),
      readRemote: () => {
        if (mode === 'throw') throw new Error('offline');
        return { status: 'error', error: 'offline' };
      },
    });
    expect(await resolveHostRole(fixture.options)).toEqual({
      role: 'active', reason: 'cache-owner-is-this-host', source: 'remote-failed',
    });
    expect(await resolveHostRole({ ...fixture.options, atStart: true })).toEqual({
      role: 'standby', reason: 'start-requires-fresh-read', source: 'remote-failed',
    });
    expect(fixture.writes).toEqual([]);
  });

  it('writeCache throw ignored without changing the decision', async () => {
    const fixture = resolver({ writeCache: () => { throw new Error('read-only cache'); } });
    expect(await resolveHostRole(fixture.options)).toEqual({
      role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote',
    });
  });
});

const REF_PATH = 'repos/web-everything/web-everything/git/ref/heads/daemon-host-owner';
const FILE_PATH = 'repos/web-everything/web-everything/contents/host?ref=daemon-host-owner';
function remoteFixture(responses) {
  const calls = [];
  return {
    calls,
    ghApi: (path) => {
      calls.push(path);
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe('readOwnerRemote', () => {
  it.each([
    ['noncanonical base64', 'YR==', 'noncanonical owner encoding'],
    ['invalid hostname', Buffer.from('bad host').toString('base64'), 'invalid owner host'],
    ['oversized encoding', 'A'.repeat(1024 * 1024 + 4), 'invalid owner encoding'],
  ])('rejects %s with a closed error', async (_name, content, error) => {
    expect(await readOwnerRemote(remoteFixture([
      { ok: true, status: 200 }, { ok: true, status: 200, body: { content } },
    ]))).toEqual({ status: 'error', error: expect.stringContaining(error) });
  });

  it('404 ref is unset and does not request contents', async () => {
    const fixture = remoteFixture([{ ok: false, status: 404 }]);
    expect(await readOwnerRemote(fixture)).toEqual({ status: 'unset' });
    expect(fixture.calls).toEqual([REF_PATH]);
  });

  it.each([403, 500, 503])('%s ref failure is error, never unset', async (status) => {
    const fixture = remoteFixture([{ ok: false, status }]);
    expect(await readOwnerRemote(fixture)).toEqual({ status: 'error', error: expect.anything() });
    expect(fixture.calls).toEqual([REF_PATH]);
  });

  it('ok decode trims the base64 owner and calls the exact paths in order', async () => {
    const fixture = remoteFixture([
      { ok: true, status: 200, body: {} },
      { ok: true, status: 200, body: { content: Buffer.from(`  ${ME}\n`).toString('base64') } },
    ]);
    expect(await readOwnerRemote(fixture)).toEqual({ status: 'ok', owner: ME });
    expect(fixture.calls).toEqual([REF_PATH, FILE_PATH]);
  });

  it('empty decoded owner is unset', async () => {
    const fixture = remoteFixture([
      { ok: true, status: 200 },
      { ok: true, status: 200, body: { content: Buffer.from(' \n').toString('base64') } },
    ]);
    expect(await readOwnerRemote(fixture)).toEqual({ status: 'unset' });
  });

  it.each([
    { ok: false, status: 403 }, { ok: false, status: 500 },
    { ok: true, status: 200, body: {} }, { ok: true, status: 200, body: null },
    { ok: true, status: 200, body: { content: 123 } },
    { ok: true, status: 200, body: { content: '%%%not-base64%%%' } },
    new Error('contents unavailable'),
  ])('malformed or unreadable contents returns error: %j', async (response) => {
    const fixture = remoteFixture([{ ok: true, status: 200 }, response]);
    expect(await readOwnerRemote(fixture)).toEqual({ status: 'error', error: expect.anything() });
    expect(fixture.calls).toEqual([REF_PATH, FILE_PATH]);
  });

  it.each([undefined, {}, new Error('network unavailable')])('malformed or throwing ref read returns error: %j', async (response) => {
    expect(await readOwnerRemote(remoteFixture([response])))
      .toEqual({ status: 'error', error: expect.anything() });
  });
});

describe('getThisHost', () => {
  it('default scutil exec is bounded to 15s and 1 MiB', () => {
    // A native child exercises the default wrapper, rather than replacing it via exec.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const calls = [];
      cp.execFileSync = (...args) => { calls.push(args); return 'daemon-a'; };
      syncBuiltinESMExports();
      const { getThisHost } = await import(${JSON.stringify(new URL('../daemon-host-guard.mjs', import.meta.url).href)});
      console.log(JSON.stringify({ host: getThisHost(), calls }));
    `], { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(JSON.parse(output)).toEqual({ host: ME, calls: [['scutil', ['--get', 'HostName'],
      expect.objectContaining({ timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })]] });
  });

  it('uses trimmed scutil HostName before hostname fallback', () => {
    const calls = [];
    expect(getThisHost({
      exec: (...args) => { calls.push(args); return ` ${ME}\n`; },
      hostname: () => { throw new Error('fallback must not run'); },
    })).toBe(ME);
    expect(calls).toEqual([['scutil', ['--get', 'HostName']]]);
  });

  it.each(['', ' \n', 'throw'])('fallback to hostname when scutil is empty or throws: %j', (output) => {
    let fallbacks = 0;
    expect(getThisHost({
      exec: () => { if (output === 'throw') throw new Error('no scutil'); return output; },
      hostname: () => { fallbacks += 1; return ME; },
    })).toBe(ME);
    expect(fallbacks).toBe(1);
  });
});

describe('cache evidence with readAt (audit round 1)', () => {
  it.each([undefined, null, '', 'error', 'failed', 'unset'])(
    'cache with missing or unsuccessful status cannot activate: %j', (status) => {
      const stored = cache({ status });
      if (status === undefined) delete stored.status;
      expect(decide({ cache: stored })).toEqual({ role: 'standby', reason: 'owner-unreadable' });
    },
  );

  it.each(['host', 'owner', 'status', 'readAt', 'writtenAt'])(
    'cache missing required field %s cannot activate with all other evidence valid', (field) => {
      const stored = cache();
      delete stored[field];
      expect(decide({ cache: stored }).role).toBe('standby');
    },
  );

  it('rejects a cache whose readAt is older than ten minutes even if writtenAt is recent', () => {
    const now = 10_000_000;
    const out = decideHostRole({ thisHost: 'studio', owner: null, now,
      cache: { host: 'studio', owner: 'studio', status: 'ok', readAt: now - 700_000, writtenAt: now - 1000 } });
    expect(out).toEqual({ role: 'standby', reason: 'cache-stale' });
  });
});

describe('incomplete cache evidence fails closed', () => {
  it('a cache without status or readAt never grants active', () => {
    expect(decideHostRole({ thisHost: ME, owner: null, now: NOW, cache: { host: ME, owner: ME, writtenAt: NOW - 1000 } }))
      .toEqual({ role: 'standby', reason: 'owner-unreadable' });
  });
});


// Every sequence owns its state: no remote calls or default cache/home access.
function failedWriteFixture(remote) {
  let stored = cache();
  let invalidations = 0;
  let reads = 0;
  const options = {
    thisHost: ME, now: NOW, atStart: true, state: {},
    readCache: () => stored,
    writeCache: () => { throw new Error('disk full'); },
    invalidateCache: () => { invalidations += 1; throw new Error('unlink denied'); },
    readRemote: () => { reads += 1; return remote; },
  };
  return {
    options, invalidations: () => invalidations, reads: () => reads,
    store: (value) => { stored = value; }, stored: () => stored,
  };
}
const offline = () => ({ status: 'error', error: 'offline' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('overlapping cache persistence after handoff', () => {
  it.each([{ status: 'ok', owner: OTHER }, { status: 'unset' }])(
    'blocks old cache while a $status handoff write is pending and after it fails', async (remote) => {
      const writing = deferred();
      const started = deferred();
      const f = failedWriteFixture(remote);
      const handoff = resolveHostRole({ ...f.options,
        writeCache: () => { started.resolve(); return writing.promise; } });
      await started.promise;
      const during = resolveHostRole({ ...f.options, atStart: false,
        now: NOW + 1, readRemote: offline });
      writing.reject(new Error('disk full'));
      await handoff;
      expect(await during).toMatchObject({ role: 'standby',
        reason: remote.status === 'unset' ? 'owner-unset' : 'owner-is-other-host' });
      expect(await resolveHostRole({ ...f.options, atStart: false,
        now: NOW + FRESH_READ_MS + 2, readRemote: offline }))
        .toMatchObject({ role: 'standby', reason: 'cache-invalidated' });
    },
  );

  it.each([[false, 0], [true, 0], [false, 1], [true, 1]])(
    'late old me write cannot undo handoff (fails: %s, clock delta: %s)', async (fails, delta) => {
      let stored = cache();
      const writing = deferred();
      const started = deferred();
      const options = { thisHost: ME, now: NOW, atStart: true, state: {},
        readCache: () => stored, invalidateCache: () => { stored = null; } };
      const old = resolveHostRole({ ...options, readRemote: () => ({ status: 'ok', owner: ME }),
        writeCache: async (value) => { started.resolve(); await writing.promise; stored = value; } });
      await started.promise;
      const handoff = resolveHostRole({ ...options, state: {}, now: NOW + delta,
        readRemote: () => ({ status: 'ok', owner: OTHER }), writeCache: (value) => {
          if (fails) throw new Error('disk full');
          stored = value;
        } });
      // Let the newer read reach persistence while the older write is still pending.
      await Promise.resolve();
      await Promise.resolve();
      writing.resolve();
      await Promise.all([old, handoff]);
      expect(stored?.owner).not.toBe(ME);
      expect(await resolveHostRole({ ...options, atStart: false,
        now: NOW + FRESH_READ_MS + 2, readRemote: offline }))
        .toMatchObject({ role: 'standby' });
    },
  );

  it('an older remote response in a separate state at the same timestamp cannot supersede a confirmed handoff', async () => {
    const reading = deferred();
    const started = deferred();
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    const old = resolveHostRole({ ...f.options, state: {},
      readRemote: () => { started.resolve(); return reading.promise; } });
    await started.promise;
    await resolveHostRole({ ...f.options, writeCache: f.store });
    reading.resolve({ status: 'ok', owner: ME });
    expect(await old).toMatchObject({ role: 'standby', reason: 'superseded-owner-read' });
    expect(await resolveHostRole({ ...f.options, atStart: false,
      now: NOW + FRESH_READ_MS + 1, readRemote: offline }))
      .toMatchObject({ role: 'standby', reason: 'cache-owner-is-other-host' });
  });

  it.each(['cache', 'remote'])('discards an old me snapshot after a handoff during a delayed %s read', async (phase) => {
    const waiting = deferred();
    const started = deferred();
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    const snapshot = cache({ readAt: phase === 'cache' ? NOW : NOW - 120000 });
    // The remote phase needs stale evidence so the fresh-cache shortcut cannot
    // bypass readRemote and leave its started signal pending forever.
    f.store(snapshot);
    const old = resolveHostRole({ ...f.options, atStart: false,
      ...(phase === 'remote' ? { state: {} } : {}),
      readCache: () => {
        if (phase === 'remote') return f.stored();
        started.resolve(); return waiting.promise;
      },
      readRemote: () => {
        if (phase === 'cache') return offline();
        started.resolve(); return waiting.promise;
      } });
    await started.promise;
    await resolveHostRole({ ...f.options, now: NOW + 1, writeCache: f.store });
    waiting.resolve(phase === 'cache' ? snapshot : offline());
    expect(await old).toMatchObject({ role: 'standby', reason: 'superseded-cache-read' });
  });

  it('delayed removal cannot delete a newer recovery write and other hosts do not wait for it', async () => {
    const removing = deferred();
    const started = deferred();
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    const handoff = resolveHostRole({ ...f.options, invalidateCache: async () => {
      started.resolve(); await removing.promise; f.store(null);
    } });
    await started.promise;
    const recovery = resolveHostRole({ ...f.options, state: {}, now: NOW + 1,
      readRemote: () => ({ status: 'ok', owner: ME }), writeCache: f.store });
    const other = await resolveHostRole({ ...f.options, thisHost: OTHER, now: NOW + 2,
      readRemote: () => ({ status: 'ok', owner: OTHER }), writeCache: () => {} });
    removing.resolve();
    await handoff;
    expect(await recovery).toMatchObject({ role: 'active', source: 'remote' });
    expect(other).toMatchObject({ role: 'active', source: 'remote' });
    expect(f.stored()?.owner).toBe(ME);
  });
});

describe('cache invalidation after non-me evidence', () => {
  it('failed cache write after fresh other-host read cannot reactivate this host on a later failed read', async () => {
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    expect(await resolveHostRole(f.options)).toEqual({
      role: 'standby', reason: 'owner-is-other-host', source: 'remote',
    });
    expect(f.invalidations()).toBe(1);
    expect(f.stored()).toEqual(cache());
    expect(await resolveHostRole({ ...f.options, atStart: false,
      now: NOW + FRESH_READ_MS + 1, readRemote: offline })).toEqual({
      role: 'standby', reason: 'cache-invalidated', source: 'remote-failed',
    });
  });

  it('an older overlapping read finishing its write later cannot clear poison from a newer other-host read', async () => {
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    expect(await resolveHostRole(f.options)).toMatchObject({ reason: 'owner-is-other-host' });
    // An older call (earlier clock) reads me and its write succeeds after the newer poison was set.
    await resolveHostRole({ ...f.options, now: NOW - 1000, atStart: true,
      readRemote: () => ({ status: 'ok', owner: ME }), writeCache: () => {} });
    expect(await resolveHostRole({ ...f.options, atStart: false,
      now: NOW + FRESH_READ_MS + 1, readRemote: offline })).toEqual({
      role: 'standby', reason: 'cache-invalidated', source: 'remote-failed',
    });
  });

  it('an older overlapping read does not overwrite a newer persisted other-host cache', async () => {
    let stored = cache();
    const options = { thisHost: ME, now: NOW, atStart: true, state: {},
      readCache: () => stored, writeCache: (v) => { stored = v; }, invalidateCache: () => {} };
    await resolveHostRole({ ...options, readRemote: () => ({ status: 'ok', owner: OTHER }) });
    await resolveHostRole({ ...options, now: NOW - 1000, readRemote: () => ({ status: 'ok', owner: ME }) });
    expect(stored.owner).toBe(OTHER);
    expect(await resolveHostRole({ ...options, atStart: false, now: NOW + FRESH_READ_MS + 1,
      readRemote: offline })).toMatchObject({ role: 'standby' });
  });

  it('failed cache write with unset owner then failed read stays standby', async () => {
    const f = failedWriteFixture({ status: 'unset' });
    expect(await resolveHostRole(f.options)).toEqual({
      role: 'standby', reason: 'owner-unset', source: 'remote',
    });
    expect(f.invalidations()).toBe(1);
    expect(await resolveHostRole({ ...f.options, atStart: false,
      now: NOW + FRESH_READ_MS + 1, readRemote: offline })).toEqual({
      role: 'standby', reason: 'cache-invalidated', source: 'remote-failed',
    });
  });

  it('invalidateCache is attempted when the write fails after a non-me fresh read; if it succeeds the stale cache is gone', async () => {
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    let invalidations = 0;
    expect(await resolveHostRole({ ...f.options, invalidateCache: () => {
      invalidations += 1; f.store(null);
    } })).toMatchObject({ role: 'standby', reason: 'owner-is-other-host' });
    expect(invalidations).toBe(1);
    expect(f.stored()).toBeNull();
    expect(await resolveHostRole({ ...f.options, atStart: false,
      now: NOW + FRESH_READ_MS + 1, readRemote: offline })).toMatchObject({
      role: 'standby', source: 'remote-failed',
    });
  });

  it('successful write clears the poison and later fresh me read is active', async () => {
    const f = failedWriteFixture({ status: 'ok', owner: OTHER });
    await resolveHostRole(f.options);
    expect(f.invalidations()).toBe(1);
    const writable = { ...f.options, writeCache: f.store };
    expect(await resolveHostRole({ ...writable, now: NOW + 1 })).toMatchObject({
      role: 'standby', reason: 'owner-is-other-host', source: 'remote',
    });
    expect(f.stored()).toEqual({ host: ME, owner: OTHER, status: 'ok', readAt: NOW + 1, writtenAt: NOW + 1 });
    expect(await resolveHostRole({ ...writable, atStart: false,
      now: NOW + FRESH_READ_MS + 2, readRemote: offline })).toEqual({
      role: 'standby', reason: 'cache-owner-is-other-host', source: 'remote-failed',
    });
    expect(await resolveHostRole({ ...writable, now: NOW + FRESH_READ_MS + 3,
      readRemote: () => ({ status: 'ok', owner: ME }) })).toEqual({
      role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote',
    });
    expect(await resolveHostRole({ ...writable, atStart: false,
      now: NOW + 2 * FRESH_READ_MS + 4, readRemote: offline })).toEqual({
      role: 'active', reason: 'cache-owner-is-this-host', source: 'remote-failed',
    });
  });
});

function throttleFixture(readRemote = offline, stored = null) {
  let reads = 0;
  let writes = 0;
  let invalidations = 0;
  return {
    reads: () => reads, writes: () => writes, invalidations: () => invalidations,
    options: { thisHost: ME, now: NOW, state: {}, readCache: () => stored,
      writeCache: () => { writes += 1; throw new Error('failed reads must not write'); },
      invalidateCache: () => { invalidations += 1; throw new Error('failed reads must not invalidate'); },
      readRemote: () => { reads += 1; return readRemote(); } },
  };
}

describe('failed-read throttling', () => {
  it('failed remote read is throttled for 60s per host', async () => {
    for (const stored of [null, cache({ readAt: NOW - 120000 })]) {
      const f = throttleFixture(offline, stored);
      const decision = stored
        ? { role: 'active', reason: 'cache-owner-is-this-host' }
        : { role: 'standby', reason: 'owner-unreadable' };
      expect(await resolveHostRole(f.options)).toEqual({ ...decision, source: 'remote-failed' });
      expect(await resolveHostRole({ ...f.options, now: NOW + FRESH_READ_MS - 1 })).toEqual({
        ...(stored ? decision : { role: 'standby', reason: 'remote-throttled' }), source: 'remote-failed',
      });
      expect(f.reads()).toBe(1);
      await resolveHostRole({ ...f.options, now: NOW + FRESH_READ_MS + 1 });
      expect(f.reads()).toBe(2);
      expect(f.writes()).toBe(0);
      expect(f.invalidations()).toBe(0);
    }
    // Throttling cannot extend the bounded cache lifetime.
    const f = throttleFixture(offline, cache({ readAt: NOW - CACHE_MAX_AGE_MS + 10,
      writtenAt: NOW - CACHE_MAX_AGE_MS + 10 }));
    await resolveHostRole(f.options);
    expect(await resolveHostRole({ ...f.options, now: NOW + 11 })).toEqual({
      role: 'standby', reason: 'cache-stale', source: 'remote-failed',
    });
    expect(f.reads()).toBe(1);
  });

  it('atStart bypasses failed-read throttle', async () => {
    const f = throttleFixture();
    await resolveHostRole(f.options);
    expect(await resolveHostRole({ ...f.options, now: NOW + 1, atStart: true })).toEqual({
      role: 'standby', reason: 'start-requires-fresh-read', source: 'remote-failed',
    });
    expect(f.reads()).toBe(2);
  });

  it('throttle is per host', async () => {
    const f = throttleFixture();
    await resolveHostRole(f.options);
    await resolveHostRole({ ...f.options, thisHost: OTHER, now: NOW + 1 });
    expect(f.reads()).toBe(2);
    for (const thisHost of [ME, OTHER]) {
      expect(await resolveHostRole({ ...f.options, thisHost, now: NOW + 2 })).toEqual({
        role: 'standby', reason: 'remote-throttled', source: 'remote-failed',
      });
    }
    expect(f.reads()).toBe(2);
  });

  it('a throwing readRemote counts as failed for the throttle', async () => {
    const f = throttleFixture(() => { throw new Error('offline'); });
    expect(await resolveHostRole(f.options)).toEqual({
      role: 'standby', reason: 'owner-unreadable', source: 'remote-failed',
    });
    expect(await resolveHostRole({ ...f.options, now: NOW + 1 })).toEqual({
      role: 'standby', reason: 'remote-throttled', source: 'remote-failed',
    });
    expect(f.reads()).toBe(1);
  });
});

describe('cache file IO and gh transport', () => {
  it.each(['ENOSPC', 'EACCES'])('live holder cannot erase denial after marker creation throws %s', async (code) => {
    expect((await liveHolderContention(code)).violations).toEqual([]);
  }, 15000);

  it.each(['ENOSPC', 'EACCES'])('revocation survives a holder already releasing its empty lock (%s)', async (code) => {
    expect((await liveHolderContention(code, { phase: 'cleanup' })).violations).toEqual([]);
  }, 15000);

  it.each(['publish', 'cleanup'])('holder %s errors cannot bypass concurrent revocation', async (phase) => {
    expect((await liveHolderContention('ENOSPC', { phase, holderFails: true })).violations).toEqual([]);
  }, 15000);

  it.each(['ENOSPC', 'EACCES'])('failed handoff invalidation also reports marker denial (%s)', async (code) => {
    expect((await liveHolderContention(code, { invalidate: true })).violations).toEqual([]);
  }, 15000);

  it.each(['ENOSPC', 'EACCES'])('retained lock denies fresh activation when marker creation throws', (code) => {
    expect(markerCreationFailure(code)).toEqual({
      decision: { role: 'standby', reason: 'fence-unenforceable', source: 'remote' },
      failures: 1, reads: 1, lockExists: true, markerExists: false,
    });
  });

  it.each(['ENOSPC', 'EACCES'])('optional cache persistence failure still allows fresh activation (%s)', (code) => {
    expect(markerCreationFailure(code, { retainedLock: false })).toEqual({
      decision: { role: 'active', reason: 'fresh-owner-is-this-host', source: 'remote' },
      failures: 1, reads: 1, lockExists: false, markerExists: false,
    });
  });

  it.each([
    ['other', OTHER, 0], ['other', OTHER, 1], ['unset', '', 0], ['unset', '', 1],
  ])('failed %s handoff retains evidence against a delayed response (owner %s, delta %s)', async (_kind, owner, delta) => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-failed-handoff-'));
    const path = join(root, 'cache.json');
    const reading = deferred();
    const started = deferred();
    const options = { thisHost: ME, now: NOW, atStart: true,
      writeCache: (value) => writeCacheFile(value, path),
      invalidateCache: (value) => invalidateCacheFile(path, value) };
    try {
      writeCacheFile(cache(), path);
      const old = resolveHostRole({ ...options, state: {}, readCache: () => readCacheFile(path),
        readRemote: () => { started.resolve(); return reading.promise; } });
      await started.promise;
      await resolveHostRole({ ...options, state: {}, now: NOW + delta,
        readCache: () => readCacheFile(path),
        readRemote: () => owner ? { status: 'ok', owner } : { status: 'unset' },
        writeCache: () => { throw new Error('failed handoff write'); } });
      reading.resolve({ status: 'ok', owner: ME });
      expect(await old).toMatchObject({ role: 'standby', reason: 'superseded-owner-read' });
      expect(readCacheFile(path)).toMatchObject({ owner, readAt: NOW + delta });
      expect(await resolveHostRole({ ...options, state: {}, atStart: false,
        now: NOW + FRESH_READ_MS + 2, readCache: () => readCacheFile(path), readRemote: offline }))
        .toMatchObject({ role: 'standby' });
      // Only a genuinely newer read may recover ownership.
      expect(await resolveHostRole({ ...options, state: {}, now: NOW + FRESH_READ_MS + 3,
        readCache: () => readCacheFile(path), readRemote: () => ({ status: 'ok', owner: ME }) }))
        .toMatchObject({ role: 'active' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['write', 'invalidate'])('failed handoff %s fences the cache when denial cannot be persisted', (operation) => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-denial-fence-'));
    const path = join(root, 'cache.json');
    try {
      // A directory at the target makes atomic replacement fail deterministically.
      mkdirSync(path);
      const denial = cache({ owner: OTHER, readAt: NOW });
      expect(() => operation === 'write' ? writeCacheFile(denial, path) : invalidateCacheFile(path, denial)).toThrow();
      expect(existsSync(`${path}.lock`)).toBe(true);
      rmSync(path, { recursive: true });
      expect(writeCacheFile(cache({ readAt: NOW - 1 }), path)).toBe(false);
      expect(() => readCacheFile(path)).toThrow(/locked/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('failed handoff invalidation records denial even with no previous cache', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-absent-denial-'));
    const path = join(root, 'nested', 'cache.json');
    try {
      invalidateCacheFile(path, cache({ owner: OTHER, readAt: NOW }));
      expect(writeCacheFile(cache({ readAt: NOW - 1 }), path)).toBe(false);
      expect(readCacheFile(path).owner).toBe(OTHER);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('failed handoff advances older denial so an intervening ownership read stays superseded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-denial-order-'));
    const path = join(root, 'cache.json');
    try {
      writeCacheFile(cache({ owner: OTHER, readAt: NOW - 2 }), path);
      const options = { thisHost: ME, now: NOW, atStart: true,
        readCache: () => readCacheFile(path),
        invalidateCache: (value) => invalidateCacheFile(path, value) };
      await resolveHostRole({ ...options, readRemote: () => ({ status: 'unset' }),
        writeCache: () => { throw new Error('disk full'); } });
      expect(readCacheFile(path)).toMatchObject({ owner: '', readAt: NOW });
      expect(writeCacheFile(cache({ readAt: NOW - 1 }), path)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a failed handoff write cannot remove newer evidence and let an oldest response reactivate ownership', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-recovery-'));
    const path = join(root, 'cache.json');
    const reading = deferred();
    const writing = deferred();
    const readStarted = deferred();
    const writeStarted = deferred();
    const options = { thisHost: ME, now: NOW, atStart: true,
      writeCache: (value) => writeCacheFile(value, path),
      invalidateCache: (value) => invalidateCacheFile(path, value) };
    try {
      const oldest = resolveHostRole({ ...options, state: {}, readCache: () => readCacheFile(path),
        readRemote: () => { readStarted.resolve(); return reading.promise; } });
      await readStarted.promise;
      const failed = resolveHostRole({ ...options, state: {}, now: NOW + 1,
        readCache: () => readCacheFile(path), readRemote: () => ({ status: 'ok', owner: OTHER }),
        writeCache: () => { writeStarted.resolve(); return writing.promise; } });
      await writeStarted.promise;
      await resolveHostRole({ ...options, state: {}, now: NOW + 2,
        readCache: () => readCacheFile(path), readRemote: () => ({ status: 'ok', owner: OTHER }) });
      writing.reject(new Error('late disk failure'));
      await failed;
      // Also pin the remover itself: the check must happen inside its file lock.
      expect(invalidateCacheFile(path, cache({ owner: OTHER, readAt: NOW + 1 }))).toBe(false);
      expect(readCacheFile(path).readAt).toBe(NOW + 2);
      reading.resolve({ status: 'ok', owner: ME });
      expect(await oldest).toMatchObject({ role: 'standby', reason: 'superseded-owner-read' });
      expect(await resolveHostRole({ ...options, state: {}, atStart: false,
        now: NOW + FRESH_READ_MS + 3, readCache: () => readCacheFile(path), readRemote: offline }))
        .toMatchObject({ role: 'standby', reason: 'cache-owner-is-other-host' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('serializes two processes when an older writer pauses between comparison and rename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-processes-'));
    const path = join(root, 'cache.json');
    const release = join(root, 'release');
    const moduleUrl = new URL('../daemon-host-guard.mjs', import.meta.url).href;
    const old = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (...args) => {
        process.send('before-rename');
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(${JSON.stringify(release)})) {
          if (Date.now() > deadline) throw new Error('release timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        return rename(...args);
      };
      syncBuiltinESMExports();
      const { writeCacheFile } = await import(${JSON.stringify(moduleUrl)});
      writeCacheFile(${JSON.stringify(cache({ readAt: NOW, writtenAt: NOW }))}, ${JSON.stringify(path)});
    `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const oldExit = once(old, 'exit');
    let newer;
    try {
      await once(old, 'message');
      newer = spawn(process.execPath, ['--input-type=module', '-e', `
        import { writeCacheFile } from ${JSON.stringify(moduleUrl)};
        process.send('writing');
        writeCacheFile(${JSON.stringify(cache({ owner: OTHER, readAt: NOW + 1, writtenAt: NOW + 1 }))}, ${JSON.stringify(path)});
      `], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const newerExit = once(newer, 'exit');
      await once(newer, 'message');
      // Release the first holder after the independent writer starts contending.
      await new Promise((resolve) => setTimeout(resolve, 50));
      writeFileSync(release, '');
      expect((await oldExit)[0]).toBe(0);
      expect((await newerExit)[0]).toBe(0);
      expect(readCacheFile(path).owner).toBe(OTHER);
      expect(readdirSync(root).sort()).toEqual(['cache.json', 'cache.json.lock.fence', 'release']);
    } finally {
      old.kill(); newer?.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an abandoned writer lock denies fallback and leaves an operator-visible fence on bounded contention', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-abandoned-'));
    const path = join(root, 'cache.json');
    try {
      writeCacheFile(cache(), path);
      mkdirSync(`${path}.lock`);
      expect(() => readCacheFile(path)).toThrow('cache locked');
      expect(writeCacheFile(cache({ owner: OTHER }), path)).toBe(false);
      expect(readdirSync(`${path}.lock`)).toEqual(['blocked']);
      expect(() => readCacheFile(path)).toThrow('cache locked');
      expect(JSON.parse(readFileSync(path, 'utf8')).owner).toBe(ME);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([0, 1])('atomic replacement rejects older ownership after a persisted handoff (delta: %s)', (delta) => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-stale-'));
    try {
      const path = join(root, 'cache.json');
      const handoff = cache({ owner: OTHER, readAt: NOW + delta, writtenAt: NOW + delta });
      writeCacheFile(handoff, path);
      expect(writeCacheFile(cache({ readAt: NOW, writtenAt: NOW }), path)).toBe(false);
      expect(readCacheFile(path)).toEqual(handoff);
      expect(readdirSync(root).sort()).toEqual(['cache.json', 'cache.json.lock.fence']);
      writeCacheFile(cache({ readAt: NOW + delta + 1, writtenAt: NOW + delta + 1 }), path);
      expect(readCacheFile(path).owner).toBe(ME);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('readCacheFile/writeCacheFile round trip with mode 0600 and no leftover tmp files', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-cache-'));
    try {
      const path = join(root, 'nested', 'cache.json');
      writeCacheFile(cache(), path);
      expect(readCacheFile(path)).toEqual(cache());
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(cache());
      expect(statSync(path).mode & 0o777).toBe(0o600);
      writeCacheFile(cache({ owner: OTHER }), path);
      expect(readCacheFile(path)).toEqual(cache({ owner: OTHER }));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(join(path, '..')).sort()).toEqual(['cache.json', 'cache.json.lock.fence']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('writeCacheFile does not leave a partial cache when rename fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-rename-'));
    try {
      const path = join(root, 'cache.json');
      mkdirSync(path);
      writeFileSync(join(path, 'sentinel'), 'unchanged');
      expect(() => writeCacheFile(cache(), path)).toThrow();
      expect(statSync(path).isDirectory()).toBe(true);
      expect(readFileSync(join(path, 'sentinel'), 'utf8')).toBe('unchanged');
      expect(readdirSync(root).sort()).toEqual(['cache.json', 'cache.json.lock.fence']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('invalidateCacheFile removes the file and tolerates a missing file', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-guard-unlink-'));
    try {
      const path = join(root, 'cache.json');
      writeFileSync(path, '{}');
      invalidateCacheFile(path);
      expect(existsSync(path)).toBe(false);
      expect(() => invalidateCacheFile(path)).not.toThrow();
      mkdirSync(path);
      expect(() => invalidateCacheFile(path)).toThrow();
      expect(statSync(path).isDirectory()).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('runGhApi maps 404 and 403 stderr to status codes, success to parsed body, and unparseable output to a failure', () => {
    for (const status of [404, 403, null]) {
      const result = runGhApi(REF_PATH, { execFile: () => {
        throw Object.assign(new Error('gh failed'), {
          stderr: Buffer.from(status === null ? 'network unavailable' : `gh: denied (HTTP ${status})`),
        });
      } });
      expect(result).toMatchObject({ ok: false, status });
    }
    const calls = [];
    expect(runGhApi(REF_PATH, { execFile: (...args) => {
      calls.push(args); return '{"owner":"daemon-a"}';
    } })).toEqual({ ok: true, status: 200, body: { owner: ME } });
    expect(calls).toEqual([['gh', ['api', REF_PATH], expect.objectContaining({
      encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
    })]]);
    expect(runGhApi(REF_PATH, { execFile: () => 'not JSON' })).toMatchObject({ ok: false, status: null });
  });
});
