/** @file Linux ownership scans isolate pre-existing permission barriers from job descendants. */
import { describe, expect, it } from 'vitest';
import { collectOwnedProcesses } from '../detached-op.mjs';

const scope = '/fixture/job.json';
const owner = (pid, start = '100') => ({ pid, start, platform: 'linux', bootId: 'boot', scope });
const record = {
  id: 'job', pid: 900, recordPath: scope,
  stdoutPath: '/fixture/out', stderrPath: '/fixture/err',
  runnerIdentity: owner(900, '200'), members: [],
};

function fixture({ at = 'environ', code = 'EACCES', start = '100', marker = false,
  writer = false, oversized = false, malformedFlags = false, recheckDenied = false } = {}) {
  let statReads = 0;
  const deny = () => { throw Object.assign(new Error('permission barrier'), { code }); };
  return { platform: 'linux', uid: 501, io: {
    readFile: async path => {
      if (path.endsWith('/boot_id')) return 'boot';
      if (path.endsWith('/stat')) {
        if (++statReads > 1 && recheckDenied) deny();
        return `101 (service) ${['S', '1', '101', ...Array(16).fill('0'), start].join(' ')}`;
      }
      if (path.endsWith('/environ')) {
        if (at === 'environ') deny();
        return marker ? 'WE_DETACHED_OP=job\0' : '';
      }
      if (path.endsWith('/fdinfo/1')) return malformedFlags ? 'flags: unknown\n' : 'flags:\t0100001\n';
      if (path.endsWith('/fdinfo/2')) return at === 'fdinfo' ? deny() : 'flags:\t0100000\n';
      throw new Error(`unexpected read ${path}`);
    },
    readdir: async path => {
      if (path === '/proc') return ['101'];
      if (at === 'fd-directory') deny();
      if (oversized) return Array.from({ length: 4097 }, (_, i) => String(i));
      return writer || malformedFlags ? ['1', '2'] : ['2'];
    },
    stat: async path => {
      if (path === record.stdoutPath) return { dev: 1, ino: 1 };
      if (path === record.stderrPath) return { dev: 1, ino: 2 };
      if (path.endsWith('/fd/2') && at === 'fd') deny();
      if (path.endsWith('/fd/1') || (path.endsWith('/fd/2') && at === 'fdinfo')) return { dev: 1, ino: 1 };
      return path.includes('/fd/') ? { dev: 1, ino: 3 } : { uid: 501 };
    },
  } };
}

describe('Linux ownership permission barriers', () => {
  it.each(['environ', 'fd-directory', 'fd'])(
    'a pre-existing unobserved service denied at %s cannot poison cleanup', async at => {
      for (const code of ['EACCES', 'EPERM']) {
        expect(await collectOwnedProcesses(record, fixture({ at, code })))
          .toEqual({ complete: true, members: [] });
      }
    },
  );

  it.each(['200', '300'])(
    'an unreadable process born at or after the runner (%s) stays incomplete', async start => {
      expect((await collectOwnedProcesses(record, fixture({ start }))).complete).toBe(false);
    },
  );

  it.each([undefined, { ...owner(900, '200'), bootId: 'different-boot' },
    { ...owner(900, '200'), scope: '/different/job.json' }, owner(900, 'invalid')])(
    'a missing or incomparable runner birth never clears a permission barrier (%j)', async runnerIdentity => {
      expect((await collectOwnedProcesses({ ...record, runnerIdentity }, fixture())).complete).toBe(false);
    },
  );

  it.each([
    ['remembered', { members: [owner(101)] }, {}],
    ['command', { commandIdentity: owner(101) }, {}],
    ['marker', {}, { at: 'fd-directory', marker: true }],
    ['log writer', {}, { at: 'fd', writer: true }],
    ['log writer with unreadable environ', {}, { at: 'environ', writer: true }],
  ])('a pre-existing %s owner remains incomplete on denial', async (_name, saved, options) => {
    expect(await collectOwnedProcesses({ ...record, ...saved }, fixture(options)))
      .toEqual({ complete: false, members: [owner(101)] });
  });

  it.each(['EIO', 'EINVAL'])('a pre-existing service with a non-permission error (%s) stays incomplete', async code => {
    expect((await collectOwnedProcesses(record, fixture({ code }))).complete).toBe(false);
  });

  it('a denied birth recheck cannot clear even a pre-existing process', async () => {
    expect((await collectOwnedProcesses(record, fixture({ recheckDenied: true }))).complete).toBe(false);
  });

  it('a pre-existing log holder with unreadable access flags stays incomplete', async () => {
    expect(await collectOwnedProcesses(record, fixture({ at: 'fdinfo' })))
      .toEqual({ complete: false, members: [] });
  });

  it.each([{ marker: true }, { writer: true }])('readable pre-existing owners are still discovered (%j)', async options => {
    expect(await collectOwnedProcesses(record, fixture({ at: 'none', ...options })))
      .toEqual({ complete: true, members: [owner(101)] });
  });

  it('a reused remembered pid does not turn an older unrelated service into an owner', async () => {
    expect(await collectOwnedProcesses({ ...record, members: [owner(101, '50')] }, fixture()))
      .toEqual({ complete: true, members: [] });
  });

  it('a pre-existing service still requires bounded, valid descriptor evidence', async () => {
    for (const options of [{ at: 'fdinfo', oversized: true }, { at: 'fd', malformedFlags: true }]) {
      expect((await collectOwnedProcesses(record, fixture(options))).complete).toBe(false);
    }
  });
});
