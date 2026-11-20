import { describe, it, expect } from 'vitest';
import { assertRunnerFreshness } from '../runner-freshness.mjs';

const sha = 'a'.repeat(40);
function run({ lease = { at: sha, branch: 'lane/target' }, head = sha, tip = sha, unreadable = false, fetchFails = false, env = {} } = {}) {
  const calls = [];
  const check = () => assertRunnerFreshness({ declaration: { name: 'open-pr' }, moduleUrl: 'file:///pool/repo/lane-1/scripts/operations/run.mjs' }, {
    env: { LANE_POOL_ROOT: '/pool', ...env },
    filesystem: {
      realpathSync: p => p,
      readFileSync: () => { if (unreadable) throw new Error('unreadable lease'); return JSON.stringify(lease); },
    },
    git: args => {
      calls.push(args);
      if (args.includes('--show-toplevel')) return '/pool/repo/lane-1';
      if (args[0] === 'symbolic-ref') throw new Error('detached');
      if (args.includes('--git-path')) return '.git/.lane-lease';
      if (args[0] === 'fetch') { if (fetchFails) throw new Error('unreadable origin'); return ''; }
      if (args.includes('HEAD')) return head;
      if (args.includes('refs/remotes/origin/lane/target')) return tip;
      if (args[0] === 'check-ref-format') return '';
      throw new Error('unexpected git read: ' + args.join(' '));
    },
  });
  return { check, calls };
}
describe('open-pr pinned runner lease', () => {
  it('accepts HEAD == lease at == freshly fetched branch tip even after main moves', () => {
    const f = run(); expect(f.check()).toMatchObject({ exempt: true });
    expect(f.calls).toContainEqual(['fetch', '--quiet', 'origin', '+refs/heads/lane/target:refs/remotes/origin/lane/target']);
  });
  it('refuses lease at different from HEAD', () => expect(run({ head: 'b'.repeat(40) }).check).toThrow());
  it('refuses a moved branch tip', () => expect(run({ tip: 'b'.repeat(40) }).check).toThrow());
  it('refuses unreadable origin despite a matching cached tip', () => expect(run({ fetchFails: true }).check).toThrow());
  it.each([{ at: sha }, { branch: 'lane/target' }, {}, { at: 'short', branch: 'lane/target' }])('refuses incomplete lease %j', lease => expect(run({ lease }).check).toThrow());
  it('stale-runner override cannot bypass an invalid pin', () => expect(run({ head: 'b'.repeat(40), env: { WE_OPERATION_ALLOW_STALE: '1' } }).check).toThrow());
  it('refuses an unreadable lease', () => expect(run({ unreadable: true }).check).toThrow());
});
