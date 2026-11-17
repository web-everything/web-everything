import { describe, expect, it, vi } from 'vitest';
import { createDispatchThrottle, gateHost } from '../dispatch-throttle.mjs';
import { createResourceFixThrottle } from '../resource-gate.mjs';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const env = { WE_FIX_DISPATCH_MAX_CONCURRENT: '2', WE_MIN_CPU_IDLE_PCT_FIX: '20', WE_MIN_MEM_FREE_PCT: '15' };

function fixture(resource) {
  let reading = { ok: true, idlePct: 90, memFreePct: 80 };
  let availableMb = 8192;
  const sample = () => reading;
  const listClaims = vi.fn(() => []);
  const gate = vi.fn(kind => gateHost({ kind, env, sample }));
  const readSnap = vi.fn(() => ({
    sampledAt: new Date(NOW).toISOString(), freshUntil: new Date(NOW + 10000).toISOString(),
    memory: { metric: 'available', availableMb, pressureLevel: 1 },
  }));
  const throttle = resource ? createResourceFixThrottle({
    env, listClaims, gate, readSnap, nowMs: () => NOW, sendBackReservedSlots: 0,
    resolveFloor: () => ({ floorMb: 2048, metric: 'available', source: 'test' }),
    settings: { cutover: 'enforce', fixCap: { floor: 2, ceiling: 2 } },
    readHeavyWait: () => 0, log: () => {},
  }) : createDispatchThrottle({ env, listClaims, sample });
  return { throttle, gate, readSnap, listClaims,
    setReading: value => { reading = value; }, setAvailable: value => { availableMb = value; } };
}

describe.each([['resource', true], ['dispatch', false]])('%s throttle host recheck', (_, resource) => {
  it('never initializes live counts or calculates the cap, and N rechecks consume no admissions', () => {
    const f = fixture(resource);
    for (let i = 0; i < 5; i++) expect(f.throttle.recheckHost()).toEqual({ admit: true });
    expect(f.listClaims).not.toHaveBeenCalled();
    if (resource) expect(f.throttle.capDecision()).toBeNull();
    expect(f.throttle.tryAdmit().admit).toBe(true);
    for (let i = 0; i < 5; i++) expect(f.throttle.recheckHost()).toEqual({ admit: true });
    expect(f.throttle.tryAdmit().admit).toBe(true);
    expect(f.throttle.tryAdmit()).toMatchObject({ admit: false, kind: 'fix-cap' });
    expect(f.throttle.recheckHost()).toEqual({ admit: true });
    expect(f.listClaims).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['low CPU idle', { ok: true, idlePct: 1, memFreePct: 80 }],
    ['low memory free', { ok: true, idlePct: 90, memFreePct: 1 }],
  ])('re-reads and refuses %s without consuming an admission', (_, reading) => {
    const f = fixture(resource);
    expect(f.throttle.recheckHost().admit).toBe(true);
    f.setReading(reading);
    expect(f.throttle.recheckHost()).toMatchObject({ admit: false, kind: 'host-load' });
    f.setReading({ ok: true, idlePct: 90, memFreePct: 80 });
    expect(f.throttle.tryAdmit().admit).toBe(true);
    expect(f.throttle.tryAdmit().admit).toBe(true);
  });

  it('fails closed when the host gate throws', () => {
    const f = fixture(resource);
    if (resource) f.gate.mockImplementation(() => { throw Error('gate exploded'); });
    else f.setReading({ ok: true, get idlePct() { throw Error('gate exploded'); } });
    expect(f.throttle.recheckHost()).toMatchObject({ admit: false, kind: 'host-load', why: expect.stringContaining('gate exploded') });
    expect(f.listClaims).not.toHaveBeenCalled();
  });
});

it('resource recheck reads the memory floor before the host gate on every call', () => {
  const f = fixture(true);
  expect(f.throttle.recheckHost('ci-heal')).toEqual({ admit: true });
  expect(f.gate).toHaveBeenCalledWith('ci-heal');
  f.setAvailable(1024);
  expect(f.throttle.recheckHost('ci-heal')).toMatchObject({ admit: false, kind: 'host-load', signal: 'mem-floor' });
  expect(f.readSnap).toHaveBeenCalledTimes(2);
  expect(f.gate).toHaveBeenCalledTimes(1);
  f.readSnap.mockImplementation(() => { throw Error('unreadable snapshot'); });
  expect(f.throttle.recheckHost()).toMatchObject({ admit: false, kind: 'host-load', signal: 'mem-floor' });
  expect(f.gate).toHaveBeenCalledTimes(1);
});
