/** R258: IO/lock waits inflate macOS load; opt-in capacity admission must use measured evidence. */
import { it, expect, vi } from 'vitest';
import { hostLoadAdmission } from '../host-load.mjs';
import { resolveHostOverloadSettings } from '../host-overload-settings.mjs';
const policy = signal => resolveHostOverloadSettings({ env: signal ? { WE_HOST_CAPACITY_SIGNAL: signal } : {}, log: () => {} });
const capacity = () => ({ admitNewWorkers: true, headroom: { mac: 'high' }, reason: 'CPU idle 38%; memory free 51%' });
const base = { interactive: false, env: {}, cores: () => 12, load: () => [50], memory: () => 4096 };
it('default load admission retains its exact legacy refusal and never reads capacity', () => {
  const read = vi.fn(capacity);
  expect(hostLoadAdmission({ ...base, policy: policy(), capacity: read })).toEqual({ admitted: false, reason: 'host load 50.00/12=4.17; host.maxLoadPerCore=2 (standard)' });
  expect(read).not.toHaveBeenCalled();
});
it('cpu-mem admits an idle high-load host and includes numbers and memory floor', () => {
  const read = vi.fn(capacity); const load = vi.fn(() => { throw Error('must not sample'); });
  const r = hostLoadAdmission({ ...base, load, capacity: read, policy: policy('cpu-mem') });
  expect(r.admitted).toBe(true); expect(r.reason).toContain('idle 38%'); expect(r.reason).toContain('free 51%'); expect(r.reason).toContain('2048');
  expect(read.mock.calls[0][0]).toMatchObject({ includeQueue: false, includeForge: false }); expect(load).not.toHaveBeenCalled();
});
it.each(['load', 'cpu-mem'])('retains the memory floor for %s', signal => {
  expect(hostLoadAdmission({ ...base, load: () => [1], policy: policy(signal), capacity, memory: () => 100 }).admitted).toBe(false);
});
it.each([() => ({ admitNewWorkers: false, headroom: { mac: 'low' }, reason: 'unknown CPU idle' }), () => ({}), () => { throw Error('unknown probe'); }])('fails closed on low, missing or failed capacity evidence', read => {
  expect(hostLoadAdmission({ ...base, policy: policy('cpu-mem'), capacity: read }).admitted).toBe(false);
});
