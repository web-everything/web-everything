import { describe, expect, it } from 'vitest';
import { defaultAwaitVerifyIo, findAwaitSession, lookupAwaitSession } from '../await-verify-pass.mjs';
import { resumeSucceeded } from '../../operations/dispatch-lane-io.mjs';

const owner = '/profiles/owner';
const foreign = '/profiles/foreign';
const sessionId = 'a287c608-48e3-4d38-99f1-10496475407f';
const row = (over = {}) => ({ id: 'a287c608', sessionId, name: 'fix-1', storeKey: owner, startedAt: 1, ...over });

describe('await name-only store ownership', () => {
  it('uses the recorded store even when a foreign namesake is newer', () => {
    const own = row();
    const rows = [own, row({ storeKey: foreign, startedAt: 2 })];
    expect(findAwaitSession({ who: 'fix-1', storeKey: owner }, rows)).toBe(own);
  });

  it('does not fall back to a foreign store when the recorded store has no namesake', () => {
    expect(findAwaitSession({ who: 'fix-1', storeKey: owner }, [row({ storeKey: foreign })])).toBeNull();
  });

  it('holds an unkeyed legacy record with namesakes in multiple stores and requests repair', () => {
    expect(() => lookupAwaitSession({ who: 'fix-1' }, [row(), row({ storeKey: foreign, startedAt: 2 })]))
      .toThrow(/ambiguous.*repair stores and retry/);
  });

  it('keeps newest-name lookup within a single store for legacy records', () => {
    const newest = row({ startedAt: 2 });
    expect(findAwaitSession({ who: 'fix-1' }, [row(), newest])).toBe(newest);
  });
});

describe('await resume confirmation store ownership', () => {
  it.each([
    ['a foreign UUID/job match', owner, [row({ storeKey: foreign })], false],
    ['a foreign match beside an owner-store job for another UUID', owner,
      [row({ sessionId: 'another-session' }), row({ storeKey: foreign })], false],
    ['an unkeyed UUID in multiple stores', undefined,
      [row(), row({ storeKey: foreign, id: 'other-job' })], false],
    ['an unkeyed job ID in multiple stores', undefined,
      [row(), row({ storeKey: foreign, sessionId: 'another-session' })], false],
    ['the recorded owner despite a foreign duplicate', owner, [row({ storeKey: foreign }), row()], true],
    ['a single-store legacy match', undefined, [row()], true],
  ])('%s', async (_label, storeKey, rows, confirmed) => {
    const io = await defaultAwaitVerifyIo({
      sleep: () => {},
      stopSessionFn: () => { throw new Error('no stop expected'); },
      dispatchIo: {
        buildAgentArgv: () => [],
        defaultSpawnAgent: () => 'backgrounded',
        // Use the full UUID as the printed handle to avoid fork-cleanup side effects in this probe.
        parseBackgroundedId: () => sessionId,
        defaultListAgents: () => rows.map(r => ({ ...r, id: r.id === 'a287c608' ? sessionId : r.id })),
        resumeSucceeded,
      },
    });
    const result = io.resume({ session: { ...row(), storeKey, cwd: '/scratch', state: 'stopped' }, prompt: 'continue' });
    expect(result.resumed).toBe(confirmed);
    expect(result.reason).toBe(confirmed ? null : 'resume-unconfirmed');
  });
});
