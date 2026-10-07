import { describe, it, expect } from 'vitest';
import { createDispatchThrottle, resolveCiHealReserve } from '../dispatch-throttle.mjs';

const claim = (kind, pr) => ({ meta: { kind, pr, repo: 'we' } });
const idle = { loadavg: () => 1, cpuCount: () => 12 };

// Live incident 2026-10-07: PR #4235 failed its own required check, but two review-fix sessions held the whole
// fixer cap, so its ci-heal was deferred pass after pass and no one owned it. A ci-heal now has a reserved slot.
describe('ci-heal reserve slot', () => {
  it('defaults to 1; env overrides; junk falls back', () => {
    expect(resolveCiHealReserve({ env: {} })).toBe(1);
    expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: '2' } })).toBe(2);
    expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: '0' } })).toBe(0);
    expect(resolveCiHealReserve({ env: { WE_CI_HEAL_RESERVE: 'x' } })).toBe(1);
  });
  it('admits a ci-heal when review fixes hold the whole cap', () => {
    const t = createDispatchThrottle({ ...idle, env: {}, listClaims: () => [claim('fix', 1), claim('fix', 2)] });
    expect(t.tryAdmit('ci-heal')).toEqual({ admit: true });
  });
  it('the reserve is for ci-heal only: a fix still waits at the cap', () => {
    const t = createDispatchThrottle({ ...idle, env: {}, listClaims: () => [claim('fix', 1), claim('fix', 2)] });
    expect(t.tryAdmit('fix')).toMatchObject({ admit: false, kind: 'fix-cap' });
  });
  it('only one ci-heal rides the reserve; a live ci-heal or one admitted this pass uses it up', () => {
    const live = createDispatchThrottle({ ...idle, env: {}, listClaims: () => [claim('fix', 1), claim('ci-heal', 2)] });
    expect(live.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'fix-cap' });
    const pass = createDispatchThrottle({ ...idle, env: {}, listClaims: () => [claim('fix', 1), claim('fix', 2)] });
    expect(pass.tryAdmit('ci-heal').admit).toBe(true);
    expect(pass.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'fix-cap' });
  });
  it('reserve 0 restores the old behaviour', () => {
    const t = createDispatchThrottle({ ...idle, env: { WE_CI_HEAL_RESERVE: '0' }, listClaims: () => [claim('fix', 1), claim('fix', 2)] });
    expect(t.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'fix-cap' });
  });
  it('host load still refuses a reserved ci-heal, with a logged reason', () => {
    const t = createDispatchThrottle({ loadavg: () => 36, cpuCount: () => 12, env: {}, listClaims: () => [claim('fix', 1), claim('fix', 2)] });
    expect(t.tryAdmit('ci-heal')).toMatchObject({ admit: false, kind: 'host-load' });
  });
  it('the cap refusal for a ci-heal names the reserve so the log says why it is still waiting', () => {
    const t = createDispatchThrottle({ ...idle, env: {}, listClaims: () => [claim('ci-heal', 1), claim('fix', 2)] });
    expect(t.tryAdmit('ci-heal').why).toMatch(/reserve/);
  });
});
