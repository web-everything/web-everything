import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { transport } = vi.hoisted(() => ({ transport: vi.fn() }));
vi.mock('../../lib/under-test.mjs', () => ({ isUnderTest: () => false }));
vi.mock('../../lib/proc-read.mjs', async original => ({ ...await original(), execRead: transport }));
vi.mock('../../lib/settings-files.mjs', async original => ({ ...await original(),
  readSettings: () => ({}), readDeclaredSettings: () => ({ settings: {}, sources: {} }),
}));
const job = await import('../review-job.mjs').catch(() => ({}));
const session = await import('../review-dispatch.mjs').catch(() => ({}));

describe('real readers floor marked PRs and never raise a normal production review', () => {
  const head = 'a'.repeat(40), slug = 'web-everything/web-everything';
  const mark = '<!-- dispatch requires-review: true -->';
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'review-floor-defaults-')); transport.mockReset();
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));
    vi.spyOn(process, 'cwd').mockReturnValue(root);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });
  const setup = marked => {
    transport.mockImplementation((file, args) => {
      if (file !== 'gh') throw Error(`unexpected executable ${file}`);
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ headRefOid: head });
      if (args.includes(`repos/${slug}/issues/42/comments`)) {
        return `${marked ? mark : 'ordinary discussion'}\t2026-11-27T12:00:00Z\tchalbert\tIC_42\n`;
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        expect(args).toEqual(expect.arrayContaining(['owner=web-everything', 'name=web-everything', 'n=42']));
        return JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 1 } } } } });
      }
      throw Error(`unexpected transport argv ${JSON.stringify(args)}`);
    });
    return { pr: 42, repo: 'we', root, home: root, checkoutExists: () => true, env: {}, now: Date.now(),
      careLevel: 'none', scopePaths: ['src/ordinary.js'], expectedHead: head,
      ciGate: () => ({ allowed: true, headSha: head }), checkStaleness: () => ({ fresh: true, behind: 0 }),
      resolveSettingsEnv: () => null };
  };
  it.each([false, true])('job real createReviewJobIo with repo key (marked=%s)', marked => {
    expect(typeof job.createReviewJobIo).toBe('function'); expect(typeof job.dispatchReviewJob).toBe('function');
    const opts = setup(marked), dir = join(root, 'jobs');
    const io = job.createReviewJobIo({ root, env: {}, dir, exec: transport, recoveryProbe: {},
      readFile: () => { throw Error('unexpected read'); }, spawnNode: () => { throw Error('unexpected spawn'); },
      readConfig: () => { throw Error('unexpected config'); }, spawnPack: () => { throw Error('unexpected pack'); } });
    const spawnJob = vi.fn(() => 4321);
    job.dispatchReviewJob({ ...opts, dir, io, readCompletion: () => null, isAlive: () => false, spawnJob });
    expect(spawnJob).toHaveBeenCalledOnce();
    expect(spawnJob.mock.calls[0][0].argv.includes('--review-model=opus')).toBe(marked);
    const counts = transport.mock.calls.filter(([, args]) => args[0] === 'api' && args[1] === 'graphql');
    expect(counts).toHaveLength(1);
    expect(counts[0][1]).toEqual(expect.arrayContaining(['owner=web-everything', 'name=web-everything']));
  });
  it.each([false, true])('session production default reader with repo key (marked=%s)', marked => {
    expect(typeof session.dispatchReview).toBe('function');
    const opts = setup(marked), spawnAgent = vi.fn(() => 'backgrounded · abc12345 · review-42\n');
    session.dispatchReview({ ...opts, io: { liveHead: () => head }, spawnAgent, wrapReview: false,
      readBrief: () => 'Review {{PR}} {{REPO}} {{SESSION_SLUG}}', mintSessionId: () => 'fixture-session',
      sessionCwdFor: () => join(root, 'session'), ensureSessionCwd: d => d,
      isolateSession: () => ({ worktreeSettings: null }) });
    expect(spawnAgent).toHaveBeenCalledOnce();
    const argv = spawnAgent.mock.calls[0][0];
    expect(argv[argv.indexOf('--model') + 1]).toBe(marked ? 'opus' : 'sonnet');
    expect(transport.mock.calls.filter(([, args]) => args.includes('--paginate'))).toHaveLength(1);
  });
});
