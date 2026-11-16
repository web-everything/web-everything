// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  FRESH_READ_MS, CACHE_MAX_AGE_MS, CLOCK_SKEW_MS, OWNER_REF, OWNER_FILE,
  defaultCachePath, getThisHost, decideHostRole, readOwnerRemote, resolveHostRole,
} from '../daemon-host-guard.mjs';

const NOW = 1_800_000_000_000;
const ME = 'daemon-a';
const OTHER = 'daemon-b';
const cache = (extra = {}) => ({ host: ME, owner: ME, writtenAt: NOW - 1000, ...extra });
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
      cache: cache(),
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
